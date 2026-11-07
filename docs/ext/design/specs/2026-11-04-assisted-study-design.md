# Assisted Study — Design Spec (child 7 of 8)

**Status:** Draft for review
**Date:** 2026-11-04
**Parent:** `2026-11-04-learning-platform-integration-design.md` (adds the `study` session kind and the files `documents.jsonl`, `reading.jsonl`, `study-links.jsonl`)
**Depends on:** `2026-11-04-personal-layer-spaced-repetition-design.md` (cards), `2026-11-04-node-knowledge-design.md` (node panel), `2026-11-04-source-verification-design.md` (source library)

## Context

RepetitionLearning had a "study new" mode: the user reads a PDF page by page, writes flashcards on the fly, progress is saved, and a lazy step later asks a model for the missing cards with their page numbers. The user considers assisted study fundamental: upload a PDF, read and study it in the app, ask the agent a question at any moment (it uses the page being read), create flashcards directly from there, and keep every question in one continuous conversation per document.

## Goals

- Read a PDF inside the app next to a conversation that always knows the current page.
- Ask a question, select text, or take an agent answer and turn it into a card (and its node) in a few steps.
- One persistent conversation per document, continuable at any time.
- Optional "complete" step that proposes drafts for pages already read, never writing them without approval.

## Non-goals

- Extracting the whole document into the graph (that is the chapter run of the lecture spec); only what the user selects, asks, or approves enters the graph.
- Annotating or editing the PDF.
- Visual design of the study layout (UI session).

## Design

### Documents

Uploading a PDF registers a document: `documents.jsonl` event with id (sha256 of the file), title, page count, and a stored copy at `data/ext/documents/<id>.pdf`. The same file uploaded twice is the same document. The document is also registered as an active **primary** entry in the source library, so nodes created from it can be verified against it. A goal can be started from a document (umbrella: goals from a PDF).

### Reading

`reading.jsonl`: events `{documentId, page, at}` as the user moves; derived state is the last page (restored on opening) and the set of pages read (a page counts as read after a short dwell time, default 5 seconds).

### Study session

A session kind `study`, bound to one document. The layout shows the PDF on one side and the conversation on the other. The conversation is a normal chat record with a `documentId`; there is exactly one per document and it is reopened, not recreated, so questions accumulate. Long conversations rely on upstream's context compaction.

Every message the user sends carries the current page number and any selected text. The agent receives the text of the current page as context and has a tool to read other pages; it cites pages as `(p. N)` and those citations are clickable and move the viewer.

### Creating cards and nodes

From a selection, the current page, or an agent answer the user can create a card. The agent drafts a minimal proposition and a question/answer; the user edits and confirms (a user-confirmed card is `active`). The proposition goes through the existing extraction pipeline (notes-source path, source = the document), the auditor links it to an existing node if it is equivalent, and the card attaches to that node. `study-links.jsonl` records node ↔ (document, page), so a node's panel shows "Source: title, p. N" and opens the document at that page.

### Complete

For pages read and not yet processed, a headless run proposes draft nodes and cards, each with its page number, skipping what already exists from those pages. Drafts are shown for batch approval (agent-authored cards stay `draft` until approved). This respects the daily cost ceiling.

## Requirements

- **REQ-study-01**: Uploading a PDF registers a document in `documents.jsonl` with sha256 id, title, page count, and a stored copy; the same file is the same document.
- **REQ-study-02**: A registered document is an active primary entry in the source library.
- **REQ-study-03**: `reading.jsonl` records page movements; the last page is restored on opening and a page counts as read after a dwell time (default 5 seconds).
- **REQ-study-04**: The `study` session kind shows the PDF beside the conversation.
- **REQ-study-05**: There is exactly one study conversation per document; opening it again resumes it.
- **REQ-study-06**: Each user message carries the current page number and any selected text, and the agent receives the text of the current page.
- **REQ-study-07**: The agent can read other pages through a tool and cites pages as `(p. N)`; citations are clickable and move the viewer.
- **REQ-study-08**: A card can be created from a selection, the current page, or an agent answer; the agent drafts the proposition and the question/answer and the user confirms or edits.
- **REQ-study-09**: A confirmed proposition enters the graph through the existing extraction pipeline with the document as source; equivalent existing nodes are linked, not duplicated.
- **REQ-study-10**: `study-links.jsonl` records node ↔ (document, page); a node's panel shows the source and opens the document at that page.
- **REQ-study-11**: "Complete" proposes draft nodes and cards for pages read and not yet processed, with page numbers, skipping what already exists, and writes nothing active without approval.
- **REQ-study-12**: Nothing from a document enters the graph unless the user selects, asks or approves it.
- **REQ-study-13**: "Complete" runs are subject to the daily cost ceiling.
- **REQ-study-14**: The new file formats are documented as language-neutral contracts (REQ-port-01).

## Risks

- PDF text extraction quality affects both the page context and any quote check (shared risk with the verification spec).
- A very long single conversation grows in cost; upstream compaction mitigates it.
- The dwell-time rule can count skimmed pages as read; it only affects what "complete" offers.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (document identity, reading state derivation)
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

- PDF viewer library (`pdfjs-dist` is the candidate; a new dependency) and how it renders inside Electron.
- How selected text and the current page are attached to a chat message in upstream's message format.
- Reuse of upstream's PDF tools and of `PdfPageViewer.tsx` from RepetitionLearning.
- The exact trigger for the "complete" step and the draft approval flow.
