# Node Knowledge: Explanations and Node Panel — Design Spec (child 3 of 5)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md`
**Depends on:** `2026-11-04-source-verification-design.md` (trust level, evidence)
**Used by:** `2026-11-04-lecture-office-hours-exercises-design.md` (lecture view opens the panel), `2026-11-04-personal-layer-spaced-repetition-design.md` (cards and review state shown in the panel)

## Context

A LearnHarness node holds a short name, one minimal true statement, aliases and provenance. That is enough for identity but not for understanding. The user wants every node to carry a highly detailed explanation in a clear, specialised register (in the spirit of ASD-STE100, not rigid: an intuition first is allowed where it helps), and wants to move between concepts the way one moves between linked notes in Obsidian, opening them beside the current view instead of leaving it.

## Goals

- Every node has a detailed explanation, grounded in source text where one exists.
- A single panel shows a node with its explanation, trust, neighbours, citing lectures, cards and review state, and is reusable from any view.
- Navigation between nodes happens inside the panel with history, without replacing the current view.

## Non-goals

- Strict ASD-STE100 conformance (it is defined for English; the principles are applied in the source language).
- The visual design of the panel (UI session); this spec fixes content, behaviour and data.
- Storing links or back-links as data (they are derived).
- Changing the content ledgers (`nodes.jsonl`, `chains.jsonl`).

## Design

### Explanations

`data/ext/explanations.jsonl`: versioned events. Fields: node id, version, body (markdown with math and inline node links `[[n_…]]`), author (`agent` | `user`), source references (snapshot hashes, or none), style-guide version, and a fingerprint of the chains concluding the node at generation time. The current explanation is the latest version.

- A user-authored version is never overwritten by the agent; the agent proposes a new version that the user approves.
- If the fingerprint of the node's concluding chains differs from the current chains, the explanation is stale (derived) and is regenerated at the next opening.

### Structure

Flexible. An optional short intuition first, then the precise explanation, why it holds (tied to the premises in the chains), an example, common confusions. A node is **complex** when it concludes a chain with at least 3 premises, or when the closure of its premises has depth at least 3; complex nodes get the longer form.

### Style guide

`explanation-style.md`, an editable prompt file (through upstream's prompt-override mechanism) stating controlled-language principles in the source language: short sentences, one idea per sentence, consistent terminology, terms defined at first use, no ambiguity. Deterministic checks are minimal: a maximum sentence length (warning only), valid links, no placeholders.

### Generation policy

- **Chapter run:** explanations for all nodes of the chapter are generated in the same run as the chapter graph and lectures, in batches of neighbouring nodes (one call per batch), with the chapter text in context so that they are grounded in the source.
- **Elsewhere** (nodes from chats or research): generated on first opening of the panel, within the daily cost ceiling; if the ceiling is reached the panel shows the statement without an explanation and says so.
- Inline links must resolve to existing nodes; otherwise the output is rejected and regenerated, at most twice. An explanation generated without source text is marked "no source context"; the node's trust level is unchanged by an explanation.

### Node panel

One native component reused by the lecture view, the graph view, chat messages that mention nodes, and review. It opens beside the current view and never replaces it.

Sections: explanation; statement, aliases, trust level and its evidence (sources and quotes from verification events); premises, conclusions and alternative arguments (from chains); lectures that cite the node; nodes whose explanations mention it; cards and review state; goals the node belongs to. A neighbourhood mini-graph shows depth 1, expandable to depth 2. Clicking a neighbour re-centres the panel, with back and forward history. Actions: create a card, pin or retire, start a review, ask in chat, use as a goal target, verify now.

Back-links (explanation mentions, citing lectures) are derived from inline links and lecture references, never stored.

## Requirements

- **REQ-node-01**: `explanations.jsonl` stores versioned events per node with body, author, source references, style-guide version and the fingerprint of the concluding chains; the current explanation is the latest version.
- **REQ-node-02**: The user can edit an explanation; the agent never overwrites a user-authored version and proposes a new version for approval instead.
- **REQ-node-03**: An explanation is stale when the fingerprint of the node's concluding chains differs from the current chains; stale explanations are regenerated at the next opening.
- **REQ-node-04**: A chapter run generates explanations for all nodes of the chapter in batches of neighbouring nodes, with the chapter text in context.
- **REQ-node-05**: A node outside a chapter run gets its explanation generated on first panel opening, within the daily cost ceiling; when the ceiling is reached the panel shows the statement without an explanation and states why.
- **REQ-node-06**: An explanation may start with a short intuition and has the sections explanation, why it holds, example and common confusions; a node concluding a chain with at least 3 premises, or whose premise closure has depth at least 3, gets the longer form.
- **REQ-node-07**: The style guide is an editable prompt file applying controlled-language principles in the source language; checks are deterministic: sentence-length warning, link validity, no placeholders.
- **REQ-node-08**: Inline node links must resolve to existing nodes; otherwise the output is rejected and regenerated at most twice.
- **REQ-node-09**: An explanation generated without source text is marked "no source context"; an explanation never changes a node's trust level.
- **REQ-node-10**: The node panel is a single native component reused by the lecture view, graph view, chat and review.
- **REQ-node-11**: The panel opens beside the current view without replacing it.
- **REQ-node-12**: The panel shows explanation; statement, aliases, trust and evidence; premises, conclusions and alternative arguments; citing lectures; nodes whose explanations mention it; cards and review state; goals.
- **REQ-node-13**: The panel shows a neighbourhood mini-graph at depth 1, expandable to depth 2; clicking a neighbour re-centres the panel, with back and forward history.
- **REQ-node-14**: The panel offers the actions create card, pin or retire, start review, ask in chat, use as goal target, and verify now.
- **REQ-node-15**: Back-links are derived from inline links and lecture references and are never stored.
- **REQ-node-16**: Explanation generation is subject to the daily cost ceiling of the parent spec.
- **REQ-node-17**: The explanation event format, the staleness rule and the complexity rule are documented as language-neutral contracts (REQ-port-01).

## Risks

- Quality of detailed explanations is subjective and model-dependent; judged by the user in use, as for lectures, with the style guide as the tuning lever.
- A detailed explanation may state things the node's statement does not; this is why it is grounded in source text where available and flagged otherwise.
- Eager generation for whole chapters multiplies cost; batching and the cost ceiling bound it.
- The sentence-length rule is a warning only, because rigidity would harm intuition-first explanations.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (staleness rule, link resolution, complexity rule)
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

- How upstream's graph view and layout code can supply the mini-graph without duplication.
- Batch size and the grouping rule for neighbouring nodes in a chapter run.
- How chat messages mark node mentions so the panel can open from them.
- The default maximum sentence length per language.
