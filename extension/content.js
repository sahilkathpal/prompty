// Injected into meet.google.com. Mounts the sidebar shadow root and bridges
// service-worker messages to the sidebar UI.

(async () => {
  const host = document.createElement("div");
  host.id = "prompty-host";
  host.style.cssText =
    "position:fixed;top:0;right:0;width:340px;height:100vh;z-index:2147483647;pointer-events:none";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const cssUrl = chrome.runtime.getURL("sidebar.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl;
  shadow.appendChild(link);

  const root = document.createElement("div");
  root.className = "prompty-root";
  root.style.pointerEvents = "auto";
  shadow.appendChild(root);

  // Toast overlay — separate host centered at top of viewport, above the
  // Meet UI. Per-toast pointer-events let users click to dismiss.
  const toastHost = document.createElement("div");
  toastHost.id = "prompty-toast-host";
  toastHost.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none";
  document.body.appendChild(toastHost);
  const toastShadow = toastHost.attachShadow({ mode: "open" });
  const toastLink = document.createElement("link");
  toastLink.rel = "stylesheet";
  toastLink.href = cssUrl;
  toastShadow.appendChild(toastLink);
  const toastRoot = document.createElement("div");
  toastRoot.className = "prompty-toasts";
  toastShadow.appendChild(toastRoot);

  function showToast(n) {
    const el = document.createElement("div");
    el.className = `prompty-toast prompty-toast-${n.urgency} prompty-toast-${n.kind}`;
    el.innerHTML = `
      <div class="prompty-toast-avatar" aria-hidden="true">👻</div>
      <div class="prompty-toast-body">
        <div class="prompty-toast-kind">${esc(n.kind)}</div>
        <div class="prompty-toast-text">${esc(n.text)}</div>
      </div>
      <button class="prompty-toast-dismiss" title="Dismiss">✕</button>
    `;
    const remove = () => {
      if (el._timeoutId) clearTimeout(el._timeoutId);
      el.classList.add("prompty-toast-leaving");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".prompty-toast-dismiss").addEventListener("click", remove);
    // Hovering pauses auto-dismiss so you can finish reading a longer nudge.
    el.addEventListener("mouseenter", () => {
      if (el._timeoutId) {
        clearTimeout(el._timeoutId);
        el._timeoutId = null;
      }
    });
    el.addEventListener("mouseleave", () => {
      if (!el._timeoutId) el._timeoutId = setTimeout(remove, 4000);
    });
    toastRoot.appendChild(el);
    const ms = n.urgency === "high" ? 14000 : 8000;
    el._timeoutId = setTimeout(remove, ms);
    // Cap the stack so a burst of nudges doesn't blanket the screen.
    while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
  }

  let state = {
    setup: null,
    nudges: [],
    dismissedNudgeIds: new Set(),
    callActive: false,
    callEnded: false,
    logPath: "",
    // micWarning: null | { kind: 'denied'|'prompt'|'failed', message?: string }
    micWarning: null,
  };

  function render() {
    const setup = state.setup;
    root.innerHTML = `
      <div class="prompty-card ${state.callActive ? "active" : ""}">
        <div class="prompty-header">
          <div class="prompty-title">Prompty</div>
          <button class="prompty-toggle" data-action="toggle">≡</button>
        </div>
        ${state.micWarning ? renderMicWarning() : ""}
        ${setup ? `
        ${setup.context?.attendee?.name || setup.context?.attendee?.summary ? `
        <div class="prompty-who">
          <div class="prompty-who-name">${esc(setup.context.attendee.name || "")}</div>
          ${setup.context.attendee.summary ? `<div class="prompty-who-summary">${esc(setup.context.attendee.summary)}</div>` : ""}
        </div>` : ""}
        <div class="prompty-goal">
          <div class="prompty-label">Goal</div>
          <div class="prompty-goal-text" data-action="expand-goal" title="${esc(setup.goal)}">${esc(setup.goal)}</div>
        </div>
        <div class="prompty-checklist">
          ${setup.checklist.map(c => `
            <div class="prompty-check prompty-check-${c.status}" data-action="expand-check" title="${esc(c.text)}">
              <span class="prompty-check-icon">${c.status === "covered" ? "✓" : c.status === "partial" ? "~" : "○"}</span>
              <span class="prompty-check-text">${esc(c.text)}</span>
            </div>
          `).join("")}
        </div>` : `
        <div class="prompty-empty">
          <p>No active setup. In Claude Code, run <code>/prompty-setup</code> to prep for a call.</p>
        </div>`}
        <div class="prompty-controls">
          ${state.callActive
            ? `<button data-action="end-call" class="prompty-btn prompty-btn-end">End call</button>`
            : state.callEnded
              ? renderPostCall()
              : setup
                ? `<button data-action="start-call" class="prompty-btn prompty-btn-start">Start call</button>`
                : ""}
          <div class="prompty-hint">Alt+Shift+Space → ask Prompty</div>
        </div>
      </div>
    `;
  }

  function renderMicWarning() {
    const w = state.micWarning;
    let title, body, primaryLabel, primaryAction;
    if (w.kind === "prompt") {
      title = "Mic access needed";
      body = "Chrome will pop up an Allow prompt. Click Allow, then Start the call again.";
      primaryLabel = "Show prompt";
      primaryAction = "request-mic";
    } else if (w.kind === "denied") {
      title = "Mic is blocked";
      body = "Your voice won't be transcribed. Open mic settings, allow Prompty, then click Start again.";
      primaryLabel = "Open mic settings";
      primaryAction = "open-mic-settings";
    } else {
      title = "Mic capture failed";
      body = w.message || "Couldn't access the mic. Check Chrome mic permissions, then click Start again.";
      primaryLabel = "Open mic settings";
      primaryAction = "open-mic-settings";
    }
    return `
      <div class="prompty-mic-warn">
        <div class="prompty-mic-warn-title">${esc(title)}</div>
        <div class="prompty-mic-warn-body">${esc(body)}</div>
        <div class="prompty-mic-warn-actions">
          <button data-action="${primaryAction}" class="prompty-btn prompty-btn-start prompty-btn-sm">${esc(primaryLabel)}</button>
          <button data-action="dismiss-mic-warn" class="prompty-btn prompty-btn-end prompty-btn-sm">Dismiss</button>
        </div>
      </div>
    `;
  }

  function renderPostCall() {
    const newCallBtn = `<button data-action="new-call" class="prompty-btn prompty-btn-end">Clear setup</button>`;
    const saveHint = `<div class="prompty-hint">In Claude Code, run <code>/prompty-save-call</code> to push notes to Attio.</div>`;
    return `${newCallBtn}${saveHint}`;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]));
  }

  root.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "toggle") {
      root.classList.toggle("collapsed");
    } else if (action === "expand-goal" || action === "expand-check") {
      e.target.closest("[data-action]").classList.toggle("expanded");
    } else if (action === "request-mic") {
      const resp = await chrome.runtime.sendMessage({ target: "background", kind: "request-mic" });
      if (resp?.ok) {
        state.micWarning = null;
      } else if (resp?.name === "NotAllowedError") {
        state.micWarning = { kind: "denied" };
      } else {
        state.micWarning = { kind: "failed", message: resp?.message };
      }
      render();
    } else if (action === "open-mic-settings") {
      await chrome.runtime.sendMessage({ target: "background", kind: "open-mic-settings" });
    } else if (action === "dismiss-mic-warn") {
      state.micWarning = null;
      render();
    } else if (action === "start-call") {
      if (!state.setup) return;
      // Preflight: surface a permission warning *before* hitting Start so the
      // user fixes mic access first instead of finding out post-call that
      // their half of the transcript is empty.
      const perm = await chrome.runtime.sendMessage({ target: "background", kind: "check-mic" });
      if (perm?.state === "denied") {
        state.micWarning = { kind: "denied" };
        render();
        return;
      }
      if (perm?.state === "prompt") {
        state.micWarning = { kind: "prompt" };
        render();
        return;
      }
      state.micWarning = null;
      const resp = await chrome.runtime.sendMessage({
        target: "background",
        kind: "start-call",
        setup: state.setup,
      });
      if (resp?.ok) {
        state.callActive = true;
        render();
      } else {
        const reason = resp?.error || "unknown error (check extension service worker console)";
        const hint = /tab capture/i.test(reason)
          ? "Tab capture needs the extension to be \"invoked\": click the Prompty toolbar icon once, then click Start again."
          : reason;
        showToast({
          id: "err_" + Date.now(),
          kind: "fact-reminder",
          text: `Start failed: ${hint}`,
          urgency: "high",
          createdAt: Date.now(),
        });
      }
    } else if (action === "end-call") {
      await chrome.runtime.sendMessage({ target: "background", kind: "end-call" });
      state.callActive = false;
      render();
    } else if (action === "new-call") {
      state.callEnded = false;
      state.setup = null;
      state.nudges = [];
      state.dismissedNudgeIds = new Set();
      try {
        await chrome.storage.local.remove("promptyPendingSetup");
      } catch {}
      render();
    }
  });

  async function applySetup(setup) {
    state.setup = setup;
    state.callEnded = false;
    state.nudges = [];
    state.dismissedNudgeIds = new Set();
    try {
      await chrome.storage.local.set({ promptyPendingSetup: setup });
    } catch {}
    render();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.kind === "audio-error" && msg.source === "mic") {
      state.micWarning =
        msg.name === "NotAllowedError"
          ? { kind: "denied" }
          : { kind: "failed", message: msg.message };
      render();
      return;
    }
    if (msg.kind !== "from-backend") return;
    const m = msg.msg;
    if (m.type === "setup_pushed") {
      void applySetup(m.setup);
    } else if (m.type === "setup") {
      state.setup = m.setup;
      render();
    } else if (m.type === "nudge") {
      state.nudges.push(m.nudge);
      showToast(m.nudge);
      render();
    } else if (m.type === "checklist_update") {
      if (state.setup) {
        const item = state.setup.checklist.find((c) => c.id === m.itemId);
        if (item) item.status = m.status;
        render();
      }
    } else if (m.type === "call_ended") {
      state.callActive = false;
      state.callEnded = true;
      state.logPath = m.logPath || "";
      render();
    } else if (m.type === "error") {
      console.warn("[prompty/content] backend error:", m.message);
    }
  });

  // Register this tab so the SW knows where to forward messages.
  await chrome.runtime.sendMessage({ target: "background", kind: "register-meet-tab" });

  // Hydrate from any previously pushed setup.
  const resp = await chrome.runtime.sendMessage({
    target: "background",
    kind: "get-pending-setup",
  });
  if (resp?.setup) state.setup = resp.setup;
  render();
})();
