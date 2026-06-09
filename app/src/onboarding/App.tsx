import React, { useEffect, useMemo, useState } from "react";
import type {
  MacOsVersion,
  MediaPermissionStatus,
  PermissionStatus,
} from "../shared/types";

type StepKey =
  | "welcome"
  | "claude"
  | "mic"
  | "auth"
  | "notifications"
  | "screen"
  | "done";

interface StepDef {
  key: StepKey;
  title: string;
}

const baseSteps: StepDef[] = [
  { key: "welcome", title: "Welcome" },
  { key: "claude", title: "Claude Code" },
  { key: "mic", title: "Microphone" },
  { key: "auth", title: "Sign in" },
  { key: "notifications", title: "Notifications" },
  { key: "screen", title: "Screen Recording" },
  { key: "done", title: "Done" },
];

const styles = {
  app: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    background: "#f5f5f7",
    color: "#1d1d1f",
    height: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  body: {
    flex: 1,
    padding: "32px 48px 16px",
    overflowY: "auto" as const,
  },
  h1: { fontSize: 22, margin: "0 0 8px" },
  p: { color: "#3a3a3c", lineHeight: 1.5, fontSize: 14, margin: "8px 0" },
  muted: { color: "#86868b", fontSize: 12 },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 24px",
    borderTop: "1px solid #d2d2d7",
    background: "#fff",
  },
  dots: { display: "flex", gap: 6 },
  dot: (active: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: 4,
    background: active ? "#1d1d1f" : "#d2d2d7",
  }),
  btn: (variant: "primary" | "ghost" = "primary", disabled = false) => ({
    appearance: "none" as const,
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    background:
      variant === "primary" ? (disabled ? "#a1a1a6" : "#1d1d1f") : "transparent",
    color: variant === "primary" ? "#fff" : "#1d1d1f",
    opacity: disabled ? 0.7 : 1,
  }),
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: 20,
    border: "1px solid #e5e5ea",
    marginTop: 16,
  },
  row: { display: "flex", alignItems: "center", gap: 10 },
  hero: {
    background: "linear-gradient(135deg, #d1d1f5, #f5d1e5)",
    borderRadius: 12,
    height: 160,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#3a3a3c",
    fontSize: 13,
    marginTop: 12,
  },
};

function Check({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        background: ok ? "#34c759" : "#ff3b30",
        color: "white",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {ok ? "✓" : "×"}
    </span>
  );
}

export default function App(): JSX.Element {
  const [stepIdx, setStepIdx] = useState(0);
  const [macOs, setMacOs] = useState<MacOsVersion | null>(null);
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const [perm, setPerm] = useState<PermissionStatus | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [signedInUser, setSignedInUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [notifFired, setNotifFired] = useState(false);
  const [micBusy, setMicBusy] = useState(false);

  // Initial probes + listen to auth state changes.
  useEffect(() => {
    void (async () => {
      const [v, c, p, auth] = await Promise.all([
        window.prompty.invoke("onboarding:macos-version", undefined as never),
        window.prompty.invoke("onboarding:check-claude", undefined as never),
        window.prompty.invoke("onboarding:permission-status", undefined as never),
        window.prompty.invoke("auth:status", undefined as never),
      ]);
      setMacOs(v);
      setClaude(c);
      setPerm(p);
      setSignedIn(auth.signedIn);
      setSignedInUser(auth.userId ?? null);
    })();
    const off = window.prompty.on("auth:state-changed", (payload) => {
      setSignedIn(payload.signedIn);
      setSignedInUser(payload.userId ?? null);
    });
    // Re-poll permission status when window regains focus (user may have
    // toggled toggles in System Settings).
    const onFocus = () => {
      void window.prompty
        .invoke("onboarding:permission-status", undefined as never)
        .then(setPerm);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const steps = useMemo<StepDef[]>(() => {
    return baseSteps.filter((s) => {
      if (s.key === "screen") return macOs?.needsScreenRecording === true;
      return true;
    });
  }, [macOs]);

  const step = steps[stepIdx]?.key ?? "welcome";

  const micGranted: boolean =
    perm?.microphone === "granted" || perm?.microphone === undefined
      ? perm?.microphone === "granted"
      : false;

  function canAdvance(): boolean {
    switch (step) {
      case "welcome":
        return true;
      case "claude":
        return !!claude?.found;
      case "mic":
        return micGranted;
      case "auth":
        return signedIn;
      case "notifications":
        return notifFired;
      case "screen":
        return true; // explainer only, advance freely
      case "done":
        return true;
    }
  }

  function next(): void {
    if (stepIdx < steps.length - 1) setStepIdx(stepIdx + 1);
  }
  function back(): void {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  }

  async function recheckClaude(): Promise<void> {
    const c = await window.prompty.invoke("onboarding:check-claude", undefined as never);
    setClaude(c);
  }

  async function requestMic(): Promise<void> {
    setMicBusy(true);
    try {
      await window.prompty.invoke("onboarding:request-mic", undefined as never);
      const p = await window.prompty.invoke("onboarding:permission-status", undefined as never);
      setPerm(p);
    } finally {
      setMicBusy(false);
    }
  }

  async function signIn(): Promise<void> {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const r = await window.prompty.invoke("auth:google-sign-in", undefined as never);
      if (!r.ok) setAuthError(r.error ?? "sign-in failed");
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function fireNotification(): Promise<void> {
    const r = await window.prompty.invoke("onboarding:fire-notification", undefined as never);
    if (r.ok) setNotifFired(true);
  }

  async function finish(): Promise<void> {
    await window.prompty.invoke("onboarding:complete", undefined as never);
  }

  function openExternal(url: string): void {
    void window.prompty.invoke("onboarding:open-external", { url });
  }

  return (
    <div style={styles.app}>
      <div style={styles.body}>
        {step === "welcome" && (
          <>
            <h1 style={styles.h1}>Welcome to Prompty</h1>
            <p style={styles.p}>
              Prompty is a real-time call coach for macOS. It listens to your
              meetings, tracks your goals and checklist, and surfaces quiet
              nudges in a floating panel — across Zoom, Meet, FaceTime, Slack,
              and more.
            </p>
            <div style={styles.hero}>[screenshot placeholder]</div>
            <p style={styles.muted}>
              We'll walk through a few one-time setup steps.
            </p>
          </>
        )}

        {step === "claude" && (
          <>
            <h1 style={styles.h1}>Claude Code</h1>
            <p style={styles.p}>
              Prompty runs its reasoning through your local Claude Code
              installation. We never send your transcripts to a third-party
              model server.
            </p>
            <div style={styles.card}>
              <div style={styles.row}>
                <Check ok={!!claude?.found} />
                <div>
                  {claude?.found ? (
                    <>
                      <div style={{ fontWeight: 500 }}>Claude Code found</div>
                      <div style={styles.muted}>{claude.path}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 500 }}>Claude Code not found</div>
                      <div style={styles.muted}>
                        Install Claude Code, then click Re-check.
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                {!claude?.found && (
                  <button
                    style={styles.btn("primary")}
                    onClick={() => openExternal("https://claude.ai/code")}
                  >
                    Install Claude Code
                  </button>
                )}
                <button style={styles.btn("ghost")} onClick={recheckClaude}>
                  Re-check
                </button>
              </div>
            </div>
          </>
        )}

        {step === "mic" && (
          <>
            <h1 style={styles.h1}>Microphone access</h1>
            <p style={styles.p}>
              Prompty captures your microphone to transcribe your side of the
              call. Audio stays on your machine; only the transcript is sent
              upstream.
            </p>
            <div style={styles.card}>
              <div style={styles.row}>
                <Check ok={micGranted} />
                <div style={{ fontWeight: 500 }}>
                  {perm?.microphone === "granted"
                    ? "Microphone access granted"
                    : perm?.microphone === "denied"
                      ? "Microphone access denied — enable in System Settings"
                      : "Microphone access pending"}
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  style={styles.btn("primary", micBusy || micGranted)}
                  disabled={micBusy || micGranted}
                  onClick={requestMic}
                >
                  {micGranted ? "Granted" : "Grant microphone access"}
                </button>
                {perm?.microphone === "denied" && (
                  <button
                    style={styles.btn("ghost")}
                    onClick={() =>
                      openExternal(
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                      )
                    }
                  >
                    Open System Settings
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {step === "auth" && (
          <>
            <h1 style={styles.h1}>Sign in with Google</h1>
            <p style={styles.p}>
              Sign in with Google to enable live transcription and let Prompty
              read your upcoming calendar events. Only your email + calendar
              read scope are requested.
            </p>
            <div style={styles.card}>
              <div style={styles.row}>
                <Check ok={signedIn} />
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {signedIn ? "Signed in" : "Not signed in"}
                  </div>
                  {signedInUser && (
                    <div style={styles.muted}>{signedInUser}</div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  style={styles.btn("primary", authBusy || signedIn)}
                  disabled={authBusy || signedIn}
                  onClick={signIn}
                >
                  {signedIn
                    ? "Signed in"
                    : authBusy
                      ? "Signing in…"
                      : "Sign in with Google"}
                </button>
              </div>
              {authError && (
                <p style={{ ...styles.muted, color: "#ff3b30" }}>{authError}</p>
              )}
            </div>
          </>
        )}

        {step === "notifications" && (
          <>
            <h1 style={styles.h1}>Notifications</h1>
            <p style={styles.p}>
              Prompty uses notifications for call-ready toasts ("Ready for X")
              and post-call summaries. The first notification will ask macOS
              for permission.
            </p>
            <div style={styles.card}>
              <div style={styles.row}>
                <Check ok={notifFired} />
                <div style={{ fontWeight: 500 }}>
                  {notifFired
                    ? "Notification sent — approve it in the macOS prompt if asked"
                    : "Send a test notification to enable them"}
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <button
                  style={styles.btn("primary", notifFired)}
                  disabled={notifFired}
                  onClick={fireNotification}
                >
                  {notifFired ? "Sent" : "Enable notifications"}
                </button>
              </div>
            </div>
          </>
        )}

        {step === "screen" && (
          <>
            <h1 style={styles.h1}>Screen Recording permission</h1>
            <p style={styles.p}>
              You're on macOS {macOs?.major}.{macOs?.minor}. Prompty needs
              Screen Recording permission to capture the other person's audio.
              We never read pixels or take screenshots — only audio frames flow
              through.
            </p>
            <p style={styles.p}>
              On macOS 14.4+ this isn't needed; we use a CoreAudio tap instead.
            </p>
            <div style={styles.card}>
              <button
                style={styles.btn("primary")}
                onClick={() =>
                  openExternal(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                  )
                }
              >
                Open System Settings
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1 style={styles.h1}>You're all set</h1>
            <p style={styles.p}>
              Prompty lives in your menu bar. The floating panel will appear
              when a call starts — or you can open it from the tray icon any
              time.
            </p>
            <p style={styles.muted}>
              Press <kbd>Alt+Shift+Space</kbd> during a call to summon a nudge
              on demand.
            </p>
          </>
        )}
      </div>

      <div style={styles.footer}>
        <button
          style={styles.btn("ghost", stepIdx === 0)}
          disabled={stepIdx === 0}
          onClick={back}
        >
          Back
        </button>
        <div style={styles.dots}>
          {steps.map((s, i) => (
            <div key={s.key} style={styles.dot(i === stepIdx)} />
          ))}
        </div>
        {step === "done" ? (
          <button style={styles.btn("primary")} onClick={finish}>
            Open Prompty
          </button>
        ) : (
          <button
            style={styles.btn("primary", !canAdvance())}
            disabled={!canAdvance()}
            onClick={next}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
