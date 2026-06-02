// Offscreen document: captures mic + tab audio, downsamples to 16kHz mono PCM16,
// and forwards chunks to the service worker.

const TARGET_SR = 16000;
const CHUNK_MS = 200;

let micStream = null;
let tabStream = null;
let audioCtx = null;
let micProcessor = null;
let tabProcessor = null;

const log = (...a) => console.log("[prompty/off]", ...a);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  (async () => {
    if (msg.kind === "start-capture") {
      const result = { ok: false, tab: null, mic: null };
      try {
        await startCapture(msg.streamId);
        result.ok = true;
        result.tab = "ok";
        result.mic = "ok";
      } catch (e) {
        log("start-capture error", e);
        result.error = String(e);
        result.tab = window.__promptyTabOk ? "ok" : "fail";
        result.mic = window.__promptyMicOk ? "ok" : "fail";
      }
      sendResponse(result);
    } else if (msg.kind === "stop-capture") {
      await stopCapture();
      sendResponse({ ok: true });
    } else if (msg.kind === "check-mic-permission") {
      try {
        if (navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: "microphone" });
          sendResponse({ state: status.state }); // "granted" | "denied" | "prompt"
        } else {
          sendResponse({ state: "unknown" });
        }
      } catch (e) {
        sendResponse({ state: "unknown", error: String(e) });
      }
    } else if (msg.kind === "request-mic-permission") {
      // Force the Chrome prompt via a fresh getUserMedia. We immediately stop
      // the resulting stream — this call exists solely to surface the prompt
      // and learn the user's choice.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((t) => t.stop());
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, name: e?.name ?? null, message: String(e?.message ?? e) });
      }
    }
  })();
  return true;
});

async function startCapture(streamId) {
  if (audioCtx) await stopCapture();

  audioCtx = new AudioContext({ sampleRate: TARGET_SR });
  window.__promptyTabOk = false;
  window.__promptyMicOk = false;

  // Tab audio — independent try so a mic failure doesn't kill tab capture.
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    // CRITICAL: pipe tab audio back to speakers so the user can still hear the
    // call. Without this, getUserMedia({chromeMediaSource: tab}) mutes the tab.
    const tabSourceForOutput = audioCtx.createMediaStreamSource(tabStream);
    tabSourceForOutput.connect(audioCtx.destination);
    tabProcessor = makeProcessor(tabStream, "them");
    window.__promptyTabOk = true;
    log("tab capture started");
  } catch (e) {
    log("tab capture FAILED:", e?.message ?? e);
    reportError("tab", e);
  }

  // Mic audio — independent try.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      video: false,
    });
    micProcessor = makeProcessor(micStream, "me");
    window.__promptyMicOk = true;
    log("mic capture started");
  } catch (e) {
    log("mic capture FAILED:", e?.message ?? e);
    reportError("mic", e);
  }

  if (!window.__promptyTabOk && !window.__promptyMicOk) {
    throw new Error("both tab and mic capture failed");
  }
}

function reportError(source, e) {
  try {
    chrome.runtime.sendMessage({
      target: "background-audio-error",
      source,
      message: String(e?.message ?? e),
      name: e?.name ?? null,
    });
  } catch {}
}

function makeProcessor(stream, source) {
  const node = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but works reliably in offscreen docs and
  // gives us simple synchronous access to PCM. Upgrade to AudioWorklet later.
  const bufferSize = nextPow2(Math.round((CHUNK_MS / 1000) * TARGET_SR));
  const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatToPcm16(input);
    // CRITICAL: convert to base64 here. chrome.runtime.sendMessage between
    // offscreen and SW uses JSON-style serialization — raw ArrayBuffers do
    // NOT survive (they arrive as empty objects). Base64-string is JSON-safe.
    const b64 = arrayBufferToBase64(pcm16.buffer);
    chrome.runtime.sendMessage({
      target: "background-audio",
      source,
      pcm16: b64,
      sampleRate: TARGET_SR,
    });
  };
  node.connect(processor);
  // Connect processor to a muted gain so it actually runs (it must be in the
  // active graph). We don't want to play mic back to speakers.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(audioCtx.destination);
  return { node, processor, sink };
}

async function stopCapture() {
  try {
    micProcessor?.processor.disconnect();
    tabProcessor?.processor.disconnect();
    micStream?.getTracks().forEach((t) => t.stop());
    tabStream?.getTracks().forEach((t) => t.stop());
    await audioCtx?.close();
  } catch (e) {
    log("stopCapture error", e);
  }
  micStream = null;
  tabStream = null;
  micProcessor = null;
  tabProcessor = null;
  audioCtx = null;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function nextPow2(n) {
  let p = 256;
  while (p < n) p <<= 1;
  return Math.min(p, 16384);
}
