# LearnHarness extension layer — overview

A description of everything added on top of LearnHarness in this fork, written for the
upstream maintainer: what exists, how it is separated from upstream code, what state it is in,
and which parts could be proposed upstream if they are of interest.

> LearnHarness is by Amos Blomqvist (AGPL-3.0). Everything below builds on its agents,
> proposition/chain graph, extraction pipeline and Electron shell. Nothing here replaces them.

## 1. Summary

The extension turns LearnHarness from a conversational teacher with a knowledge graph into a
longer-running learning system: it adds spaced repetition, source-backed verification of what the
graph claims, narrated lectures and office hours, PDF-assisted study, a background research loop,
session debriefs, and a read-only MCP server so other local agents can consult the learner's state.

Measured against the fork point (`git diff 713377f..HEAD`): 212 commits, 436 files, +51,143 / −33 lines,
**including tests and docs**. The 33 deleted lines are the whole footprint on existing upstream code;
the rest is new files.

Origin: three personal projects (a Rust FSRS flashcard app, a Python/Node lecture pipeline with a
Socratic reviewer, and a knowledge-graph research prototype) were merged into this fork instead of
growing separately, because LearnHarness already had the hard parts: the agent loop, the graph
and the extraction pipeline.

## 2. How it is kept apart from upstream

- All new code lives under `src/*/ext/`, `components/ext/`, `data/ext/`, `app/api/ext/` and the
  new pages (`app/practice`, `app/lectures`, `app/study`, `app/research`, `app/journal`).
- Upstream files are edited only at a **closed list of touchpoints**, one row per edit with the reason,
  in [`TOUCHPOINTS.md`](./TOUCHPOINTS.md). Most are one-line barrel exports, additions to the `ChatKind`
  union (`review`, `office_hours`, `research`, `study`), an agent branch in `chat-handler.ts`, and one
  `<ExtNav />` line in the sidebar. A command in that file shows any drift from `upstream/main`.
- Layering follows the upstream architecture: pure code in `core`, store adapters, agents that do not
  import stores, composition roots in `server`, and the app reaching code only through the
  `@/src/core` and `@/src/server` barrels.
- Contracts (file formats, invariants, per-path behaviour) are documented in [`CONTRACTS.md`](./CONTRACTS.md).
- Each feature has a written design with numbered requirements (`REQ-<topic>-NN`), kept in the
  parent repository's `docs/superpowers/specs/` (eight specs under an umbrella spec).

## 3. What was added

### 3.1 Personal layer and spaced repetition
- FSRS (`ts-fsrs`) state **per node**, derived from an append-only review-event ledger; cards are content
  variants and do not carry their own state.
- Three review channels feeding the same node state: fixed cards the learner writes, dialogic review
  (a `review` session kind), and exercises.
- A daily plan bounded by a **time budget**, not a card count, so the daily load does not grow without limit.
- Goals scope the review deck, verification effort and research direction; completion is decided by
  exercises, not self-declared.

### 3.2 Source-of-truth verification
- Each proposition gets a derived **trust level**: `unverified`, `sourced`, `contested`, `refuted`.
- A `sourced` result needs a quotation that **code** confirms occurs in a stored copy of the source; the
  model only gives the stance. It runs as a stage after the existing merge, so the upstream extractor
  schema is unchanged.
- A global source library with tiers: the system can propose sources but never promotes them.
- Trust badge in the node detail card; picked propositions carry their trust into the chat context.

### 3.3 Node knowledge and the node panel
- A detailed, source-grounded explanation per node, and one reusable side panel (explanation, trust,
  neighbours, citing lectures, cards, review state) opened from any view, with in-panel history.
- Links and back-links are derived, never stored.

### 3.4 Lectures, office hours, graded exercises
- Chapters of a PDF become narrated lectures; the chapter's graph is produced in the same run, so a
  lecture points at the nodes it covers. Native player with slides, highlight cues and exercise countdowns.
- Office hours: a Socratic session that never confirms correctness itself. Exercise verdicts come from
  sources; with no source the answer is "not verifiable".

### 3.5 Assisted study
- Read a PDF in the app (pdf.js) next to a persistent per-document conversation that always knows the
  current page and selection; turn a question, selection or answer into a card in a few steps.
- An optional "complete" step proposes drafts for pages already read; nothing is written without approval.

### 3.6 Research loop
- A periodic, gap-driven cycle that grows the graph without the learner present, steerable by persistent
  marks (expand / hold / stop, per node, subtree or goal), a watchlist (feeds, arXiv queries) and a chat.
- Autonomy follows trust: sources already in the library ingest on their own, new ones wait for approval.
- Hard limits plus the agent's own confidence as the stop; an inbox, a log of cycles, and abort/steer controls.

### 3.7 Session debriefs
- A debrief after each study session and a weekly synthesis, resting on **facts computed by code**
  so remarks can be checked against numbers; stored in a journal, shown in the app, exposed through MCP.

### 3.8 Read-only MCP server
- A stdio server (`scripts/ext-mcp.ts`) with 11 tools over the knowledge (search, node, neighbours,
  trust, lectures) and study state (goals, today's plan with estimated minutes, research status).
- It cannot change data: filesystem access goes through an allowlist of read functions, responses are
  capped (128 KiB), and node lookups use a lazy in-memory index validated by file stamps.
- Purpose: an external agent (the learner's daily-schedule agent) can plan from the learner's real state.

### 3.9 Cost and provider limits
- One shared daily cost gate across all background work (default ceiling 2 USD), enforced before each model call.
- Provider **usage-limit handling** for subscription providers: a detected limit pauses the work
  (30 min, doubling to a 6 h cap, or the reset time the provider states) instead of retrying into the limit.

### 3.10 Navigation and pages
- Sidebar entries (Review, Lectures, Study, Research, Journal) with icons, one page shell with the sidebar
  reopen toggle on all of them, and a Research page that explains cycles, marks, watchlist and status.
- The visual design is deliberately functional: a design pass is planned separately.

## 4. How it was verified

- 2,496 tests pass in the extension suites (`tests/ext-*`, plus the sidebar render tests); typecheck,
  eslint and `next build` are clean.
- Specs were reviewed in about ten macro pieces, and the fixes were driven by **adversarial tests**: a
  separate agent reads only the spec and signature-only `.d.ts` files (never the source) and writes strict
  tests; a different agent then makes them pass. This found defects that code-reading reviews had missed
  (a quadratic de-duplication, unbounded recursion in sweeps, Unicode-normalised search).
- A local unsigned macOS build was installed and the main pages load.

## 5. What is not verified (honest list)

- **Nothing has been exercised end to end with real models yet**: verifier, review chat, lecture writer,
  gap researcher, watch classifier, debrief writer, study drafts and a full research cycle are tested with
  fakes. The first real-provider runs are still to do.
- Not yet looked at in a browser with real data: graph canvas with the node panel, the lecture player,
  the study view with a PDF.
- Known gaps: extraction spend is not on the daily ceiling (it would need a change in
  `extraction.ts`); a lecture cancel ends as `failed`, not `aborted`; pending debrief entries are
  memory-only; the "single mode control over seven kinds" is not built (entries are separate pages).
- Provider limit wording for the Claude Code provider has not been captured from a real limit.

## 6. Observations on upstream (possible small fixes)

- `nativeSubscriptionError` maps any text containing "limit" to "usage limit reached", which is broader than intended.
- With the standalone build, Next's file tracing pulled the repo `data/` directory and credential files into
  `.next/standalone` (caused by dynamic `fs` access in `headless.ts`, `pdf-read.ts` and `store/graph.ts`);
  `scripts/build-server.mjs` correctly refused to continue. Worth a look for anyone producing a release build.

## 7. What could be proposed upstream

Ordered from most separable to least. I would rather propose a piece the maintainer wants than ask for
everything; each of these can be prepared as its own focused PR or discussion.

| Piece | Why it may fit | Size / coupling |
|---|---|---|
| The two small fixes in section 6 | Concrete bugs found while building | Tiny, no discussion needed |
| Provider usage-limit pause | Generic: any subscription provider can hit a limit | Small, three ext files plus wiring |
| Read-only MCP server | Lets other local agents read the learner's state, no write path | Self-contained, own entry point |
| Source verification (trust levels) | Addresses "the extractor trusts the teacher" | Medium: a stage after merge, one barrel edit |
| Spaced repetition (FSRS per node) | A scheduling layer the graph lacks | Large, new session kinds |
| Lectures, study, research, debriefs | Whole product areas | Large; better as a plugin if the plugin system lands |

The contributing guide says optional capabilities belong in plugins once the infrastructure exists;
the closed touchpoint list and the `ext` directories are designed so most of this could move behind
a plugin boundary later.

## 8. Questions for the maintainer

1. Is any of section 7 of interest, and in which form (issue, discussion, PR)?
2. For the larger areas, would you prefer to wait for the plugin infrastructure?
3. Is it fine for the fork to be published separately with clear attribution, and should it keep the
   name or use another?

## 9. Licence and attribution

The fork keeps the AGPL-3.0 licence and the original copyright notices. It is described everywhere as
an extension of LearnHarness by Amos Blomqvist, and links to the upstream repository.
