// Block E1: Spawn the Swift AudioSidecar binary, demux its stdout frames
// (length-prefixed; tag byte distinguishes control JSON, mic PCM, tap PCM)
// into two Readable streams + a control EventEmitter.
//
// Wire protocol (see audio-sidecar/Sources/AudioSidecarCore/Protocol.swift):
//   [1B tag][4B BE uint32 payload length][N bytes payload]
//   tag 0x01 = control JSON, 0x02 = mic PCM, 0x03 = tap PCM
//
// Auto-restarts on unexpected exit, up to 3 attempts.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, PassThrough } from "node:stream";
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

const FRAME_TAG_CONTROL = 0x01;
const FRAME_TAG_MIC = 0x02;
const FRAME_TAG_TAP = 0x03;

export interface SidecarOptions {
  /** Bundle ID to target for the system-audio tap, e.g. "us.zoom.xos". */
  targetBundle?: string;
  /** PID to target for the system-audio tap. Mutually exclusive with targetBundle. */
  targetPid?: number;
}

export interface SidecarHandle {
  micStream: Readable;
  tapStream: Readable;
  controlEvents: EventEmitter;
  kill(): void;
}

export interface SidecarControlEvent {
  type: "ready" | "screen_share_started" | "screen_share_stopped" | "error" | string;
  msg?: string;
  [k: string]: unknown;
}

/** Resolve the path to the bundled AudioSidecar binary. */
export function resolveSidecarBinary(): string {
  // In packaged builds, the sidecar is shipped under resources/.
  // Cast to any because process.resourcesPath isn't typed in renderer/main shared.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (app.isPackaged && resourcesPath) {
    const p = path.join(resourcesPath, "audio-sidecar");
    if (fs.existsSync(p)) return p;
  }
  // Dev: look at the SwiftPM build output relative to the repo root.
  const devCandidates = [
    path.resolve(__dirname, "../../../../audio-sidecar/.build/release/AudioSidecar"),
    path.resolve(process.cwd(), "../audio-sidecar/.build/release/AudioSidecar"),
    path.resolve(process.cwd(), "audio-sidecar/.build/release/AudioSidecar"),
  ];
  for (const p of devCandidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fall back to first candidate; spawn will fail loudly with a useful path.
  return devCandidates[0]!;
}

/**
 * Spawn the AudioSidecar process and demux its stdout. Returns streams that
 * emit raw 16-bit LE PCM for mic and tap channels, plus a control event
 * emitter for JSON frames.
 *
 * The returned `micStream` / `tapStream` are PassThroughs the caller can pipe
 * into the Deepgram client. Calling `kill()` ends both streams cleanly.
 */
export function spawnSidecar(opts: SidecarOptions = {}): SidecarHandle {
  const binary = resolveSidecarBinary();
  const controlEvents = new EventEmitter();
  const micStream = new PassThrough();
  const tapStream = new PassThrough();

  let attempts = 0;
  let killed = false;
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  const buildArgs = (): string[] => {
    const args: string[] = [];
    if (opts.targetPid != null) {
      args.push("--target-pid", String(opts.targetPid));
    } else if (opts.targetBundle) {
      args.push("--target-bundle", opts.targetBundle);
    }
    return args;
  };

  const start = () => {
    if (killed) return;
    attempts++;
    console.log(
      `[sidecar] spawning ${binary} (attempt ${attempts}) args=${JSON.stringify(buildArgs())}`,
    );

    let proc: ChildProcess;
    try {
      proc = spawn(binary, buildArgs(), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      controlEvents.emit("control", {
        type: "error",
        msg: `sidecar spawn failed: ${(e as Error).message}`,
      } satisfies SidecarControlEvent);
      return;
    }
    child = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) console.log(`[sidecar][stderr] ${line}`);
      }
    });

    // Frame demux state.
    let buffer: Buffer = Buffer.alloc(0);
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const tag = buffer[0]!;
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break;
        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);
        switch (tag) {
          case FRAME_TAG_CONTROL: {
            try {
              const obj = JSON.parse(payload.toString("utf8")) as SidecarControlEvent;
              controlEvents.emit("control", obj);
              if (typeof obj.type === "string") {
                controlEvents.emit(obj.type, obj);
              }
            } catch (e) {
              console.error(
                `[sidecar] bad control JSON: ${(e as Error).message}`,
              );
            }
            break;
          }
          case FRAME_TAG_MIC:
            // Copy to detach from the growing buffer.
            micStream.write(Buffer.from(payload));
            break;
          case FRAME_TAG_TAP:
            tapStream.write(Buffer.from(payload));
            break;
          default:
            console.warn(`[sidecar] unknown frame tag 0x${tag.toString(16)}`);
        }
      }
    });

    proc.on("exit", (code, signal) => {
      console.log(
        `[sidecar] exit code=${code} signal=${signal} killed=${killed} attempts=${attempts}`,
      );
      child = null;
      if (killed) {
        micStream.end();
        tapStream.end();
        return;
      }
      if (attempts >= 3) {
        controlEvents.emit("control", {
          type: "error",
          msg: `sidecar exited ${attempts} times; giving up`,
        } satisfies SidecarControlEvent);
        micStream.end();
        tapStream.end();
        return;
      }
      const backoffMs = 500 * attempts;
      console.log(`[sidecar] restarting in ${backoffMs}ms`);
      restartTimer = setTimeout(start, backoffMs);
    });

    proc.on("error", (e) => {
      console.error(`[sidecar] process error: ${e.message}`);
    });
  };

  start();

  return {
    micStream,
    tapStream,
    controlEvents,
    kill() {
      if (killed) return;
      killed = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (!child) {
        micStream.end();
        tapStream.end();
        return;
      }
      const proc = child;
      try {
        proc.kill("SIGTERM");
      } catch {}
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        micStream.end();
        tapStream.end();
      });
    },
  };
}
