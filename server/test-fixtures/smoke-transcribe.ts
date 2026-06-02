import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDeepgramStream } from "../transcribe.ts";
import { loadSecrets } from "../secrets.ts";
import type { TranscriptUtterance } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Smoke test for the Deepgram dual-stream client.
 *
 * Reads ./them.wav and ./me.wav, streams them through two separate Deepgram
 * sockets in real time (paced as if they were live audio), and prints the
 * speaker-tagged transcript as it arrives. Measures the audio-end → last-final
 * latency.
 *
 * If no .wav files are present, generates a 1.5s silence + tone fixture so the
 * mock path can still exercise the plumbing.
 *
 * Modes:
 *   PROMPTY_MOCK_DEEPGRAM=1 — use fake Deepgram (no key needed).
 *   DEEPGRAM_API_KEY=...    — use real Deepgram.
 */
async function main() {
  const useMock = process.env.PROMPTY_MOCK_DEEPGRAM === "1";
  const secrets = loadSecrets();
  if (!useMock && !secrets.deepgramApiKey) {
    console.error(
      "Set DEEPGRAM_API_KEY (or PROMPTY_MOCK_DEEPGRAM=1) and re-run.",
    );
    process.exit(1);
  }

  const themPath = join(HERE, "them.wav");
  const mePath = join(HERE, "me.wav");
  if (useMock) {
    ensureSineFixture(themPath, 0.4);
    ensureSineFixture(mePath, 0.7);
  } else {
    // Real Deepgram run — synthesize speech via macOS `say` so we have real
    // words to transcribe. Skipped if either file already exists (user may
    // have dropped real recordings in).
    ensureSpeechFixture(
      themPath,
      "The migration to Kafka took us about eight months end to end.",
      "Daniel",
    );
    ensureSpeechFixture(
      mePath,
      "Oh nice, that's faster than I expected actually.",
      "Samantha",
    );
  }

  const themPcm = wavToPcm16Mono16k(readFileSync(themPath));
  const mePcm = wavToPcm16Mono16k(readFileSync(mePath));

  const utterances: { recvAt: number; u: TranscriptUtterance }[] = [];
  const errors: Error[] = [];

  const them = openDeepgramStream("them", secrets.deepgramApiKey ?? "mock", {
    onUtterance: (u) => utterances.push({ recvAt: Date.now(), u }),
    onError: (e) => errors.push(e),
  });
  const me = openDeepgramStream("me", secrets.deepgramApiKey ?? "mock", {
    onUtterance: (u) => utterances.push({ recvAt: Date.now(), u }),
    onError: (e) => errors.push(e),
  });

  console.log(
    `[smoke] streaming ${themPcm.byteLength}B them + ${mePcm.byteLength}B me ` +
      `(mock=${useMock})`,
  );

  // Pace both streams at real time, ~100ms chunks.
  const CHUNK_MS = 100;
  const audioEndAt = await Promise.all([
    paceAudio(themPcm, CHUNK_MS, (chunk) => them.sendAudio(chunk)),
    paceAudio(mePcm, CHUNK_MS, (chunk) => me.sendAudio(chunk)),
  ]).then(() => Date.now());

  // Wait briefly for the final transcripts to land, then close.
  await new Promise((r) => setTimeout(r, useMock ? 800 : 1500));
  await them.close();
  await me.close();

  // Report.
  const lastFinalAt = utterances
    .filter((x) => x.u.isFinal)
    .reduce((acc, x) => Math.max(acc, x.recvAt), 0);
  const latency = lastFinalAt ? lastFinalAt - audioEndAt : -1;

  console.log("\n[smoke] transcript:");
  for (const { u } of utterances) {
    const marker = u.isFinal ? "F" : " ";
    console.log(`  [${u.speaker}][${marker}] ${u.text}`);
  }
  console.log(`\n[smoke] errors: ${errors.length}`);
  for (const e of errors) console.log("  ", e.message);
  // Latency reported but not gated. Measured from "last chunk sent" to "final
  // transcript received" — in synthetic tests with no trailing silence,
  // Deepgram's endpointing window dominates this number. In a real call,
  // finals arrive ~300-500ms after a speaker pauses.
  console.log(`[smoke] audio-end → last-final latency: ${latency}ms (informational)`);

  // What we actually verify: connection works, both streams flow, both
  // produce final transcripts.
  const hasThemFinal = utterances.some((x) => x.u.speaker === "them" && x.u.isFinal);
  const hasMeFinal = utterances.some((x) => x.u.speaker === "me" && x.u.isFinal);
  const pass = errors.length === 0 && hasThemFinal && hasMeFinal;

  console.log(`[smoke] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

async function paceAudio(
  pcm: ArrayBuffer,
  chunkMs: number,
  send: (chunk: ArrayBuffer) => void,
) {
  // 16kHz * 2 bytes/sample = 32 bytes/ms
  const bytesPerChunk = chunkMs * 32;
  const view = Buffer.from(pcm);
  for (let off = 0; off < view.byteLength; off += bytesPerChunk) {
    const end = Math.min(off + bytesPerChunk, view.byteLength);
    const slice = view.subarray(off, end);
    send(
      slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    );
    await new Promise((r) => setTimeout(r, chunkMs));
  }
}

/** Generate a synthetic 1.5s 16kHz mono PCM16 WAV with a sine tone. */
function ensureSineFixture(path: string, toneFreq: number) {
  if (existsSync(path)) return;
  const sampleRate = 16000;
  const durationS = 1.5;
  const numSamples = Math.floor(sampleRate * durationS);
  const data = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * (toneFreq * 1000) * t);
    data.writeInt16LE(Math.round(v * 0.3 * 0x7fff), i * 2);
  }
  writeFileSync(path, buildWav(data, sampleRate));
}

/**
 * Generate a speech fixture via macOS `say`, converted to 16kHz mono PCM16
 * WAV via `afconvert`. macOS-only — harmless to skip on other platforms.
 */
function ensureSpeechFixture(path: string, text: string, voice: string) {
  if (existsSync(path)) return;
  const aiff = path.replace(/\.wav$/, ".aiff");
  try {
    execFileSync("say", ["-v", voice, "-o", aiff, text], { stdio: "ignore" });
    execFileSync(
      "afconvert",
      ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, path],
      { stdio: "ignore" },
    );
    // Clean up the intermediate aiff.
    try {
      execFileSync("rm", ["-f", aiff], { stdio: "ignore" });
    } catch {}
  } catch (e) {
    console.warn(`[smoke] couldn't synthesize speech (${voice}):`, (e as Error).message);
    console.warn("[smoke] falling back to sine tone. Drop a real .wav at", path);
    ensureSineFixture(path, voice === "Daniel" ? 0.4 : 0.7);
  }
}

function buildWav(pcmData: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function wavToPcm16Mono16k(wav: Buffer): ArrayBuffer {
  // Minimal WAV parser — assumes our fixtures are already 16kHz mono PCM16.
  // For arbitrary WAVs we'd want a real decoder; out of scope for the smoke.
  if (wav.subarray(0, 4).toString() !== "RIFF") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  while (off < wav.length - 8) {
    const id = wav.subarray(off, off + 4).toString();
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      const data = wav.subarray(off + 8, off + 8 + size);
      const out = new ArrayBuffer(data.byteLength);
      new Uint8Array(out).set(data);
      return out;
    }
    off += 8 + size;
  }
  throw new Error("no data chunk found in WAV");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
