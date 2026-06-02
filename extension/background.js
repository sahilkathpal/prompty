// Service worker: owns the WebSocket to the local backend, owns tab capture,
// and instructs the offscreen document to capture the mic.
//
// Designed to be plain JS so the extension loads unpacked without a build step.

const BACKEND_URL = "ws://127.0.0.1:7878";

/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let activeMeetTabId = null;
/** @type {boolean} */
let callActive = false;

const log = (...args) => console.log("[prompty/bg]", ...args);

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }
  ws = new WebSocket(BACKEND_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => log("ws open");
  ws.onclose = () => {
    log("ws closed");
    ws = null;
  };
  ws.onerror = (e) => {
    // A WebSocket error often precedes onclose, but on some failure modes
    // the close event never fires and the socket stays in a "ghost" state.
    // Aggressively null it out so the next send() forces a fresh connection.
    log("ws error", e);
    try { ws?.close(); } catch {}
    ws = null;
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // Cache pushed setups so the content script can hydrate even if it loads
    // after the push, or after a Meet tab refresh.
    if (msg?.type === "setup_pushed" && msg.setup) {
      try {
        await chrome.storage.local.set({ promptyPendingSetup: msg.setup });
      } catch (e) {
        log("storage set failed", e);
      }
    }
    // Forward to whichever Meet tab is active.
    if (activeMeetTabId != null) {
      try {
        await chrome.tabs.sendMessage(activeMeetTabId, { kind: "from-backend", msg });
      } catch (e) {
        log("forward to tab failed", e);
      }
    }
  };
  return ws;
}

function send(msg) {
  const sock = connectWs();
  const data = JSON.stringify(msg);
  if (sock.readyState === WebSocket.OPEN) sock.send(data);
  else sock.addEventListener("open", () => sock.send(data), { once: true });
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture mic audio for live call transcription.",
  });
}

async function startCapture(tabId) {
  await ensureOffscreen();
  // Get a stream ID the offscreen doc can use to grab tab audio.
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? "no stream id"));
      } else resolve(id);
    });
  });
  const offResp = await chrome.runtime.sendMessage({
    target: "offscreen",
    kind: "start-capture",
    streamId,
  });
  if (!offResp?.ok) {
    const err = offResp?.error || "offscreen start-capture returned no response";
    log("offscreen failed:", err);
    // Forward to backend so it shows in the server log alongside audio counts.
    send({ type: "client_error", source: "offscreen", message: String(err) });
    throw new Error(err);
  }
  callActive = true;
}

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", kind: "stop-capture" });
  } catch {}
  callActive = false;
}

// Messages from content script / popup / offscreen
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.target === "background") {
      switch (msg.kind) {
        case "register-meet-tab":
          activeMeetTabId = sender.tab?.id ?? null;
          log("registered meet tab", activeMeetTabId);
          // Ensure WS is up so the server can replay any cached setup over
          // the existing setup_pushed broadcast path.
          connectWs();
          sendResponse({ ok: true });
          break;
        case "start-call":
          try {
            send({ type: "start_call", setup: msg.setup });
            if (sender.tab?.id != null) {
              activeMeetTabId = sender.tab.id;
              await startCapture(sender.tab.id);
            }
            sendResponse({ ok: true });
          } catch (e) {
            log("start-call failed:", e?.message ?? e);
            sendResponse({ ok: false, error: e?.message ?? String(e) });
          }
          break;
        case "end-call":
          send({ type: "end_call" });
          await stopCapture();
          sendResponse({ ok: true });
          break;
        case "request-nudge":
          send({ type: "request_nudge" });
          sendResponse({ ok: true });
          break;
        case "get-pending-setup": {
          const { promptyPendingSetup } = await chrome.storage.local.get("promptyPendingSetup");
          sendResponse({ setup: promptyPendingSetup ?? null });
          break;
        }
        case "check-mic": {
          await ensureOffscreen();
          const resp = await chrome.runtime.sendMessage({ target: "offscreen", kind: "check-mic-permission" });
          sendResponse(resp || { state: "unknown" });
          break;
        }
        case "request-mic": {
          await ensureOffscreen();
          const resp = await chrome.runtime.sendMessage({ target: "offscreen", kind: "request-mic-permission" });
          sendResponse(resp || { ok: false, message: "no response" });
          break;
        }
        case "open-mic-settings": {
          // Target the extension's own origin page, not the global mic list —
          // mic permission for the offscreen document lives there. Global mic
          // settings would surface whichever site (e.g. Meet) is currently
          // active, which is the wrong place to allow Prompty.
          const origin = `chrome-extension://${chrome.runtime.id}`;
          const url = `chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}`;
          await chrome.tabs.create({ url });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown kind" });
      }
      return;
    }
    if (msg.target === "background-audio") {
      // pcm16 is already a base64 string (offscreen converts it before IPC).
      send({
        type: "audio_chunk",
        source: msg.source,
        pcm16: msg.pcm16,
        sampleRate: msg.sampleRate,
      });
      return;
    }
    if (msg.target === "background-audio-error") {
      log("offscreen audio error:", msg.source, msg.message);
      send({ type: "client_error", source: msg.source, message: msg.message, name: msg.name });
      if (activeMeetTabId != null) {
        try {
          await chrome.tabs.sendMessage(activeMeetTabId, {
            kind: "audio-error",
            source: msg.source,
            message: msg.message,
            name: msg.name,
          });
        } catch {}
      }
      return;
    }
  })();
  return true; // async sendResponse
});

// The toolbar icon click is kept as a no-op listener: clicking it grants
// `activeTab` to the current page, which is what tabCapture needs as a
// user-gesture invocation before Start. No UI is opened.
chrome.action.onClicked.addListener(() => {
  log("toolbar icon clicked — activeTab granted for current tab");
});

chrome.commands.onCommand.addListener((cmd) => {
  log("hotkey command fired:", cmd, "callActive:", callActive);
  if (cmd === "request-nudge") {
    // Don't gate on callActive — the backend's request_nudge is a no-op when
    // there's no active nudge loop, and the gate hides legitimate presses when
    // the SW state is stale (MV3 service workers reset module globals on wake).
    send({ type: "request_nudge" });
  }
});

// Helper: ArrayBuffer → base64 (so we can send over JSON WS easily).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
