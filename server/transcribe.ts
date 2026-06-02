import { WebSocket } from "ws";
import type { Speaker, TranscriptUtterance } from "./types.ts";

const DG_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&endpointing=300&smart_format=true&punctuate=true&encoding=linear16&sample_rate=16000&channels=1";

export type TranscribeEvents = {
  onUtterance: (u: TranscriptUtterance) => void;
  onError: (err: Error) => void;
};

export type DeepgramStream = {
  /** Send a chunk of 16kHz mono PCM16 little-endian audio. */
  sendAudio(pcm16: ArrayBuffer): void;
  /** Close the stream cleanly (flushes any final transcript). */
  close(): Promise<void>;
};

/**
 * Opens one Deepgram streaming WebSocket. The caller is responsible for
 * which audio source it represents (mic vs tab) — we tag the speaker here.
 *
 * If process.env.PROMPTY_MOCK_DEEPGRAM is set, returns a fake stream that
 * echoes the audio length as a transcript every 500ms — used by the smoke
 * test when we don't have a Deepgram key.
 */
export function openDeepgramStream(
  speaker: Speaker,
  apiKey: string,
  events: TranscribeEvents,
): DeepgramStream {
  if (process.env.PROMPTY_MOCK_DEEPGRAM === "1") {
    return openMockStream(speaker, events);
  }

  const ws = new WebSocket(DG_URL, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let openedAt = 0;
  let bytesSent = 0;
  let chunksSeen = 0;
  const pending: Buffer[] = [];

  ws.on("open", () => {
    openedAt = Date.now();
    console.log(`[dg ${speaker}] connected`);
    for (const chunk of pending) ws.send(chunk);
    pending.length = 0;
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "Results") {
        // Surface non-Results messages (Metadata, Error, etc.) for debug.
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

  ws.on("error", (e) => {
    console.log(`[dg ${speaker}] ws error: ${(e as Error).message}`);
    events.onError(e as Error);
  });
  ws.on("close", (code, reason) => {
    console.log(`[dg ${speaker}] ws closed code=${code} reason=${reason.toString().slice(0, 100)}`);
  });

  return {
    sendAudio(pcm16) {
      const buf = Buffer.from(pcm16);
      bytesSent += buf.byteLength;
      chunksSeen++;
      if (chunksSeen === 1) {
        // First chunk diagnostic: bytes, first 8 sample values as Int16.
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
      else pending.push(buf);
    },
    async close() {
      // Deepgram closes the stream when it receives the empty terminator
      // followed by a CloseStream control message.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        // Safety timeout — if Deepgram never sends Close, bail after 3s.
        setTimeout(() => {
          try {
            ws.terminate();
          } catch {}
          resolve();
        }, 3000);
      });
      void openedAt;
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
    const ms = Math.round(buffered / 32); // 16kHz * 2 bytes
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
      buffered += pcm16.byteLength;
    },
    async close() {
      clearInterval(timer);
      // Final flush
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
