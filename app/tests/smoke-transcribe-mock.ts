import { PassThrough } from "node:stream";
import { startTranscription } from "../src/main-process/deepgram";
import type { TranscriptUtterance } from "../src/main-process/types";

/**
 * Mock-mode smoke for the dual-stream Deepgram client. Verifies that:
 *  - `startTranscription` accepts two PCM Readable streams (mic + tap)
 *  - the merge emits utterances tagged with both "me" and "them"
 *  - cleanup via `handle.close()` flushes finals
 *
 * No Deepgram key is required — PROMPTY_MOCK_DEEPGRAM=1 swaps in the fake
 * Deepgram stream defined in deepgram.ts.
 */

process.env.PROMPTY_MOCK_DEEPGRAM = "1";

async function main() {
  const utterances: TranscriptUtterance[] = [];
  const errors: Error[] = [];

  const micStream = new PassThrough();
  const tapStream = new PassThrough();

  const handle = startTranscription({
    micStream,
    tapStream,
    deepgramKey: "mock",
    onUtterance: (u) => {
      utterances.push(u);
      console.log(`[smoke] [${u.speaker}] ${u.text}`);
    },
    onError: (e) => {
      errors.push(e);
      console.log(`[smoke] ERROR: ${e.message}`);
    },
  });

  // 1.5s of "audio" on each stream — paced as ~100ms chunks of 16kHz mono PCM16.
  const CHUNK_MS = 100;
  const bytesPerChunk = CHUNK_MS * 32;
  const chunk = Buffer.alloc(bytesPerChunk);

  for (let i = 0; i < 15; i++) {
    micStream.write(Buffer.from(chunk));
    tapStream.write(Buffer.from(chunk));
    await sleep(CHUNK_MS);
  }

  // Let mock stream flush its 500ms-interval emits.
  await sleep(900);
  await handle.close();

  const meFinals = utterances.filter((u) => u.speaker === "me" && u.isFinal);
  const themFinals = utterances.filter((u) => u.speaker === "them" && u.isFinal);

  console.log(`\n[smoke] me finals: ${meFinals.length}, them finals: ${themFinals.length}, errors: ${errors.length}`);

  const pass = errors.length === 0 && meFinals.length > 0 && themFinals.length > 0;
  console.log(`[smoke] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
