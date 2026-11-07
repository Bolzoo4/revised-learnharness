# Self-Growing Research Loop and SOTA Watch — Design Spec (child 5 of 5)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (refines REQ-res-01 to REQ-res-04 and REQ-cost-01; defines the `research` session kind)
**Depends on:** `2026-11-04-source-verification-design.md` (source library, verification), `2026-11-04-node-knowledge-design.md`, `2026-11-04-personal-layer-spaced-repetition-design.md` (weak premises as a gap source)

## Context

The original Learning_system vision was a research system: it looks for what the graph is missing, goes deeper where it matters, and follows the state of the art and how new work relates to what is already known. LearnHarness only researches on request inside a chat, and its researcher returns a brief to the teacher; nothing drives the graph's growth. The user wants the loop to start from gaps ("what could be added"), to keep deepening, to be steerable region by region (expand here, stop there), and to relate new work to the existing graph.

## Goals

- A periodic, gap-driven cycle that grows the graph without the user present.
- The user's control over where it expands and where it stops, by persistent marks and by talking to it.
- Autonomy limited by source trust: active library sources ingest on their own, new ones wait for approval.
- A state-of-the-art watch that classifies new work against the graph.

## Non-goals

- A fixed cap on sources per cycle: the stop is the agent's own confidence (see Design), backed by hard limits.
- Connectors beyond web search/fetch, PDF and the public arXiv API in the first version.
- Calibrating the agent's confidence from the user's approvals (future work; the Rust discovery design had this idea).
- Interface beyond the research chat (UI session comes last).

## Design

### The cycle

A headless run (no chat), scheduled every N hours while the app is open (default 6) and startable on demand from the research chat.

1. **Read** the frontier marks, active goals and budget.
2. **Find gaps** with a pure, deterministic function over the graph and review data. Sources: passages of known sources not yet covered (upstream coverage); nodes in the scope of active goals without known premises or still unverified; contested nodes lacking a primary source; premises recorded as weak in reviews. Score = goal priority × gap-type weight × a penalty for distance from the scope. Marks filter: `stop` excludes a region, `hold` forbids expansion but allows verification, `expand` raises the score.
3. **Formulate** research questions for the best gaps.
4. **Search** with the upstream researcher (web and PDF), library sources first. For each gap the agent keeps going until it reports a **confidence** that the gap is answered at or above a threshold, or judges that more sources will not help; confidence and rationale are recorded.
5. **Triage** each source: active library source → ingest through the existing extraction pipeline (notes-source path, provenance = the source); new or unvetted source → the inbox.
6. **Verify** new in-scope nodes (verification spec); explanations are generated at opening (node-knowledge spec).
7. **Log** one entry in `research-log.jsonl`: gaps chosen, questions, sources, nodes added, confidence with rationale, cost.

### Limits and stopping

There is no fixed number of sources per cycle. Hard backstops: the daily cost ceiling of the parent spec; depth and budget limits carried by marks (default depth 2 from the scope); and **saturation**: a cycle that adds fewer than 2 new nodes in a region sets that region to `hold` with the note "saturated", authored by `agent`. User-authored marks win over agent-authored marks on conflict.

### Inbox

`inbox.jsonl`: events for sources awaiting a decision (locator, the gap it was found for, status `pending` | `approved` | `rejected` | `activated`). The user approves (ingest once), rejects (not proposed again) or activates the source in the library, which also triggers the verification spec's re-check.

### State-of-the-art watch

`watchlist.json` (configuration): entries with kind (`arxiv-query` | `feed` | `repo`), query, cadence and an optional linked goal. At each cycle, new items are compared with the nodes of the scope and `radar.jsonl` records the proposed relation (`extends` | `contradicts` | `applies` | `unrelated`) and action (`ingest` | `ignore`). The relation is a proposal shown to the user; actual links are created by the extraction pipeline (the auditor's equivalence links). Items from active sources are ingested, others go to the inbox.

### Research chat

Session kind `research`. Agent tools: set and list marks, run a cycle now, view and decide the inbox, edit the watchlist, read the log. A running cycle can be steered through upstream's steering queue.

### New files (`data/ext/`)

`research-log.jsonl`, `inbox.jsonl`, `radar.jsonl` (events) and `watchlist.json` (configuration), in addition to `frontier.jsonl` of the parent spec.

## Requirements

- **REQ-rs-01**: The cycle runs headless every N hours while the app is open (default 6) and can be started on demand.
- **REQ-rs-02**: Gap candidates come from uncovered passages, in-scope nodes without known premises or unverified, contested nodes lacking a primary source, and premises recorded as weak in reviews.
- **REQ-rs-03**: Gap scoring is pure and deterministic: goal priority × gap-type weight × a distance penalty; marks filter (`stop` excludes, `hold` forbids expansion but allows verification, `expand` raises the score).
- **REQ-rs-04**: Research on a gap ends when the agent reports a confidence at or above a threshold or judges that more sources will not help; confidence and rationale are recorded; there is no fixed per-cycle source cap.
- **REQ-rs-05**: Hard backstops stop a cycle: the daily cost ceiling, mark-carried depth and budget limits (default depth 2), and the saturation rule.
- **REQ-rs-06**: A cycle adding fewer than 2 new nodes in a region sets that region to `hold` with the note "saturated" authored by `agent`; user-authored marks win over agent-authored marks.
- **REQ-rs-07**: A source in an active library entry is ingested automatically through the existing extraction pipeline (notes-source path, provenance = the source).
- **REQ-rs-08**: A new or unvetted source goes to `inbox.jsonl`; the user can approve, reject or activate it, and a rejected source is not proposed again.
- **REQ-rs-09**: Activating a source from the inbox adds it to the library and triggers the re-check of the verification spec.
- **REQ-rs-10**: Each cycle appends to `research-log.jsonl` the gaps chosen, questions, sources, nodes added, confidence with rationale, and cost.
- **REQ-rs-11**: `watchlist.json` holds entries with kind (`arxiv-query` | `feed` | `repo`), query, cadence and an optional goal.
- **REQ-rs-12**: New watch items are classified against in-scope nodes and recorded in `radar.jsonl` with a proposed relation and action; the relation is a proposal and links are created only by the extraction pipeline.
- **REQ-rs-13**: Watch items from active sources are ingested; others go to the inbox.
- **REQ-rs-14**: The first version uses web search/fetch, PDF reading and the public arXiv API only.
- **REQ-rs-15**: The `research` session offers tools to set and list marks, run a cycle now, view and decide the inbox, edit the watchlist, and read the log.
- **REQ-rs-16**: A running cycle can be steered through upstream's steering queue.
- **REQ-rs-17**: The formats of the new files and the gap-scoring function are documented as language-neutral contracts (REQ-port-01).

## Addendum 2026-11-07: Research page rework

Decided with the user after trying the page. No external citation service is used: REQ-rs-14 stands (web search/fetch, PDF reading, public arXiv API). Citation APIs were tried (OpenAlex, Semantic Scholar, OpenCitations) and rejected: recent preprints were missing, e.g. a paper that cites LeanDojo in its bibliography was in none of them.

- **REQ-rs-18**: Marks are set from the graph: the node detail card offers expand / hold / stop and shows the node's current mark. The form with typed ids is removed.
- **REQ-rs-19**: The Research page has a text field for a research goal. Submitting starts a cycle whose scope is that goal; the agent starts from what it judges to be basic knowledge of the topic and then moves toward the current frontier. The goal is recorded in the cycle log.
- **REQ-rs-20**: A running cycle writes a short progress report every few steps (what it is looking at and why), shown on the page while the cycle runs and kept in the log.
- **REQ-rs-21**: The user can leave a note while a cycle runs. The agent reads pending notes before each report interval and changes direction accordingly. This replaces the unread steering queue of REQ-rs-16 (superseded; the "Send steer" form is removed).
- **REQ-rs-22**: The page shows status, the goal field, the running cycle's reports and the inbox first; watchlist and log are collapsed.

## Risks

- A model-reported confidence can be wrong in both directions: too low wastes the budget, too high leaves gaps open. The hard backstops and the saturation rule bound the damage; logged confidences allow later calibration.
- The loop can drift from what the user cares about; marks, distance penalty and goal priority are the controls.
- arXiv and web items vary in quality; the active-source rule and the inbox keep unvetted material out of the graph by default.
- Cycles cost money while the user is away; the daily ceiling is the final limit.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (gap scoring, mark precedence, triage rule)
- adversarial-test-writing
- static-analysis-hardening

**Explicitly excluded:**
- mutation-testing — user decision 2026-11-05: behaviour tests and static analysis are enough for this project; mutation testing cost more than it protected
- requirements-traceability-matrix — baseline chosen; REQ IDs are still assigned
- mcdc-coverage — baseline chosen
- system-safety-analysis — not applicable, no physical or irreversible failure modes
- watchdog-safe-state — not applicable; the cost ceiling and marks are the safeguards
- lightweight-wcet — not applicable, not latency-sensitive

**Set:** 2026-11-04, inherited from the parent spec

## Open items for the plan

- The confidence threshold and how the agent reports confidence (scale, prompt wording).
- Default values: gap-type weights, distance penalty, cycle cadence N, saturation threshold.
- Precise definition of "region" for marks (node, subtree, goal) and how overlaps resolve.
- Calibrating confidence from the user's inbox decisions.
- How the app schedules cycles while it is open, and what happens to a cycle interrupted by closing the app.
