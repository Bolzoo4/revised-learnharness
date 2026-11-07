# Lecture, Office Hours and Graded Exercises — Design Spec (child 4 of 5)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (refines REQ-ver-04 and REQ-mode-01 for the `lecture` and `office_hours` kinds)
**Depends on:** `2026-11-04-source-verification-design.md` (evidence machinery, trust levels), `2026-11-04-personal-layer-spaced-repetition-design.md` (exercise outcome → review events, REQ-pl-14), and the node-knowledge spec (node explanations and the node side panel; written next)

## Context

The `teacher` project turns textbook chapters into narrated lectures: prose discourse, then `lezione.html` + `narrazione.txt` (TTS cues) driven by a standalone player, plus a Socratic office-hours reviewer that never confirms correctness itself. It has no knowledge graph, and the player lives outside any app. The user wants the same experience natively inside the Electron app: lectures built from a book's chapters, generated together with the graph that supports them, with concepts on the slides clickable into the graph, lectures behaving like Obsidian notes that link to concepts, office hours with sourced verdicts, and non-immediate exercises that decide when a goal is reached.

## Goals

- Chapters of a book become lectures, and the chapter's graph is generated in the same run, so each lecture points at the nodes it covers.
- Lectures are viewed natively in the app; clicking a concept opens the node in a side panel next to the slides.
- Lectures appear in the graph view as special nodes that cite concepts, without touching the content ledgers.
- Office hours and exercise grading never let the model alone decide correctness.

## Non-goals

- Visual design of the lecture view (the "blackboard" theme and layouts belong to the UI session); this spec fixes behaviour and data.
- Node explanations and the node side panel themselves (node-knowledge spec); this spec uses them.
- Automatic grading without a source: the answer is "not verifiable".
- Reproducing the book verbatim.

## Design

### Chapter run

One headless run per chapter, in this order:

1. **Chapter and lecture split.** Chapters come from the PDF bookmarks (LLM fallback if absent, as in teacher). A chapter splits into lectures from its outline, not from page count; a lecture targets about 2000 words of discourse. The book is registered as an active **primary** source in the library of the verification spec.
2. **Chapter graph.** The upstream extraction pipeline (extractor, auditor, merger) runs on the chapter text through the notes-source path. The graph is extracted from the chapter, not from the generated discourse, so editorial additions and paraphrase errors of the lecture never enter the graph, and chapter propositions have a checkable quote in a primary source from the start.
3. **Lecture generation.** Lectures of one chapter are written in sequence (each receives a summary of the previous one); chapters run in parallel. The chapter's nodes are an input, and every narrated block cites the nodes it covers. Discourse is rephrased, never verbatim, with editorial additions tagged as notes.
4. **Structured output.** `data/ext/lectures/<id>/lecture.json`: slides, blocks with roles, narration script with synchronisation cues, node references, and timed in-lecture exercises (toy example, short time, then discussion). A validator checks that every cited node id exists and reports chapter nodes covered by no lecture; invalid output is retried with feedback up to two times.

### Native lecture view

The lecture is a structured document rendered by React components inside the app, with a slide section and a player using the browser speech engine with cue-synchronised highlighting. Clicking a concept on a slide opens the node in a **side panel** next to the slides (the panel is specified in the node-knowledge spec); navigation continues inside the panel. The lecture is never replaced by the panel. Whether the speech engine behaves acceptably inside Electron is checked at the start of the plan.

### Lectures as special nodes

Lectures stay entities of the extension layer. The graph view derives special lecture nodes with `cites` edges from the node references in `lecture.json`; nothing is written to `nodes.jsonl` or `chains.jsonl`. A node's panel therefore shows which lectures cite it (back-links), Obsidian-style.

### Office hours

A session kind `office_hours`. The user submits written work (a proof, an exercise solution). The agent asks Socratic questions about each step and never states that the work is correct or incorrect. A verdict is given only when the user asks for it, by comparing against a designated source or solution, with the quotation checked by code as in the verification spec. With no designated source the answer is "not verifiable"; the model's own judgment is never the verdict.

### Graded exercises

At goal level (personal-layer spec) the agent builds a non-immediate exercise set over nodes in the scope. The reference solution is built from nodes whose trust level is `sourced`; if it uses any other node, the grading is marked low confidence. Grading follows the office-hours rules. The per-node outcome (`passed`, `weak`, `failed`) is emitted as `exercise` review events (REQ-pl-14).

## Requirements

- **REQ-lec-01**: Chapters are detected from PDF bookmarks (LLM fallback when absent) and split into lectures from the outline, targeting about 2000 words of discourse per lecture.
- **REQ-lec-02**: Ingesting a book registers it as an active primary source in the source library.
- **REQ-lec-03**: A chapter run extracts the chapter graph first and generates the lectures after it, with the chapter's nodes as input.
- **REQ-lec-04**: The chapter graph is extracted from the chapter text, never from generated discourse.
- **REQ-lec-05**: Lectures of one chapter are generated in sequence with a rolling summary; chapters run in parallel.
- **REQ-lec-06**: Each lecture is stored as `data/ext/lectures/<id>/lecture.json` with slides, role-typed blocks, narration cues, node references and timed exercises.
- **REQ-lec-07**: A validator rejects a lecture that cites a non-existent node id, reports chapter nodes covered by no lecture, and triggers at most two retries with feedback.
- **REQ-lec-08**: Lecture discourse rephrases the source and never reproduces it verbatim; editorial additions are tagged and distinguishable.
- **REQ-lec-09**: The lecture view is a native component of the app (not an iframe or an external page) with a slide section and a speech player with cue-synchronised highlighting.
- **REQ-lec-10**: Clicking a concept on a slide opens the node in a side panel beside the slides without leaving the lecture; navigation then continues inside the panel.
- **REQ-lec-11**: Lectures appear in the graph view as special nodes with `cites` edges derived from `lecture.json`; no lecture is written to the content ledgers.
- **REQ-lec-12**: A node's panel lists the lectures that cite it.
- **REQ-lec-13**: `office_hours` sessions ask Socratic questions per step and never state correctness themselves.
- **REQ-lec-14**: An office-hours verdict is produced only on request, only by comparison with a designated source or solution with a code-verified quotation, and otherwise reads "not verifiable".
- **REQ-lec-15**: The exercise set for a goal is non-immediate and built over nodes in the goal's scope.
- **REQ-lec-16**: The reference solution is built from nodes with trust level `sourced`; use of any other node marks the grading low confidence.
- **REQ-lec-17**: Exercise grading follows REQ-lec-13 and REQ-lec-14, and emits per-node outcomes as `exercise` review events (REQ-pl-14).
- **REQ-lec-18**: Chapter runs and exercise generation are subject to the daily cost ceiling of the parent spec.
- **REQ-lec-19**: The `lecture.json` schema and the validator rules are documented as language-neutral contracts (REQ-port-01).

## Risks

- Browser speech synthesis inside Electron may differ in voices and event support from the browser used by teacher; verify first.
- Extracting from chapter text depends on PDF text quality (same risk as the verification spec).
- Lecture generation quality is subjective; teacher evaluated it by feel with the user, not with automatic evals, and this spec does the same.
- Long chapters multiply cost; the cost ceiling and per-chapter runs bound it.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (lecture validator, verdict rules)
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

- The `lecture.json` schema and the converter from teacher's `slides.html` / `narrazione.txt` format and prompts (skills `lezione-da-dispensa`, `discorso-to-slides`).
- Entry point for ingesting a book before the UI exists (CLI or API route).
- The threshold for "most of the scope is solid" that triggers the exercise set (shared with the personal-layer spec).
- How the designated solution source for an exercise is chosen.
