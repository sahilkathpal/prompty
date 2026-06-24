# Ruby — Onboarding Rethink (Implementation Spec)

**Date:** 2026-06-23
**Status:** Decided, ready to implement. Not started.
**Visual mock:** `design/onboarding-redesign.html` (real screenshots + drawn proposals for the two net-new surfaces). Screenshots captured from the built app live in `design/shots/`.

---

## 1. Problem

New users complete the 7-step onboarding wizard and then **freeze at the first real screen** (the blank prep input): *"what do I type here?"*. The wizard's concept-teaching does not transfer to real use.

This is a named, studied failure mode, not a copy problem:
- Upfront tutorials are "push revelations" — interrupted, out of context, forgotten by the time they're relevant (NN/g; *Paradox of the Active User*).
- Onboarding completion collapses with step count: ~3-step flows complete ~72%, **7+ steps ≈ 16%** (Appcues/Chameleon; corroborated by Pendo). The current 7-step wizard sits in the collapse zone.
- The two closest analogues — **Granola** (AI meeting notes) and **Cluely** (live-call overlay) — both go self-serve, permission-first, then launch straight into the first real call with **no concept tour**.

## 2. Principle

**Keep irreducible setup upfront; teach concepts in the journey, at the moment each becomes true.** Split the wizard by type:
- **Gates** (Claude, sign-in, mic) — keep, primed, lean.
- **Teaching slides** (welcome / "How Ruby works" / hotkey-demo) — cut; re-home the one useful piece (hotkey) into the live call.
- **The freeze** — fixed by the journey itself + existing empty-state scaffolding (the first-run coach already ships).

## 3. The shape

```
Hook (hero demo) → Claude → Sign-in → Mic  →  [land in the real app]
                   └─ lean primed gate ─┘       Home → Prep → Playbook → Start
                                                 → Live (ready primer) → Recap → Memory
```

"Onboarding" stops being a screen with a start and end. It becomes **one tiny gate + first-run scaffolding distributed across the real journey.**

---

## 4. Changes (the only work)

Each item: **what / where / today / target / copy / acceptance.** Everything not listed here is explicitly unchanged (§5).

### C1 — Hook: replace the welcome slide with a hero demo  · NET-NEW
- **Where:** `app/src/onboarding/App.tsx` `StepWelcome` (~line 586); `onboarding.css`.
- **Today:** text slide — "Meet Ruby." + a paragraph + "Get started →".
- **Target:** a single screen with a **looping hero of the magic moment** — the gem whispering a nudge mid-call — over one line of value copy + "Get started →". Reuse the real bloom material (`.gem-bloom` / `.gem-note-tag` / `.gem-note-q` from `overlay.css`) so the demo matches the live artifact. Show *only* the magic; no mechanics, no feature list.
- **Copy:** headline "Ruby listens and whispers the right thing to say — live." · sub "She preps you before the call, sits in while you talk, and writes the recap after. Everything runs on your machine."
- **Acceptance:** welcome step shows an animated/looping nudge demo; no 4-moment teaching; "Get started →" advances to Claude.

### C2 — Cut the teaching slides  · CUT
- **Where:** `app/src/onboarding/App.tsx` — remove `StepHow` (~608) and `StepHotkey` (~817) as standalone steps; drop their entries from the step sequence and the "Step N of 7" progress (becomes 4 of 4 or unnumbered). Remove the now-unused `onboarding:arm-hotkey` / `onboarding:fire-nudge` demo wiring **only if** not reused by C5 (the live primer can reuse the same bloom path).
- **Today:** Step 2 "How Ruby works" (4 moments), Step 5 hotkey demo.
- **Target:** both gone from setup. The hotkey is taught live (C5).
- **Acceptance:** onboarding never renders "How Ruby works" or a pre-use hotkey demo; e2e `onboarding.spec.ts` updated to the new sequence.

### C3 — Gate order + priming  · CHANGE (reorder)
- **Where:** `app/src/onboarding/App.tsx` step order; `StepClaude` (~637), `StepSignin` (~877), `StepMic` (~730).
- **Today:** Claude → Mic → Hotkey → Sign-in → Done.
- **Target:** **Claude → Sign-in → Mic → Done.** All three gates already carry priming copy; keep it. Mic stays **upfront** (see C4). Each gate keeps its delayed low-emphasis escape valve ("set this up later").
- **Acceptance:** setup runs Claude, then Google sign-in, then mic, then done; sign-in still gates completion (`onboarding:complete`, `ipc-handlers.ts` ~815).

### C4 — Mic stays upfront, primed  · CHANGE (do NOT defer)
- **Where:** `StepMic` (~730); `onboarding:request-mic` (`ipc-handlers.ts` ~719).
- **Decision:** Mic is **not** deferred to call-start. Rationale: the macOS mic prompt is one-shot — a denial at call-start strands the user mid-call with no in-flow recovery (must leave to System Settings). A primed upfront ask (Apple HIG; CHI'14 rationale lift +12–81%) is far safer. Keep current copy ("Just the microphone…").
- **Acceptance:** mic is requested during setup with a rationale string, before any live call; call-start never triggers the OS mic prompt.

### C5 — Live "ready" primer (re-homes the hotkey lesson)  · NET-NEW
- **Where:** `app/src/overlay/App.tsx`; gated on a first-run flag (new `firstCallCoach` setting, mirror of `firstRunCoach` in `settings-store.ts` / `types.ts`).
- **Today:** no primer; the gem just appears.
- **Target:** on the **first call only**, in the pre-conversation window (right after "Start listening", before the conversation), a single **non-blocking** primer near the gem, then it retires. Auto-nudges self-teach thereafter; the hotkey is hinted once here and may be reinforced on later calls (hotkeys stick via repeated exposure, not one demo). **No mid-call distractions** of any kind.
- **Copy:** tag "Ruby · listening" · "I'll whisper when I catch something worth saying." · "Want one now? ⌥⇧Space" · footnote "Shown once, on your first call."
- **Acceptance:** primer renders once on first live session, never blocks, never reappears; subsequent calls show nothing extra.

### C6 — Enrich the playbook rows  · CHANGE (no flow change)
- **Where:** `app/src/main-window/App.tsx` `SkillDropdown` (~1203–1273) and the playbook section of the prep sidebar (~1531–1568); playbook source `app/src/main-process/prompts/skills/{discovery,hiring,user-interview}/in-call.md` frontmatter; loader `loader.ts` (~116–129).
- **Today:** the dropdown lives inside the yellow Game Plan sticky and lists **bare names** (General / Sales discovery / Hiring interview / User interview (Mom Test)). Selection is explicit and sticky. `SkillInfo` already carries `title` + `description` (`types.ts` ~159).
- **Target:** each row shows **a one-line "what Ruby does" + a sample nudge.** Add a `sample` field to each skill's frontmatter (or derive from `description`). Add a first-run-only "What's a playbook?" line above the list. **No structural/flow change** — same dropdown, same place, collapsed at rest; richness shows only while the menu is open.
- **Copy (examples):** Sales discovery — "Pushes you to uncover pain & qualify before you pitch." · sample "Ask what they've already tried". · "What's a playbook? It shapes what Ruby listens for & nudges on."
- **Acceptance:** opening the playbook dropdown shows description + sample per option; resting sidebar layout unchanged; first-run "what's a playbook" line retires after first call.

### C7 — End the call on hover, not a hidden click  · CHANGE
- **Where:** `app/src/overlay/App.tsx` (expand trigger; `gem-end-btn` "Finish listening" ~495–503); `overlay.css`.
- **Today:** the notes panel — which contains the **only** "Finish listening" control — opens on an **ambiguous click** of the gem. Collapsed state has no end affordance. (User's "hidden behind a click".)
- **Target:** the panel (history + Finish) **expands on hover**; **click pins it open**; both gestures reveal the same panel (no lost behavior). Add a one-time first-run hint near the gem: *"Hover for notes, or to end."* No rehoming to the main window, no in-progress-view change.
- **Acceptance:** hovering the gem reveals the panel with Finish without a click; click still pins; first-run hint shows once; `overlay-end-call.spec.ts` / `gem.spec.ts` updated.

### C8 — Home heading reword  · CHANGE (copy only) — *needs final confirm*
- **Where:** `app/src/main-window/App.tsx` home heading (~932).
- **Today:** "Let me help with your next call." + the input + first-run coach with "Use an example" (all already ship).
- **Target:** reword the heading so Ruby speaks first, e.g. **"Hi — what call are you prepping for?"** No chips, no new surfaces (playbooks are *not* on Home). Everything else on Home stays.
- **Acceptance:** heading reads as a direct question; coach + example unchanged.

---

## 5. Explicitly unchanged (already ships as designed)

Verified against the built app (`design/shots/`):
- **Prep + Game Plan** (`PrepScreen`, the yellow sticky with brief/goal/checklist that Ruby fills live). No change.
- **Start listening** (red button, bottom-right of prep; `startCall` ~332, `call:start`). Start-before is the taught default; mid-call start works inherently. **Auto-detect (calendar) is explicitly deferred to a future v2 — not in scope.**
- **Recap** (`PostCallScreen` ~1679; "The gist" ~2005, "Insights" + attribution ~2012). **Kept passive** — reached via the "Call saved" notification + the Past Calls list. **No push built.**
- **Recap personalization card** ("Tell me what to remember", `pcs-memory-card` ~2033; `saveNote` ~2754 → `memory:add`). Already ships. No change.
- **Memory screen** (`MemoryScreen` ~2095; user-authored, never reflexive; injected into call prompts via `system.ts` ~38). Needs nothing.

## 6. Net build list (priority order)

1. **C6** Enrich playbook rows (smallest, highest in-journey payoff; data + dropdown render).
2. **C7** Flip gem panel to hover + first-run hint (fixes the "hidden end" bug).
3. **C2 + C3 + C4** Cut slides, reorder gates, keep mic upfront (mostly deletion + reorder).
4. **C8** Home heading reword (one string) — pending final confirm.
5. **C5** Live "ready" primer (new first-run overlay state).
6. **C1** Hero-demo asset (the one piece needing design/motion work).

## 7. Decisions resolved (for the record)

- Hybrid, not either/or: journey-embedded teaching + irreducible setup upfront.
- Cut welcome / how / hotkey-demo slides; keep Claude / sign-in / mic gates.
- Mic upfront (reversed from an earlier "defer" instinct) — one-shot-denial risk.
- Playbook stays explicit and in-prep; only the rows get richer.
- Recap stays passive (no push). Memory needs nothing.
- Overlay redesign (click→main-window rehoming) **parked**; the hover flip is the minimal fix.

## 8. Open items

- **C8 Home heading** — confirm the exact reworded copy.
- **C6 `sample` field** — decide: new frontmatter field vs. derive from `description`.
- e2e specs to update: `onboarding.spec.ts`, `overlay-end-call.spec.ts`, `gem.spec.ts`, plus any playbook-dropdown assertions.
