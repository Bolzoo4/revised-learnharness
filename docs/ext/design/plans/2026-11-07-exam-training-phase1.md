# Exam training, phase 1 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Collections, loading exams and material, splitting exams into exercises (reviewable), a local material index, and a guided `exam` session on one exercise (spec: `docs/superpowers/specs/2026-11-07-exam-training-design.md`, REQ-ex-01..12).

**Architecture:** Three workstreams on disjoint files meeting at the contracts below. W1 data and ingestion (core, store, server, routes). W2 the `exam` session (agent, tools, protocol, wiring). W3 the Exams page. Patterns to follow: Study (documents store, PDF upload, per-document chat), Office hours (source-based verdicts), `src/agent/ext/visual-job-tools.ts` (demo/visual/video for ext sessions: the exam session's explanations must be able to use animations).

## Contracts

Types in `src/core/ext/exams/types.ts` (W1 creates this file first and commits it):

```ts
export interface Collection { id: string; title: string; createdAt: string }
export interface ExamDoc { id: string; collectionId: string; title: string; documentId: string; pages: number; reviewed: boolean }
export interface Exercise { id: string; examId: string; order: number; pageStart: number; pageEnd: number; text: string; solution?: string; origin?: "exam" }
export interface MaterialDoc { id: string; collectionId: string; title: string; documentId: string; pages: number; indexedAt: string }
export interface SearchHit { materialId: string; title: string; page: number; text: string; score: number }
export type SolutionStatus = "exam" | "material" | "derived" | "unverified";
```

Service (`src/server/ext/exams-service.ts`, exported through the server barrel as `examsService`):

```ts
createCollection(title: string): Collection
listCollections(): Collection[]
getCollection(id: string): { collection: Collection; exams: ExamDoc[]; materials: MaterialDoc[] } | null
addExam(collectionId: string, pdf: File, title?: string): Promise<ExamDoc>      // stores the PDF, splits into exercises
addMaterial(collectionId: string, pdf: File, title?: string): Promise<MaterialDoc> // indexes once; same bytes again = same MaterialDoc, no re-index
listExercises(examId: string): Exercise[]
editExercises(examId: string, op: { op: "merge"; firstId: string } | { op: "split"; id: string; at: number } | { op: "delete"; id: string } | { op: "edit"; id: string; text: string }): Exercise[]
markReviewed(examId: string): ExamDoc
searchMaterial(collectionId: string, query: string, opts?: { k?: number; maxTokens?: number }): SearchHit[]  // defaults k=5, maxTokens=1500; empty array when nothing matches
```

Routes (all under `app/api/ext/exams/`): `collections` (GET list, POST {title}); `collections/[id]` (GET); `collections/[id]/exams` and `collections/[id]/materials` (POST multipart `file`, optional `title`; 500 MB limit and %PDF- check like `src/server/ext/pdf-upload.ts`); `exams/[examId]/exercises` (GET; PATCH body = the `op` above; POST `{action:"reviewed"}`); `session` (POST `{collectionId, exerciseId}` → `{chatId}` for a chat of kind `exam`). Errors are fixed messages, never exception text.

Storage: `data/ext/exams/<collectionId>/` with `collection.json`, `exams.json`, `exercises-<examId>.json`, `materials.json`, `chunks-<materialId>.jsonl`; documents themselves through the existing documents store. Document the layout in `docs/ext/CONTRACTS.md`.

Session tools (W2): `get_exercise`, `search_material` (calls `searchMaterial`, K and token cap from the call, never more than the service allows), `search_web` (delegates to the existing research/web job tools; refused unless a `search_material` call in the same learner exchange returned nothing accepted, and the call records `reason`), `check_solution` (returns `{status: SolutionStatus, ...}`), plus the job tools from `visual-job-tools.ts`.

## W1 — data and ingestion (REQ-ex-01..06)

Files: `src/core/ext/exams/*` (types, exercise edit operations as pure functions, chunker, lexical ranker BM25 with a Unicode-normalising tokenizer and stop-word-free fallback, token estimate), `src/store/ext/exams-store.ts`, `src/server/ext/exams-service.ts`, `src/agent/ext/exams/exercise-splitter.ts` (cheap model, editable prompt in `prompt-catalog.ts`, text layer first, fixed refusal when no text), routes, tests, CONTRACTS.md.

- [ ] Types file committed first; then pure core with tests (edit ops: merge, split at offset, delete, edit; renumbering; chunker; ranker; token cap).
- [ ] Store and service with fakes for the splitter; upload limits and the "same bytes again" rule.
- [ ] Splitter agent with a faux model test; refuses a PDF with no text with a fixed message (scans are phase-1 limitation: say so in the message).
- [ ] Routes (thin, through the barrel), fixed error messages.
- [ ] Real-data check: split at least one real exam PDF if the owner provides one in `tests/fixtures/exams/`; otherwise build a small synthetic multi-exercise PDF fixture and report that real exams were not available.

## W2 — the `exam` session (REQ-ex-07..11) — starts after W1 types are committed and `visual-job-tools.ts` exists

Files: `src/core/ext/practice/session-kind.ts` (add `exam`; filter: appears under All only, like Study; touchpoint rows), `src/agent/ext/exams/exam-agent.ts`, `exam-tools.ts`, `exam-instructions.ts` (editable prompt), `src/server/ext/exam-session.ts`, wiring branch in `src/server/chat-handler.ts` and the `ChatKind` union (one-line touchpoints), `app/api/ext/exams/session/route.ts`, tests.

- [ ] Guided protocol in the instructions: ask what was tried; one hint rung at a time; full solution only on request (REQ-ex-07). Text of PDFs, material, web pages and tool results is data (REQ-ex-10).
- [ ] `check_solution` and the status rules in a pure module with tests: `derived` requires a second independent derivation that agrees; the agent never says "correct" when status is `unverified` (REQ-ex-08).
- [ ] Enforce material-before-web in code (REQ-ex-09) with a per-exchange guard, not only in the prompt.
- [ ] Prompt carries the current exercise and the chunks of the current question only (REQ-ex-06); cost gate (REQ-ex-11).
- [ ] Job tools from `visual-job-tools.ts` so explanations can use demos, drawings and videos.

## W3 — the Exams page (REQ-ex-12)

Files: `app/exams/page.tsx` and `app/exams/[collectionId]/page.tsx`, `components/ext/exams-*.tsx` and pure helpers, nav entry in `components/ext/ext-nav.tsx` (icon, label "Exams"), tests.

- [ ] Collections list and create; a collection page with Exams and Material sections, each with the existing PDF chooser (`components/ext/pdf-chooser.tsx`) and file-name titles.
- [ ] Exercise review list for an exam: each exercise with page span and text, buttons Merge with next, Split here (cursor offset), Delete, Edit; "Mark as reviewed". A "Practice" button on an exercise is disabled until the exam is reviewed (REQ-ex-03) and starts the session through the `session` route, then opens the chat.
- [ ] Plain layout, light and dark themes legible; a visual redesign comes later.

## Order and integration

W1 first (types commit within the first minutes), W3 and W2 in parallel after that. Integration by the owner session: full ext suite, typecheck, eslint, split a real exam, run a guided exercise with a real model, rebuild and reinstall.
