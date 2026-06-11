import React, { useEffect, useState } from "react";
import type {
  MediaPermissionStatus,
  PermissionStatus,
} from "../shared/types";

type StepKey =
  | "welcome"
  | "claude"
  | "mic"
  | "auth"
  | "notifications"
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
  { key: "done", title: "Done" },
];

function Check({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span className={`ob-check ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "×"}</span>
  );
}

export default function App(): JSX.Element {
  const [stepIdx, setStepIdx] = useState(0);
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const [perm, setPerm] = useState<PermissionStatus | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [signedInUser, setSignedInUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [notifFired, setNotifFired] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false);

  // Initial probes + listen to auth state changes.
  useEffect(() => {
    void (async () => {
      const [c, p, auth] = await Promise.all([
        window.prompty.invoke("onboarding:check-claude", undefined as never),
        window.prompty.invoke("onboarding:permission-status", undefined as never),
        window.prompty.invoke("auth:status", undefined as never),
      ]);
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

  const steps = baseSteps;

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
    setClaudeBusy(true);
    try {
      const c = await window.prompty.invoke("onboarding:check-claude", undefined as never);
      setClaude(c);
    } finally {
      setClaudeBusy(false);
    }
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
    <div className="ob-app">
      <div className="ob-titlebar" />
      <div className="ob-body">
        {step === "welcome" && (
          <>
            <h1 className="ob-h1">Welcome to Prompty</h1>
            <p className="ob-p">
              Prompty is a real-time call coach for macOS. It listens to your
              meetings, tracks your goals and checklist, and surfaces quiet
              nudges in a floating panel — across Zoom, Meet, FaceTime, Slack,
              and more.
            </p>
            <div className="ob-hero">[screenshot placeholder]</div>
            <p className="ob-muted">
              We'll walk through a few one-time setup steps.
            </p>
          </>
        )}

        {step === "claude" && (
          <>
            <h1 className="ob-h1">Claude Code</h1>
            <p className="ob-p">
              Prompty runs its reasoning through your local Claude Code
              installation. We never send your transcripts to a third-party
              model server.
            </p>
            <div className="ob-card">
              <div className="ob-row">
                <Check ok={!!claude?.found} />
                <div>
                  {claude?.found ? (
                    <>
                      <div className="ob-strong">Claude Code found</div>
                      <div className="ob-muted">{claude.path}</div>
                    </>
                  ) : (
                    <>
                      <div className="ob-strong">Claude Code not found</div>
                      <div className="ob-muted">
                        Install Claude Code, then click Re-check.
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="ob-actions">
                {!claude?.found && (
                  <button
                    className="ob-btn ob-btn-primary"
                    onClick={() => openExternal("https://claude.ai/code")}
                  >
                    Install Claude Code
                  </button>
                )}
                <button
                  className="ob-btn ob-btn-ghost"
                  onClick={recheckClaude}
                  disabled={claudeBusy}
                >
                  {claudeBusy ? "Checking…" : "Re-check"}
                </button>
              </div>
            </div>
          </>
        )}

        {step === "mic" && (
          <>
            <h1 className="ob-h1">Microphone access</h1>
            <p className="ob-p">
              Prompty captures your microphone to transcribe your side of the
              call. Audio stays on your machine; only the transcript is sent
              upstream.
            </p>
            <div className="ob-card">
              <div className="ob-row">
                <Check ok={micGranted} />
                <div className="ob-strong">
                  {perm?.microphone === "granted"
                    ? "Microphone access granted"
                    : perm?.microphone === "denied"
                      ? "Microphone access denied — enable in System Settings"
                      : "Microphone access pending"}
                </div>
              </div>
              <div className="ob-actions">
                <button
                  className="ob-btn ob-btn-primary"
                  disabled={micBusy || micGranted}
                  onClick={requestMic}
                >
                  {micGranted ? "Granted" : "Grant microphone access"}
                </button>
                {perm?.microphone === "denied" && (
                  <button
                    className="ob-btn ob-btn-ghost"
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
            <h1 className="ob-h1">Sign in with Google</h1>
            <p className="ob-p">
              Sign in with Google to enable live transcription and let Prompty
              read your upcoming calendar events. Only your email + calendar
              read scope are requested.
            </p>
            <div className="ob-card">
              <div className="ob-row">
                <Check ok={signedIn} />
                <div>
                  <div className="ob-strong">
                    {signedIn ? "Signed in" : "Not signed in"}
                  </div>
                  {signedInUser && (
                    <div className="ob-muted">{signedInUser}</div>
                  )}
                </div>
              </div>
              <div className="ob-actions">
                <button
                  className="ob-btn ob-btn-primary"
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
              {authError && <p className="ob-error">{authError}</p>}
            </div>
          </>
        )}

        {step === "notifications" && (
          <>
            <h1 className="ob-h1">Notifications</h1>
            <p className="ob-p">
              Prompty uses notifications for call-ready toasts ("Ready for X")
              and post-call summaries. The first notification will ask macOS
              for permission.
            </p>
            <div className="ob-card">
              <div className="ob-row">
                <Check ok={notifFired} />
                <div className="ob-strong">
                  {notifFired
                    ? "Notification sent — approve it in the macOS prompt if asked"
                    : "Send a test notification to enable them"}
                </div>
              </div>
              <div className="ob-actions">
                <button
                  className="ob-btn ob-btn-primary"
                  disabled={notifFired}
                  onClick={fireNotification}
                >
                  {notifFired ? "Sent" : "Enable notifications"}
                </button>
              </div>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1 className="ob-h1">You're all set</h1>
            <p className="ob-p">
              Prompty lives in your menu bar. The floating panel will appear
              when a call starts — or you can open it from the tray icon any
              time.
            </p>
            <p className="ob-muted">
              Press <kbd>Alt+Shift+Space</kbd> during a call to summon a nudge
              on demand.
            </p>
          </>
        )}
      </div>

      <div className="ob-footer">
        <button
          className="ob-btn ob-btn-ghost"
          disabled={stepIdx === 0}
          onClick={back}
        >
          Back
        </button>
        <div className="ob-dots">
          {steps.map((s, i) => (
            <div
              key={s.key}
              className={`ob-dot${i === stepIdx ? " active" : ""}`}
            />
          ))}
        </div>
        {step === "done" ? (
          <button className="ob-btn ob-btn-primary" onClick={finish}>
            Open Prompty
          </button>
        ) : (
          <button
            className="ob-btn ob-btn-primary"
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
