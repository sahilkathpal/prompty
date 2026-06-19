import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RubyLogo } from "../shared/RubyLogo";
import type { MediaPermissionStatus, PermissionStatus } from "../shared/types";

type StepKey = "welcome" | "claude" | "mic" | "hotkey" | "signin";
const STEPS: StepKey[] = ["welcome", "claude", "mic", "hotkey", "signin"];

// ─── Icons ────────────────────────────────────────────────────────────────────

function GemIcon({ size = 24, color = "white" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2L3 9L7 22H17L21 9L12 2Z" fill={color} opacity="0.92" />
      <path d="M12 2L3 9H21L12 2Z" fill={color} />
      <path d="M3 9L12 14L21 9" stroke="rgba(0,0,0,0.12)" strokeWidth="0.6" fill="none" />
    </svg>
  );
}

function TerminalIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 7L11 12L4 17" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 17H20" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="8.5" y="2" width="7" height="11" rx="3.5" fill="white" />
      <path d="M4.5 11.5C4.5 16.195 7.96 20 12 20C16.04 20 19.5 16.195 19.5 11.5" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="20" x2="12" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function KeyboardIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="6" width="20" height="12" rx="2.5" stroke="white" strokeWidth="1.8" />
      <circle cx="7" cy="10.5" r="1" fill="white" />
      <circle cx="12" cy="10.5" r="1" fill="white" />
      <circle cx="17" cy="10.5" r="1" fill="white" />
      <rect x="8.5" y="14" width="7" height="1.5" rx="0.75" fill="white" />
    </svg>
  );
}

function PersonIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke="#333" strokeWidth="1.8" />
      <path d="M4 22C4 17.582 7.582 14 12 14C16.418 14 20 17.582 20 22" stroke="#333" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.638-.057-1.252-.164-1.84H9v3.48h4.844a4.14 4.14 0 01-1.796 2.717v2.258h2.908C16.658 14.013 17.64 11.7 17.64 9.2z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.861-3.048.861-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A9 9 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A9 9 0 00.957 4.958l3.007 2.332C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="ob-progress">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`ob-seg${i < current ? " done" : i === current ? " active" : ""}`}
        />
      ))}
    </div>
  );
}

// ─── Step icon block ──────────────────────────────────────────────────────────

function StepIcon({
  bg,
  shadow,
  children,
}: {
  bg: string;
  shadow?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ob-step-icon" style={{ background: bg, boxShadow: shadow }}>
      {children}
    </div>
  );
}

// ─── Inline code chip ─────────────────────────────────────────────────────────

function Code({ children }: { children: React.ReactNode }) {
  return <code className="ob-code">{children}</code>;
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App(): JSX.Element {
  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx]!;

  const [stepVisible, setStepVisible] = useState(true);

  // Claude
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const [claudeBusy, setClaudeBusy] = useState(false);

  // Mic
  const [perm, setPerm] = useState<PermissionStatus | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  const micStatus: MediaPermissionStatus = perm?.microphone ?? "not-determined";
  const micGranted = micStatus === "granted";

  // Hotkey step
  const [hotkeyDone, setHotkeyDone] = useState(false);
  const [showHotkeyContinue, setShowHotkeyContinue] = useState(false);
  // True when the real global shortcut couldn't be registered (combo already
  // owned by another app) — the step falls back to a focused-window listener.
  const [hotkeyFallback, setHotkeyFallback] = useState(false);
  // The "Skip for now" safety valve fades in after a delay, so a user who
  // genuinely can't press the combo is never stuck.
  const [showHotkeySkip, setShowHotkeySkip] = useState(false);

  // Signin step
  const [signingIn, setSigningIn] = useState(false);

  // Ruby copy (dev reference — pill not yet implemented)
  const [bubbleText, setBubbleTextState] = useState("");
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const bubbleVisibleRef = useRef(false);
  const bubbleTextRef = useRef("");
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Bubble controller ─────────────────────────────────────────────────────

  function setBubble(text: string | null) {
    if (bubbleTimerRef.current) {
      clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = null;
    }
    // Send to gem overlay
    void window.prompty.invoke("onboarding:set-ruby-message", { text });

    if (text === null) {
      bubbleVisibleRef.current = false;
      setBubbleVisible(false);
      return;
    }
    if (bubbleVisibleRef.current && bubbleTextRef.current === text) return;
    if (bubbleVisibleRef.current) {
      bubbleVisibleRef.current = false;
      setBubbleVisible(false);
      bubbleTimerRef.current = setTimeout(() => {
        bubbleTextRef.current = text;
        setBubbleTextState(text);
        bubbleVisibleRef.current = true;
        setBubbleVisible(true);
        bubbleTimerRef.current = null;
      }, 300);
    } else {
      bubbleTextRef.current = text;
      setBubbleTextState(text);
      bubbleVisibleRef.current = true;
      setBubbleVisible(true);
    }
  }

  // ── Bubble text per step ──────────────────────────────────────────────────

  function bubbleForStep(idx: number, c: typeof claude, mg: boolean) {
    const s = STEPS[idx];
    if (s === "welcome") return "Hello. I'm Ruby. I'll be with you on every call. Let's get you set up.";
    if (s === "claude") {
      if (c === null) return null;
      return c.found
        ? "Claude is ready. We're off to a good start."
        : "No Claude yet. That's fine. The instructions below will have you set up in just a few minutes.";
    }
    if (s === "mic") {
      return mg
        ? "Thank you for trusting me with that. I'll only ever use your mic when you're on a call. Nothing else, ever."
        : "Just so you know, I only listen when you deliberately start a session. I'm not running in the background.";
    }
    if (s === "hotkey") return "On a real call, I'll give you something relevant. For now, just feel how fast I respond.";
    if (s === "signin") return "Almost there. This keeps your history and memory safe across sessions.";
    return null;
  }

  // ── Initial data load ─────────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      const [c, p] = await Promise.all([
        window.prompty.invoke("onboarding:check-claude", undefined as never),
        window.prompty.invoke("onboarding:permission-status", undefined as never),
      ]);
      setClaude(c);
      setPerm(p);
    })();
    const onFocus = () => {
      void window.prompty.invoke("onboarding:permission-status", undefined as never).then(setPerm);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ── Welcome bubble on mount ───────────────────────────────────────────────

  useEffect(() => {
    setBubble("Hello. I'm Ruby. I'll be with you on every call. Let's get you set up.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── React to claude loading while on step 2 ───────────────────────────────

  useEffect(() => {
    if (step !== "claude" || claude === null) return;
    const text = bubbleForStep(stepIdx, claude, micGranted);
    if (text) setBubble(text);
  }, [claude]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── React to mic grant while on step 3 ───────────────────────────────────

  useEffect(() => {
    if (step !== "mic" || !micGranted) return;
    setBubble("Thank you for trusting me with that. I'll only ever use your mic when you're on a call. Nothing else, ever.");
  }, [micGranted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Hotkey step: arm the real global shortcut + react to it ───────────────

  // On entering the step, register the real global shortcut (works system-wide,
  // even if this window isn't focused) and put main into onboarding-nudge mode.
  // If the combo is already taken, fall back to a focused-window listener below.
  useEffect(() => {
    if (step !== "hotkey") return;
    let cancelled = false;
    void window.prompty
      .invoke("onboarding:arm-hotkey", undefined as never)
      .then((res) => {
        if (!cancelled) setHotkeyFallback(!res.registered);
      });
    const skipTimer = setTimeout(() => {
      if (!cancelled) setShowHotkeySkip(true);
    }, 10000);
    return () => {
      cancelled = true;
      clearTimeout(skipTimer);
    };
  }, [step]);

  // The shortcut fired (real or fallback) → a sample nudge bloomed in the gem.
  // Mark the step done, bring the card back forward, reveal Continue.
  useEffect(() => {
    const off = window.prompty.on("onboarding:hotkey-fired", () => {
      onHotkeyFired();
    });
    return off;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback only: when the global shortcut couldn't be registered, catch the
  // keypress in-window and ask main to bloom the sample nudge (same path).
  useEffect(() => {
    if (step !== "hotkey" || !hotkeyFallback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        void window.prompty.invoke("onboarding:fire-nudge", undefined as never);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, hotkeyFallback]);

  // ── Advance to next step ──────────────────────────────────────────────────

  function advance() {
    if (stepIdx >= STEPS.length - 1) return;
    setStepVisible(false);

    setTimeout(() => {
      const nextIdx = stepIdx + 1;
      setStepIdx(nextIdx);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setStepVisible(true);
          setTimeout(() => {
            const text = bubbleForStep(nextIdx, claude, micGranted);
            if (text) setBubble(text);
          }, 220);
        });
      });
    }, 260);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function recheckClaude() {
    setClaudeBusy(true);
    try {
      const c = await window.prompty.invoke("onboarding:check-claude", undefined as never);
      setClaude(c);
    } finally {
      setClaudeBusy(false);
    }
  }

  async function requestMic() {
    setMicBusy(true);
    try {
      await window.prompty.invoke("onboarding:request-mic", undefined as never);
      const p = await window.prompty.invoke("onboarding:permission-status", undefined as never);
      setPerm(p);
    } finally {
      setMicBusy(false);
    }
  }

  // Called when a sample nudge bloomed (first or repeat press). The narration
  // and Continue only need to appear once; repeat presses just re-bloom the gem.
  function onHotkeyFired() {
    setHotkeyDone((already) => {
      if (already) return true;
      setBubble("That's all there is to it. You're going to do great.");
      setTimeout(() => setShowHotkeyContinue(true), 700);
      return true;
    });
  }

  async function handleSignIn() {
    setSigningIn(true);
    // Backend auth not yet wired — simulating for now
    setBubble("It's been a pleasure. I'll be here every time you take a call. Good luck out there.");
    await new Promise<void>((r) => setTimeout(r, 1500));
    await window.prompty.invoke("onboarding:complete", undefined as never);
  }

  function openExternal(url: string) {
    void window.prompty.invoke("onboarding:open-external", { url });
  }

  // ── Resize window to fit card content ────────────────────────────────────

  const appRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const fit = () => {
      const h = Math.ceil(el.scrollHeight);
      void window.prompty.invoke("onboarding:set-height", { height: h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="ob-app" ref={appRef}>
      <div className="ob-titlebar" />

      <div className="ob-card">
        <ProgressBar current={stepIdx} total={STEPS.length} />

        <div className={`ob-step${stepVisible ? " ob-step-in" : " ob-step-out"}`}>
            {step === "welcome" && (
              <StepWelcome onNext={advance} />
            )}
            {step === "claude" && (
              <StepClaude
                claude={claude}
                claudeBusy={claudeBusy}
                onRecheck={recheckClaude}
                onNext={advance}
                onOpenExternal={openExternal}
              />
            )}
            {step === "mic" && (
              <StepMic
                micGranted={micGranted}
                micBusy={micBusy}
                micStatus={micStatus}
                onRequest={requestMic}
                onNext={advance}
                onOpenExternal={openExternal}
              />
            )}
            {step === "hotkey" && (
              <StepHotkey
                done={hotkeyDone}
                showContinue={showHotkeyContinue}
                showSkip={showHotkeySkip}
                fallback={hotkeyFallback}
                onNext={advance}
                onSkip={advance}
              />
            )}
            {step === "signin" && (
              <StepSignin
                signingIn={signingIn}
                onSignIn={handleSignIn}
                onRestart={() => { setStepIdx(0); setStepVisible(true); setHotkeyDone(false); setShowHotkeyContinue(false); setHotkeyFallback(false); setShowHotkeySkip(false); setSigningIn(false); }}
              />
            )}
        </div>
      </div>
    </div>
  );
}

// ─── Step components ──────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="ob-step-content">
      <div style={{ marginBottom: 18 }}><RubyLogo size={48} /></div>
      <h1 className="ob-title">Meet Ruby, <em>your call coach.</em></h1>
      <p className="ob-body">
        A real-time AI coach that lives inside your calls. She preps you before,
        listens live, and whispers the right question at the right moment. Runs
        entirely on your machine.
      </p>
      <div className="ob-actions">
        <button className="ob-btn-primary" onClick={onNext}>
          Get started →
        </button>
      </div>
    </div>
  );
}

function StepClaude({
  claude,
  claudeBusy,
  onRecheck,
  onNext,
  onOpenExternal,
}: {
  claude: { found: boolean; path: string | null } | null;
  claudeBusy: boolean;
  onRecheck: () => Promise<void>;
  onNext: () => void;
  onOpenExternal: (url: string) => void;
}) {
  return (
    <div className="ob-step-content">
      <img src={new URL("./claude.svg", import.meta.url).href} width={54} height={54} style={{ borderRadius: 15, marginBottom: 18, display: "block", objectFit: "cover" }} alt="Claude" />
      <h1 className="ob-title">Ruby runs on Claude.</h1>
      <p className="ob-body">
        Ruby uses Claude Code (Anthropic's CLI) as its AI brain. It runs
        entirely on your machine, so your calls stay private. We'll check if
        you're already set up.
      </p>

      {claude === null && (
        <div className="ob-check-row">
          <div className="ob-status-dot ob-status-idle" />
          <span className="ob-check-label">Checking…</span>
        </div>
      )}

      {claude !== null && claude.found && (
        <>
          <div className="ob-check-row">
            <div className="ob-status-dot ob-status-ok" />
            <div>
              <div className="ob-check-label">Claude Code found. You're good to go.</div>
              {claude.path && <div className="ob-check-sub">{claude.path}</div>}
            </div>
          </div>
          <div className="ob-actions">
            <button className="ob-btn-primary" onClick={onNext}>Continue →</button>
          </div>
        </>
      )}

      {claude !== null && !claude.found && (
        <>
          <div className="ob-check-row">
            <div className="ob-status-dot ob-status-warn" />
            <span className="ob-check-label">Claude Code not detected yet.</span>
          </div>
          <div className="ob2-instructions">
            <ol>
              <li>Open Terminal on your Mac</li>
              <li>Install Claude Code: <Code>npm install -g @anthropic-ai/claude-code</Code></li>
              <li>Log in to your Anthropic account: <Code>claude login</Code></li>
              <li>Follow the browser prompt to sign in</li>
              <li>Come back here and hit "Check again"</li>
            </ol>
          </div>
          <div className="ob-actions">
            <button className="ob-btn-plain" onClick={onRecheck} disabled={claudeBusy}>
              {claudeBusy ? "Checking…" : "Check again"}
            </button>
            <button
              className="ob-btn-ghost"
              onClick={() => onOpenExternal("file:///System/Applications/Utilities/Terminal.app")}
            >
              Open Terminal
            </button>
          </div>
          <p className="ob-note">More AI agents coming soon: Gemini CLI, OpenCode, and others.</p>
        </>
      )}
    </div>
  );
}

function StepMic({
  micGranted,
  micBusy,
  micStatus,
  onRequest,
  onNext,
  onOpenExternal,
}: {
  micGranted: boolean;
  micBusy: boolean;
  micStatus: MediaPermissionStatus;
  onRequest: () => Promise<void>;
  onNext: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const denied = micStatus === "denied" || micStatus === "restricted";

  return (
    <div className="ob-step-content">
      <StepIcon bg="#7c3aed" shadow="0 8px 24px rgba(124,58,237,0.28)">
        <MicIcon size={26} />
      </StepIcon>
      <h1 className="ob-title">One permission.</h1>
      <p className="ob-body">
        Ruby needs your microphone to hear your side of the call. That's all.
        no screen recording, no camera, nothing else. Everything stays on your machine.
      </p>

      <div className="ob-check-row">
        <div className={`ob-status-dot${micGranted ? " ob-status-ok" : " ob-status-idle"}`} />
        <span className="ob-check-label">
          {micGranted ? "Microphone granted" : "Microphone waiting"}
        </span>
      </div>

      <div className="ob-actions">
        {!micGranted && !denied && (
          <button className="ob-btn-plain" onClick={onRequest} disabled={micBusy}>
            {micBusy ? "Requesting…" : "Allow microphone"}
          </button>
        )}
        {denied && (
          <button
            className="ob-btn-plain"
            onClick={() =>
              onOpenExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            }
          >
            Open System Settings
          </button>
        )}
        {micGranted && (
          <button className="ob-btn-primary" onClick={onNext}>Continue →</button>
        )}
      </div>
      <div className="ob-note ob-note-trust">
        <div className="ob-note-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6l-8-4z" fill="#a0917e" />
            <path d="M9 12l2 2 4-4" stroke="#f2ebe0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span>Ruby only listens during an active session.<br />You're always in control.</span>
      </div>
    </div>
  );
}

function StepHotkey({
  done,
  showContinue,
  showSkip,
  fallback,
  onNext,
  onSkip,
}: {
  done: boolean;
  showContinue: boolean;
  showSkip: boolean;
  fallback: boolean;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="ob-step-content">
      <StepIcon bg="#1a1a1a">
        <KeyboardIcon size={26} />
      </StepIcon>
      <h1 className="ob-title">Want a nudge? Just ask.</h1>
      <p className="ob-body">
        {done
          ? "That's a nudge — the same card she'll bloom mid-call, except then she'll be listening to your actual conversation. Press again to see another."
          : "Ruby's waiting up in the corner ↗. Press the hotkey and watch her hand you a question — it works even when another app is focused, just like on a real call."}
      </p>

      <div className="ob4-demo">
        <div className="ob4-demo-label">
          {done ? "PRESS AGAIN FOR ANOTHER" : "PRESS THIS, THEN LOOK UP ↗"}
        </div>
        <div className="ob4-keys">
          <span className="ob4-key">⌥</span>
          <span className="ob4-key">⇧</span>
          <span className="ob4-key">Space</span>
        </div>
        {fallback && (
          <div className="ob4-fallback-note">
            Keep this window focused — another app is using this shortcut. You can
            change it later in Settings.
          </div>
        )}
      </div>

      <div className="ob-actions">
        {showContinue && (
          <button className="ob-btn-primary ob-anim-fade" onClick={onNext}>
            Continue →
          </button>
        )}
        {!done && showSkip && (
          <button className="ob-btn-skip ob-anim-fade" onClick={onSkip}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function StepSignin({
  signingIn,
  onSignIn,
  onRestart,
}: {
  signingIn: boolean;
  onSignIn: () => Promise<void>;
  onRestart: () => void;
}) {
  return (
    <div className="ob-step-content">
      <StepIcon bg="#e8e4de">
        <PersonIcon size={26} />
      </StepIcon>
      <h1 className="ob-title">Last step.</h1>
      <p className="ob-body">
        Create your Prompty account to save your calls, memory, and recap
        history. Takes about five seconds.
      </p>

      <button className="ob5-google-btn" onClick={onSignIn} disabled={signingIn}>
        <GoogleIcon />
        <span>{signingIn ? "Signing in…" : "Sign in with Google"}</span>
      </button>

      <p className="ob-note">
        We only use your Google account to identify you. Your calls and
        transcripts stay on your device.
      </p>

      {/* DEV ONLY */}
      <button className="ob-dev-restart" onClick={onRestart}>
        ↩ Restart onboarding (dev)
      </button>
    </div>
  );
}
