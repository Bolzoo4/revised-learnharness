# Personal Layer and Spaced Repetition — Design Spec (child 2 of 4)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (refines REQ-goal-02, REQ-review-01 to REQ-review-09; adds `cards.jsonl` and the `review` session kind to the parent's file list and mode list)

## Context

LearnHarness keeps mastery out of the graph and has no scheduling. RepetitionLearning has FSRS and flashcards but no knowledge graph. The user wants memory maintained over time without the daily load growing without bound, fixed cards they can write themselves (writing fixes concepts), agent-driven questions they can reason with, and real, non-immediate exercises that verify learning at the end of a goal.

## Goals

- A personal layer, keyed by node, holding the FSRS state derived from review events.
- Three review channels feeding one state per node: fixed cards, dialogic review, exercises.
- A daily plan bounded by a time budget, not a card count.
- Goal completion decided by exercises, not self-declared.

## Non-goals

- Card-level FSRS state (state is per node; cards are content variants).
- FSRS parameter optimisation from review history (deferred until enough data exists).
- Exercise generation and correction (child spec 3); this spec only defines how their outcome enters review state.
- UI screens beyond the chat and mode button (UI work comes last).

## Design

### Files (`data/ext/`)

- `cards.jsonl`: events defining content variants of a node: node id, question, answer, author (`user` | `agent`), status (`draft` | `active` | `retired`). Agent-authored variants start as `draft` and are not scheduled until the user approves them. Variants of one node rotate under one schedule.
- `review.jsonl` (extends the parent): each event carries `channel` (`fixed` | `dialogic` | `exercise`); dialogic events also carry the premises found weak.

### Channels

- **Fixed:** the user writes cards, or approves agent drafts. Reviewed in the existing chat through upstream's question tools (free recall or multiple choice); no new screen.
- **Dialogic:** a new session kind `review`. The agent receives the node, its trust level and its premises, asks a new question each time, reasons with the user, then proposes a rating and the weak premises. The user confirms or overrides.
- **Exercise:** non-immediate exercises proposed by the agent at goal level (child spec 3). Their outcome emits review events on the nodes involved.

**Assignment:** a fact goes to the fixed channel. A node concluded by at least one chain goes to dialogic review, up to a daily cap (default 5), the overflow falling back to fixed. The user can pin a channel for a node.

### Scheduling

- FSRS through the `ts-fsrs` library. Default desired retention 0.9, overridable per goal; a node in several goals takes the retention of its highest-priority goal. All channels update the node's single state; state is derived by replaying `review.jsonl` and events for deleted nodes are ignored.
- **Implicit repetition:** a successful dialogic review gives each premise an implicit event: `newStability = old + w × (computed − old)`, `w` default 0.5. A failed review penalises a premise only if the dialogue flagged it as weak.
- **Derivable nodes:** a node with a chain whose premises all have recall probability ≥ 0.85 has no scheduled card unless pinned; it stays covered by exercises.

### Daily plan

A pure function of deck, events, current time and budget. Default budget 25 minutes. Capacity = budget ÷ median review duration (per channel, defaults before data exists: fixed 20 s, dialogic 180 s). New-card quota = `max(0, capacity − due)`, and zero when `due > 1.5 × capacity`. Order: goal priority, then forgetting risk (1 − recall probability). Overflow is deferred, never dropped. Nodes of paused goals leave the deck and keep their state.

### Goal completion

When most of a goal's scope is solid the agent proposes an exercise set (child spec 3). Passing it is the condition to mark the goal `reached`; a weak result reopens the involved nodes through `exercise` events.

## Requirements

- **REQ-pl-01**: `cards.jsonl` records content variants of a node (question, answer, author, status); variants of one node rotate under a single FSRS schedule.
- **REQ-pl-02**: The user can author fixed cards.
- **REQ-pl-03**: Agent-authored cards are `draft` and are not scheduled until the user approves them.
- **REQ-pl-04**: Every review event carries `channel` (`fixed` | `dialogic` | `exercise`); all channels update the node's single FSRS state.
- **REQ-pl-05**: A fact is assigned to the fixed channel; a node concluded by a chain is assigned to dialogic review up to a daily cap (default 5), overflow falling back to fixed; the user can pin the channel of a node.
- **REQ-pl-06**: Fixed cards are reviewed in the existing chat through upstream's question tools, without a new screen.
- **REQ-pl-07**: A dialogic review gives the agent the node, its trust level and its premises, asks a new question each time, and ends with a proposed rating and weak premises that the user can override.
- **REQ-pl-08**: Scheduling uses `ts-fsrs` with default desired retention 0.9, overridable per goal; a node in several goals uses the retention of its highest-priority goal.
- **REQ-pl-09**: A successful dialogic review emits implicit events on the premises with `newStability = old + w × (computed − old)`, `w` default 0.5; a failure penalises only premises flagged weak.
- **REQ-pl-10**: A node with a chain whose premises all have recall probability ≥ 0.85 has no scheduled card unless pinned.
- **REQ-pl-11**: The daily plan uses a time budget (default 25 minutes), per-channel median durations, and new-card quota `max(0, capacity − due)`, zero when `due > 1.5 × capacity`.
- **REQ-pl-12**: The queue is ordered by goal priority, then by 1 − recall probability; overflow is deferred, not dropped.
- **REQ-pl-13**: Nodes of paused goals are excluded from the deck and keep their state.
- **REQ-pl-14**: A goal becomes `reached` only after its exercise set is passed; a weak result emits `exercise` events that reopen the involved nodes.
- **REQ-pl-15**: Dialogic events record the weak premises; learner errors are never written to the content graph.
- **REQ-pl-16**: The daily plan and the state derivation are pure and deterministic given the same events, time and settings.
- **REQ-pl-17**: Every formula (FSRS use, implicit repetition, derivability, daily plan) is documented as a language-neutral contract (REQ-port-01).

## Risks

- Defaults (0.5 implicit weight, 0.85 derivability, 1.5 backlog factor, dialogic cap 5, initial durations) are untested guesses and need tuning on real use.
- The agent's proposed rating in dialogic review is a model judgment; the user override is the safeguard.
- Median durations are missing at the start; the plan relies on defaults until data exists.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (daily plan, state derivation, implicit repetition)
- adversarial-test-writing
- static-analysis-hardening

**Explicitly excluded:**
- mutation-testing — user decision 2026-11-05: behaviour tests and static analysis are enough for this project; mutation testing cost more than it protected
- requirements-traceability-matrix — baseline chosen; REQ IDs are still assigned
- mcdc-coverage — baseline chosen
- system-safety-analysis — not applicable, no physical or irreversible failure modes
- watchdog-safe-state — not applicable, same reason
- lightweight-wcet — not applicable, not latency-sensitive

**Set:** 2026-11-04, inherited from the parent spec

## Open items for the plan

- Tuning of the default parameters after first use; FSRS parameter optimisation.
- How a goal's priority is expressed (numeric, ordinal).
- Exact wording of the question-tool flow for fixed cards in the chat.
- Interface between child spec 3 (exercise sets) and REQ-pl-14.
