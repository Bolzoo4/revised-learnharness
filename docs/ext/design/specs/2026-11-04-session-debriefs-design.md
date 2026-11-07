# Session Debriefs — Design Spec (child 8 of 8)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (adds `journal.jsonl`)
**Depends on:** the data of specs 1, 2, 3, 4 and 7; exposed by `2026-11-04-external-access-mcp-design.md`

## Context

After a study session the user wants the agent to comment: observations, the state of learning, and criticism where deserved, so that progress is questioned and not only counted. The comments should also be readable by the user's external daily-schedule agent.

## Goals

- A debrief after each study session and a weekly synthesis.
- Every debrief rests on facts computed by code, so the agent's remarks can be checked against numbers.
- Debriefs are stored, shown in the app and exposed through the MCP server.

## Non-goals

- Changing scheduling or goals automatically from a debrief (suggestions only).
- Gamification or scores.
- Debriefs for chats outside the study modes (plain teaching conversations).

## Design

### When

At the end of a session of kind `review`, `lecture`, `office_hours`, `study` or an exercise set: when the user ends it, or after 30 minutes of inactivity (configurable). A **weekly synthesis** is produced once per week (default Sunday evening, when the app is open, or at the next opening). Both run headless and respect the daily cost ceiling; if the ceiling is reached the entry is stored with its facts and no commentary.

### Facts

A pure function computes `facts` per session kind from the ledgers, with no model involved:

- review: counts per channel, rating distribution, lapses, weak premises (node names), duration against plan;
- lecture: slides viewed, concepts opened, in-lecture exercises done;
- office hours: steps questioned, questions left unanswered;
- exercises: outcome per node;
- study: pages read, questions asked, cards and nodes created.

The weekly facts add trends: time per day against budget, backlog trend, retention of cards reviewed, progress per goal, share of in-scope nodes by trust level.

### Commentary

The agent receives the facts and writes Markdown with four parts: observations, state of learning (grounded in goal progress and review state), critique (concrete and direct: for example reviews skipped, cards created faster than consolidated, pages read without consolidation), and a suggestion for the next session. It must tie its statements to the facts. Facts are stored beside the commentary so a reader can compare them.

### Storage and exposure

`journal.jsonl` events: id, kind (`session` | `weekly`), session id and kind when applicable, timestamp, facts, commentary (or null), author `agent`. The app shows the debrief at the end of the session. The MCP server exposes `get_recent_debriefs` and, in the study-state group, the weekly synthesis; `--knowledge-only` hides them since they describe the learner's performance.

## Requirements

- **REQ-deb-01**: A debrief is produced when a session of kind `review`, `lecture`, `office_hours`, `study` or an exercise set ends, by explicit end or after 30 minutes of inactivity (configurable).
- **REQ-deb-02**: A weekly synthesis is produced once a week (default Sunday evening, or at the next opening of the app).
- **REQ-deb-03**: `facts` are computed by a pure, deterministic function from the ledgers, per session kind and for the week, without any model.
- **REQ-deb-04**: The commentary has observations, state of learning, critique and a suggestion for the next session, and refers to the facts.
- **REQ-deb-05**: Facts are stored with the commentary in `journal.jsonl`.
- **REQ-deb-06**: When the daily cost ceiling is reached, the entry is stored with facts and a null commentary.
- **REQ-deb-07**: A debrief never changes goals, marks, cards or the schedule; suggestions are text only.
- **REQ-deb-08**: The app shows the debrief at the end of the session and keeps a history.
- **REQ-deb-09**: The MCP server exposes `get_recent_debriefs` and the weekly synthesis in the study-state group.
- **REQ-deb-10**: Debrief generation is idempotent per session: a session produces at most one debrief.
- **REQ-deb-11**: The journal format and the facts function are documented as language-neutral contracts (REQ-port-01).

## Risks

- The agent can state things not supported by the facts; mitigated by storing the facts next to the text and by instructing it to refer to them, not by a machine check.
- Critique tone is a matter of taste; the prompt is an editable file.
- Inactivity detection can end a session during a long reading pause; the timeout is configurable.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (facts function, idempotence)
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

- The exact definition of "session end" for each session kind in upstream's chat lifecycle.
- The prompt wording and register of the critique.
- The facts schema for each session kind.
