import { WebSocket } from "ws";
import type { Readable } from "node:stream";
import type { Speaker, TranscriptUtterance } from "./types";

const DG_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&endpointing=300&smart_format=true&punctuate=true&encoding=linear16&sample_rate=16000&channels=1";

/** Connection-level status of a single Deepgram socket. */
export type DeepgramConnStatus = "open" | "reconnecting" | "error";

export type TranscribeEvents = {
  onUtterance: (u: TranscriptUtterance) => void;
  onError: (err: Error) => void;
  /** Fired on socket open / abnormal close / error. */
  onStatus?: (s: DeepgramConnStatus, speaker: Speaker) => void;
};

export type DeepgramStream = {
  sendAudio(pcm16: ArrayBuffer | Buffer | Uint8Array): void;
  close(): Promise<void>;
};

export type TranscriptionHandle = {
  /** Close both Deepgram sockets cleanly. */
  close(): Promise<void>;
};

export type StartTranscriptionOptions = {
  /** 16 kHz mono 16-bit LE PCM. Tagged as speaker "me". */
  micStream: Readable;
  /** 16 kHz mono 16-bit LE PCM. Tagged as speaker "them". */
  tapStream: Readable;
  /** Deepgram API key (already minted via relay-client.getDeepgramToken). */
  deepgramKey: string;
  onUtterance: (u: TranscriptUtterance) => void;
  onError?: (err: Error) => void;
  /** Connection status from either socket (open / reconnecting / error). */
  onStatus?: (s: DeepgramConnStatus, speaker: Speaker) => void;
};

/**
 * Open two Deepgram streams (mic + tap) and pipe the provided PCM streams
 * into them. Final + interim transcripts are merged into a single
 * `onUtterance` callback, tagged by speaker. Mirrors the dual-stream merge
 * the server used to do over the extension WebSocket.
 */
export function startTranscription(opts: StartTranscriptionOptions): TranscriptionHandle {
  const onError = opts.onError ?? ((e) => console.error("[dg] error:", e.message));

  const me = openDeepgramStream("me", opts.deepgramKey, {
    onUtterance: opts.onUtterance,
    onError,
    onStatus: opts.onStatus,
  });
  const them = openDeepgramStream("them", opts.deepgramKey, {
    onUtterance: opts.onUtterance,
    onError,
    onStatus: opts.onStatus,
  });

  pipePcm(opts.micStream, me, onError);
  pipePcm(opts.tapStream, them, onError);

  return {
    async close() {
      await Promise.all([me.close(), them.close()]);
    },
  };
}

function pipePcm(src: Readable, dg: DeepgramStream, onError: (e: Error) => void) {
  src.on("data", (chunk: Buffer) => {
    try {
      dg.sendAudio(chunk);
    } catch (e) {
      onError(e as Error);
    }
  });
  src.on("error", onError);
  src.on("end", () => {
    // Caller decides when to close — leave the dg stream open.
  });
}

// Deepgram closes an idle socket after ~10s with code 1011. The system-audio
// tap emits no PCM frames while nothing is playing, so its socket would starve
// and drop mid-call. Sending a KeepAlive every few seconds of silence holds the
// connection open. Kept well under the 10s window.
const KEEPALIVE_MS = 5_000;
// Backoff bounds for reconnecting after an unexpected drop.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 6;
// Cap the buffer of audio held while a socket is down so a long outage can't
// grow memory without bound (~a few seconds of 16 kHz mono PCM).
const MAX_PENDING_CHUNKS = 400;

export function openDeepgramStream(
  speaker: Speaker,
  apiKey: string,
  events: TranscribeEvents,
): DeepgramStream {
  if (process.env.PROMPTY_MOCK_DEEPGRAM === "1") {
    return openMockStream(speaker, events);
  }

  let ws: WebSocket;
  let bytesSent = 0;
  let chunksSeen = 0;
  let lastAudioSentAt = 0;
  let closing = false;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const pending: Buffer[] = [];

  // Periodically poke the socket if no real audio has gone out recently. A
  // single timer spans reconnects — it only ever inspects the current `ws`.
  const keepAliveTimer = setInterval(() => {
    if (closing || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastAudioSentAt < KEEPALIVE_MS) return;
    try {
      ws.send(JSON.stringify({ type: "KeepAlive" }));
    } catch {
      /* a failed send means the socket is going down; close handler recovers */
    }
  }, KEEPALIVE_MS);

  const scheduleReconnect = () => {
    if (closing || reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[dg ${speaker}] giving up after ${reconnectAttempts} reconnect attempts`);
      events.onStatus?.("error", speaker);
      return;
    }
    events.onStatus?.("reconnecting", speaker);
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    );
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      console.log(`[dg ${speaker}] reconnecting (attempt ${reconnectAttempts})`);
      connect();
    }, delay);
  };

  function connect() {
    ws = new WebSocket(DG_URL, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    ws.on("open", () => {
      reconnectAttempts = 0;
      console.log(`[dg ${speaker}] connected`);
      events.onStatus?.("open", speaker);
      for (const chunk of pending) ws.send(chunk);
      pending.length = 0;
    });

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString()
          : Array.isArray(data)
            ? Buffer.concat(data).toString()
            : Buffer.from(data as ArrayBuffer).toString();
        const msg = JSON.parse(text);
        if (msg.type !== "Results") {
          if (msg.type) console.log(`[dg ${speaker}] ${msg.type} ${JSON.stringify(msg).slice(0, 500)}`);
          return;
        }
        const alt = msg.channel?.alternatives?.[0];
        if (!alt || !alt.transcript) return;
        events.onUtterance({
          speaker,
          text: alt.transcript,
          startMs: Math.round((msg.start ?? 0) * 1000),
          endMs: Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000),
          isFinal: !!msg.is_final,
        });
      } catch (e) {
        events.onError(e as Error);
      }
    });

    ws.on("error", (e: Error) => {
      console.log(`[dg ${speaker}] ws error: ${e.message}`);
      events.onError(e);
      // A 'close' event always follows; reconnect is handled there.
    });
    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[dg ${speaker}] ws closed code=${code} reason=${reason.toString().slice(0, 100)}`);
      // A clean, caller-initiated close (1000) is final. Anything else mid-call
      // — including Deepgram's 1011 idle timeout — should reconnect rather than
      // permanently kill this speaker's transcription.
      if (!closing && code !== 1000) scheduleReconnect();
    });
  }

  connect();

  return {
    sendAudio(pcm16) {
      const buf = Buffer.isBuffer(pcm16)
        ? pcm16
        : pcm16 instanceof Uint8Array
          ? Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
          : Buffer.from(pcm16);
      bytesSent += buf.byteLength;
      chunksSeen++;
      lastAudioSentAt = Date.now();
      if (chunksSeen === 1) {
        const samples: number[] = [];
        for (let i = 0; i < Math.min(8, buf.byteLength / 2); i++) {
          samples.push(buf.readInt16LE(i * 2));
        }
        console.log(`[dg ${speaker}] first chunk: ${buf.byteLength} bytes, samples=[${samples.join(",")}]`);
      }
      if (chunksSeen % 25 === 1) {
        console.log(`[dg ${speaker}] sent ${chunksSeen} chunks, ${bytesSent} bytes total, ws=${ws.readyState}`);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else {
        pending.push(buf);
        // Drop the oldest frames if a reconnect drags on — bounded memory beats
        // replaying a stale backlog the moment we recover.
        while (pending.length > MAX_PENDING_CHUNKS) pending.shift();
      }
    },
    async close() {
      closing = true;
      clearInterval(keepAliveTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        setTimeout(() => {
          try {
            ws.terminate();
          } catch {}
          resolve();
        }, 3000);
      });
      void bytesSent;
    },
  };
}

function openMockStream(
  speaker: Speaker,
  events: TranscribeEvents,
): DeepgramStream {
  let buffered = 0;
  let chunkIdx = 0;
  const timer = setInterval(() => {
    if (buffered === 0) return;
    const ms = Math.round(buffered / 32);
    events.onUtterance({
      speaker,
      text: `[mock-${speaker}-${chunkIdx++}] received ~${ms}ms of audio`,
      startMs: 0,
      endMs: ms,
      isFinal: true,
    });
    buffered = 0;
  }, 500);

  return {
    sendAudio(pcm16) {
      const len =
        Buffer.isBuffer(pcm16) || pcm16 instanceof Uint8Array
          ? pcm16.byteLength
          : pcm16.byteLength;
      buffered += len;
    },
    async close() {
      clearInterval(timer);
      if (buffered > 0) {
        events.onUtterance({
          speaker,
          text: `[mock-${speaker}-final]`,
          startMs: 0,
          endMs: Math.round(buffered / 32),
          isFinal: true,
        });
      }
    },
  };
}
