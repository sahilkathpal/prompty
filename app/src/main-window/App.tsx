// Prompty — Playground home (prompt-playground branch).
//
// Two tabs: Direction (the whole coaching prompt, with the minimal base.md) +
// past calls; and Settings (mic, Google, Claude, debug, hotkey). No onboarding,
// calendar, prep, skills, goal, or checklist — those are earned features, added
// back to production only once proven useful. Starting a call goes straight to a
// direction-only session (no prep).

import React, { useCallback, useEffect, useRef, useState } from "react";
import Gem from "../shared/Gem";
import "../shared/tokens.css";

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";
type CallFile = { name: string; mtimeMs: number };
type Tab = "direction" | "settings";

// The post-call card (RUBY_MVP decision #9), as written onto the call log JSON
// by summary.ts. Optional fields are defensive — older logs predate this shape.
type CallInsight = { text: string; assisted?: boolean; via?: string };
type CallSummary = {
  recap: string;
  insights: CallInsight[];
  questionsNotAsked: { text: string }[];
  stat: { surfaced: number; used: number };
};
type ParsedCall = {
  summary?: CallSummary;
  startedAt?: number;
  endedAt?: number;
  attendee?: { name?: string; company?: string };
  raw: string;
};

const v = (name: string, fallback: string) => `var(${name}, ${fallback})`;
const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("direction");
  const [direction, setDirection] = useState("");
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [hotkey, setHotkey] = useState("Alt+Shift+Space");
  const [calls, setCalls] = useState<CallFile[]>([]);
  const [openCall, setOpenCall] = useState<{ name: string; call: ParsedCall } | null>(null);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const seeded = useRef(false);

  const refreshCalls = useCallback(() => {
    window.prompty
      .invoke("calls:list", undefined as never)
      .then((r) => setCalls(r.files.sort((a, b) => b.mtimeMs - a.mtimeMs)))
      .catch(() => {});
  }, []);
  const refreshMic = useCallback(() => {
    window.prompty
      .invoke("onboarding:permission-status", undefined as never)
      .then((p) => setMicStatus(p.microphone))
      .catch(() => {});
  }, []);
  const refreshClaude = useCallback(() => {
    window.prompty
      .invoke("onboarding:check-claude", undefined as never)
      .then((r) => setClaude(r))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Restore the persisted direction — box ⇄ ~/.prompty/playground/direction.md.
    window.prompty
      .invoke("direction:load-current", undefined as never)
      .then((r) => {
        if (r.content && !seeded.current) {
          setDirection(r.content);
          seeded.current = true;
        }
      })
      .catch(() => {});
    window.prompty
      .invoke("session:state", undefined as never)
      .then((r) => {
        setSessionState(r.state);
        if (!seeded.current && r.setup?.direction) {
          setDirection(r.setup.direction);
          seeded.current = true;
        }
      })
      .catch(() => {});
    window.prompty
      .invoke("settings:get", undefined as never)
      .then((s) => {
        const set = s as { debugMode?: boolean; hotkey?: string };
        if (set.hotkey) setHotkey(set.hotkey);
        // Playground defaults debug on; force it on if a stored setting was off.
        setDebug(true);
        if (set.debugMode !== true) window.prompty.invoke("settings:set", { debugMode: true } as never);
      })
      .catch(() => {});
    window.prompty
      .invoke("preflight:get", undefined as never)
      .then((pf) => pf && setError(pf.message))
      .catch(() => {});
    refreshCalls();
    refreshMic();
    refreshClaude();

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "ended" || p.state === "idle") refreshCalls();
    });
    const offPf = window.prompty.on("preflight:failed", (p) => {
      setError(p.message);
      if (p.code === "mic") refreshMic();
    });
    return () => {
      offState();
      offPf();
    };
  }, [refreshCalls, refreshMic, refreshClaude]);

  const isLive =
    sessionState === "starting" || sessionState === "live" || sessionState === "ending";

  const saveDir = useCallback((text: string) => {
    void window.prompty.invoke("direction:save-current", { content: text });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!direction.trim()) {
      setError("Set a direction first — it's the whole coaching prompt now.");
      return;
    }
    saveDir(direction);
    const r = await window.prompty.invoke("call:start", {});
    if (!r.ok) {
      const pf = await window.prompty
        .invoke("preflight:get", undefined as never)
        .catch(() => null);
      setError(pf?.message ?? r.error ?? "Couldn't start the call.");
      if (pf?.code === "mic") refreshMic();
    }
  }, [direction, saveDir, refreshMic]);

  const end = useCallback(() => {
    void window.prompty.invoke("call:end", undefined as never);
  }, []);

  const loadFile = useCallback(async () => {
    const r = await window.prompty
      .invoke("direction:load-file", undefined as never)
      .catch(() => null);
    if (r) {
      setDirection(r.content);
      saveDir(r.content);
    }
  }, [saveDir]);

  const toggleDebug = useCallback(() => {
    setDebug((cur) => {
      const next = !cur;
      window.prompty.invoke("settings:set", { debugMode: next } as never);
      return next;
    });
  }, []);

  const grantMic = useCallback(async () => {
    await window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {});
    refreshMic();
  }, [refreshMic]);

  const viewCall = useCallback(
    (name: string) => {
      if (openCall?.name === name) {
        setOpenCall(null);
        return;
      }
      window.prompty
        .invoke("calls:read", { name })
        .then((r) => {
          let parsed: ParsedCall = { raw: r.content };
          try {
            const obj = JSON.parse(r.content) as Record<string, unknown>;
            parsed = {
              summary: obj.summary as CallSummary | undefined,
              startedAt: obj.startedAt as number | undefined,
              endedAt: obj.endedAt as number | undefined,
              attendee: obj.attendee as ParsedCall["attendee"],
              raw: JSON.stringify(obj, null, 2),
            };
          } catch {}
          setOpenCall({ name, call: parsed });
        })
        .catch(() => {});
    },
    [openCall],
  );

  const micOk = micStatus === "granted";
  const micBlocked = micStatus === "denied" || micStatus === "restricted";

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <div style={S.title}>
            <Gem variant="mini" size={20} />
            <span>Ruby</span>
          </div>
          <div style={S.subtitle}>minimal base + your direction — that's the whole prompt</div>
        </div>
        <nav style={S.nav}>
          {(["direction", "settings"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...S.navBtn, ...(tab === t ? S.navBtnActive : null) }}
            >
              {t === "direction" ? "Direction" : "Settings"}
            </button>
          ))}
        </nav>
      </header>

      {tab === "direction" ? (
        <>
          {!micOk && micStatus && (
            <div style={S.warn}>
              <span>🎙️ Microphone not granted — calls can't hear audio.</span>
              <button style={S.linkBtn} onClick={() => setTab("settings")}>
                Fix in Settings →
              </button>
            </div>
          )}

          <section style={S.card}>
            <label style={S.label} htmlFor="direction">
              Direction
            </label>
            <textarea
              id="direction"
              data-testid="playground-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              onBlur={() => saveDir(direction)}
              placeholder="Describe what a good call looks like: what to explore, the stance to carry, when to speak up…"
              spellCheck={false}
              style={S.textarea}
            />
            <div style={S.row}>
              <button style={S.btnGhost} onClick={loadFile}>
                Load from file…
              </button>
              <label style={S.checkRow} title="Write ~/.prompty/debug/call-*.{jsonl,md}">
                <input type="checkbox" checked={debug} onChange={toggleDebug} />
                Debug logging
              </label>
              <button
                style={S.linkBtn}
                onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}
              >
                Reveal logs
              </button>
              <span style={{ flex: 1 }} />
              {isLive ? (
                <button style={S.btnDanger} data-testid="playground-end" onClick={end}>
                  End call
                </button>
              ) : (
                <button style={S.btnAccent} data-testid="playground-start" onClick={start}>
                  Start call
                </button>
              )}
            </div>
            {isLive && (
              <div style={S.live}>
                <span style={S.dot} /> Call {sessionState} — coaching in the floating overlay
              </div>
            )}
            {error && (
              <div style={S.error} data-testid="playground-error">
                {error}
              </div>
            )}
          </section>

          <section style={S.card}>
            <div style={S.cardHead}>
              <span style={S.label}>Past calls</span>
              <button style={S.linkBtn} onClick={refreshCalls}>
                Refresh
              </button>
            </div>
            {calls.length === 0 ? (
              <div style={S.empty}>No calls yet.</div>
            ) : (
              <ul style={S.list}>
                {calls.map((c) => (
                  <li key={c.name}>
                    <button style={S.callRow} onClick={() => viewCall(c.name)}>
                      <span style={S.callName}>{c.name.replace(/\.json$/, "")}</span>
                      <span style={S.callDate}>{new Date(c.mtimeMs).toLocaleString()}</span>
                    </button>
                    {openCall?.name === c.name && <CallCard call={openCall.call} />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <>
          <section style={S.card}>
            <Setting
              label="Microphone"
              value={micStatus ?? "checking…"}
              tone={micOk ? "green" : micBlocked ? "red" : "amber"}
            >
              {!micOk &&
                (micBlocked ? (
                  <button
                    style={S.btnGhost}
                    onClick={() => window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL })}
                  >
                    Open System Settings
                  </button>
                ) : (
                  <button style={S.btnAccent} onClick={grantMic}>
                    Grant microphone
                  </button>
                ))}
            </Setting>

            <Setting
              label="Claude Code"
              value={claude ? (claude.found ? claude.path ?? "found" : "not found") : "checking…"}
              tone={claude?.found ? "green" : claude ? "red" : "amber"}
            >
              <button style={S.btnGhost} onClick={refreshClaude}>
                Re-check
              </button>
            </Setting>
          </section>

          <section style={S.card}>
            <Setting label="Debug logging" value={debug ? "on" : "off"} tone="muted">
              <input type="checkbox" checked={debug} onChange={toggleDebug} />
            </Setting>
            <Setting label="Reveal debug logs" value="~/.prompty/debug" tone="muted">
              <button
                style={S.btnGhost}
                onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}
              >
                Open folder
              </button>
            </Setting>
            <Setting label="Hotkey (ask)" value={hotkey} tone="muted" />
          </section>
        </>
      )}
    </div>
  );
}

function Setting(props: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber" | "muted";
  children?: React.ReactNode;
}): JSX.Element {
  const toneColor =
    props.tone === "green"
      ? v("--green", "#46c46a")
      : props.tone === "red"
        ? v("--red", "#d05050")
        : props.tone === "amber"
          ? v("--amber", "#e0a23a")
          : v("--muted", "#9a9aa2");
  return (
    <div style={S.settingRow}>
      <div style={{ minWidth: 0 }}>
        <div style={S.settingLabel}>{props.label}</div>
        <div style={{ ...S.settingValue, color: toneColor }}>{props.value}</div>
      </div>
      <div style={S.settingControl}>{props.children}</div>
    </div>
  );
}

// The post-call card (RUBY_MVP decision #9): Recap / Insights & quotes (✦ marks
// Ruby-assisted ones) / Questions you didn't ask, plus one quiet stat line. Falls
// back to the raw JSON for older logs (or a call that never produced a summary).
function CallCard(props: { call: ParsedCall }): JSX.Element {
  const { summary, raw, attendee, startedAt, endedAt } = props.call;
  if (!summary) {
    return (
      <div style={S.card2}>
        <div style={S.cardNote}>No summary card for this call — showing the raw log.</div>
        <pre style={S.pre}>{raw}</pre>
      </div>
    );
  }
  const name = attendee?.name?.trim() || "Call";
  const mins =
    startedAt && endedAt && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 60000))
      : null;
  return (
    <div style={S.card2} data-testid="call-card">
      <div style={S.receiptHead}>
        {name}
        {mins != null && <span style={S.receiptMeta}> · {mins} min</span>}
      </div>
      <div style={S.receiptSub}>
        Ruby surfaced {summary.stat.surfaced} · you used {summary.stat.used}
      </div>

      <section style={S.sec}>
        <div style={S.secHead}>Recap</div>
        <p style={S.recap}>{summary.recap}</p>
      </section>

      <section style={S.sec}>
        <div style={S.secHead}>Insights &amp; quotes</div>
        {summary.insights.length === 0 ? (
          <div style={S.cardNote}>Nothing notable surfaced.</div>
        ) : (
          <ul style={S.insightList}>
            {summary.insights.map((ins, i) => (
              <li key={i} style={S.insight}>
                <span style={ins.assisted ? S.checkOn : S.checkOff} aria-hidden>
                  {ins.assisted ? "✓" : "·"}
                </span>
                <span>
                  {ins.text}
                  {ins.assisted && ins.via && <span style={S.via}> — {ins.via}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={S.sec}>
        <div style={S.secHead}>Questions you didn't ask</div>
        {summary.questionsNotAsked.length === 0 ? (
          <div style={S.cardNote}>You picked up everything Ruby surfaced.</div>
        ) : (
          <ul style={S.qList}>
            {summary.questionsNotAsked.map((q, i) => (
              <li key={i} style={S.qItem}>{q.text}</li>
            ))}
          </ul>
        )}
      </section>

      <div style={S.stat} data-testid="call-stat">
        Ruby surfaced {summary.stat.surfaced}, you used {summary.stat.used}.
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    font: v("--font", "14px system-ui, sans-serif"),
    color: v("--text", "#e8e8ea"),
    background: v("--bg", "#16161a"),
    minHeight: "100vh",
    padding: "28px 32px",
    boxSizing: "border-box",
    maxWidth: 760,
    margin: "0 auto",
  },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 },
  title: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    fontFamily: v("--serif", "Georgia, serif"),
    fontSize: 26,
    fontWeight: 500,
    letterSpacing: "-0.015em",
    color: v("--ink", "#211d15"),
  },
  subtitle: { fontSize: 13, color: v("--muted", "#6e6757"), marginTop: 6 },
  nav: { display: "flex", gap: 4, flexShrink: 0 },
  navBtn: {
    padding: "6px 12px",
    fontSize: 13,
    color: v("--muted", "#9a9aa2"),
    background: "transparent",
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  navBtnActive: { color: v("--text-strong", "#fff"), background: v("--surface-raised", "#2a2a32"), borderColor: v("--border-strong", "#3a3a44") },
  warn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 14px",
    marginBottom: 14,
    fontSize: 13,
    color: v("--amber", "#e0a23a"),
    background: "rgba(224,162,58,0.10)",
    border: `1px solid ${v("--amber", "#e0a23a")}`,
    borderRadius: 8,
  },
  card: {
    background: v("--surface", "#1e1e24"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
  },
  label: { fontSize: 13, fontWeight: 600, color: v("--text-strong", "#fff") },
  textarea: {
    width: "100%",
    minHeight: 220,
    marginTop: 8,
    padding: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.5,
    color: v("--text", "#e8e8ea"),
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    resize: "vertical",
    boxSizing: "border-box",
  },
  row: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: v("--muted", "#9a9aa2") },
  live: { marginTop: 12, fontSize: 13, color: v("--green", "#46c46a"), display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%", background: v("--green", "#46c46a"), display: "inline-block" },
  error: {
    marginTop: 12,
    padding: "10px 12px",
    fontSize: 13,
    color: v("--danger-text", "#ffb4b4"),
    background: "rgba(220,80,80,0.12)",
    border: `1px solid ${v("--red", "#d05050")}`,
    borderRadius: 8,
  },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  empty: { fontSize: 13, color: v("--muted-dim", "#6a6a72") },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 },
  callRow: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: v("--text", "#e8e8ea"),
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
  },
  callName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  callDate: { color: v("--muted-dim", "#6a6a72"), flexShrink: 0 },
  pre: {
    margin: "4px 0 8px",
    padding: 12,
    maxHeight: 320,
    overflow: "auto",
    fontSize: 12,
    lineHeight: 1.45,
    color: v("--muted", "#bdbdc4"),
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  card2: {
    margin: "4px 0 10px",
    padding: 16,
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 10,
  },
  receiptHead: {
    fontFamily: v("--serif", "Georgia, serif"),
    fontSize: 19,
    fontWeight: 600,
    color: v("--ink", "#211d15"),
  },
  receiptMeta: { color: v("--ink-faint", "#a39a82"), fontWeight: 400 },
  receiptSub: { fontSize: 12, color: v("--ink-faint", "#a39a82"), margin: "5px 0 16px" },
  sec: { marginBottom: 16 },
  secHead: {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.13em",
    textTransform: "uppercase",
    color: v("--ruby", "#d61f47"),
    marginBottom: 8,
  },
  recap: { margin: 0, fontSize: 13, lineHeight: 1.55, color: v("--text", "#211d15") },
  insightList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 },
  insight: {
    display: "flex",
    gap: 9,
    fontSize: 13,
    lineHeight: 1.5,
    color: v("--text", "#211d15"),
  },
  checkOn: { color: v("--ok", "#2e9e63"), flexShrink: 0, fontWeight: 800 },
  checkOff: { color: v("--ink-faint", "#a39a82"), flexShrink: 0, fontWeight: 700 },
  via: { color: v("--gold", "#c98e2e"), fontStyle: "italic" },
  qList: { listStyle: "disc", margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 },
  qItem: { fontSize: 13, lineHeight: 1.5, color: v("--text", "#e8e8ea") },
  cardNote: { fontSize: 13, color: v("--muted-dim", "#6a6a72") },
  stat: {
    marginTop: 4,
    paddingTop: 12,
    borderTop: `1px solid ${v("--border", "#2c2c34")}`,
    fontSize: 12,
    color: v("--muted", "#9a9aa2"),
  },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "12px 0",
    borderBottom: `1px solid ${v("--border", "#2c2c34")}`,
  },
  settingLabel: { fontSize: 13, fontWeight: 600, color: v("--text-strong", "#fff") },
  settingValue: { fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 },
  settingControl: { flexShrink: 0 },
  btnAccent: {
    padding: "9px 18px",
    fontSize: 13,
    fontWeight: 700,
    color: "#fff",
    background: `linear-gradient(140deg, ${v("--ruby", "#d61f47")}, ${v("--ruby-deep", "#b01238")})`,
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(214,31,71,0.28)",
  },
  btnDanger: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: v("--red", "#d05050"),
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnGhost: {
    padding: "8px 14px",
    fontSize: 13,
    color: v("--text", "#e8e8ea"),
    background: "transparent",
    border: `1px solid ${v("--border-strong", "#3a3a44")}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  linkBtn: {
    padding: 0,
    fontSize: 13,
    color: v("--accent", "#5b7cfa"),
    background: "transparent",
    border: "none",
    cursor: "pointer",
  },
};
