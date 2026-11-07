# Source-of-Truth Verification — Design Spec (child 1 of 4)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (refines REQ-ver-01 to REQ-ver-03 and REQ-cost-01; REQ-ver-04, graded-exercise verdicts, is detailed in child spec 3)

## Context

The LearnHarness extraction pipeline fully trusts the extractor: propositions come from the teacher's prose and no stage checks them against a source, so a teacher error becomes graph content. The evidence/quote fields were removed from the extractor's submit schema on purpose (weak models wasted retries on them), so verification must be a separate stage after the merge, leaving the extractor schema untouched.

## Goals

- Every proposition has a derived trust level: `unverified`, `sourced`, `contested` or `refuted`.
- A `sourced` outcome rests on a quotation that code, not the model, confirmed to occur in a stored copy of the source.
- Sources are curated by the user in a global library with tiers; the system can propose sources but never promote them.
- Verification is cheap enough to run for the nodes that matter (those in the scope of active goals).

## Non-goals

- Judging semantically whether a quotation supports the statement beyond the model's stance call (known limit, stated in Risks).
- Fuzzy quote matching in the first version.
- Exercise correction verdicts (child spec 3) and the research loop (child spec 4), which consume this stage.
- UI for the library and trust display beyond a node-detail indicator (UI work comes last).

## Design

### Source library

`data/ext/sources.json`: a configuration file (read-modify-write like upstream's `sources.json`, not an event ledger). Entry fields: `id`, `kind` (`pdf` | `url-prefix` | `repo`), `locator` (path, domain or URL prefix, repository), `tier` (`primary` | `secondary`), `label`, `author` (optional), `status` (`active` | `proposed`), `addedBy` (`user` | `agent`). Anything not matched by an active entry is `unvetted`. A fetched URL matches the entry with the longest matching URL prefix; a local PDF matches by path. Agent-proposed entries are `proposed` and are ignored by the outcome function until the user sets them `active`.

### Snapshots

Every source text used in a check is stored at `data/ext/snapshots/<sha256>.txt` and the hash goes into the verification event. Quote checks run against the snapshot, so a check is reproducible offline and a changed source is visible as a different hash. PDF text comes from upstream's existing PDF tools.

### Verification run

A headless run (upstream `subagents/headless.ts`, no chat) takes a batch of node ids.

1. The verifier agent searches active library sources first (PDFs via the existing search/extract tools, domains via fetch), then the open web.
2. For each source it returns `{sourceRef, locator, quote, stance}` with `stance` either `supports` or `contradicts`.
3. Code then: assigns the tier from the library (the model never assigns tiers), obtains or creates the snapshot, and checks that the quote occurs in the snapshot after normalization (whitespace, hyphenation at line breaks, case, unicode form). Exact match after normalization only. A quote that does not occur discards that piece of evidence with reason `quote_not_found`.
4. A pure function maps the surviving evidence to an outcome:
   - `sourced`: at least one qualified supporting primary, or at least two qualified supporting secondaries that are independent, and no qualified contradicting primary;
   - `contested`: qualified evidence both for and against;
   - `refuted`: qualified evidence against and none for;
   - otherwise `unverified`.
   "Qualified" means the quote check passed and the source is in an active primary or secondary library entry; `unvetted` sources never qualify. Two secondaries are independent when they are distinct library entries with different hosts or different author labels.
5. One event per node is appended to `verification.jsonl` with the outcome and the evidence (source id, locator, quote, snapshot hash, stance, tier at the time).

A failed or aborted run appends `check_failed` and never changes the derived trust level.

### Triggers

- After a successful merge, for `unverified` nodes in the scope of active goals.
- On demand for any node.
- When the user activates a library entry, for `unverified` and `contested` nodes in the scope of active goals.

All runs count against the single daily cost ceiling of the parent spec.

### Exposure

The trust level is included in the teaching and practice context so the teacher can tell sourced statements from unverified ones, and shown as an indicator in the node detail card. Layout and presentation are deferred to the UI session.

## Requirements

- **REQ-src-01**: `data/ext/sources.json` holds library entries with `id`, `kind`, `locator`, `tier`, `label`, `status`, `addedBy`; any source not matched by an active entry is `unvetted`.
- **REQ-src-02**: Agent-proposed entries have status `proposed` and are ignored by the outcome function until the user activates them.
- **REQ-src-03**: A fetched URL matches the library entry with the longest matching URL prefix; a local PDF matches by path.
- **REQ-src-04**: Every source text used in a check is stored at `data/ext/snapshots/<sha256>.txt` and its hash is recorded in the event.
- **REQ-src-05**: Evidence is kept only if its quote occurs in the snapshot after normalization (whitespace, hyphenation, case, unicode); otherwise it is discarded with reason `quote_not_found`.
- **REQ-src-06**: Source tier is assigned by code from the library, never by the model.
- **REQ-src-07**: The outcome function is pure and deterministic: identical evidence yields an identical outcome.
- **REQ-src-08**: `sourced` requires a qualified supporting primary, or two qualified supporting independent secondaries, and no qualified contradicting primary.
- **REQ-src-09**: `contested` holds when qualified evidence exists both for and against; `refuted` when qualified evidence exists against and none for.
- **REQ-src-10**: Two secondaries are independent only if they are distinct library entries with different hosts or different author labels.
- **REQ-src-11**: `unvetted` sources never count as qualified evidence.
- **REQ-src-12**: A failed or aborted run appends `check_failed` and does not change the derived trust level.
- **REQ-src-13**: Automatic verification runs after a merge for `unverified` nodes in the scope of active goals, on demand for any node, and when a library entry is activated for `unverified` and `contested` nodes in scope.
- **REQ-src-14**: Each verification event records source id, locator, quote, snapshot hash, stance and the tier at the time of the check.
- **REQ-src-15**: The trust level is included in teaching and practice context and exposed on the node detail.
- **REQ-src-16**: Verification runs are subject to the daily cost ceiling of the parent spec (REQ-cost-01).
- **REQ-src-17**: The verification stage does not modify the extractor submit schema or any upstream ledger.

## Risks

- Text extracted from mathematical PDFs is often damaged (broken formulas), so exact matching after normalization may discard valid evidence. Mitigation: measure on a real PDF at the start of the plan; move to approximate matching only if the measured loss is material.
- The stance call (`supports` / `contradicts`) is a model judgment; only the existence of the quotation is machine-checked.
- A library curated too sparsely leaves most nodes `unverified`; the system proposes sources to counter this.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (outcome function, quote check, tier assignment)
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

- Exact normalization rules and a regression corpus built from a real PDF.
- Batch size per run and the verifier's search budget per node.
- How the `author` label is obtained for independence checks (library entry field vs. extracted).
- Where exactly the post-merge hook is wired in `chat-handler.ts` (a documented touchpoint).
