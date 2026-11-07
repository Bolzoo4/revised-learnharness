# Exam training — design

Date: 2026-11-07. Origin: the learner wants a session where old exams are loaded and an agent helps solve them, finds what recurs, names the "typical exercises" and explains how each is solved. The app may later go to non-technical friends, so setup and cost must stay low; the work must be token efficient.

## Decisions taken with the learner

- A space of its own ("Exams"), not a mode of Study.
- Main use: guided, step by step solving of one exercise, without giving the solution away. Then analysis across exams: what recurs, the typical exercises, how each is solved, a study plan.
- Knowledge order: the learner's loaded material first, then web search when the agent judges the material insufficient.
- Old exams come with solutions only in part; the agent often derives solutions itself, so every solution carries a visible status.
- Two phases. Phase 1: collections, loading, splitting into exercises, material index, guided session on one exercise. Phase 2: analysis across exams, typical exercises, study plan.

## Design

- **Collection** per subject: exams and material (notes, book, slides, all PDFs). Stored under `data/ext/exams/<collectionId>/`.
- **Loading an exam**: the PDF is read once, split into exercises (text, page span, optional solution text, an `origin` of `exam` when the exam carries the solution). The learner sees the split and can merge, split or delete exercises: a wrong split makes everything after it useless, so it is reviewed before use.
- **Material index**: material is chunked once by page and section and indexed locally (lexical ranking, no embeddings and no provider call). Retrieval returns a bounded number of chunks with their page numbers. Embeddings can replace the ranker later without changing the tools.
- **Session kind `exam`** with tools: `get_exercise`, `search_material`, `search_web` (the existing web search/fetch jobs), `check_solution`. The prompt carries the current exercise and the retrieved chunks, never whole documents.
- **Guided protocol**: the agent asks what the learner tried, gives one hint at a time (ladder: where to look, the idea, the first step, the structure of the solution), and gives the full solution only when the learner asks for it.
- **Solution status**, shown on every solution and every check: `exam` (from the exam's own solution), `material` (a retrieved passage supports it), `derived` (the agent worked it out; a second independent derivation agrees), `unverified` (derived, no agreement or no source). The learner is never told "correct" about an `unverified` solution.
- **Material first, web second**: the web is searched only after a material search returned nothing the agent accepts, and the call records why. Web text is data.
- **Cost**: model calls count on the shared daily cost gate; the session shows tokens spent. Retrieval is capped per question.
- **Phase 2**: exercises across a collection's exams are grouped into types by a cheap model (label plus the exercises it covers), with counts per exam; each type gets an explanation of how it is solved built from the material and from solved examples; a study plan is produced against the learner's goals.

## Requirements

- **REQ-ex-01**: A collection holds exams and material; its files and index live under `data/ext/exams/<collectionId>/`; the format is documented in CONTRACTS.md.
- **REQ-ex-02**: Loading an exam PDF stores a list of exercises, each with id, exam id, page span, text and `origin` (`exam` when a solution came with it, else absent); a PDF that is not a PDF, is empty or exceeds the upload limit is refused with a fixed message.
- **REQ-ex-03**: The learner can merge two consecutive exercises, split one at a given point, delete one, and edit its text; the changes persist and no session reads an exercise list the learner has not been shown.
- **REQ-ex-04**: Loading material indexes it once; a document already indexed is not indexed again.
- **REQ-ex-05**: `search_material` returns at most K chunks (default 5) within a token cap, each with document and page; an empty result is reported as empty, never padded.
- **REQ-ex-06**: The session prompt contains the current exercise and the chunks retrieved for the current question only; no document is sent whole.
- **REQ-ex-07**: The `exam` session kind follows the guided protocol: no full solution before the learner asks for it; hints advance one rung at a time.
- **REQ-ex-08**: Every solution shown carries a status from `exam | material | derived | unverified`; `derived` requires a second independent derivation that agrees; the agent never says a solution is correct when its status is `unverified`.
- **REQ-ex-09**: `search_web` is callable only after a `search_material` call in the same exchange returned nothing accepted, and it records the reason; the order is enforced in code, not only in the prompt.
- **REQ-ex-10**: Text from PDFs, material, web pages and tool results is treated as data: it cannot change tools, status, limits or the guided protocol.
- **REQ-ex-11**: Spend of an exam session counts on the shared daily cost gate; when the gate is closed, the session says so and calls no model.
- **REQ-ex-12**: The Exams space is a page in the extension navigation; sessions of kind `exam` are listed there and under All, not under the other filters (like Study).
- **REQ-ex-13** (phase 2): Exercises of a collection are grouped into types; each type has a label, the exercises it covers and a count per exam; the learner can rename, merge or split types.
- **REQ-ex-14** (phase 2): Each type has an explanation of how it is solved, with the status of REQ-ex-08, built from the material and from solved examples.
- **REQ-ex-15** (phase 2): A study plan lists the types ordered by frequency and by the learner's weakness, and links to the learner's goals.

## Risks

- Splitting exams into exercises (scans, two-column layouts, formulas) may fail often: it is tested on real exams before phase 1 is accepted.
- Lexical retrieval may miss paraphrases; the ranker is behind one function so embeddings can replace it.
- A derived solution that two derivations share a mistake on is still wrong; the status says `derived`, not `correct`.

## Open items for the plan

- Where the exercise splitter gets its text (PDF text layer vs vision model for scans) and its limits on page count.
- Default K, the token cap, the per-question cap on web calls.
- Which extension navigation entry and icon.

## Security Profile

**Level:** baseline

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (status rules, enforcement of material-before-web, retrieval caps)
- adversarial-test-writing
- static-analysis-hardening

**Explicitly excluded:**
- mutation-testing — user decision 2026-11-05
- requirements-traceability-matrix — baseline chosen; REQ IDs are still assigned
- mcdc-coverage — baseline chosen
- system-safety-analysis — baseline chosen, no physical or irreversible failure modes
- watchdog-safe-state — baseline chosen; the cost gate is the safeguard
- lightweight-wcet — not applicable

**Set:** 2026-11-07, during brainstorming
