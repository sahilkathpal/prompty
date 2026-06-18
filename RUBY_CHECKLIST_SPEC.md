# Ruby — Checklist Behavior Spec

> Status: **VALIDATED & working** (once the tool-deferral bug was fixed). The
> design (§1–§5) is implemented and confirmed end-to-end. Earlier "Option A
> insufficient / 0 ticks" readings were confounded by the deferral bug
> (`project_nudge_tools_permission_block` / `tools: []` fix) — with tools actually
> callable, Option A (required pre-step + per-turn coverage block) works; Option B
> was NOT needed.
>
> **Validation (purpose-built 20-utterance test, `/tmp/checklist-test*`):** items
> ticked on genuine coverage (sources @ turn 6, cleaning @ turn 14); the untouched
> output item stayed open (strict bar held); "still open" decremented 3→2→1 (closed
> loop confirmed); mid-call nudges stayed soft (medium, tie-break to open items);
> and at wind-down Ruby escalated to high-urgency backstop nudges naming the one
> open item. All as specified.
>
> **Backstop de-nagging (implemented & accepted — via context, not suppression):**
> validated: with the "already surfaced" block fed per turn, the model held back on a
> repeat when nothing changed and re-raised only at the literal closing moment
> (3 blind repeats → 2 deliberate, context-driven ones). The remaining last-chance
> flag is accepted as defensible judgment (and the test is the adversarial case
> where the user never acts). The backstop
> re-surfaced the same open item ~3 turns running because the per-turn `interrupt()`
> leaves the model with no memory of having just raised it — so it re-decided blind.
> Fix = feed the model what it already surfaced, and let it judge. A new per-turn
> block (sibling to the coverage block) lists the nudges surfaced this call, and
> `base.md` raises the bar for repeats: re-raise only when the live conversation
> gives a *fresh* reason (topic resurfaced, answer dodged, cleaner opening); else
> treat as handled. NOT a code suppression / similarity heuristic — that's blind to
> live context and would block warranted repeats. The repeat judgment stays with the
> model, which is the only thing that can see whether the moment changed.
>
> Shipped: `base.md` reframes `mark_covered` as a required strict-bar pre-step and
> splits the checklist into soft-body / firm-edge regimes with the close-of-call
> backstop; `agent.ts` feeds a live per-turn coverage block (`checklistStateBlock`,
> rebuilt from the shared `setup.components`) into every `consider()` turn, closing
> the loop. Unit-tested (`tests/unit/checklist-coverage.test.ts`); the replay
> harness gained a `--components-file` override to A/B real recorded calls.
>
> **Validation result (replay of the Vikas call, 150 turns, new prompt + coverage
> block):** the coverage block reached the model every turn, but `mark_covered`
> fired **0 times** and the model never reasoned about coverage at all — the
> "required pre-step" framing is dropped just like the "optional" framing was. The
> separate-tool approach does not work. **Next: Option B** — fold coverage into the
> decision tools (`emit_nudge`/`stay_quiet` gain an optional `coveredItemIds`), so
> ticking rides along with the decision the model already makes every turn.
>
> **Blocker:** the same replay (and the real Vikas call) shows `mcp__prompty-nudges`
> tool calls being permission-rejected despite `permissionMode: "bypassPermissions"`
> + `allowedTools`. This nullifies proactive nudging and pollutes validation. Fix
> this FIRST — see the separate permission-bug investigation.

---

## 1. Why the checklist exists (and why it isn't the direction box)

Ruby already has a soft directional instrument: the **direction** free-text. It
sets the goal and the vibe, and Ruby steers toward it loosely. The checklist is
gated behind a *different* intent — it's offered only when "it looks like you
need to track what you need to cover." That gate is the whole point:

> **Direction = a soft steer. Checklist = the things that must get covered.**

If the checklist is also just a soft steer, it collapses back into the direction
box and earns nothing. So its semantics must match the gate that created it:
**a need-to-cover list**, not a second steering hint.

This is the load-bearing decision. Everything below follows from it.

---

## 2. The core model: need-to-cover, governed at the *end state*

The fear with "need to cover" is interrogation mode — Ruby wrenching the live
thread to force item 4. That fear conflates two different things:

- **Forcing an item right now** (bad — violates "a bad nudge is worse than no
  nudge").
- **Ensuring an item is covered by the time the call ends** (good — it's the
  job).

"Need to cover" governs the **second**. The checklist is a contract about the
call's *end state*, not a license to interrupt in the moment. Separating these
dissolves the tension with the conversational-mining ethos.

This produces two regimes, graded by where the call is in its arc.

### 2a. Body of the call — soft

While there's still runway:

- Coverage **breaks ties** between otherwise-good nudges: prefer the next
  question that opens an uncovered item, all else equal.
- Ruby may **bridge** to an open item only at a **natural opening** — a lull, a
  topic transition, a "so anyway…" moment — and only when the bridge is obvious
  (carries over the existing `base.md:17` bridge rule).
- Ruby **never forces** an item mid-thread. An open item is not yet a problem; it
  may surface organically. Silence still beats a wrenching nudge.

This is essentially today's `base.md:43` wording — but it is now explicitly the
*body-of-call half only*, not the whole story.

### 2b. Edge of the call — firm (the backstop, and the reason the checklist exists)

As the call winds down, the cost of *not* covering an item rises, and the bar to
surface an uncovered one drops sharply. When wind-down cues appear and items are
still open, Ruby asserts:

> "Before you wrap — you haven't touched the output-file structure yet."

This close-of-call **completeness backstop** is the headline behavior. It is the
one thing a good human assistant does that justifies a checklist at all:
*"you set out to cover five things, you got three, the call's ending, here are
the two you missed."* A small, well-timed interruption at the close is
high-value and welcome; the same interruption mid-body would be a bad nudge.

**Wind-down trigger.** Ruby has no clock or agenda, so the arc is inferred from
transcript cues, e.g.: "I think that's everything," "we're about at time," "any
last questions," "great, I'll send a recap," scheduling/goodbye language, or a
clear drop in new substantive ground. When such a cue co-occurs with open items,
enter the firm regime. (Fuzzier than a timer; acceptable — false positives just
mean one slightly-early "anything left on X?" which is itself low-cost near a
wrap.)

---

## 3. The strict-tick bar (sharper, not softer)

In a need-to-cover model, coverage **drives behavior**, so a wrong tick is now
actively harmful: marking an item covered on a shallow, in-passing answer both
kills a legitimate follow-up *and* removes the item from the end-of-call
backstop. Therefore:

- Keep the **strict** bar from `base.md:9`: an item is covered only when
  **genuinely addressed** — a vague answer, or a topic merely touched in passing,
  is **not** coverage.
- The thing we make **non-optional** is *firing* `mark_covered` when the bar is
  met; the thing we keep **strict** is *what meets the bar*. Loosen the forcing,
  not the ticking.
- When unsure, **leave it open.** An over-cautious open item costs one extra
  late-call check; a false tick costs a silently-missed topic. Asymmetric, so
  bias toward open.

---

## 4. What this requires — closing the loop

The behavior above is impossible today because the coverage signal is written and
never read back. Three pieces must exist:

1. **`mark_covered` actually fires.** Reframe it in the prompt from "auxiliary,
   optional" (`base.md:9`, `agent.ts:174`) into a required pre-step: *before
   deciding, scan the checklist; if the last exchange genuinely completed an open
   item, call `mark_covered` first, then decide.* Today it fired 0 times across a
   595-turn call.
2. **Live coverage is fed back per turn.** The system prompt is built once at
   session start (`agent.ts:247`) and each `consider()` turn sends only a trigger
   line + transcript window (`agent.ts:341`) — the checklist `[ ]` state is
   frozen and never refreshed. `mark_covered` mutates `setup.components` in place
   (`coach-session.ts:117`) but only `end()` ever reads it. Fix: inject the
   *current* coverage into each turn's message — e.g. a short
   `Still open: A, C / Covered: B` line rebuilt from the live `setup.components`.
   This is also a stronger, cheaper grounding signal than relying on the
   persistent session's transcript memory over a long call.
3. **Arc awareness.** Surface the wind-down inference (§2b) so the firm regime can
   trigger. Cheapest path: include it in the same per-turn coverage line (e.g. a
   `call appears to be winding down` flag derived from recent cues), so the model
   gets coverage + arc together each turn.

Note: `onItemCovered` currently does **not** broadcast (`coach-session.ts:419`
only mutates), and the overlay has **no** checklist UI. That's fine — coverage
stays a post-call-card signal for now (§6). The closed loop above is about
feeding the agent, not the user.

---

## 5. Guardrails (carry over the existing ethos)

- **Question-default** holds: surfaced items are phrased as something the user can
  ask or say close to verbatim, not as instructions.
- **Don't read the list aloud** mid-call; the backstop names *specific* open
  items, one at a time, not the whole list.
- **One nudge at a time** still applies; the backstop doesn't dump every missed
  item at once — it surfaces the most important open one, then the next if there's
  room.
- The body-of-call **quiet bar is unchanged**. The checklist raises the priority
  of open items; it does not lower the overall bar to speak.

---

## 6. Out of scope (for now)

- **Live checklist UI in the overlay.** Coverage remains visible only on the
  post-call card (`checklistCoverage` in the main window), which reads `done`
  flags from the persisted log. Revisit only if a mid-call coverage tracker
  proves wanted — it risks clutter against the gem's minimalism.
- **A real clock / calendar.** Arc awareness is transcript-inferred only;
  consistent with "no calendar awareness" (`RUBY_MVP.md §2`).

---

## 7. Implementation outline (follows from this spec)

1. **Prompt:** rewrite `base.md:9` (mark_covered: required pre-step, strict bar)
   and split `base.md:43` into body-soft + edge-firm regimes with the wind-down
   trigger and the backstop behavior.
2. **Per-turn feedback:** in `agent.ts` `consider()`, prepend a coverage line
   (open/covered items + winding-down flag) to `userMsg`, rebuilt from the live
   `setup.components` each turn.
3. **Tool:** keep `mark_covered` wiring (`agent.ts:172`,
   `coach-session.ts:markChecklistItemCovered`); no schema change needed for the
   minimal version. (Folding coverage into `emit_nudge`/`stay_quiet` as a
   `coveredItemIds` field — Option B from the earlier analysis — is a possible
   hardening if the required-pre-step framing still under-ticks.)
4. **Verify:** extend `checklist-checkoff.spec.ts` with (a) a real-agent path that
   ticks a genuinely-covered item, (b) an unchanged-on-shallow-mention case, and
   (c) a wind-down transcript that triggers a backstop nudge for an open item.
