import { describe, it, expect } from "vitest";
import os from "node:os";
import { scrubProps, scrubEvent, redactString } from "../../electron/scrub";

// scrubEvent is what's registered as the PostHog client `before_send` — the
// guaranteed content-scrub backstop that runs on the NETWORK path (where the
// E2E ring buffer never runs). These unit tests exercise it directly, including
// against a posthog-node-shaped `$exception` event, so the privacy backstop is
// proven, not just inspected.

const HOME = os.homedir();

describe("redactString", () => {
  it("redacts the home dir to ~", () => {
    expect(redactString(`${HOME}/Secret/notes.txt`)).toBe("~/Secret/notes.txt");
  });
  it("redacts token-like runs (>=40 chars)", () => {
    const token = "A1b2C3d4".repeat(6); // 48 chars
    expect(redactString(`bearer ${token} end`)).toBe("bearer [redacted] end");
  });
  it("leaves ordinary prose untouched", () => {
    expect(redactString("agent error: max_turns")).toBe("agent error: max_turns");
  });
});

describe("scrubProps", () => {
  it("redacts paths, drops long free-text, keeps short metadata + numbers", () => {
    const out = scrubProps({
      homePath: `${HOME}/a/b.txt`,
      transcript: "x".repeat(500), // content → dropped on original length
      reason: "cancelled", // short → kept
      count: 7,
      ok: true,
    });
    expect(out.homePath).toBe("~/a/b.txt");
    expect(out).not.toHaveProperty("transcript");
    expect(out.reason).toBe("cancelled");
    expect(out.count).toBe(7);
    expect(out.ok).toBe(true);
  });

  it("drops functions/undefined and recurses into nested objects + arrays", () => {
    const out = scrubProps({
      nested: { path: `${HOME}/x`, blob: "y".repeat(300) },
      list: [`${HOME}/z`, "short"],
      fn: () => 1,
    });
    expect(out.nested).toEqual({ path: "~/x" }); // blob dropped
    expect(out.list).toEqual(["~/z", "short"]);
    expect(out).not.toHaveProperty("fn");
  });
});

describe("scrubEvent (before_send backstop)", () => {
  it("passes null through", () => {
    expect(scrubEvent(null)).toBeNull();
  });

  it("scrubs a named event's properties in place", () => {
    const event = { event: "prep_started", properties: { note: `${HOME}/n`, big: "z".repeat(400) } };
    const out = scrubEvent(event);
    expect(out).toBe(event); // same ref (before_send returns the event)
    expect(out!.properties.note).toBe("~/n");
    expect(out!.properties).not.toHaveProperty("big");
  });

  it("redacts an autocaptured $exception stack + message but does NOT length-drop them (code context)", () => {
    // Shape mirrors what posthog-node builds for captureException(): the message
    // and stack frames live under $exception_list. A user-content property
    // riding alongside must still be dropped.
    // >200 chars, but prose (spaces) so token-redaction doesn't collapse it —
    // proves a long CODE-context string is kept, not length-dropped.
    const longButCode = `Error at ${HOME}/app/foo.ts: ` + "blah ".repeat(80);
    const event = {
      event: "$exception",
      properties: {
        $exception_list: [
          {
            type: "Error",
            value: `boom reading ${HOME}/Secret/call.wav`,
            stacktrace: {
              frames: [
                { filename: `${HOME}/app/dist/electron/agent.js`, function: "run", lineno: 42 },
                { filename: `${HOME}/app/dist/electron/ipc.js`, function: "onError", lineno: 7 },
              ],
            },
          },
        ],
        $exception_message: longButCode,
        component: "agent",
        transcript: "the user literally said ...".padEnd(400, "."), // content → dropped
      },
    };
    const out = scrubEvent(event)!;
    const exc = (out.properties.$exception_list as Array<Record<string, unknown>>)[0];
    // message value: home path redacted, but the (long) message is KEPT (code).
    expect(exc.value).toBe("boom reading ~/Secret/call.wav");
    const frames = (exc.stacktrace as { frames: Array<Record<string, unknown>> }).frames;
    expect(frames[0].filename).toBe("~/app/dist/electron/agent.js");
    expect(frames[1].filename).toBe("~/app/dist/electron/ipc.js");
    expect(frames[0].lineno).toBe(42); // numbers preserved
    // long code-context message kept (not dropped), home path redacted
    expect(out.properties.$exception_message).toBe(`Error at ~/app/foo.ts: ` + "blah ".repeat(80));
    // content riding alongside is dropped
    expect(out.properties).not.toHaveProperty("transcript");
    expect(out.properties.component).toBe("agent");
  });
});
