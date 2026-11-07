# Learning Platform Integration — Umbrella Design Spec

**Status:** Draft for review
**Date:** 2026-11-04
**Scope:** the shared architecture for merging RepetitionLearning (spaced repetition), teacher (narrated lectures + office hours) and the Learning_system knowledge-graph vision into a fork of LearnHarness. Eight child specs (listed below) each get their own spec → plan → implementation cycle.

## Context

Three separate pieces exist today:

- **Learning_system** (`Mission.md`): a federated, multi-domain knowledge graph (connectors, 7-stage ingestion, typed cross-references, contested attributes, lazy backfill) aimed at research: relating sources and following the state of the art. An approved but not yet fully implemented redesign (`implementation/docs/superpowers/specs/2026-09-18-concept-graph-agentic-extraction-design.md`) moves it to concept nodes decoupled from documents, an implementer/reviewer pipeline and a governed relationship registry.
- **RepetitionLearning**: Rust/React/Tauri app with flashcards, MCQ, FSRS, a prerequisites DAG and a PDF chunker.
- **teacher**: Python + Node pipeline turning textbook PDFs into narrated lectures (`lezione.html` + `narrazione.txt`) with a Socratic office-hours reviewer that never confirms correctness directly.

LearnHarness (github.com/amosblomqvist/learnharness, AGPL-3.0, TypeScript/Next.js/Electron) already provides: a prober → teacher → practitioner agent loop, a proposition-and-reasoning-chain knowledge graph with a three-stage extraction pipeline (extractor, source-blind auditor, deterministic merger), message-level extraction coverage, background sub-agents (researcher, PDF reader, demo/visual builders), and a plan DAG. It lacks spaced repetition, any check of graph content against a source (the extractor is "fully trusted: no stage re-checks it"), lectures/office hours, and any self-growing research loop.

Decision (2026-11-04): fork LearnHarness (cloned at `Learning_system/learnharness`, Node 26.13 via nvm, `npm ci`, 3543/3547 upstream tests pass; the two failures assume the `claude` CLI is absent, one earlier loader failure was a Node 22 artifact) and add the missing capabilities as modular extensions. The Neo4j/Qdrant stack of the old vision is dropped for now: the fork's JSONL ledgers are the store.

Decision (2026-11-04, after approval): the fork **replaces** the Rust `knowledge-graph` worktree (`.claude/worktrees/concept-graph-agentic-extraction`, ~17.7k lines of Rust, two specs implemented: concept-graph extraction pipeline and graph expansion; a third, learning-and-discovery, approved but unplanned) for now, to test the combined system in daily use. That worktree stays untouched as a reference and is not deleted. A later, complete Rust rewrite is an explicit possibility once the fork has proven the design; the third Rust spec (correction loop, cross-links, self-tuning discovery) is not carried over now, but its ideas may inform child spec 4.

## Goals

- One content graph (propositions + reasoning chains) with a per-proposition trust level backed by sources.
- A personal layer holding what the learner knows, scheduled with FSRS, whose daily load is bounded by design.
- A goal entity that scopes the review deck, the verification effort and the research direction.
- Lecture/office-hours/exercise modes whose verdicts come from sources, not from model judgment.
- A research loop that expands the graph from gaps, which the user can steer and stop by region.
- Minimal, enumerated edits to upstream files so upstream updates remain mergeable.

## Non-goals

- Neo4j, Qdrant, MinIO, multi-user or multi-tenant operation, cloud deployment.
- Any UI work beyond the mode selector (REQ-mode-01); the full UI redesign comes last in its own session.
- Typed relationship registry from the 2026-09-18 spec: not carried over (chains are the relation primitive). Revisit only if real cases appear.
- Fixing upstream bugs unrelated to the extensions.

## Decomposition

| # | Child spec | Depends on |
|---|---|---|
| 1 | Source-of-truth verification stage | this spec |
| 2 | Personal layer and spaced repetition | this spec |
| 3 | Node knowledge: detailed explanations per node and the Obsidian-style node side panel | 1 |
| 4 | Lecture, office hours, graded exercises (written; uses the node panel of spec 3) | 1, 2, 3 |
| 5 | Self-growing research loop and SOTA watch | 1, 3, frontier from this spec |
| 6 | External access: read-only local MCP server (knowledge and study state) for outside agents such as the daily-schedule project | 1 to 5, 7, 8 as their data appears |
| 7 | Assisted study: read a PDF with a page-aware conversation, make cards from it | 2, 3 |
| 8 | Session debriefs: agent commentary after sessions and a weekly synthesis | 2, 4, 7 |

## Architecture

### Layers

- **Content layer (upstream, unchanged):** `nodes.jsonl`, `chains.jsonl`, `coverage.jsonl`, `sessions.jsonl`. Written only by the existing extraction pipeline.
- **Extension layer (new):** `data/ext/` with its own `format.json` stamp (so upstream's graph-family stamp logic is untouched). Event files, append-only, current state derived by reading them.

| File | Content |
|---|---|
| `goals.jsonl` | Goal: id, title, origin (`chat` \| `user` \| `pdf`), origin reference, target node ids, status (`active` \| `paused` \| `reached`), timestamps |
| `review.jsonl` | One event per review: node id, mode (`fact` \| `argument`), rating, duration, free-text answer if any; also implicit-review events and manual `pin`/`retire` events |
| `documents.jsonl`, `reading.jsonl`, `study-links.jsonl` | Registered PDFs, reading progress, node ↔ (document, page) links; see the assisted-study spec |
| `journal.jsonl` | Session debriefs and weekly synthesis with their computed facts; see the session-debriefs spec |
| `cards.jsonl` | Content variants of a node (question, answer, author, status); see the personal-layer spec |
| `verification.jsonl` | One event per check: node id, outcome, source, locator, quote, checker, timestamp |
| `frontier.jsonl` | Research marks: scope (node, goal or subtree), mark (`expand` \| `hold` \| `stop`), optional max depth, optional budget, note, author (`user` \| `agent`) |

### Goal

A goal is one or more **target nodes** the learner wants to master. It can be introduced from a chat, by the user, or from a PDF; in every case it creates a target node, a proposition that must be reached, initially without known premises. The target node enters the graph through the existing merge pipeline with a `goal_…` source id (same idea as the `src_…` ids of imported notes). Goal **scope** = the targets plus the transitive closure of their premises over the current chains.

### Review model

- FSRS state exists **per node only**. The merger rewrites the chain ledger and drops redundant chains, so chain ids are not stable; node ids are. An "argument" card is a mode of a node: its premises are read from the current chains at review time.
- State is derived by replaying `review.jsonl`; events for deleted nodes are ignored at read time.
- **Deck** (computed, not stored) = scope of active goals − derivable nodes − retired nodes + pinned nodes. A node is derivable if some chain concluding it has all premises sufficiently well remembered.
- **Daily plan**: a pure function of deck, events, time and budget. New-card quota = `max(0, capacity − due)`, with `capacity = daily time budget / median review duration` (default budget 25 minutes), and zero when the backlog exceeds a threshold.
- Levers beyond selection: implicit repetition (a successful argument review credits its premises with a reduced-weight event), one card per argument, per-goal desired retention, daily cap with priority ordering (overflow is deferred, never dropped).
- Learner errors live only in review and practice records, never in the content graph.

### Verification

A headless stage (the upstream `subagents/headless.ts` runner, no chat) runs after a successful merge for nodes in the scope of active goals, or on demand. It uses the researcher's web/PDF tools plus user-designated primary sources. The model returns source, locator and quote; **code verifies that the quote occurs in the retrieved source text**. Only then is the outcome `sourced`. Trust per node is derived from the latest event: `unverified` (default) → `sourced` → `contested` → `refuted`. A failed or aborted check never changes the trust level. The evidence fields were deliberately removed from upstream's extractor schema; verification therefore runs as a separate post-merge stage and the extractor schema is not touched.

### Research loop

- **Frontier marks** (`frontier.jsonl`) are the persistent control surface. The user sets them directly (CLI now, UI later) or through a research chat; the agent can set them too, recorded with its author.
- The autonomous cycle (headless, scheduled) reads the frontier at the start of every cycle and never expands under a `stop` mark or beyond a depth or budget limit. Gap sources: uncovered passages (upstream coverage), unresolved prerequisites, contested nodes, learner errors from reviews.
- A **research chat** (`kind: research`) lets the user talk to the loop: set marks, start a cycle now, see what was found. Its sub-agent jobs use upstream's existing job/steering delivery into the chat.
- Research output reaches the graph only through the existing extraction pipeline, via the notes-source path, with the source as provenance.
- One daily cost ceiling covers verification and research; when reached they stop, while reading the graph and reviewing continue.

### Modes

The chat UI stays the same. A **mode** control sets the session kind: `teaching`, `practice` (upstream), `lecture`, `office_hours`, `review`, `study`, `research` (new). A lecture is a rendering of a path through the graph (the teacher pipeline's builder, fed from the graph instead of a PDF chapter); office hours keeps the rule that the model never confirms or denies correctness itself, the verdict comes from a source or solution.

### Code layout and fork discipline

New code mirrors upstream layering so its lint rules apply: `src/core/ext/` (pure logic), `src/store/ext/`, `src/agent/ext/`, `src/server/ext/`, `app/api/ext/`. Upstream files touched, closed list (kept in `docs/ext/TOUCHPOINTS.md`): `src/server/stores.ts`, the post-extraction hook in `src/server/chat-handler.ts`, the `kind` union of `ChatRecord`, `config.ts`, `package.json` (FSRS library; `allowScripts` already added locally for `fsevents`, `protobufjs`, `unrs-resolver`). Git: `main` tracks `upstream`; work on branch `ext`, rebased periodically.

### Errors and testing

Corrupt lines in `ext/` files are skipped; a stamp newer than the build makes reads throw (same doctrine as upstream). Tests use upstream's runner (`tsx --test`), deterministic, no model, no network; LLM stages are tested with a scripted fake engine like the researcher's.

## Requirements

- **REQ-int-01**: `data/ext/` carries its own format stamp; reading never writes it; a stamp newer than the build makes reads fail.
- **REQ-int-02**: Extension code never writes the upstream ledgers (`nodes`, `chains`, `coverage`, `sessions`) except through the existing merge pipeline.
- **REQ-int-03**: Extension code passes upstream's ESLint layering rules.
- **REQ-int-04**: Upstream files are edited only if listed in `docs/ext/TOUCHPOINTS.md`.
- **REQ-goal-01**: A goal can be created from a chat, by the user, or from a PDF, and each creates a target node with its origin recorded.
- **REQ-goal-02**: Goal scope is the targets plus the transitive premise closure over current chains.
- **REQ-review-01**: Review state exists per node only and is derived by replaying `review.jsonl`; events for deleted nodes are ignored.
- **REQ-review-02**: The deck is scope of active goals minus derivable minus retired plus pinned, computed and not stored.
- **REQ-review-03**: New-card quota is `max(0, capacity − due)` with capacity from the time budget and the observed median review duration (default 25 minutes), and zero above the backlog threshold.
- **REQ-review-04**: A node with a chain whose premises are sufficiently remembered gets no card.
- **REQ-review-05**: An argument card reads its premises from the current chains at review time.
- **REQ-review-06**: A successful argument review emits reduced-weight implicit-review events for its premises.
- **REQ-review-07**: A daily cap with priority ordering applies; overflow is deferred, never dropped.
- **REQ-review-08**: Desired retention is configurable per goal.
- **REQ-review-09**: Learner errors are never written to the content graph.
- **REQ-ver-01**: Trust level is derived from the latest verification event, defaults to `unverified`, and a failed or aborted check never promotes it.
- **REQ-ver-02**: The `sourced` outcome requires code-verified occurrence of the quoted text in the retrieved source.
- **REQ-ver-03**: Automatic verification runs only for nodes in the scope of active goals; other nodes only on demand.
- **REQ-ver-04**: A graded-exercise verdict comes from a designated source or solution, never from the model alone.
- **REQ-res-01**: Frontier marks (`expand`, `hold`, `stop`, optional depth and budget limits) persist in `frontier.jsonl` and can be set by the user directly and through the research chat.
- **REQ-res-02**: Each autonomous cycle reads the frontier at its start and never expands under a `stop` mark or beyond a limit.
- **REQ-res-03**: Research output enters the graph only through the existing extraction pipeline with the source as provenance.
- **REQ-res-04**: Gap candidates come from uncovered passages, unresolved prerequisites, contested nodes and learner errors.
- **REQ-cost-01**: One daily cost ceiling covers verification and research; when reached they stop, and reading and reviewing are unaffected.
- **REQ-mode-01**: The chat UI is shared; a mode control sets the session kind among `teaching`, `practice`, `lecture`, `office_hours`, `review`, `study`, `research`.
- **REQ-port-01**: Every `data/ext/` file format and every `src/core/ext/` function is documented as a language-neutral contract (field names, types, derivation rules) so that a later Rust rewrite can reproduce them against the same files.

## Security Profile

**Level:** baseline

**Active practices:**
- architectural-mapping (always on)
- design-by-contract
- adversarial-test-writing
- static-analysis-hardening

**Explicitly excluded:**
- mutation-testing — user decision 2026-11-05: behaviour tests and static analysis are enough for this project; mutation testing cost more than it protected
- requirements-traceability-matrix — user chose baseline over hardened; REQ IDs are still assigned above
- mcdc-coverage — user chose baseline; no compound-condition-heavy safety logic identified
- system-safety-analysis — not applicable: a single-user study and research tool with no physical or irreversible failure modes
- watchdog-safe-state — not applicable, same reason
- lightweight-wcet — not applicable: not latency-sensitive

**Set:** 2026-11-04, during brainstorming

## Open items for child specs

- How upstream's UI resolves `provenance.chatId` for `goal_…` ids (spec 2 or umbrella follow-up).
- Exact derivability threshold and the implicit-repetition weight function (spec 2).
- Which sources count as primary and how they are designated (spec 1).
- Concrete lecture-builder input contract from graph paths (spec 3).
- Gap-prioritisation function and cycle cadence; SOTA watchlist format (spec 4).
- Whether the two failing upstream `claude-code` tests need an environment fix locally.
- Upstream's `AGENTS.md` requires asking before any design guess; child specs follow the same one-decision-at-a-time rule.
