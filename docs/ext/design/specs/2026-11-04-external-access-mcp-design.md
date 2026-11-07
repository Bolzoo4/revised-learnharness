# External Access via a Local MCP Server — Design Spec (child 6 of 6)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md`
**Depends on:** the other five child specs for the data it exposes; each tool group can be built as soon as its data exists.

## Context

The user wants an external agent, first of all the one of their "daily schedule" project, to consult this system's knowledge and study state: what a concept means and how well it is supported, what is due today, how much time studying needs. The data is plain files, and derivations (graph, daily plan) are pure functions, so a read-only process can serve them without the app running.

## Goals

- An external agent can search and read the knowledge (nodes, explanations, trust, neighbours, lectures).
- It can read study state (goals, today's plan with estimated minutes, research status) to plan a day.
- Nothing about the exposure can change the data.

## Non-goals

- Write actions (for example marking a study block as done); evaluated later as narrow, separate actions.
- Network access, accounts or remote use: local, started by the client.
- Semantic search with embeddings: node search is fuzzy text over names, statements and aliases (upstream's `core/fuzzy.ts`), enough for the first version.
- Calling any model from the server.

## Design

### Process

A standalone Node process, entry `scripts/ext-mcp.ts`, speaking MCP over **stdio**, launched by the client with `LH_DATA_DIR=<data directory> npx tsx scripts/ext-mcp.ts [--knowledge-only]` (no npm script, so `package.json` is unchanged). It reads the data directory selected by `LH_DATA_DIR` (as the app does) and imports the pure core functions of the fork and of `src/core/ext/`. It runs with the app closed, makes no model calls, opens no network listener and never writes: reads of format stamps and ledgers do not create or touch any file. A stamp newer than the build makes every tool answer with a clear error, as in the app. Corrupt lines are skipped.

### Tools

**Knowledge group**
- `search_nodes(query, limit?, trust?, goalId?)`: fuzzy search; returns id, name, statement, trust level.
- `get_node(id)`: statement, aliases, trust level and evidence, current explanation (marked stale or "no source context" when applicable), premises, conclusions and alternative arguments, citing lectures, number of cards, review state (due date, recall probability), goals.
- `get_neighbors(id, depth?)`: neighbourhood to depth 1 or 2.
- `list_lectures(chapter?)` and `get_lecture(id)`: outline, node references, timed exercises; slides' narration text is omitted.

**Study-state group**
- `list_goals(status?)`: goals with scope size and share of solid nodes.
- `get_goal(id)`: scope summary, due counts, state of the exercise set.
- `get_daily_plan(date?)`: budget in minutes, due counts per channel, estimated minutes, new-card quota, and whether an exercise set is pending. Computed by the same pure plan function as the app; writes nothing.
- `research_status()`: frontier marks, inbox size, summary of the last cycle.
- `get_recent_debriefs(limit?, since?, kind?)`: session debriefs and the latest weekly synthesis, with their facts (session-debriefs spec).
- `list_documents()`: registered PDFs with title, page count and reading progress (assisted-study spec).

The first consumer is the agent of the daily-schedule project (`Sistema/UI-AI-workspace/backend`, FastAPI with agents on the Claude Agent SDK, which accepts MCP servers in its configuration). Decision (2026-11-04): that agent runs on the user's Mac, so stdio is sufficient; the VPS-based alternatives (private-network HTTP, or a read-only data copy) were considered and not chosen.

`--knowledge-only` disables the study-state group, since it exposes the learner's performance.

### Output discipline

Every list is bounded and returns `count` and `truncated`; long text fields are capped with an explicit marker. Unknown ids produce a structured not-found error. Tool input and output schemas are documented as language-neutral contracts.

## Requirements

- **REQ-mcp-01**: The server is a standalone local process over stdio that reads the data directory, runs without the app, and makes no model calls.
- **REQ-mcp-02**: The server never writes any file under the data directory, including format stamps.
- **REQ-mcp-03**: A format stamp newer than the build makes every tool return a clear error; corrupt ledger lines are skipped.
- **REQ-mcp-04**: Knowledge tools `search_nodes`, `get_node`, `get_neighbors`, `list_lectures`, `get_lecture` exist with the fields above.
- **REQ-mcp-05**: Study-state tools `list_goals`, `get_goal`, `get_daily_plan`, `research_status` exist with the fields above.
- **REQ-mcp-06**: `--knowledge-only` disables the study-state tools.
- **REQ-mcp-07**: `get_daily_plan` uses the same pure plan function as the app and gives identical output for identical data, time and settings.
- **REQ-mcp-08**: Every list result is bounded and carries `count` and `truncated`; long text is capped with an explicit marker.
- **REQ-mcp-09**: `get_node` reports the trust level with its evidence, and marks an explanation as stale or lacking source context when that holds.
- **REQ-mcp-10**: An unknown id yields a structured not-found error, never a crash.
- **REQ-mcp-11**: The server opens no network listener.
- **REQ-mcp-12**: Tool schemas are documented as language-neutral contracts (REQ-port-01).
- **REQ-mcp-13**: `get_recent_debriefs` returns session debriefs and the latest weekly synthesis with their facts when small (facts over 4 KiB are replaced by a marker), bounded as in REQ-mcp-08, and is disabled by `--knowledge-only`.
- **REQ-mcp-14**: `list_documents` returns registered PDFs with title, page count and reading progress.

## Risks

- The external agent sees personal learning data; stdio-only and `--knowledge-only` limit exposure, but any process the user launches with access to the data directory can read it.
- Reading while the app appends can show a torn last line; skipping corrupt lines handles it.
- The daily plan is a snapshot: it may differ from what the app shows a moment later.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (read-only guarantee, bounded outputs)
- adversarial-test-writing (especially for REQ-mcp-02: no file is created or changed)
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

- MCP SDK dependency and version (a new entry in `package.json`).
- How the daily-schedule project registers the server and which of its needs are not covered (a later write action list).
- Default limits (list sizes, text caps).
- Whether `get_lecture` should offer the narration text on request.
