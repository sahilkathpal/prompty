# Ruby — Phase 2c: capturing memory

> Status: **implemented 2026-06-17.** Both surfaces built and verified end-to-end
> (`tests/e2e/post-call-note.spec.ts`, `tests/e2e/prep-memory.spec.ts`); typecheck
> and the prep/memory regression suite pass. Closes the memory half of
> `project_ruby_phase2c_pending` (the in-call skill picker shipped earlier in
> Phase 1, commit `da57abe`).
>
> One change beyond the original plan: the Memory tab now refetches on open
> (`App.tsx`, effect keyed on `tab`), since it previously only loaded once on mount
> — so a note added from the call card (a different component) now shows without a
> relaunch. This is the cheap stand-in for the `memory:updated` broadcast.
>
> **Superseded:** the `MemoryItem.source` (`"manual" | "suggested"`) distinction
> described below was later **removed entirely** at the user's request — first the
> Memory-tab "suggested" badge, then the field itself across the store, types, IPC
> handler, prep tool, and tests. `addMemory(text)` now takes only the text and items
> are `{ id, text, createdAt }`. Ignore the source-field details in the sections
> below; everything else still holds.

## What this is

Two new ways to add to Ruby's **memory** — without changing what memory *is*.

Memory is the flat global list in `memory-store.ts` (`~/.prompty/memory.json`,
surfaced in the Memory tab, injected into prompts via `memoryBlock`). It holds
**feedback about how Ruby nudges** — what the user likes or dislikes about Ruby's
behaviour — the in-app twin of the CLAUDE.md prep-behaviour rules. It is **not** a
place for facts about a call's content.

Two consequences shape everything below:

- **Memory can't be auto-derived.** The input is the user's subjective reaction to
  Ruby's own behaviour, which Ruby can't observe. So neither surface drafts memory
  from the transcript; both are user-authored or user-confirmed.
- **Capture happens where the user can speak.** Mid-call the user talks to the
  other person, never to Ruby, so there's no in-call channel. The two channels that
  *do* exist are the **post-call card** (reflection) and the **prep chat**
  (a real conversation with Ruby).

Today nothing writes memory except the Memory tab's manual input. The `source`
field (`"manual" | "suggested"`) already exists and is unused for `"suggested"`;
this phase finally uses it.

No new IPC channels. No type/schema changes. No cards.

---

## Part A — Post-call memory note (quiet, user-authored)

A collapsed affordance on the post-call card the user taps when they have a take on
how Ruby nudged this call — positive or negative. Never prompts reflexively.

**File:** `app/src/main-window/App.tsx`, `CallCard` (~989–1068).

**Placement:** directly beneath the stat line (`App.tsx:1063–1065`,
`data-testid="call-stat"`). The stat ("Ruby surfaced N, you used M") is the one
thing on the card that reflects Ruby's nudging, so it's the natural anchor.

**Behaviour:** collapsed link → inline textarea + Save → "Saved to memory."
No pre-filled text (we ruled out drafting). Collapsed by default.

```tsx
function CallCard(props: { call: ParsedCall }): JSX.Element {
  // ...existing...
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);

  const saveNote = useCallback(() => {
    const text = note.trim();
    if (!text) return;
    void window.prompty.invoke("memory:add", { text }).then((r) => {
      if (r.item) { setNote(""); setNoteOpen(false); setSaved(true); }
    });
  }, [note]);
```

Rendered right after the stat `<div>`:

```tsx
      </div>  {/* S.stat */}

      {saved ? (
        <div style={S.cardNote} data-testid="nudge-note-saved">Saved to memory.</div>
      ) : noteOpen ? (
        <div style={S.noteRow}>
          <textarea
            style={S.noteInput}
            placeholder="e.g. don't surface follow-up questions during the close"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
          <button style={S.btn} onClick={saveNote}>Save to memory</button>
        </div>
      ) : (
        <button
          style={S.noteToggle}
          onClick={() => setNoteOpen(true)}
          data-testid="nudge-note-open"
        >
          + Note something about how Ruby nudged
        </button>
      )}
```

**Styles:** add `noteToggle` (borderless quiet link, matching the card's muted
tone), `noteRow`, `noteInput` (mirror the Memory-tab input styling for consistency).

**IPC path — unchanged, already exists:**

```
CallCard "Save" → window.prompty.invoke("memory:add", { text })
               → ipc-handlers.ts: handle("memory:add", p => ({ item: addMemory(p.text, "manual") }))
               → memory-store.ts: addMemory → appends to ~/.prompty/memory.json
```

Source stays `"manual"` — the user authored the text.

**Known edge (accepted for v1):** `memory:add` doesn't broadcast, so a Memory tab
already open in another window won't live-update; it catches up on next mount /
tab-switch. The card's "Saved to memory." confirmation closes the loop. If this
ever annoys, add a `memory:updated` broadcast mirroring `calls:updated` — out of
scope here.

---

## Part B — Prep conversational memory tool (offer-then-write)

In the prep chat, when the user voices a standing preference about how Ruby should
nudge in future calls, Ruby offers to remember it and writes it only on agreement.
The consent is the user's "yes" *in conversation* — no card, no confirm UI.

```
Ruby: "Want me to remember that for next time?"
User: "yeah"
Ruby: write_memory({ text })  → memory:add equivalent, source "suggested"
Ruby: "Got it — I'll keep that in mind from now on."
```

**File:** `app/src/main-process/prep-agent.ts`.

**New tool** on the existing `prompty-prep` MCP server (after `set_checklist`,
~line 115):

```ts
tool(
  "write_memory",
  "Save a durable preference about how Ruby should coach the user in FUTURE calls. Only call this after the user has agreed to remember it. The text is a standing instruction about Ruby's behaviour, not a fact about this call.",
  {
    text: z.string().describe("The preference, in the user's framing — one sentence."),
  },
  async (args) => {
    addMemory(args.text, "suggested");
    return { content: [{ type: "text", text: "memory_saved" }] };
  },
),
```

- Import `addMemory` from `./memory-store` (prep-agent doesn't import it yet).
- Add `"mcp__prompty-prep__write_memory"` to `allowedTools` (~line 169).
- `source: "suggested"` — agent-surfaced, so the Memory tab tags it distinctly from
  the user's own typed / post-call `"manual"` notes. (First real use of the field.)
- Unlike `set_goal`/`set_checklist`, this writes to the **global** store directly,
  not the per-call `components` list — so there's no `emitComponents()` and no card.

**Prompt fragment** in `app/src/main-process/prompts/prep.md` — a new short section
(do **not** fold into "Optional structured tools": those pin per-call cards; memory
is global and persistent, a different bar). Per the de-tooling rule, describe the
*situation*, never name the tool:

> ## Remembering how to coach them
>
> Separately from this call, the user may tell you how they want you to nudge them —
> in general, across calls ("don't interrupt me near the end of a call",
> "I like it when you push me to ask for specifics"). When they voice a preference
> like that about your behaviour, offer to remember it for future calls, and save it
> only if they agree. Save what they actually said, not your gloss on it.
>
> Only on a preference they voice — never infer one from this call's topic or how it
> went, and don't go fishing for one. A "no" stays a no. This reshapes every future
> call, so the bar is a real standing preference about how you coach, not a one-off
> aside about today.

**Mock harness:** `prep-agent.ts` has a deterministic mock (~line 255+) used in
tests. Extend it to, on a trigger phrase, offer + write a memory item so the flow is
testable without a live agent.

---

## Testing

Per the independent-Playwright-verification convention, verify with a different
subagent than built it, driving the real app:

- **Part A:** end a call → open the call card → click `nudge-note-open` → type →
  Save → assert `nudge-note-saved` and that the item appears in the Memory tab
  (tagged neither "suggested" — it's `"manual"`).
- **Part B:** drive the prep mock through the trigger → assert the offer appears in
  chat, a "yes" writes a `"suggested"` item to `memory.json`, and a "no" writes
  nothing.

## Out of scope

- `memory:updated` broadcast for cross-window live refresh (note the edge, don't build).
- Any model-gating of the post-call note (ruled out: usage isn't valence, and there's
  no transcript signal since the user never speaks to Ruby in-call).
- The in-call skill picker (separate track).
