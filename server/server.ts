import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { openAgent, type Agent } from "./agent.ts";
import { openDeepgramStream, type DeepgramStream } from "./transcribe.ts";
import { startNudgeLoop, type NudgeLoop } from "./nudge-loop.ts";
import { writeCallLog } from "./persistence.ts";
import { loadSecrets } from "./secrets.ts";
import { listAvailableModes } from "./prompts/system.ts";
import type { CallLog } from "./persistence.ts";
import type {
  CallSetup,
  ChecklistItem,
  ClientToServer,
  Nudge,
  ServerToClient,
  TranscriptUtterance,
} from "./types.ts";

const PORT = Number(process.env.PROMPTY_PORT ?? 7878);

process.on("uncaughtException", (e) => {
  console.error("[prompty] uncaughtException:", (e as Error)?.message ?? e);
});
process.on("unhandledRejection", (e) => {
  console.error("[prompty] unhandledRejection:", (e as Error)?.message ?? e);
});

let currentSetup: CallSetup | null = null;

const httpServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/setup") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        res.writeHead(413).end("payload too large");
        req.destroy();
      }
    });
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad JSON" }));
        return;
      }
      const validated = validateSetup(parsed);
      if (!validated.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: validated.error }));
        return;
      }
      currentSetup = validated.setup;
      console.log(
        `[prompty] /setup received — mode: ${currentSetup.mode ?? "default"}, goal: "${currentSetup.goal.slice(0, 80)}", checklist: ${currentSetup.checklist.length} items`,
      );
      broadcast({ type: "setup_pushed", setup: currentSetup });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/modes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ modes: listAvailableModes() }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[prompty] HTTP + WS server listening on http://127.0.0.1:${PORT}`);
});

wss.on("connection", (ws) => {
  console.log("[prompty] client connected");
  const session = newSession(ws);
  ws.on("message", (data) => session.handle(data.toString()));
  ws.on("close", () => session.end());
  send(ws, { type: "ready" });
  if (currentSetup) send(ws, { type: "setup_pushed", setup: currentSetup });
});

type Session = { handle: (raw: string) => void; end: () => void };

function newSession(ws: WebSocket): Session {
  let agent: Agent | null = null;
  let nudgeLoop: NudgeLoop | null = null;
  let themStream: DeepgramStream | null = null;
  let meStream: DeepgramStream | null = null;
  let activeSetup: CallSetup | null = null;
  const transcript: TranscriptUtterance[] = [];
  const nudges: Nudge[] = [];
  let lastCallLog: CallLog | null = null;
  const audioCounters = { me: 0, them: 0, dropped: 0 };

  const onUtterance = (u: TranscriptUtterance) => {
    if (u.isFinal) {
      transcript.push(u);
      console.log(`[transcript ${u.speaker}] ${u.text}`);
    }
    send(ws, { type: "transcript", utterance: u });
    if (u.isFinal) nudgeLoop?.pushUtterance(u);
  };

  return {
    handle(raw) {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(raw);
      } catch {
        send(ws, { type: "error", message: "bad JSON" });
        return;
      }
      switch (msg.type) {
        case "start_call": {
          if (agent) {
            send(ws, { type: "error", message: "call already active" });
            return;
          }
          console.log("[prompty] start_call received, goal:", msg.setup.goal.slice(0, 60));
          audioCounters.me = 0;
          audioCounters.them = 0;
          audioCounters.dropped = 0;
          activeSetup = msg.setup;
          const secrets = loadSecrets();
          if (!secrets.deepgramApiKey) {
            send(ws, {
              type: "error",
              message:
                "no Deepgram key — set DEEPGRAM_API_KEY or write ~/.prompty/secrets.json",
            });
            return;
          }
          agent = openAgent(msg.setup, {
            onNudge: (n) => {
              nudges.push(n);
              console.log(`[nudge ${n.kind}/${n.urgency}] ${n.text}`);
              send(ws, { type: "nudge", nudge: n });
            },
            onChecklistUpdate: (id, status) => {
              const item = activeSetup?.checklist.find((c) => c.id === id);
              if (item) item.status = status;
              console.log(`[checklist] ${id} → ${status}`);
              send(ws, { type: "checklist_update", itemId: id, status });
            },
            onStayQuiet: (reason) => {
              console.log(`[quiet] ${reason}`);
            },
            onError: (e) => {
              console.log(`[agent error] ${e.message}`);
              send(ws, { type: "error", message: e.message });
            },
          });
          nudgeLoop = startNudgeLoop(agent);
          themStream = openDeepgramStream("them", secrets.deepgramApiKey, {
            onUtterance,
            onError: (e) => send(ws, { type: "error", message: e.message }),
          });
          meStream = openDeepgramStream("me", secrets.deepgramApiKey, {
            onUtterance,
            onError: (e) => send(ws, { type: "error", message: e.message }),
          });
          send(ws, { type: "setup", setup: msg.setup });
          break;
        }
        case "audio_chunk": {
          const stream = msg.source === "me" ? meStream : themStream;
          if (!stream) {
            audioCounters.dropped++;
            if (audioCounters.dropped % 20 === 1) {
              console.log(`[prompty] dropped audio_chunk (no stream for ${msg.source}) ×${audioCounters.dropped}`);
            }
            break;
          }
          const bytes = Buffer.from(msg.pcm16, "base64");
          const ab = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
          stream.sendAudio(ab);
          audioCounters[msg.source]++;
          const total = audioCounters.me + audioCounters.them;
          if (total % 50 === 1) {
            console.log(`[prompty] audio chunks received — me:${audioCounters.me} them:${audioCounters.them}`);
          }
          break;
        }
        case "request_nudge": {
          void nudgeLoop?.requestImmediate();
          break;
        }
        case "client_error": {
          console.log(`[prompty] client error (${msg.source}): ${msg.message}${msg.name ? ` [${msg.name}]` : ""}`);
          break;
        }
        case "end_call": {
          void this.end();
          break;
        }
      }
    },
    async end() {
      if (!agent) return;
      nudgeLoop?.stop();
      await Promise.all([themStream?.close(), meStream?.close()]);
      await agent.close();
      let logPath = "";
      if (activeSetup) {
        try {
          lastCallLog = {
            setup: activeSetup,
            transcript: [...transcript],
            nudges: [...nudges],
            endedAt: Date.now(),
          };
          logPath = await writeCallLog(lastCallLog);
        } catch (e) {
          console.error("[prompty] persistence error:", e);
        }
      }
      send(ws, { type: "call_ended", logPath });
      agent = null;
      nudgeLoop = null;
      themStream = null;
      meStream = null;
      activeSetup = null;
      console.log("[prompty] call ended");
    },
  };
}

function broadcast(msg: ServerToClient) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function send(ws: WebSocket, msg: ServerToClient) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function validateSetup(
  raw: unknown,
): { ok: true; setup: CallSetup } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.goal !== "string" || !obj.goal.trim()) {
    return { ok: false, error: "goal must be a non-empty string" };
  }
  if (!Array.isArray(obj.checklist)) {
    return { ok: false, error: "checklist must be an array" };
  }
  const checklist: ChecklistItem[] = [];
  for (let i = 0; i < obj.checklist.length; i++) {
    const item = obj.checklist[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `checklist[${i}] must be an object` };
    }
    const id = typeof item.id === "string" && item.id ? item.id : `c${i + 1}`;
    if (typeof item.text !== "string" || !item.text.trim()) {
      return { ok: false, error: `checklist[${i}].text must be a non-empty string` };
    }
    const status =
      item.status === "covered" || item.status === "partial" ? item.status : "open";
    checklist.push({ id, text: item.text, status });
  }
  const context =
    obj.context && typeof obj.context === "object"
      ? (obj.context as CallSetup["context"])
      : {};
  const mode = typeof obj.mode === "string" && obj.mode.trim() ? obj.mode.trim() : undefined;
  return { ok: true, setup: { goal: obj.goal, checklist, context, mode } };
}
