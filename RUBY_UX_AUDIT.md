# Ruby — Full UX / UI / Copy Audit

A surface-by-surface audit of the entire app, aimed at making Ruby delightful and
highly usable. Each finding cites `file:line`, names a category (Copy / UX-flow /
UI-visual / Placement / A11y), a severity, the concrete issue, and a specific fix.

Severity legend: **High** (hurts usability / breaks a promise / dead-end) ·
**Medium** · **Low** · **Polish** (delight).

**Global copy rule (DECIDED):** never use the word **"coaching"** in user-facing copy.
Ruby *nudges* / *whispers the right thing to say* / *helps live*. This applies
everywhere (Memory M1, Prep P8, Onboarding O5, etc.).

Files referenced:
- `app/src/main-window/App.tsx` + `app/src/main-window/main-window.css` (Home, Prep, Live, Post-call, Memory, Settings)
- `app/src/onboarding/App.tsx` + `app/src/onboarding/onboarding.css`
- `app/src/overlay/App.tsx` + `app/src/overlay/overlay.css` + `app/src/shared/Gem.tsx` + `app/src/shared/gem.css`
- `app/src/main-process/summary.ts`

---

## Part 0 — Cross-cutting themes (highest leverage; fix the pattern once)

### X1. "Stop Listening" is confusing — it ends Ruby's session (not the call). [High] — DECIDED
The same control appears on the Live screen (`App.tsx:1103`), the Home topbar
(`App.tsx:614`), and the Overlay (`overlay/App.tsx:433`). All fire `call:end` (full
teardown + recap generation). "Stop Listening" reads as a *reversible* pause and
doesn't signal the recap. "End call" is also wrong — Ruby has no control over the
actual Zoom/Meet call.
**DECISION:**
- The session bracket is **"Start listening"** (the Prep CTA, replacing "Finish prep
  & start listening", `App.tsx:1067`) and **"Finish listening"** / in-progress
  **"Finishing…"** (the teardown button on all three surfaces). "Finish" = a definite
  end (not a pause), keeps the "…listening" symmetry, and stays Ruby-scoped.
- **No pause feature** — out of scope. This strikes the "Pause nudges" toggle from
  L6 and the pause half of V3 (the per-nudge dismiss `×` in V3 stays).
- Confirm-on-finish (X4) still TBD.

### X2. Three surfaces promise live behavior the code never delivers. [High]
- Live screen: "Transcript appears here during the call." (`App.tsx:1142`) and
  "Ruby says: Listening…" (`App.tsx:1147`) are frozen — `LiveScreen` is passed no
  transcript and no nudge data, so they never change for the whole call.
- Overlay: the **gem-with-a-face** (the signature delight element) is never rendered
  on the pill — it draws `RubyLogo`, not `FacedGem` (`Gem.tsx:208-223`). All the
  blink/look/sparkle expressions are dead code on the most-seen surface.
- Overlay: the countdown drain bar is keyed to ~8s but queued notes vanish at 2.5s
  (`overlay/App.tsx:35,173`); the bar is ~70% full when the note disappears.
**Fix:** Wire real data into `LiveScreen` or rewrite the copy to stop implying live
behavior; render `FacedGem` on the pill; drive the drain bar from the note's actual
lifetime.

### X3. The product's core value is the quietest thing; the judgmental thing is loudest. [High]
On the post-call card, Ruby's contribution shows only as a cryptic italic
"↳ after a Ruby nudge" (`App.tsx:1355`), while the one quantified "stat" is a
coverage report card "2 of 5" (`App.tsx:106`) — reintroducing exactly the grading
the summary model deliberately suppresses (`summary.ts:92`).
**Fix:** Invert the emphasis — surface "Ruby helped surface 2 of these," quiet the
coverage fraction to a descriptive "5 topics."

### X4. Destructive actions have no guardrails. [High]
End call (no confirm), delete memory (instant, irreversible, 4px from the edit icon,
`App.tsx:1495`), sign out (instant, styled like a benign button, `App.tsx:1594`).
**Fix:** Confirm-or-undo on all three. An undo toast fits memory-delete best; a
consequence-stating confirm fits sign-out.

### X5. Empty states teach nothing at the moment users need orientation. [High]
- Memory: "No memories yet — add one above." (`App.tsx:1465`) — the only place that
  could explain Memory = coaching preferences, not call notes.
- Home: "No calls yet — start one above." (`App.tsx:705`) — also factually off (you
  go to prep, you don't start a call there).
- Prep: its teaching empty state exists only as **orphaned dead CSS**
  (`.prep-empty-*`, `main-window.css:552`).
**Fix:** Each empty state should define + motivate + show an example.

### X6. Accessibility gaps are systemic. [Medium, but broad]
Across screens: no `:focus-visible` rings (home rows; memory actions reveal on
`:hover` only — keyboard users see nothing); color-only state signals (overlay
urgency is a 0.5→0.85 border-alpha delta; post-call tabs are plain buttons with no
`role="tab"`/`aria-selected`); no `aria-live` on dynamic content (nudge blooms,
"Copied!", "Summarizing…", sign-in errors); sub-44px hit targets (28–30px icon
buttons throughout).
**Fix:** Add focus-visible rings, tablist/tab semantics, aria-live regions, and
expand hit areas to ~40–44px.

### X7. Dead / orphaned code to delete or ship. [Polish]
`.home-wordmark`, `.home-bar-who`, the `prepped` dot (hardcoded `false`),
`.prep-empty-*`, the `prep-mic-pulse` keyframe, the hidden `DragHandle`, the unused
`FacedGem` path. Each signals an abandoned design and clutters the codebase.

---

## Part 1 — Homepage (`home-` classes)

**Cross-cutting note:** the homepage's primary verb is ambiguous — the arrow / Enter
/ "Send" all imply *go*, but the destination is the Prep screen, and there's no
"start a call" affordance on home at all (the live button only exists mid-call).
Findings H1, H8, H9 all stem from this. **DECISION: the model is `type → prep →
Start listening`** — confirmed; make it legible rather than changing it.

### High
- **H1. Send arrow gives no hint it opens Prep, not a call.** [UX-flow/Copy] — DECIDED
  `App.tsx:671-681` (`aria-label="Send"`), placeholder `:658`. Clicking routes to
  Prep (`onSend={enterPrep}`), but `→` + "Send" implies submit/begin.
  **Fix:** `aria-label="Prepare for this call"`, add a visible "Prep →" micro-label
  or `title="Set up your prep"`. Keep the `type → prep → start` model; just signpost it.
- **H2. Past-call rows unreachable by keyboard; lose timestamp on hover.** [A11y]
  `App.tsx:720-732`, CSS `:395-396`. Hover swaps time→arrow via `:hover` only; no
  `:focus-visible` ring; mouse users can't read title + time together.
  **Fix:** Add `.home-call-row:focus-visible { outline: 2px solid #ED0C48; }`;
  mirror the swap on focus; stop hiding the time on hover.
- **H3. Errors float with no context, icon, dismiss, or retry.** [UX-flow/UI]
  `App.tsx:701`, CSS `:281-288`. Lone red sentence with `margin-top:-16px`; no
  indication which action failed.
  **Fix:** Soft inset banner (cream bg, ruby left-border, alert glyph) with
  "Try again" + dismiss; remove the negative top margin.

### Medium
- **H4. First-run empty state wastes the highest-intent moment.** [Copy/UX]
  `App.tsx:705`. "start one above" is wrong and faint.
  **Fix:** e.g. "Your past calls will appear here. Tell Ruby about your next one
  above — even a sentence helps her prep." Add a clickable example prompt.
- **H5. Two different Ruby logos on one screen; wordmark CSS unused.** [UI/Placement]
  Topbar SVG `:606-611` + body `RubyLogo` `:646`; `.home-wordmark` (`CSS:103-109`)
  never rendered. **Fix:** One brand moment per screen — keep topbar wordmark, make
  hero the gem-with-a-face; delete `.home-wordmark`.
- **H6. Summarizing rows can't be distinguished.** [Copy/UX]
  `App.tsx:725-727`. "Untitled call … Summarizing…" with no attendee/duration.
  **Fix:** Use `attendee.name`/prep direction as a provisional anchor; add duration
  (`fmtDur`, `:57`) next to the time, e.g. "2:14 PM · 18 min".
- **H7. "prepped" dot is built but hardcoded off.** [UX/UI] — REPURPOSED
  `App.tsx:717` (`const prepped = false`), CSS `:350-358` styled but never rendered.
  **Decision:** Ship the dot — but its first job is the **live-call indicator** at the
  top of the list (pulsing ruby, "Live · 12:04"), per the Part 3 redesign. A static
  "prepped" variant for finished calls is optional/secondary.
- **H8. Enter-to-send / Shift+Enter undiscoverable.** [Copy/A11y]
  `App.tsx:667-669`. Multi-line serif textarea invites paragraphs; Enter submits.
  **Fix:** Faint focus hint "Enter to continue · Shift+Enter for a new line".
- **H9. "Pinned: a goal · 2 checklist items" + "Start fresh" is cryptic.** [Copy/UX] — DECIDED (tackle)
  `App.tsx:686-696`. Restored-draft surface; "Pinned" is jargon; discard is the only
  verb. **Fix:** Reframe to "Picking up your prep — 1 goal, 2 things to cover." with a
  primary **"Continue prep"** (re-enters the draft) and a quieter "Start fresh".

### Low / Polish
- **H10.** `.home-day-text` uses off-brand cool grey `#b0b0b0` (CSS:318) vs warm
  palette — use `#a89f92`. [UI]
- **H11.** Row hover animates padding 0→12px, sliding the title 12px (CSS:339,348) —
  animate a background inset / transform instead. [UI/Polish]
- **H12.** Home topbar live button (`App.tsx:614-623`) — **DROP entirely** per the
  Part 3 redesign. The live row at the top of the calls list now represents the call;
  "Finish listening" lives on the overlay pill + the in-progress view. [Placement]
- **H13.** 30px topbar/send hit targets (CSS:146-157,265-267) — expand clickable
  area to ~40px. [A11y/Polish]
- **H14.** `.home-bar-who` ("Ruby" label) is styled but never rendered (CSS:230-238) —
  render it (personality touch) or delete. [Polish]

---

## Part 2 — Prep screen (`prep-` classes)

### High
- **P1. Cards pop in with zero animation or signposting.** [UX-flow]
  `App.tsx:1011-1052`, CSS `:650-665`. The most delightful moment (Ruby filling the
  card) happens silently, off-axis from the chat. `prep-mic-pulse` keyframe (CSS:420)
  is applied to nothing. **Fix:** Fade+slide-in on `.prep-comp-block` (~260ms); a
  soft amber flash on first add; an inline chat line ("I jotted a goal into the note →").
- **P2. Empty/first state.** [UX/Copy] — DECIDED (mostly dropped)
  `App.tsx:998-1063`; orphaned `.prep-empty-*` (CSS:552-585). **Decision:** The note is
  **never actually empty** — it's seeded from the Home input box on entry — so the
  "explain the empty note" helper copy is **unnecessary** and we skip it. The only
  action here is to **delete the orphaned `.prep-empty-*` CSS** (rolls into X7). The
  panel is self-explanatory once it carries the user's own words.
- **P3. No "thinking" indicator on the panel side.** [UX-flow]
  `App.tsx:935`. `prepThinking` only renders a "…" bubble in the chat; the panel
  gives no signal a change is about to land there.
  **Fix:** Shimmer / "Ruby is updating your note…" on the sticky-note header.

### Medium
- **P4. "Note to Ruby" is the wrong mental direction.** [Copy] — DECIDED
  `App.tsx:988`. The note is the shared plan Ruby drafts and follows; labeling it
  "Note to Ruby" frames it as one-way user instruction. **Decision:** Rename →
  **"Game plan"**.
- **P5. Goal vs checklist not glanceably distinct.** [UI/Placement]
  `App.tsx:1016-1018,1026-1028`. The uppercase kind label is the only differentiator.
  **Fix:** Add a leading glyph per kind (target for Goal, checkbox for Checklist).
  Keep delete in the overflow menu.
- **P6. Checklist item × contradicts the quiet-delete pattern.** [UI]
  `App.tsx:1038-1040`. Per-item × is always visible while whole-card delete hides in
  a menu — the smaller action is louder. **Fix:** Reveal the × on row hover/focus;
  vertically center it.
- **P7. "Finish prep & start listening" has no readiness signal.** [UX/Copy]
  `App.tsx:1067-1073`. Same prominence whether empty or fully prepped.
  **Fix:** Keep always-clickable; soften to secondary until `direction`/a component
  exists, then promote. Optional empty-state note: "You can start now — Ruby will
  follow along even without a plan."
- **P8. "Playbook" / "No playbook" / "skill" — three names, unexplained empty.** [Copy] — DECIDED
  `App.tsx:1056,797,830`. **Decision:** Keep the user-facing word **"Playbook"**;
  rename the default "No playbook" → **"General"** (the general playbook — reads as a
  deliberate mode, not an absence); add an always-on caption **"Shapes how Ruby helps
  on this call."** (Avoid the word "coaching" in user-facing copy.)

### Low / Polish
- **P9.** Thinking bubble is a static "…" (CSS:485 color-only) — animate 3 dots. [UI]
- **P10.** Chat log lacks `role="log" aria-live="polite"`; send button lacks
  `aria-label` (`App.tsx:929,955`). [A11y]
- **P11.** "Tap on the note to edit it" (`App.tsx:995`) — touch language, hover-only,
  no keyboard path. **Fix:** "Click anywhere in the note to edit it."; trigger on
  `:focus-visible`. [Copy/A11y]
- **P12.** Resize handle flashes full brand-red on hover (CSS:495-496) — use a muted
  tone + resting hairline + grip dots. [UI]
- **P13.** Three placeholder voices/colors in one note (`App.tsx:1003,1021,1035`) —
  unify styling; tighten goal copy. [Copy/UI/Polish]
- **P14.** Warm up empty-chat line + back button (`App.tsx:931,926`): "What's this
  call about? Tell Ruby and she'll help you prep."; consider "← Home". [Copy/Polish]

---

## Part 3 — Live session (REDESIGNED — the dedicated Live screen is cut) — DECIDED

**DECISION:** Delete the dedicated full-window Live screen entirely. It was a weaker
duplicate of the overlay pill with two frozen placeholders (old L1, L3) and nothing
honest to show. The overlay pill is the real in-call surface; the main window doesn't
need a second one.

### New behavior

- **Starting a call** (`Start listening`) returns the main window to **Home**. The
  overlay pill is the in-call surface (gem + nudges + **Finish listening**). The main
  window is backgrounded behind Zoom/Meet anyway, so Home is the natural resting state.
- **The live call appears as the top row of the calls list** with a pulsing ruby dot +
  "Live · 12:04" elapsed timer in place of a timestamp. (Reuses the currently-dead
  `home-call-dot` styling — resolves H7.)
- **Clicking the live row** opens a calm **in-progress view** (reuse the post-call
  shell): the **prep plan** (direction, goal, checklist) shown as quiet read-only
  reference, the elapsed timer, a listening-status line, a "Ruby's listening — your
  recap lands here when you wrap up" message, and the **Finish listening** button.
  Useful (glance at your own game plan mid-call), not a dead-end.
- **"Finish listening"** lives primary on the overlay pill (always visible) and in the
  in-progress view. **Drop the Home-topbar live button** (resolves H12) — the live row
  represents the call now; the topbar stays clean.

### Carried over from the old Live screen into the new in-progress view
- **L4 (→ Medium).** Finish is irreversible/unconfirmed. Per X4, **no confirm** is
  planned (it doesn't end the real call; the recap is non-destructive). Revisit only if
  accidental finishes show up in testing.
- **L7 (→ Copy).** Warm, human empty/status copy in the in-progress view (e.g. no
  direction set → "You didn't set a direction — Ruby's still listening and ready to
  help.").
- **L10 (→ Placement).** Show the direction whenever it's set (not only as a fallback
  when goal/checklist are absent) — it's core context for the read-only plan.
- **L11 (→ Polish).** The "Wrapping up"/finishing state should read as calm success,
  not amber-warning (old CSS:1463-1465) — use neutral/ruby.

### Dropped with the screen
- **L1, L3** — the frozen transcript pane and "Ruby says: Listening…" teleprompter are
  deleted, not fixed.
- **L2** — mic/audio-capture trust cue moves to its proper home: the overlay pill and
  Settings (see V10, M11), not a dedicated live screen.
- **L6** — no pause control (see X1 decision).
- **L8, L9, L12** — moot once the `live-` markup is removed; re-check any styles reused
  by the new in-progress view.

---

## Part 4 — Post-call summary screen (`pcs-` classes)

**Note:** the "surfaced/used nudges stat" and a "questions not asked" block don't
exist in the build — the only stat is the checklist "X of Y" (`App.tsx:106`) and
unasked-question grading is intentionally suppressed (`summary.ts:92`).

### High
- **PC1. The only "stat" is the most judgmental element, mislabeled as a stat.** [Copy/UX]
  `App.tsx:104-106` ("What you planned to cover" + "{covered} of {total}"). Collapsed
  by default → pure score, no context. See X3. **Fix:** Drop the fraction or make it
  descriptive ("5 topics"); label "Your prep checklist".
- **PC2. Ruby's attribution is invisible — a bare `↳` with no legend or count.** [Copy/UI]
  `App.tsx:1355-1356`, CSS `:991`. **Fix:** Add "Ruby helped surface 2 of these."
  (from `insights.filter(i => i.assisted).length`); make the first `↳` a full clause.
- **PC3. Tab toggle has no a11y semantics.** [A11y]
  `App.tsx:1292-1307`. Plain buttons, active state color-only.
  **Fix:** `role="tablist"`/`role="tab"` + `aria-selected`, body `role="tabpanel"`.
- **PC4. Copy-transcript: no aria-label, silent feedback, no failure path.** [A11y/UX]
  `App.tsx:1270-1287,1175-1182`. Only on the Transcript tab; `writeText` has no
  `.catch`. **Fix:** `aria-label`, wrap "Copied!" in `aria-live`, add `.catch`
  ("Couldn't copy"); consider copy on both tabs.

### Medium
- **PC5. "Nothing was captured on this call." is a dead end.** [Copy/UX]
  `App.tsx:1340-1341`. Reads like data loss. **Fix:** "No conversation was captured —
  the call ended before there was anything to transcribe."; branch to mic settings if
  audio never arrived.
- **PC6. "Summarizing this call…" has no duration cue / skeleton.** [Copy/UX]
  `App.tsx:1322-1326`. **Fix:** "…this takes a few seconds. You can leave — it'll be
  here when you're back."; render a greyed recap skeleton.
- **PC7. "Couldn't load this call." is a flat error with no retry.** [UX/Copy]
  `App.tsx:1314` (reuses `.pcs-loading`). **Fix:** Own treatment + "Try again" re-runs
  `readCall`.
- **PC8. Recap (most valuable) has no label; lesser "Insights" does.** [UI/Placement] — DECIDED
  `App.tsx:1345` vs `:1349`. **Decision:** Give the recap a quiet label (**"The gist"**),
  consistent with the "Insights" label below it, so a first-timer knows the serif block
  is the auto-summary.
- **PC9. Memory-note copy doesn't scope to *how Ruby nudges*.** [Copy/Placement] — DECIDED
  `App.tsx:1405-1409`. "Leave an instruction for next time" is vague; a user could
  write a prospect fact (wrong model). **Decision:** Tighten to **"Want Ruby to nudge
  differently? Leave a note and it'll adjust next call."** (No change to
  discoverability/auto-prompt — stays quiet and user-authored.)
- **PC10. "Saved to memory" is terminal — no view/edit/undo.** [UX-flow]
  `App.tsx:1366-1377`. **Fix:** Add quiet "View" / "Undo" linking to the Memory screen.

### Low / Polish
- **PC11.** Copy export uses "Them:" and drops timestamps (`App.tsx:1177,139,141`) —
  use attendee name + `mm:ss`. [Copy]
- **PC12.** "← Back" doesn't name the destination (`App.tsx:1268`) — "← All calls". [Copy]
- **PC13.** Raw-log fallback leaks dev language to users on legacy logs
  (`App.tsx:1333`, `pcs-raw`) — show "This call was recorded before summaries — here's
  the transcript." and render the transcript; gate the raw dump behind a dev flag. [Copy]
- **PC14.** Floating tab pill clearance is a magic number (CSS:738 vs 848) — verify at
  small heights; derive from a shared var. [UI/Polish]
- **PC15.** Inactive tab `#a09080` / meta `#b0a898` likely below AA on cream
  (CSS:761,896,1014) — darken; pair active tab with weight/underline. [A11y/Polish]

---

## Part 5 — Memory & Settings (`fullscreen-`, `mem-`, `set-` classes)

### High
- **M1. Memory empty state doesn't explain what Memory IS or why to use it.** [Copy/UX] — DECIDED
  `App.tsx:1465-1470`. "Memory" + a heart/pin icon implies saved call facts; it's
  actually nudge preferences. **Decision:** Titled empty state, using "nudge" (not
  "coaching"):
  > **Teach Ruby how to nudge you**
  > Memories are standing notes about how Ruby nudges you — they apply to every call.
  > For example: "Don't interrupt when I'm mid-sentence" or "Push me harder on pricing."

  Also swap the existing intro line "Tell Ruby how to coach you" → "Tell Ruby how to
  nudge you" (avoid "coaching" in user-facing copy everywhere). Replace the heart/pin
  icon with the **SD-card icon** (`~/Downloads/device-sd-card.svg`, tabler
  `device-sd-card`) — reads as "memory/storage."
- **M2. Delete memory is instant, irreversible, 4px from edit.** [UX-flow]
  `App.tsx:1495-1502` → `:342-346`, CSS gap `:1186`. **Fix:** Undo toast (preferred)
  or a confirm; widen the gap to ≥8px.
- **M3. Sign out is instant with no confirm, styled benign.** [UX-flow]
  `App.tsx:1594`. **Fix:** Confirm stating the consequence ("You'll need to sign in
  again to use transcription/relay.").

### Medium
- **M4. Audio-device picker & model selection are absent.** [UX/Placement] — DECIDED
  `App.tsx:1576-1604` has only Microphone, Claude Code, Account, Hotkey, Debug logs.
  **How capture works today (verified):** the Swift sidecar's `MicCapture` binds to
  `AVAudioEngine().inputNode`, which always follows the **macOS default input device**.
  There is **no device argument** — the sidecar CLI only takes `--target-pid` /
  `--target-bundle` (the system-audio *tap* target for "them"). The sidecar already
  auto-rebuilds when the OS default input changes mid-call
  (`AVAudioEngineConfigurationChange`, MicCapture.swift:46-64).
  **Decision:** **Defer the in-app picker** — a true picker is a non-trivial
  cross-boundary feature (renderer `enumerateDevices` → pass a device UID → Swift AUHAL
  `kAudioOutputUnitProperty_CurrentDevice` + WebRTC-deviceId↔CoreAudio-UID mapping).
  For launch, **rely on the macOS default input** and make it *legible*: show
  "Listening to: <default input name>" on the Microphone row so the user knows which
  device is live and that switching it = switch the system default. **Defer model
  selection** (keep the best default). [Revisit a real picker post-launch.]
- **M4b. Gate the "Debug logs" row behind the debug flag.** [UI/hygiene] — DECIDED
  `App.tsx:1601-1602` always renders a "Debug logs" row pointing at `~/.prompty/debug`.
  The backend already has a `PROMPTY_DEBUG=1` switch (`debug-logger.ts:46`).
  **Decision:** Only render this row when debug is on. Expose the flag to the renderer
  (e.g. a `debug:enabled` IPC / a field on `window.prompty`) and conditionally render
  the row; remove it from the default user-facing Settings.
- **M5. "Claude Code" row exposes a raw filesystem path.** [Copy/UI]
  `App.tsx:1583`, truncated CSS `:1215`. **Fix:** Show "Connected"/"Not found"; move
  the path to a tooltip; add a one-line "what Claude Code is and why it's required".
- **M6. Settings groups have no headers.** [UX/Placement]
  `App.tsx:1576,1587,1599`. **Fix:** Uppercase headers ("PERMISSIONS", "ACCOUNT",
  "ADVANCED") reusing `.mem-section-label`.
- **M7. Hit targets <44px; edit/delete only appear on `:hover` (mouse-only).** [UI/A11y]
  CSS `:1183-1190,1194,1142`. **Fix:** Reveal on `:hover, :focus-within`; bump buttons
  to ~32px; visible focus rings.
- **M8. Edit saves on blur with no visible Save/Cancel.** [UX-flow]
  `App.tsx:1480-1483`. Hidden modality (Enter=save, Esc=cancel, click-away=save).
  **Fix:** Inline "Save"/"Cancel" or a hint "Enter to save · Esc to cancel".

### Low / Polish
- **M9.** Add-memory input has no `aria-label`; Enter-to-add unhinted
  (`App.tsx:1449-1456`). [Copy/A11y]
- **M10.** "Hotkey — nudge on demand" row is read-only and unexplained
  (`App.tsx:1600`) — add "Press anywhere to ask Ruby for a nudge mid-call." [Copy/UX]
- **M11.** Mic status shows raw enums ("granted"/"denied"/"restricted")
  (`App.tsx:1577`) — map to "Allowed"/"Blocked"/"Restricted by your device". [Copy]
- **M12.** "Connected" pill is hardcoded for all green rows (`App.tsx:1625`) — wrong
  for Account ("Signed in") / mic ("Allowed"); make it a per-row prop. [Copy]
- **M13.** Settings reuses `.mem-title` (`App.tsx:1575`) — promote to a shared
  `.fullscreen-h1`. [UI/hygiene]
- **M14.** Settings has no intro line while Memory does (`App.tsx:1575-1576`) — add one
  or leave deliberately bare. [Copy/Polish]

---

## Part 6 — Onboarding (`ob-` classes; separate window)

**Most fragile surface — real dead-ends for a meaningful slice of first-run users.**
Original step order: `["welcome", "claude", "mic", "hotkey", "signin"]`.

### REDESIGN (DECIDED) — teach the loop, then set up, then start

The original flow is **all mechanical setup and explains none of the product** — a user
finishes knowing Ruby can hear them but with no idea what Prep is, that playbooks exist,
that a pill whispers nudges, or that there's a recap and a memory. New shape:

**Act 1 — What Ruby does**
1. **Welcome** — one-line pitch ("Ruby sits in on your calls and whispers the right
   thing to say, live."). Show the faced gem; a real sample nudge blooms from the pill
   (show-don't-tell; onboarding can already drive the gem + sample nudges).
2. **How Ruby works** — a **single screen** (DECIDED — not a multi-step walkthrough)
   naming the four moments the old flow never mentions. Static teaching, with **one live
   element: moment 2 renders the actual overlay pill + an animating sample nudge** on a
   gentle loop (the magic moment is the only one worth demoing; Prep/Recap/Memory stay
   as crisp copy). Numbered list (it's a sequence/loop), the gem reappears up top, one
   "Continue" CTA, no skip. Heading "How Ruby works". Copy per moment:
   - **1 Prep** — Tell Ruby what the call's about and pick a playbook for the kind of call.
   - **2 Live** — Ruby listens and whispers the right thing to say through a little
     floating pill. *(live pill + sample nudge shown beside this line)*
   - **3 Recap** — Finish the call and Ruby writes up what was said — and what surfaced.
   - **4 Memory** — Tell Ruby how you like to be nudged. It sticks across every call.
   *(A full active walkthrough is explicitly deferred — revisit post-launch only if
   activation data shows people finish onboarding but don't start a first call.)*

**Act 2 — Set up (each step framed by the value it unlocks, not a raw permission)**
3. **Claude Code** — "Ruby thinks with Claude Code." *(skip-forward, O2)*
4. **Microphone** — "So Ruby can hear your side of the call." *(quiet skip, O4)*
5. **Hotkey** — "Press ⌥⇧Space anytime to ask Ruby for a nudge."
6. **Sign in** — "Save your recaps and let your memory follow you." *(stays last, O1)*

**Act 3 — Start**
7. **You're set** — "Got a call coming up? Tell Ruby about it." → drops into Home with
   the **prep bar focused** (no practice round — DECIDED), instead of a cold empty Home.

The findings below (O1–O15) still apply *within* this new structure — they describe the
setup steps (Acts 2–3) that carry over.

### High
- **O1. Step order.** [UX-flow] — DECIDED (keep current order)
  `App.tsx:6` (`welcome → claude → mic → hotkey → signin`).
  **Decision:** **Do NOT reorder. Keep sign-in last.** An early auth wall is a
  conversion drop-off point — that outweighs the "value before commitment" argument.
  Mic stays where it is (users expect a mic ask — it's the whole point of Ruby). The
  only ordering fix is removing the Claude-install *dead-end* (O2), not moving steps.
- **O2. Claude-install step is a hard dead-end with no skip.** [UX-flow] — DECIDED
  `App.tsx:514-542`. Only "Check again" / "Open Terminal"; a user without Node is fully
  stuck. **Decision:** **Allow moving ahead without Claude Code.** Add a "I'll set this
  up later →" valve (mirroring the hotkey skip, `:665-669`) so users can finish
  onboarding, sign in, and explore. **Gate call-starting in-app** behind a clear
  "Finish setup: connect Claude Code" prompt (calls won't work until it's installed,
  but the user isn't trapped). Add the missing prerequisite line: "Requires Node.js —
  don't have it? [link]".
- **O3. No way to go back — strictly one-directional.** [UX-flow]
  `App.tsx:289-307` (`advance` only increments). Only a dev "Restart onboarding"
  (`:706-708`). Progress bar isn't interactive.
  **Fix:** Subtle back chevron (hidden on step 0) wired to a `goBack()`.
- **O4. Mic is skippable (quietly) + denied/restricted recovery.** [UX-flow] — DECIDED
  `App.tsx:562,588-600`. Continue (`micGranted`) is the only way forward; denied path
  gives no guidance. **Decision:** **Make the mic step skippable, but quietly** — a
  delayed, low-emphasis "I'll allow it later" link (same pattern as Claude/hotkey),
  NOT a button competing with Continue (onboarding is the highest-intent moment to
  grant; an equal-weight skip would tank grant rates and ship users into a silent
  first call). Two guardrails make the skip safe:
  1. **Denied/restricted branch must never trap** — add guidance ("Find Ruby in the
     list and toggle the microphone on, then come back here.") AND the same
     continue-anyway escape.
  2. **Hard re-prompt at call-start** — when "Start listening" fires without mic
     access, surface "Ruby can't hear you — allow microphone access" (rides the same
     in-app gate as the Claude check, O2). The hook exists: mic auth is already checked
     at capture start (`MicCapture.swift:39-42`).

### Medium
- **O5. Mic step undersells *why* and has a grammar error.** [Copy] — DECIDED
  `App.tsx:570-573` ("That's all. no screen recording…"). **Decision (no "coaching"):**
  "Ruby needs your microphone so she can hear your side of a call and whisper the right
  thing to say, live. That's the only permission she needs — no screen recording, no
  camera, nothing else. Everything stays on your machine."
- **O6. "One permission." is misleading.** [Copy]
  `App.tsx:569`. The flow already needed a Claude install + will need hotkey + sign-in,
  and system-audio later. **Fix:** "Just the microphone."
- **O7. Welcome doesn't establish value before the install ask; she/it pronoun drift.** [Copy]
  `App.tsx:454-459` vs `:486-488`. **Fix:** Standardize "she/her"; add a one-line
  value beat before "Get started."
- **O8. No "step N of M"; progress bar low-contrast/ambiguous.** [UI]
  `App.tsx:73-84,400`, CSS `:77-79`. **Fix:** "Step 3 of 5" label; bump active-segment
  contrast.
- **O9. A11y: color/glyph-only status, unlabeled SVGs, no focus management.** [A11y]
  `App.tsx:494-518,73-84,10-58`. **Fix:** `role="status" aria-live` on check rows;
  `role="progressbar"` + values; `aria-hidden` on decorative icons; move focus to the
  step `<h1>` after each `advance()`.
- **O10. Sign-in error feedback routes only through the unimplemented bubble.** [UX-flow]
  `App.tsx:351-357,362-368`; bubble "not yet implemented" (`:141`). In the shipping
  build a failed Google sign-in shows **nothing** in the card.
  **Fix:** Render auth errors as visible inline text in the card; don't depend on an
  unbuilt surface.

### Low / Polish
- **O11.** Hotkey "Skip for now" only appears after 10s (`App.tsx:255-257,665-669`) —
  drop to ~4-5s or show a low-emphasis skip immediately. [UX-flow]
- **O12.** "Ruby only listens during an active session." (`App.tsx:609`) but
  onboarding runs a mic probe (`:321-330`) — "After setup, Ruby only listens during
  an active session." [Copy]
- **O13.** "More AI agents coming soon" only shows in the not-found state
  (`App.tsx:540`); Terminal opened via hardcoded `file://` (`:535`) — move the note to
  success/welcome; prefer `open -a Terminal` with a fallback. [Copy/UX]
- **O14.** "Last step." (`:689`) + bubble "Almost there." (`:199`) duplicate;
  "save your calls, memory, and recap history" (`:691`) vs "stay on your device"
  (`:701`) reads contradictory — clarify what the account saves vs what stays local. [Copy/Polish]
- **O15.** "Restart onboarding (dev)" (`App.tsx:705-708`) ships to real users on the
  sign-in screen — gate behind `import.meta.env.DEV`. [UI/Polish]

---

## Part 7 — Overlay / nudge pill / gem (`overlay/`, `shared/Gem`)

**The most-seen in-call surface.** Biggest miss: the gem-with-a-face never appears
(the pill renders `RubyLogo`, not `FacedGem`).

### High
- **V1. Nudge body has no minimum on-screen guarantee under queue pressure.** [UX-flow]
  `App.tsx:173-188`, `:35` (`DEFAULT_DWELL_MS=2500`). Queued notes replace after 2.5s
  while the drain bar is keyed to `hideMs` (8000) — the bar is ~70% full when the note
  vanishes. **Fix:** Drive the bar's `animationDuration` from the note's actual
  lifetime (`dwellMs` when queued, `hideMs` when not); consider a ~4000ms floor.
- **V2. Tag is hardcoded "Worth asking" — can't distinguish a question from a fact.** [Copy]
  `App.tsx:380`. If Ruby surfaces an answer/fact, the tag mislabels it.
  **Fix:** Drive from kind — "Worth asking" (question) / "Good to know" (answer) /
  "Ask now" (high urgency). If no kind in the model yet, soften to neutral "Ruby".
- **V3. No way to dismiss or snooze a nudge.** [UX-flow]
  `App.tsx:374-390`. A wrong/already-covered nudge mid-sentence must be waited out.
  **Fix:** A faint `×` (or click-to-dismiss) that calls `advance()`; a "Pause nudges"
  toggle in the expanded panel.
- **V4. Urgency is a barely-perceptible, color-only border-alpha delta.** [UI]
  `gem.css:104-123` (0.5→0.85, same hue). **Fix:** Non-color cue — one-shot pulse on
  bloom-in, distinct "Ask now" tag, thicker/full-saturation border; redundant label so
  urgency never rides on hue alone.

### Medium
- **V5. The signature faced gem is never rendered on the pill.** [UI]
  `Gem.tsx:208-223` draws `RubyLogo`; `Face`/`Eyes`/`pgemMotion` (`:59-128`) only reach
  `variant="bare"/"mini"`. `App.tsx:351` passes `variant="pill"`. **Fix:** Render
  `<FacedGem state={state} size={26} />` in the pill — the highest-leverage delight fix;
  the machinery already exists.
- **V6. `worth-asking` ignores urgency on the face.** [UX-flow]
  `App.tsx:313-325`. High-urgency and calm nudges drive the same `"worth-asking"`
  state. **Fix:** `bloom.urgency === "high" ? "attention" : "worth-asking"`.
- **V7. "No notes yet this call." shows during onboarding where there is no call.** [Copy]
  `App.tsx:399` (panel reachable in onboarding, `:421-423`). **Fix:** Context-aware off
  `liveish` — live: "Nothing worth flagging yet — Ruby's listening."; else: "Notes
  Ruby surfaces will collect here."
- **V8. Expand affordance is a bare 0.4-alpha `⌄`; End-call is hidden behind it.** [UX-flow]
  `App.tsx:365-369`, CSS `:175-187`; suppressed while a bloom shows. **Fix:** Persistent,
  slightly stronger affordance whenever live; `title`/`aria` "Click to see notes & end
  call"; a count badge ("3 notes").
- **V9. Drag affordance is invisible; `DragHandle` is `display:none`.** [Placement]
  `gem.css:55-60`; `overlay.css:40-43`. **Fix:** Hover grip / first-session "drag to
  move" tooltip; `title="Drag to move • Click for notes"`.
- **V10. Gem `aria-label` exposes status but not the action; blooms not announced.** [Copy/A11y]
  `App.tsx:346`. **Fix:** `aria-label="Ruby — {status}. Show notes and call controls."`;
  `role="status" aria-live="polite"` on `.gem-bloom`.

### Low / Polish
- **V11.** "Stop Listening" fires `call:end` (`App.tsx:433`) — see X1; rename "End call". [Copy]
- **V12.** Glowing animated drain bar pulls peripheral attention even on calm notes
  (`App.tsx:382-388`, CSS `:149-172`) — reserve the bar for high-urgency; drop the glow. [UI]
- **V13.** Nudge text has no line-clamp (`App.tsx:381`, `.gem-note-q` CSS:142-147); a long
  note grows the always-on-top pill into a wall of text — `-webkit-line-clamp: 2`. [UI]
- **V14.** Blooms animate in but exit with a hard cut (`App.tsx:168,182`; `gem-bloom-in`
  CSS:124-127) — add an exit fade. [Polish]
- **V15.** Idle gem is greyed but the waveform can still animate (`App.tsx:351`,
  `gem.css:85-87`) — tie `waveActive` strictly to actual listening. [Polish]

---

## Phased execution plan

Work proceeds in ordered phases. **A phase is not "done" until it passes BOTH gates:**
1. **End-to-end (automated):** `npm run typecheck` clean, the relevant Playwright e2e
   spec(s) added/updated and green (`npx playwright test <spec>`), and the renderer
   rebuilt (`npm run build:renderer`) so e2e runs against the new code.
2. **Physical (manual, in the real app):** launch the actual app and drive the changed
   surface by hand — observe the behavior, don't just trust the test. Per house rule,
   verify with an **independent Playwright pass driven by a different subagent than the
   one that built the phase** (see `[[feedback_independent_playwright_verification]]`),
   and never report a phase complete without running it end-to-end
   (`[[feedback_verify_before_done]]`).

Each phase is a self-contained commit (or small PR) on `ruby-rebuild`. Do not start a
phase until the previous one has passed both gates.

---

### Phase 1 — Copy, naming & dead-code sweep (no behavior change)
**Scope:** X1 rename (**Start/Finish listening** on all 3 surfaces), global **no-"coaching"**
swaps, X5 empty-state copy (Memory M1, Home H4), Prep **P4 "Game plan"** + **P8 "General"**
+ caption, Memory **M1 SD-card icon**, Home **H1 signpost** + **H8 hint**, Post-call
**PC8 "The gist"** + **PC9** note copy + **PC12 "← All calls"** + **PC5** empty copy,
**X7 dead code** delete (`.home-wordmark`, `.home-bar-who`, `.prep-empty-*`,
`prep-mic-pulse`, hidden `DragHandle`).
**E2E:** update existing post-call/prep specs for new strings; assert no "coaching"
appears; assert button reads "Finish listening".
**Physical:** open app → Home, Prep, Memory, Settings, post-call card; confirm every
renamed label/copy reads correctly and nothing references the deleted CSS.

### Phase 2 — Overlay & gem (delight)
**Scope:** **V5 faced gem on the pill** (biggest delight win), **V1** honest drain bar,
**V2** kind-aware tags, **V3** per-nudge dismiss, **V4/V6** real urgency cue + face
escalation, **V7** onboarding "no notes" context copy, **V8/V9** expand+drag
affordances, **V10** gem aria + bloom announce, **V11–V15** polish.
**E2E:** overlay spec — sample nudge blooms, dismiss removes it, high-urgency renders
the distinct cue, drain duration matches the note lifetime.
**Physical:** start a real call (or onboarding sample-nudge path); watch nudges bloom,
dismiss one mid-call, confirm the gem face expresses state and high-urgency is
glanceable.

### Phase 3 — Cut the Live screen → Home live-row + in-progress view (structural)
**Scope:** delete `LiveScreen`; **live call as top row of Home** (pulsing dot + "Live ·
mm:ss", reuses `home-call-dot` / H7); **in-progress view** backed by the prep plan with
**Finish listening**; **drop Home-topbar live button** (H12); carry **L4/L7/L10/L11**.
Depends on Phase 1 (uses "Finish listening").
**E2E:** start-call flow returns to Home; live row present with timer; clicking it opens
the in-progress view; Finish transitions to summarizing→recap.
**Physical:** run a real call end-to-end — start → main window returns to Home → live
row ticks → open in-progress view (see the plan) → Finish listening → recap appears.
This is the highest-risk phase; verify the full loop by hand.

### Phase 4 — Post-call summary rework
**Scope:** **PC1/PC2 (X3)** soften coverage → "5 topics" + add "Ruby helped surface N",
**PC6** summarizing skeleton/reassurance, **PC7** load-error retry, **PC10** note
View/Undo, **PC11** transcript export (attendee name + timestamps), **PC13** legacy
raw-log fallback, **PC3/PC4/PC15** tab+copy a11y.
**E2E:** assert the attribution line, the descriptive topic count, retry re-runs load,
copy-failure path; extend the existing no-transcript/legacy specs.
**Physical:** finish a real call → read the recap; trigger a load error; save a note and
use Undo; copy the transcript and paste it.

### Phase 5 — Prep interaction polish
**Scope:** **P1** card entry animation + amber flash + chat narration line, **P3**
panel "updating…" shimmer, **P5** kind glyphs, **P6** item-× hover reveal, **P9**
animated thinking dots, **P11** "Click…" copy + focus, **P12** resize handle, **P13/P14**
placeholder/copy unification, **P10** a11y.
**E2E:** prep spec — components render with the animation class; per-item × appears on
hover/focus.
**Physical:** run a prep chat; watch a goal/checklist animate in as Ruby drafts it;
add/remove items; confirm the moment feels alive.

### Phase 6 — Onboarding redesign
**Scope:** the full **Act 1–3 restructure** (Welcome live demo → teach-the-loop single
screen with live pill in moment 2 → value-framed setup → drop into focused prep),
**O2** Claude skip-forward + in-app gate + Node note, **O4** quiet mic skip + call-start
re-prompt, **O10** inline sign-in error, **O3** back nav, **O8** progress label, **O9**
a11y, **O15** dev-button gate, **O5/O6/O7/O11–O14** copy.
**E2E:** onboarding spec — each step advances/back-navigates; skip-forward paths work;
sign-in failure shows inline error; dev button absent in prod build.
**Physical:** run first-run onboarding cold, including the **deny-mic path**, the
**no-Claude path**, and a **failed sign-in** — confirm none dead-end, and finishing
drops you into a focused prep bar.

### Phase 7 — Settings legibility + a11y sweep + final cleanup
**Scope:** **M4** "Listening to: <default input>" on the mic row (no picker), **M4b**
debug-row gated behind `PROMPTY_DEBUG`, **M5** Claude-row status, **M6** group headers,
**M11/M12** enum→friendly + per-row pill, **M2/M3** undo/confirm, **M7/M8/M9/M10**,
then the cross-cutting **X6 a11y sweep** (focus rings, tab semantics, aria-live, 44px
targets) across every surface, and **H-series polish** (H3 error banner, H6 row anchor,
H10/H11 visual).
**E2E:** settings spec — debug row hidden without the flag; delete-memory undo; sign-out
confirm; keyboard focus traverses interactive elements.
**Physical:** walk Settings; toggle `PROMPTY_DEBUG`; delete a memory and undo; tab
through each screen with the keyboard and confirm visible focus + reachable controls.
