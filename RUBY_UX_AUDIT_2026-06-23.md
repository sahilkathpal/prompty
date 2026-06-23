# Ruby — Full UX / UI / Copy Re-Audit (2026-06-23)

A re-audit of the current code on `ruby-rebuild` after the 2026-06-22 audit (`RUBY_UX_AUDIT.md`) was largely implemented. Each finding cites `file:line`, names a category (Copy / UX-flow / UI-visual / Placement / Dead-code / A11y), a severity, the concrete issue, and a specific fix. Severity legend: **High** (hurts usability / breaks a promise / leaves a decided fix unshipped) · **Medium** · **Low** · **Polish** (delight). Findings are confirmed against current code; where a prior decision was made but not carried through, it is flagged as such.

## Changes since the 2026-06-22 audit

- **Live call as a Home row** (Part 3 redesign) — shipped. The in-progress view it opens is real and read-only, not the old frozen placeholder. Mostly healthy; the surviving nits are cosmetic (the row's title is a static "Current call" rather than the prepped call's identity, and the row/timer lack live-region and aria-label polish).
- **Overlay expand hint removed** — shipped, but it removed the *only* always-visible discoverability cue on the pill, so the gem now reads as a pure status indicator with no resting signal that it opens the notes / Finish-listening panel. Needs a lightweight cue restored.
- **Editable post-call titles** (click-to-edit rename) — shipped and functional, but the affordance is hover-only, has no keyboard focus ring, gives screen readers no "renames the call" hint, and has zero test coverage.
- **New "Your prep" top section** on the recap (`PrepRecap`) — shipped and useful, but it introduces fresh terminology ("Your brief", "topics") that diverges from the rest of the app, inverts emphasis on covered checklist items via strike-through, and its collapse toggle lacks a focus ring.

Net: the structural Phase-3/Phase-4 work landed and is healthy in behavior; the residue is copy consistency, a11y focus/announcement polish, and one decided Home reframe (H9) that was never applied.

_Walkthrough decisions recorded inline below (— DECIDED / — DROPPED) on 2026-06-23._

## Part 0 — Cross-cutting themes

These are the patterns worth fixing once rather than per-surface. Per-surface sections below carry only the surface-specific instances; genuinely systemic gaps are lifted here.

### High

- **X1. Skill/playbook picker trigger has its focus ring deliberately removed.** [A11y] — DECIDED
  `main-window.css:1812` is literally `.skill-dd-trigger:focus-visible { outline: none; }`, stripping the keyboard focus indicator from the playbook picker (`App.tsx:1180-1189`). Every other interactive control got a 2px ruby ring in the prior audit; this one explicitly suppresses it with no replacement. **Fix:** replace with `.skill-dd-trigger:focus-visible { outline: 2px solid #ED0C48; outline-offset: 2px; border-radius: 8px; }` (or ring the `.skill-dd` wrapper); remove the `outline:none`.
- **X2. Custom dropdowns are not keyboard-operable as menus.** [A11y] — DECIDED (modified): minimal — Escape-to-close + aria-haspopup/expanded only, no arrow-key roving
  Both the playbook picker (`App.tsx:1180`) and the prep-card overflow menu (`App.tsx:1132`) open a div popover that closes only on a document `mousedown` handler (`App.tsx:1167-1174`, `1121-1128`) — no `keydown`, so Escape doesn't close them and arrows don't move between items. Neither trigger sets `aria-haspopup="menu"` / `aria-expanded`, so a screen reader never announces that activating them opens a menu or its open state. **Fix:** add `aria-haspopup="menu"` and `aria-expanded={open}` to each trigger; add an `onKeyDown` to the open popover that closes on Escape and returns focus to the trigger; optionally support ArrowUp/ArrowDown roving focus. At minimum, wire Escape-to-close.

### Medium

- **X3. Infinite `home-pulse` animation ignores `prefers-reduced-motion`.** [A11y] — DECIDED
  The `home-pulse` keyframe (`main-window.css:109-112`, opacity 1→0.4, scale 1→0.7, infinite) drives `.home-call-dot-live` (`:515-518`, also reused in the in-progress badge at `App.tsx:1549`), `.prep-chat-dot` (`:656`), and `.prep-shimmer-dot` (`:764-769`). None of the four existing reduced-motion blocks (`:503`, `:898`, `:1624`, `:1746`) cover it, so a reduce-motion user gets a perpetually pulsing/scaling dot. **Fix:** add `@media (prefers-reduced-motion: reduce) { .home-call-dot-live, .prep-chat-dot, .prep-shimmer-dot { animation: none; } }` and keep the dots visible via solid ruby fill (the "Live" label carries the meaning).
- **X4. Overlay has zero reduced-motion handling.** [A11y] — DECIDED
  `overlay.css` defines no `@media (prefers-reduced-motion: reduce)` at all. The high-urgency note flashes (`gem-urgent-flash`, keyframe `:126-129`), every note slides/scales in (`gem-bloom-in`, keyframe `:122-124`), and the urgency drain bar animates (`gem-drain`, `:189-195`) regardless of preference — on the most-seen surface, with an attention-grabbing entrance. **Fix:** add a reduced-motion block disabling entrance/flash/drain and freeze/hide `.gem-note-fill`; keep the static thicker/brighter ruby border on `.gem-bloom-high` so the high-urgency cue survives without motion.
- **X5. Post-call rename button gives screen readers no hint it is editable.** [A11y] — DECIDED
  The click-to-edit hero title is a `<button>` (`App.tsx:1772-1783`) whose only accessible name is the visible title text — the pencil SVG is `aria-hidden` and `title="Rename this call"` does not append to the accessible name when visible text is present. A screen-reader user hears just the call name + "button" with no rename cue; the pencil only appears on hover/focus, so non-visual users have no discovery path. **Fix:** add `aria-label={`Rename call: ${title}`}` (or `aria-label="Rename this call"`) to `.pcs-title-edit`; keep the visible title.

### Low / Polish

- **X6. Live elapsed timer and in-progress listening status are not announced.** [A11y] — DECIDED
  The in-progress status block (`App.tsx:1558-1561`, `.ip-status`) has no `role`/`aria-live`, so a blind user on the in-progress screen gets no confirmation Ruby is listening; the home live row (`App.tsx:1058-1066`) ticks "Live · {liveTimer}" inside a plain button. **Fix:** wrap the in-progress status block in `role="status" aria-live="polite"` so the listening line is announced on entry. Leave `liveTimer` non-announced (per-second updates would spam).
- **X7. Post-call rename button lacks a visible focus ring.** [A11y] — DECIDED
  `.pcs-title-edit` (`main-window.css:1192-1214`) reveals the faint `#b0a898` pencil glyph on `:focus-visible` but adds no outline/background change, unlike `.pcs-back`, `.pcs-tab`, `.home-call-row` which get a 2px ruby ring. Keyboard focus on the rename control is hard to perceive. **Fix:** add `.pcs-title-edit:focus-visible { outline: 2px solid #ED0C48; outline-offset: 2px; }` (keep the pencil reveal too).

### Copy & voice (systemic)

- **X8. Ruby's narrator flips between first person and third person — sometimes on one screen.** [Copy] — DECIDED (modified): rule — Ruby speaks first person in her own UI copy; third person only in chrome that describes her as a feature
  On the prep screen the chat empty state speaks about Ruby in third person ("Tell Ruby and she'll help you prep.", `App.tsx:1322`) while the first-run playbook coachmark beside it is first person ("it shapes how I prep and nudge", `App.tsx:1477`) and the caption below reverts to third person ("Shapes how Ruby helps on this call.", `App.tsx:1489`); the sticky updating line is third person ("Ruby is updating your plan…", `App.tsx:1389`). Across the app, Home/Memory/In-progress are first person (`App.tsx:901, 912, 1559, 2053`) while Post-call/Settings are third person (`App.tsx:1975, 2245`). **Fix:** pick ONE narrator. Recommended: Ruby speaks first person in her own UI copy, reserving third person only for chrome that describes her as a feature (Settings rows, onboarding meta). Flip the prep-chat empty state to "Tell me and I'll help you prep.", the sticky line to "I'm updating your plan…", the caption to "Shapes how I help on this call.", and the post-call memory desc to "I'll apply this to future calls."
- **X9. she/it pronoun drift for Ruby (regression of the old O7 fix).** [Copy] — DECIDED
  Onboarding standardizes on she/her ("She preps you before, listens during", `onboarding/App.tsx:597`), but the Memory moment personifies her as "it" ("Tell Ruby how you like to be nudged. It sticks across every call.", `onboarding/App.tsx:617`), and the same "it" leaks in-app on the post-call note ("…Leave a note and it'll adjust next call.", `App.tsx:2010`). In both cases "it" plausibly refers to the note/preference, so this reads as ambiguity rather than a hard error. **Fix:** rephrase so the subject is unambiguous (e.g. onboarding "…she remembers it across every call" or "…and it carries across every call"); align the post-call note to whichever narrator rule X8 settles on.
- **X10. The prep artifact has several names across its lifecycle.** [Copy] — DECIDED (modified): keep "Game plan" as the canonical artifact name; rename the recap section "Your prep" → "Your game plan"; direction sub-label → "Brief"
  The same object (direction + goal + checklist) is "Game plan" on the prep sticky (`App.tsx:1385`), "Your game plan" on the in-progress screen (`App.tsx:1566`), and "Your prep" with the direction sub-block renamed "Your brief" on the recap (`App.tsx:126, 138`). "Brief" is introduced only in the recap. **Fix:** use one name for the artifact and one for the direction field everywhere; the real divergence is the recap's "Your prep" header plus the new "Your brief" — align them to the prep/in-progress wording.
- **X11. The post-call output is called "recap" / "Summary" / "call summary" / "The gist" interchangeably.** [Copy] — DECIDED (modified): standardize on "Recap"; keep "The gist" only as the prose-block label
  The artifact is "recap" (onboarding `App.tsx:597`; in-progress sub-line "Your recap lands here", `App.tsx:1560`), "Summary" (the tab label, `App.tsx:1858`), "Summarizing this call…" (`App.tsx:1903`), "call summary" (in-progress finishing line, `App.tsx:1600`), and "The gist" (the recap section label, `App.tsx:1938`). A first-timer is told a "recap" lands, then sees a "Summary" tab containing "The gist". **Fix:** standardize the user-facing name. If "recap" is the brand word (used in the highest-intent onboarding moment), rename the tab "Recap", the finishing line "saving your recap", and the loading state "Writing your recap…". Keep "The gist" only if it is deliberately the label for the prose block within the recap.
- **X12. PrepRecap collapsed summary calls checklist items "topics" but the expanded block labels them "Checklist".** [Copy] — DECIDED
  The collapsed "Your prep" teaser builds "brief · goal · N topics" (`App.tsx:116-120`) but expands to a block labeled "Checklist" (`App.tsx:150`); "topics" appears nowhere else. **Fix:** make the count match the expanded label — "N to cover" (matches the need-to-cover framing) or "N checklist item(s)"; avoid the one-off "topics".

### Dead-code (systemic)

The codebase carries a cluster of orphaned CSS rules from superseded designs. Sweep them together:

- **X13. Orphaned `.fullscreen-*` topbar cluster.** [Dead-code] — DECIDED `main-window.css:1488-1494` — `.fullscreen-topbar`, `.fullscreen-back` (+ `:hover`), `.fullscreen-title`, `.fullscreen-empty` are referenced nowhere; the only `.fullscreen-root` users render headers with `.pcs-toprow`/`.pcs-back`. **Fix:** delete the four rules. `.fullscreen-root/-body/-intro/-h1` stay.
- **X14. Orphaned `.pcs-transcript-toggle` / `.pcs-transcript-body`.** [Dead-code] — DECIDED `main-window.css:1875-1897` (pre-tab collapsible transcript); the transcript is now a tab rendering `.pcs-transcript-full` (`App.tsx:175`). **Fix:** delete the toggle, its `:hover`, and `-body`; keep `.pcs-transcript-full` and `.pcs-utt-*`.
- **X15. Orphaned `.home-call-dot.prepped`.** [Dead-code] — DECIDED `main-window.css:511-513`; the `prepped` modifier is never applied (App.tsx renders only `home-call-dot home-call-dot-live` at `1058, 1549`). **Fix:** delete the rule.
- **X16. Orphaned `.prep-panel-label`.** [Dead-code] — DECIDED `main-window.css:727`, unreferenced. **Fix:** delete.
- **X17. Self-labeled dead onboarding DEV CSS.** [Dead-code] — DECIDED `onboarding.css:554-579` — `.ob-dev-ruby-copy` / `.ob-dev-ruby-label` under a comment "remove when pill is implemented"; the pill is implemented and neither class is referenced. **Fix:** delete the block and the stale comment.
- **X18. Orphaned `.ob-actions-right`.** [Dead-code] — DECIDED `onboarding.css:360-362`, never applied (all seven action rows use bare `.ob-actions`). **Fix:** delete.
- **X19. Click-to-edit rename has zero test coverage.** [Dead-code] — DECIDED
  Post-call rename adds `data-testid="call-title"` (`App.tsx:1774`) and `data-testid="call-title-input"` (`App.tsx:1761`), but neither testid nor `calls:rename` (`App.tsx:1731`) is referenced by any spec in `app/tests/`. The Enter-commits / Escape-cancels / blur-commits logic is untested. **Fix:** add an e2e case (phase4-postcall.spec.ts): click `call-title`, type into `call-title-input`, press Enter, assert title updates and `calls:rename` invoked; assert Escape reverts.

## Part 1 — Home

### High

- **H1. Pinned-prep line never got its decided "Continue prep" redesign; re-entry is invisible.** [UX-flow] — DECIDED
  Audit finding H9 was DECIDED (`RUBY_UX_AUDIT.md:138-141`) to reframe the restored-draft surface to "Picking up your prep — 1 goal, 2 things to cover." with a primary **"Continue prep"** and a quieter "Start fresh". The shipped code still renders "Pinned:" + " a goal" + " · N checklist item(s)" (`App.tsx:985-990`) and the only verb is "Start fresh" (`onDiscard`, `App.tsx:991-993`). A returning user with a saved goal/checklist sees their prep is preserved but the only button discards it; to resume they must guess that the Home send arrow re-opens the draft (`enterPrep` does preserve `prepComponents`, `App.tsx:369-380`, so it works — but it is unsignposted, `aria-label="Prepare for this call"`). The loudest action on a non-destructive surface is destructive. **Fix:** implement the decided H9 design — change the copy to "Picking up your prep — {1 goal}{·}{N things to cover}." and add a primary "Continue prep" button beside the quieter "Start fresh"; wire "Continue prep" to `onSend`/`enterPrep` so resuming is a one-click named action.

### Medium

- **H2. "Pinned:" wording and pluralization still use rejected jargon.** [Copy] — DECIDED
  The label leads with "Pinned:" — exactly the jargon H9 called out (`App.tsx:985-990`) — and reads "Pinned: a goal · 2 checklist items", inconsistent with the warm plain Home copy ("Tell me about your next call…"). **Fix:** drop "Pinned:" entirely; use the decided phrasing ("Picking up your prep — a goal, 2 things to cover.") and reuse "things to cover" (the established user-facing checklist register) instead of "checklist items". (Subsumed by H1's fix — resolve together; the distinct point is the register: "checklist items" → "things to cover".)

### Low / Polish

- **H3. Live "Current call" row is not anchored to the prepped call.** [UX-flow] — DECIDED
  The live row title is the static literal "Current call" (`App.tsx:1059`) with no tie-back to the call the user prepped, unlike past-call rows which derive `rowTitle` (`App.tsx:1082`). (The row is not a dead-end — clicking it opens the real read-only InProgressScreen, `App.tsx:1529-1604`.) **Fix:** title the live row from the live plan's `direction` when available (mirror the `rowTitle` logic), falling back to "Current call".
- **H4. First-run coach is permanently lost once any prep component is pinned.** [UX-flow] — DECIDED
  The coachmark renders only when `firstRun && !isLive && components.length === 0` (`App.tsx:945`). A new user who starts a prep (which writes components) and returns Home with `components.length > 0` never sees the coach again, even though they haven't completed a call. **Fix:** gate the coach on first-run + no completed calls (`calls.length === 0`) rather than on `components.length === 0`, or keep showing it alongside the pinned line until the first call finishes.
- **H5. Live row button has no descriptive accessible name.** [A11y] — DECIDED
  The live row `<button>` (`App.tsx:1053-1066`) exposes only its visible text ("Current call" + "Live · 12:04"); the dot and arrow are `aria-hidden`. A screen-reader user hears no indication this is the control to open the active call. **Fix:** add `aria-label={`Current call, live ${liveTimer} — open`}`; optionally apply the same "title — open" pattern to past-call rows for consistency.

## Part 2 — Prep

### Medium

- **P1. Start-call error feedback lands far from the button that triggered it.** [Placement] — DECIDED
  Clicking "Start listening" (bottom-right, `App.tsx:1510`) with an empty direction sets `error`, which renders in `.prep-error-banner` pinned to the very TOP of `.prep-root` (`App.tsx:1313`), above the two-column body. The user's eyes are on the bottom-right CTA; the feedback appears in the opposite corner. Mic/Claude preflight failures (the common real failure here) suffer the same disconnect, and the banner is not in an aria-live region. **Fix:** render the call-start error adjacent to the Start button — a small inline line inside `.prep-panel-begin` above/beside `.prep-begin-btn` — instead of (or in addition to) the top banner; keep it in an aria-live region so it is announced.
- **P2. "Start listening" has no in-flight / disabled state during `call:start`.** [UX-flow] — DECIDED
  `onBeginCall` → `startCall` awaits `window.prompty.invoke("call:start", …)` (`App.tsx:327-337`) but the button (`App.tsx:1510`) is never disabled and shows no pending state, so a second click fires `call:start` again. Every other primary action here guards against this (`prep-send-btn` `:1352`, `ip-finish-btn` `:1603-1604`, `mem-add-btn` `:2065`) — launching a call is the most consequential and the only unguarded one. **Fix:** add an `isStarting` state set true at the top of `startCall` and cleared on completion/error; disable the button and swap the label to "Starting…" while pending (mirrors "Finishing…"). Note: no `.prep-begin-btn:disabled` rule exists in CSS yet, so a disabled style must be added.

### Low / Polish

- **P3. P7 readiness signal never implemented — Start button is full-prominence even with an empty plan.** [UX-flow] — DROPPED (with the P7 decision)
  The prior audit (P7) decided the Start CTA should stay always-clickable but soften to secondary until a `direction` or component exists, then promote. The current button (`App.tsx:1510`) carries only the static `prep-begin-btn` class with full ruby gradient + glow + lift in every state (`main-window.css:603`); no `--ready`/`--bare` modifier exists. **Fix:** add a `prep-begin-btn--ready` (or `--bare`) modifier toggled on `direction.trim() || prepComponents.length > 0`; render the resting state as a quieter secondary fill and promote to the full gradient once a plan exists. Keep it clickable in both states.
- **P4. Edit-tooltip overpromises: not the whole note is editable.** [Copy] — DECIDED
  The Game-plan help tooltip says "Click anywhere in the note to edit it" (`App.tsx:1398`), but only the direction textarea (`:1402`), goal textarea (`:1431`), and checklist item textareas (`:1451`) are editable — the divider, "Playbook" label/caption, "Speak to founders" footer, and empty padding do nothing. **Fix:** scope the claim ("Click the brief or any item to edit"), or make the whole note surface focus the nearest editable field on click so the copy becomes true.
- **P5. Caption duplicates the per-playbook description when one is selected.** [UI-visual] — DECIDED
  The always-on caption "Shapes how Ruby helps on this call." (`App.tsx:1489`) sits immediately above the selected skill's own `description` (`.prep-skill-hint`, `App.tsx:1490-1494`) — two stacked 12px-gold explanatory lines saying overlapping things when a described playbook is active. The generic caption earns its place only on "General" (no description). **Fix:** show the generic caption only when no description is present (`{!selectedSkill?.description && <caption/>}`), or merge them into a single line per state.
- **P6. Editable plan fields have no programmatic label.** [A11y] — DECIDED
  The direction (`App.tsx:1402-1410`), goal (`:1431-1433`), and checklist-item textareas (`:1451-1454`) convey their purpose only via a nearby visual kind label and a placeholder — no `aria-label`/`aria-labelledby` — so a screen reader announces them as unlabeled text fields (and placeholders vanish once typed). The chat input and send button on the same screen got aria-labels; the plan editor did not. **Fix:** add `aria-label` to each textarea ("Call brief", "Goal", "Checklist item") or associate via id/`aria-labelledby` with the existing kind labels.

## Part 3 — In-progress

### Medium

- **IP1. Pulsing live dot has no reduced-motion guard.** [A11y] — DECIDED
  `.home-call-dot-live` runs the infinite `home-pulse` animation (`main-window.css:515-518`) and is rendered inside the in-progress live badge (`App.tsx:1549`); neither existing reduced-motion block (`:503`, `:898`) disables it, so a vestibular-sensitive user gets a perpetually animating dot here with no way to stop it. **Fix:** covered by the cross-cutting X3 sweep — add `.home-call-dot-live` (and `.prep-chat-dot`) to a `prefers-reduced-motion` `animation: none` rule; keep the dot a static ruby fill.

### Low / Polish

- **IP2. Finish button column is wider than the plan text column it sits under.** [UI-visual] — DECIDED
  `.pcs-body` is max-width 600px with 32px side padding → a 536px text column, while the footer's `.ip-finish-btn` is max-width 552px centered (`main-window.css:939` vs `1090-1097`). On a wide window the primary CTA is ~16px wider than the game-plan text above it, its edges sitting ~8px outside the text on each side. **Fix:** cap the button (or a wrapping container) at 536px centered, or set the footer inner padding so the button edges line up with the direction/goal/checklist text.
- **IP3. In-progress view never names which call is live.** [Copy] — DROPPED
  The header shows only a generic "Live · timer" badge (`App.tsx:1548-1552`); the only identifying context (the direction) appears below a divider under "Your game plan" (`App.tsx:1563-1568`). **Fix (optional):** surface a short anchor by the Live badge — an attendee name if known, or a truncated first line of the direction — so the header reads as this specific call. Low priority since the direction does appear below.

## Part 4 — Post-call

### Medium

- **PC1. Covered checklist items are struck through, de-emphasizing the success.** [UI-visual] — DECIDED (modified): drop strike-through on covered items AND mute the not-covered ○ items
  `.pcs-coverage-item.done` applies `text-decoration: line-through` + greyed `#b0a898` to topics that WERE covered (`main-window.css:1871`; class applied at `App.tsx:152-156`), while the un-covered ○ items render at full-strength near-black. In a post-call "what you got to" view, the covered topic is the win, but strike-through reads as "cancelled / no longer relevant" — the accomplished items look dismissed. **Fix:** drop the line-through on `.done`; keep the green ✓ as the success signal and leave covered text at normal weight or a calm tone (e.g. `#6e6757`). If anything, mute the NOT-covered (○) items — they're the gap.
- **PC2. Rename affordance is hover-only and has no keyboard focus ring.** [A11y] — DECIDED (modified): faint always-on pencil (~0.35 opacity) + focus ring
  The click-to-edit title's only at-rest signal is the pencil, which is `opacity: 0` until `:hover`/`:focus-visible` (`main-window.css:1207-1214`), and there is no `:focus-visible` outline on `.pcs-title-edit` itself (`App.tsx:1772-1783`). Keyboard and touch users get no persistent hint the 32px serif heading is editable; the new rename feature is close to undiscoverable without hovering. **Fix:** add `.pcs-title-edit:focus-visible { outline: 2px solid #ED0C48; outline-offset: 2px; }`; consider keeping the pencil at a low resting opacity (~0.35) instead of fully hidden so the affordance is always legible. (See also cross-cutting X5/X7.)

### Low / Polish

- **PC3. "Your prep" collapse toggle has no focus-visible ring.** [A11y] — DECIDED
  `.pcs-checklist-head` is the keyboard-focusable button that expands the new "Your prep" section (`main-window.css:1329-1339`; `App.tsx:125`) and correctly carries `aria-expanded`, but has no `:focus-visible` style — inconsistent with `.pcs-tab`, `.pcs-back`, etc. **Fix:** add `.pcs-checklist-head:focus-visible { outline: 2px solid #ED0C48; outline-offset: 2px; border-radius: 4px; }`.
- **PC4. Copy-transcript and memory buttons lack focus-visible rings.** [A11y] — DECIDED
  `.pcs-copy-btn` (`main-window.css:1073-1088`), `.pcs-memory-btn` (`1420-1434`), `.pcs-memory-link` (`1438-1449`), and `.pcs-note-cancel` (`1954-1955`) all define `:hover` but no `:focus-visible`, while `.pcs-tab`/`.pcs-back`/`.pcs-retry-btn` got rings — so keyboard traversal of the recap has dead spots. **Fix:** add `:focus-visible { outline: 2px solid #ED0C48; outline-offset: 2px; }` to each.
- **PC5. Collapsed prep summary can render the bare word "brief".** [Copy] — DECIDED
  The summary is built from parts joined by " · " (`App.tsx:115-121, 127-128`); a call with only a direction (no goal, no checklist) renders the lone string "brief" — a bare lowercase noun that reads like a truncation. **Fix:** special-case `parts.length === 1 && direction` to read "your brief" (or "direction set") so the lone case is self-describing.
- **PC6. Prep block labels are inconsistently possessive.** [Copy] — DECIDED
  Inside the expanded "Your prep" section the three block labels are "Your brief", "Goal", "Checklist" (`App.tsx:138, 144, 150`) — the first possessive, the others bare. **Fix:** drop the possessive under the already-possessive header ("Brief / Goal / Checklist"), or make all three consistent.

## Part 5 — Memory

### Medium

- **M1. "suggested" tag is dead code — no path ever sets `source`.** [Dead-code] — DECIDED (modified): delete the suggested-tag plumbing (field, pill, CSS)
  The list renders a "suggested" pill via `{m.source === "suggested" && …}` and `Mem` declares `source?: "manual" | "suggested"` (`App.tsx:18, 2106`), but the backend `MemoryItem` (`shared/types.ts:47-51`) has only `{id, text, createdAt}`; `addMemory()` never sets `source` and `readMemory()` re-projects to `{id, text, createdAt}` (`memory-store.ts:34-38, 51-63`). Every write path (`App.tsx:418, 455`; `prep-agent.ts:138, 335`) calls `addMemory(text)` with no source, so the pill can never appear. **Fix:** decide intent. If the distinction is wanted: add `source` to `MemoryItem`, default it 'manual' in `addMemory`, have the prep-agent paths pass 'suggested', and stop stripping it in `readMemory`. If not: delete the `source` field (`App.tsx:18`), the conditional render (`App.tsx:2106`), and the `.mem-tag` rule (`main-window.css:1578`).

### Low / Polish

- **M2. Undo re-adds the memory at the bottom with a new id.** [UX-flow] — DECIDED
  `undoDeleteMemory` calls `memory:add` with only `victim.text` and appends the returned item (`App.tsx:451-461`), so the restored item gets a fresh id and `createdAt` and jumps to the end of the list — a visible reorder after an action labelled "Undo" (the code comment at `:434-436` already notes there is no backend soft-delete). **Fix:** restore in place — keep the victim's index on delete and splice it back at that index on undo; at minimum preserve all fields.
- **M3. Clearing an edit input silently no-ops instead of deleting or warning.** [UX-flow] — DECIDED
  `saveMemoryEdit` clears `editingMem` then `if (!text) return;` (`App.tsx:423-432`), so emptying the draft and pressing Enter/blurring (the edit input saves on both, `App.tsx:2095-2099`) silently reverts to the old text with no feedback — a user trying to empty a memory to remove it gets no response. **Fix:** when the draft is emptied, either route to `deleteMemory` (so the undo toast appears) or surface a brief inline hint ("Memory can't be empty — use the trash icon to remove it"). Option (a) is more forgiving.
- **M4. Undo toast has no progress/timeout cue and no manual dismiss.** [UX-flow] — DECIDED
  The toast auto-dismisses after 6000ms (`App.tsx:447`) with no visual indication it is about to disappear and no close affordance — only "Undo" (`App.tsx:2131-2136`). `role=status` + `aria-live=polite` is present but the live text "Memory deleted" doesn't announce that Undo is available. **Fix:** add a subtle countdown/fade and/or a small close (×); phrase the live text "Memory deleted. Undo available."

## Part 6 — Settings

### Medium

- **S1. Status word printed twice on Microphone and Claude rows.** [UI-visual] — DECIDED
  For green rows the value text already carries a green check + the status word AND `set-row-right` renders a matching `set-connected-pill`: Microphone shows value="Allowed" plus pill="Allowed"; Claude Code shows value="Connected" plus pill="Connected" (`App.tsx:2227-2248`, rendered at `:2319-2329`). M12 made the pill a per-row prop but it was wired with the literal same string as the value, defeating the point (the pill color `#1e7a49` even matches `set-val-green`). **Fix:** drop the redundant pill on Mic and Claude rows (the green check + value already communicate OK), reserving the pill for rows whose value isn't the status word (e.g. Account, where value=email).
- **S2. "the relay" is internal jargon in the sign-out confirm.** [Copy] — DECIDED
  The confirm reads "Sign out? You'll need to sign in again to use transcription and the relay." (`App.tsx:2262`) — "the relay" is an implementation term (the Cloudflare/Deepgram relay) meaningless to users and redundant with "transcription". **Fix:** rewrite in user terms, e.g. "Sign out? Ruby won't be able to transcribe your calls until you sign in again." Drop "the relay".

### Low / Polish

- **S3. `set-btn-accent` and `set-btn-danger` are byte-identical.** [UI-visual] — DECIDED (modified): distinct destructive styling (not collapse into accent)
  Both rules are identical (#ED0C48 fill, #c40a3c hover) at `main-window.css:1682-1685`, so "Sign in with Google" / "Grant access" (accent) and the destructive "Sign out" confirm (danger) are visually indistinguishable; the danger button gets no destructive weight and the separate rule is effectively dead. **Fix:** make `set-btn-danger` visually distinct (red outline/ghost or darker/desaturated red) so destructive intent reads differently from the primary brand CTA — or, if ruby == both by design, delete the redundant `.set-btn-danger` rules and apply `.set-btn-accent`. Given a destructive confirm, distinct danger styling is preferable.
- **S4. Signed-in Account row shows "Signed in" twice when email is missing.** [Copy] — DECIDED
  `value = account.signedIn ? account.email ?? "Signed in" : …` and `pill = "Signed in"` (`App.tsx:2255-2257`), so when signed in but email is absent (fallback path), both value and pill read "Signed in". **Fix:** resolved automatically if the pill is removed per S1; otherwise suppress the pill when value falls back to "Signed in" (show it only when an email is present).
- **S5. Truncated email/path values have no tooltip on the Account row.** [UX-flow] — DECIDED
  `.set-val` caps at 320px with ellipsis (`main-window.css:1661`); the Claude row passes `valueTitle={claude.path}` for hover recovery, but the Account row passes no `valueTitle` (`App.tsx:2253-2257`), so a long ellipsized email is unrecoverable. **Fix:** pass `valueTitle={account.email}` on the Account `SettingRow`, mirroring the Claude path treatment.
- **S6. Green check frames analytics data-sharing "On" as a success/correct state.** [UI-visual] — DECIDED
  The privacy row uses `tone="green"` when sharing is On (`App.tsx:2289-2298`), rendering the same success check used for granted-mic/connected-Claude, with Off muted/grey — a subtle nudge toward keeping data-sharing on, where the other green rows denote genuine functional readiness. **Fix:** use a neutral tone for this toggle regardless of state so On/Off read as a user preference, reserving the green check for functional-readiness rows (mic/Claude/account).

## Part 7 — Overlay

### Medium

- **O1. Panel (notes + Finish listening) has zero visual affordance after the expand hint was removed.** [UX-flow] — DROPPED (keep the gem cue-less, per the deliberate removal)
  The expand hint (caret + "N notes" count) was removed, so the only signal that the gem opens the history / Finish-listening panel is the hover title and aria-label (`overlay/App.tsx:393-407`); the pill looks like a pure status indicator and the sole resting interactivity cue is the hover transform (`overlay.css:54`, scale(1.05)). A user who never hovers has no overlay path to the note history or the gem's Finish-listening control. (Not a hard dead-end — the main window's live row also opens an in-progress view with a Finish-listening button — so this is one of two paths, hence Medium.) **Fix:** restore a lightweight always-visible cue while live — a small caret or a count chip on the gem when `history.length > 0` (the existing `.gem-badge` slot, `gem.css:162`), or a subtle bottom handle — so the resting pill communicates "there's more here, click me."

### Low / Polish

- **O2. Calm note tag reads "Ruby" — a name, not a category.** [Copy] — DECIDED (modified): calm tag → "Worth asking" (reverting the old fe1079e change), keep "Ask now" for high urgency
  The calm-note tag chip renders the literal "Ruby" (`overlay/App.tsx:441-443`: `bloom.urgency === "high" ? "Ask now" : "Ruby"`) — the assistant's name, redundant with the gem directly above, saying nothing about why the note appeared (and there is deliberately no `kind` taxonomy in `types.ts`). **Fix:** use a neutral category-style label for the calm chip ("Worth a look" / "Heads up" / "Note"), reserving "Ask now" for high urgency; driven only by urgency, no new field needed.
- **O3. Gem title/aria promise "end call" controls even when there is no call.** [Copy] — DECIDED
  The gem's aria-label ("…click to show notes and call controls", `overlay/App.tsx:400`) and title ("Drag to move • Click for notes & end call", `:401`) always reference call controls, but the End-call button only renders when `liveish || isEnding` (`:493`). During onboarding (sample-nudge review) or idle, clicking opens a panel with no end-call action. **Fix:** make the title/aria-label conditional on `liveish || isEnding` (both already in scope at `:366, :278`): live → "& end call", otherwise "Click to see notes".
- **O4. High-urgency "Ask now" blooms are announced politely, not assertively.** [A11y] — DECIDED
  The bloom is `role="status" aria-live="polite"` for all urgencies (`overlay/App.tsx:421-428`), so a high-urgency note — the one moment meant to preempt — queues behind whatever the screen reader is reading, while the visual layer escalates (thicker/brighter border + flash + "Ask now" tag). **Fix:** make politeness urgency-aware: `aria-live={bloom.urgency === "high" ? "assertive" : "polite"}` and `role={bloom.urgency === "high" ? "alert" : "status"}`.
- **O5. No focus-visible styling on any overlay control.** [A11y] — DECIDED
  The gem button, per-note dismiss ×, and Finish-listening button are custom `<button>`s with no `:focus-visible` rule anywhere in `overlay.css`/`gem.css` (`overlay.css:44-55`; buttons at `.gem` `:44`, `.gem-note-dismiss` `:199`, `.gem-end-btn` `:292`). A keyboard user tabbing the overlay sees no focus indication. **Fix:** add `:focus-visible` outlines for `.gem`, `.gem-note-dismiss`, `.gem-end-btn` (e.g. `outline: 2px solid rgba(255,45,85,0.9); outline-offset: 2px;`). (Kept Low: the overlay is normally click-through, so keyboard focus reaching it is uncommon.)

## Part 8 — Onboarding

### Low / Polish

- **OB1. Welcome copy and the Ruby bubble say the same sentence twice, at the same moment.** [Copy] — DECIDED
  On the welcome step the gem bubble (`App.tsx:258`, matching return at `:218`) shows "Hi, I'm Ruby. I sit in on your calls and whisper the right thing to say, live. Let's get you set up." while the card body (`App.tsx:596`) reads "Ruby sits in on your calls and whispers the right thing to say, live…" — the same core value sentence repeated at the bubble's first impression. **Fix:** make the bubble a shorter voice-driven greeting (e.g. "Hi, I'm Ruby. Let's get you set up — this takes about two minutes.") and keep the value pitch only in the card body.
- **OB2. Welcome tells the user to "watch the pill" but the welcome step does not demo a nudge.** [Copy] — DECIDED
  The welcome body (`App.tsx:595-599`) says "…watch the pill up in the corner.", but the sample-nudge loop runs only on the 'how' step (the useEffect at `:324` is gated to `step === "how"`); welcome shows only the static greeting bubble (`:258`). The instruction lands one screen early, and StepHow (`:619`) repeats the same line where the loop actually runs. **Fix:** drop "watch the pill up in the corner" from the welcome body so the show-don't-tell beat is reserved for the 'how' screen.
- **OB3. Stale "dev reference / pill not yet implemented" comments and unused bubble state.** [Dead-code] — DECIDED
  The comment at `App.tsx:173` ("Ruby copy (dev reference — pill not yet implemented)") is false: `setBubble` drives the real gem overlay via the `onboarding:set-ruby-message` IPC (`:188`, registered at `ipc.ts:234`). The `bubbleText`/`bubbleVisible` state and `setBubbleTextState`/`setBubbleVisible` writes (`:174-175, 198-209`) are never read in any JSX. **Fix:** delete the unused state and its writes (keep the refs and the IPC call); update the comment to describe that `setBubble` pushes narration to the gem overlay.
- **OB4. Dead onboarding CSS for the removed dev bubble and unused action modifier.** [Dead-code] — DECIDED
  `.ob-dev-ruby-copy`/`.ob-dev-ruby-label` (`onboarding.css:554-579`, under a "remove when pill is implemented" comment) and `.ob-actions-right` (`:360-362`) have zero JSX references. **Fix:** remove the dev-bubble block and the `.ob-actions-right` rule. (Same items as cross-cutting X17/X18 — fold into the dead-code sweep.)
- **OB5. Nested aria-live regions can double-announce on screen readers.** [A11y] — DECIDED
  `.ob-step` has `aria-live="polite"` (`App.tsx:512`) and inside it the Claude/mic check rows are each `role="status" aria-live="polite"` (`:669, 677, 692, 766`); when an inner row updates, both regions are live, so VoiceOver may announce twice. Focus is already moved into the step via `stepRef` on each advance (`:353`), making the outer region redundant for the advance-announce. **Fix:** drop `aria-live` from the outer `.ob-step` and rely on the targeted `role="status"` rows.
- **OB6. Claude not-found instructions tell the user to run a command that may not be installed yet.** [UX-flow] — DECIDED
  In the not-found branch the ordered list presents "Install Claude Code: npm install -g @anthropic-ai/claude-code" as step 2 (`App.tsx:699`), with the "Requires Node.js — don't have it? Install Node" prerequisite below the list (`:705-707`). A user without Node runs npm first, hits 'command not found', then discovers the prerequisite — the dependency ordering is backwards. **Fix:** surface the Node prerequisite as the first ordered step ("Make sure Node.js is installed — [Install Node]"), or move the Node line directly above the ordered list.

## Suggested phasing

Phases are ordered cheapest/safest first and are independently shippable, each on `ruby-rebuild` as a self-contained commit. Per house rule, no phase is done until it passes both gates: end-to-end (`npm run typecheck` clean, relevant Playwright spec green, renderer rebuilt) and a physical pass in the real app verified by an independent subagent.

### Phase 1 — Copy & dead-code sweep (no behavior change)
The cheap, low-risk batch. Dead-code: X13–X18, M1 (if dropping the suggested pill), OB3, OB4. Copy: X8–X12 (settle the narrator + the artifact name), H2, P4, PC5, PC6, S2, S4, O2, O3, OB1, OB2, IP3. Add the missing rename test (X19). E2E: assert the new strings; assert no orphaned classes referenced. Physical: read every renamed label across Home, Prep, In-progress, Post-call, Memory, Settings, Onboarding, Overlay.

### Phase 2 — A11y sweep (focus rings, labels, reduced-motion, announcements)
One coherent accessibility pass: focus rings (X1, X7, PC2, PC3, PC4, O5), menu keyboard semantics + Escape (X2), reduced-motion (X3, X4, IP1), accessible names / labels (X5, H5, P6), and live regions (X6, O4, OB5). E2E: keyboard-traversal spec hits every interactive control with a visible ring; reduced-motion media query present. Physical: tab through each surface; toggle OS reduce-motion and confirm dots/blooms freeze; VoiceOver pass on the in-progress status and high-urgency bloom.

### Phase 3 — Home restored-draft reframe (decided H9)
Ship the unshipped decided fix: H1 (copy + primary "Continue prep" + quieter "Start fresh"), folding in H2's register change. Smaller Home items ride along: H3 (anchor live-row title), H4 (coach gating). E2E: restored-draft surface shows "Continue prep", clicking it re-enters the draft with components intact; "Start fresh" still discards. Physical: start a prep, return Home, resume via "Continue prep".

### Phase 4 — Prep & launch-control polish
P1 (error placement near the Start button), P2 (in-flight disabled "Starting…" state), P3 (readiness modifier), P5 (caption dedupe). E2E: double-clicking Start fires `call:start` once; empty-direction error renders by the button. Physical: trigger an empty-direction and a preflight failure; confirm the error is seen and the button locks during start.

### Phase 5 — Post-call & overlay refinements
PC1 (drop strike-through on covered items), S1/S3/S6 (Settings pill/danger/consent framing), O1 (restore the overlay discoverability cue). E2E: covered items render with ✓ and no line-through; Mic/Claude rows show one status word; overlay shows a resting cue while live. Physical: finish a real call, read the recap, confirm covered topics read as wins; on a live call confirm the resting gem signals it is clickable.

### Phase 6 — Memory & remaining flow polish
M2 (restore-in-place undo), M3 (empty-edit handling), M4 (toast countdown/dismiss), S5 (Account tooltip), OB6 (Node prerequisite ordering). E2E: undo restores the memory at its original index; emptying an edit routes to delete-with-undo. Physical: delete + undo a memory and confirm order; walk the no-Claude onboarding branch.