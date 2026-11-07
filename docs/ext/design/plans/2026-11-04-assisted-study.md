# Assisted Study Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a PDF inside the app beside its one persistent conversation, which always knows the current page; turn a selection, a page or an answer into a card and a graph node; optionally "complete" the pages already read into drafts the learner approves.

**Architecture:** A new session kind `study` (practice-like: the chat-level extraction never runs on it). Everything is extension code under `src/*/ext/study/` plus four new ledgers and a content-addressed document store in `data/ext/`. The conversation is bound to its document by an event in `documents.jsonl`, not by a new field on the upstream chat record. Every learner message starts with a `[study-context] {json}` line (document, page, selection); the agent's prompt is composed per turn from the newest such line plus the text of that page. A confirmed card sends its proposition through upstream's notes-import front door (`extraction.importNotes`), so equivalent nodes are linked, never duplicated; the card is then created through the personal layer's `createUserCard`. "Complete" is a headless, cost-gated run that writes only `proposed` draft events; approval is what sends a proposition to the pipeline.

**Tech Stack:** TypeScript on Node 26, Next.js 16 (Turbopack), React, `pdfjs-dist` 6.3.289 (already a dependency of the fork), `node:test` run by `tsx`. The fork is `learnharness/`, branch `ext`.

---

## Read this first

- **Where the work happens.** All paths are relative to `learnharness/` (the fork at `<repo>`, branch `ext`). Every command below assumes `cd` into it and `source ~/.nvm/nvm.sh && nvm use 26`.
- **Tests.** `NODE_ENV=test npx tsx --test tests/<file>`. The whole extension suite is `NODE_ENV=test npx tsx --test tests/ext-*.test.ts`. Imports use `.ts` extensions inside `src/` and `tests/`; `components/` and `app/` import only the `@/src/core` and `@/src/server` barrels.
- **Layering (ESLint-enforced).** `src/core` is pure (no `node:` imports in the files the browser barrel reaches); `src/store` holds filesystem adapters; `src/agent` holds model-facing code; `src/server` holds the composition roots. Run `npx eslint` on what you touched at the end of each task.
- **How this plan was produced.** Every file in this plan was written and run in a scratch copy of the fork. At that point the whole extension suite passed (637 tests), and `tsc --noEmit` and ESLint were clean on the new files. The code below is that code; copy it verbatim. If a step's expected output differs from what you see, stop and find out why before moving on.
- **The PDF viewer was verified separately** (a throwaway Electron probe rendered a page to a canvas and built the text layer, 214 spans on a text page; a scratch Turbopack build compiled the dynamic `pdfjs-dist` import). Task 1 repeats the text-quality half of that check on your own PDF.
- **The fork keeps moving.** Other plans (research loop) edit some of the same lines (`ChatKind`, `createChat`, barrels). Each edit below is one token or one line, so a conflict resolves by keeping both sides.
- **Commit trailer.** Every commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; the commands below pass it as a second `-m`.

## Decisions taken in this plan (each has a default; the user can overturn any)

1. **Registration is by absolute local path**, not multipart upload. The app is a local desktop app, `proxy.ts` caps request bodies, and the learner's PDFs already live on disk. The server reads the file, checks the `%PDF-` magic and a 200 MiB cap, stores a content-addressed copy, and registers it. (Upload can be added later behind the same service method.)
2. **One extra file, `study-drafts.jsonl`.** The umbrella spec lists three new files; "complete" needs somewhere to hold proposals that are not graph content yet. Draft nodes cannot live in the graph (only the extraction pipeline writes it), so proposals are events until approved.
3. **Confirmed cards pin their node by default** (a checkbox lets the learner turn that off), because the deck is "the active goal's scope plus pinned nodes" and a card nobody can reach is a dead end.
4. **Interactive card drafting is not blocked by the daily ceiling** (it is spend, so it is still recorded). Only "complete" runs are gated (REQ-study-13).
5. **The one conversation per document is bound by `documents.jsonl` (`chat` event, first wins)**, not by a `documentId` on `ChatRecord`, so no upstream type gains a field.
6. **Scanned PDFs (no text layer) are refused with 422.** There is no OCR here; Task 1 is where you find out if your books are affected.
7. **One extraction run per confirmed card.** Simple and cheap per card, but it creates many small `study/<title>/p0012-<hash>.md` sources in the source directory. Batching is a later optimisation, not built.

## Upstream touchpoints (the closed list; each needs a stated reason)

| File | Change | Reason |
|---|---|---|
| `src/core/contracts/chat.ts` | `ChatKind` gains `"study"` | the session kind |
| `src/core/ports.ts` | `ChatStore.createChat` accepts `"study"` | create the session |
| `src/store/chats.ts` | `createChat` signature widened | same |
| `src/core/ext/practice/session-kind.ts` | `isPracticeLike` accepts `"study"` | suppress chat-level extraction (REQ-study-12) |
| `src/server/chat-handler.ts` | import + `record.kind === "study"` branch | the study agent |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for `study` | reopen from the sidebar |
| `components/chat.tsx` | optional `transformOutgoing` prop applied on send and steer | attach page and selection to each message (REQ-study-06) |
| `components/ext/node-panel-view.tsx` | "Source in your documents" section | REQ-study-10 |
| `src/core/ext/node-panel*.ts`, `src/server/ext/panel-providers.ts` | `studySources` (extension files; the panel's reserved seam) | REQ-study-10 |
| `src/core/ext/index.ts`, `src/server/ext/index.ts`, `src/server/ext/stores.ts` | barrel lines and five store members (extension files) | wiring |

No `package.json` change: `pdfjs-dist` is already installed.

## File structure

```
src/core/ext/study/      context.ts documents.ts reading.ts links.ts drafts.ts card-node.ts source-path.ts ports.ts
src/store/ext/           documents-store.ts
src/agent/ext/study/     pdf-pages.ts study-tools.ts study-instructions.ts study-agent.ts draft-writer.ts
src/server/ext/          study-service.ts study-input.ts study-engine.ts study-live.ts
app/api/ext/study/       documents/route.ts documents/[id]/route.ts documents/[id]/pdf/route.ts
                         reading/route.ts cards/route.ts drafts/route.ts goal/route.ts
app/study/               page.tsx [documentId]/page.tsx
components/ext/          citation-click.ts pdf-viewer.tsx study-home.tsx study-view.tsx
tests/                   ext-study-*.test.ts ext-citation-click.test.ts helpers/study-fakes.ts
docs/ext/                CONTRACTS.md TOUCHPOINTS.md (appended in the last-but-one task, described there)
```

Responsibilities: `core` holds the pure rules (context line, event parsers and derivations, matching); `store` holds the PDF and page-text files; `agent` holds the study tools, prompt and the two drafting calls; `server/ext/study-service.ts` holds the use cases behind ports, and `study-live.ts` is the only file that wires them to the real stores, engine and cost gate.

---

### Task 1: Environment check (PDF text quality)

Everything downstream (the agent's page context, the drafting calls, the "complete" run) reads text extracted from the PDF by upstream's `pdfExtract`. If the math in your own books comes out damaged, find out now. The script already exists in the fork (`scripts/ext-check-pdf-math.ts`, added for the lecture work); this task only runs it.

**Files:** none created or modified.

- [ ] **Step 1: Run the check on a page range with formulas**

```bash
cd <repo>
source ~/.nvm/nvm.sh && nvm use 26
npx tsx scripts/ext-check-pdf-math.ts <local>/dispense_Prob_1.pdf 10-12
```

Expected (verified on the author's machine for this PDF): a JSON block with `"replacementChars": 0`, `"privateUse": 0`, `"cidTokens": 0`, `"controlChars": 0`, `"damageRatio": 0` and `"mathLines": 15`, followed by "Most mathematical lines (read them):" and 15 lines. Exit code 0.

- [ ] **Step 2: Read the sample lines yourself**

The counters catch encoding damage; only your eyes catch a garbled formula. Open the PDF at pages 10-12 and compare a few of the printed lines with the page.

- [ ] **Step 3: Decide**
  - `damageRatio` at most 0.01 and the lines readable: continue.
  - Otherwise, or if the PDF is a scan (the check prints `"chars": 0` and exits 1): the page context and every drafting call will be poor for that book. Tell the user before building further; the plan refuses scans at registration (decision 6) but cannot repair a book whose formulas are garbled.

- [ ] **Step 4: Nothing to commit.** Note the result (ratio, readable or not) in the task report.

---

### Task 2: The study context line and page citations (core, browser-safe)

REQ-study-06 (page and selection travel with each message) and REQ-study-07 (citations `(p. N)` are recognised). This file is imported by the browser, so it must not import `node:`.

**Files:**
- Create: `src/core/ext/study/context.ts`
- Modify: `src/core/ext/index.ts` (one export line)
- Test: `tests/ext-study-context.test.ts`, `tests/ext-study-core-barrel.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/ext-study-context.test.ts`

```typescript
// tests/ext-study-context.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	citationAt,
	encodeStudyContext,
	latestStudyContext,
	MAX_SELECTION_CHARS,
	pageCitations,
	parseStudyContext,
	STUDY_CONTEXT_PREFIX,
} from "../src/core/ext/study/context.ts";

const DOC = "a".repeat(64);

describe("study message context (REQ-study-06)", () => {
	it("round-trips the page, the selection and the learner's text", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 12, selection: "σ-algebra" }, "What is this?");
		assert.ok(wire.startsWith(STUDY_CONTEXT_PREFIX));
		assert.deepEqual(parseStudyContext(wire), { context: { documentId: DOC, page: 12, selection: "σ-algebra" }, text: "What is this?" });
	});
	it("keeps multi-line selections and multi-line text apart (newlines are escaped in the JSON line)", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 1, selection: "line one\nline two" }, "first\nsecond");
		const parsed = parseStudyContext(wire)!;
		assert.equal(parsed.context.selection, "line one\nline two");
		assert.equal(parsed.text, "first\nsecond");
	});
	it("a selection that imitates the prefix cannot forge a second context", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 3, selection: `x\n${STUDY_CONTEXT_PREFIX}{"documentId":"evil","page":99}` }, "hi");
		const parsed = parseStudyContext(wire)!;
		assert.equal(parsed.context.page, 3);
		assert.equal(parsed.text, "hi");
	});
	it("cuts a selection longer than the limit", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 1, selection: "x".repeat(MAX_SELECTION_CHARS + 500) }, "t");
		assert.equal([...parseStudyContext(wire)!.context.selection].length, MAX_SELECTION_CHARS);
	});
	it("a message without a valid context line is not a study message", () => {
		for (const bad of [
			"plain question",
			`${STUDY_CONTEXT_PREFIX}not json\ntext`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: "", page: 1 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 0 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 1.5 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 1, selection: 7 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}null\nt`,
		]) {
			assert.equal(parseStudyContext(bad), null, bad);
		}
	});
	it("a context line without text gives empty text", () => {
		const wire = `${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 2 })}`;
		assert.deepEqual(parseStudyContext(wire), { context: { documentId: DOC, page: 2, selection: "" }, text: "" });
	});
});

describe("latestStudyContext", () => {
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	it("reads the newest user message only", () => {
		const messages = [
			user(encodeStudyContext({ documentId: DOC, page: 4, selection: "" }, "old")),
			{ role: "assistant", content: [{ type: "text", text: "answer (p. 4)" }] },
			user(encodeStudyContext({ documentId: DOC, page: 9, selection: "s" }, "new")),
		];
		assert.deepEqual(latestStudyContext(messages), { documentId: DOC, page: 9, selection: "s" });
	});
	it("is null when the newest user message has no context, even if an older one had", () => {
		const messages = [user(encodeStudyContext({ documentId: DOC, page: 4, selection: "" }, "old")), user("no context here")];
		assert.equal(latestStudyContext(messages), null);
	});
	it("accepts string content and is null for no user message", () => {
		assert.deepEqual(latestStudyContext([{ role: "user", content: encodeStudyContext({ documentId: DOC, page: 2, selection: "" }, "q") }])?.page, 2);
		assert.equal(latestStudyContext([]), null);
		assert.equal(latestStudyContext([{ role: "assistant", content: "x" }]), null);
	});
});

describe("page citations (REQ-study-07)", () => {
	const text = "See the definition (p. 12) and the proof (p.14). Not this (page 3) or (p. x).";
	it("finds every (p. N), tolerating a missing space", () => {
		assert.deepEqual(pageCitations(text).map((c) => c.page), [12, 14]);
	});
	it("maps an offset inside a citation to its page, and any other offset to null", () => {
		const at = text.indexOf("(p. 12)");
		assert.equal(citationAt(text, at), 12);
		assert.equal(citationAt(text, at + 3), 12);
		assert.equal(citationAt(text, at + "(p. 12)".length - 1), 12);
		assert.equal(citationAt(text, at + "(p. 12)".length), null);
		assert.equal(citationAt(text, at - 1), null);
		assert.equal(citationAt(text, text.indexOf("(page 3)")), null);
	});
	it("ignores page 0", () => {
		assert.deepEqual(pageCitations("(p. 0)"), []);
	});
});
```

`tests/ext-study-core-barrel.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import * as core from "../src/core/index.ts";

describe("browser-safe core barrel for the lecture player", () => {
	it("exports what the player needs", () => {
		assert.equal(typeof core.activeCue, "function");
		assert.equal(typeof core.parseNodeLinks, "function");
		assert.equal(typeof core.stripNodeLinks, "function");
		assert.deepEqual(core.parseNodeLinks("a [[n_x|b]] c").map((p) => p.kind), ["text", "node", "text"]);
	});
	it("the modules behind it import nothing from node:", () => {
		for (const f of ["src/core/ext/lecture/lecture.ts", "src/core/ext/lecture/cues.ts", "src/core/ext/index.ts"]) {
			assert.equal(/from\s+"node:/.test(fs.readFileSync(f, "utf-8")), false, f);
		}
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-context.test.ts tests/ext-study-core-barrel.test.ts`
Expected: FAIL, `Cannot find module '../src/core/ext/study/context.ts'` (the barrel test fails on `core.encodeStudyContext` being undefined).

- [ ] **Step 3: Implement**

`src/core/ext/study/context.ts`

```typescript
// src/core/ext/study/context.ts
/**
 * What a study message carries (REQ-study-06) and the page citations the
 * agent writes (REQ-study-07). Browser-safe: no node: imports, because the
 * study view builds the message and reads the citations in the browser.
 *
 * Wire format of a user message in a study session: a first line
 * `[study-context] <JSON>` and, after the first newline, the learner's text.
 * JSON.stringify escapes every newline, so a selection can never end the
 * first line early.
 */

export const STUDY_CONTEXT_PREFIX = "[study-context] ";
/** Longest selection a message carries; longer selections are cut. */
export const MAX_SELECTION_CHARS = 2000;

export interface StudyContext {
	documentId: string;
	/** 1-based page the learner is looking at. */
	page: number;
	/** Text the learner selected (empty when none). */
	selection: string;
}

function clip(selection: string): string {
	const chars = [...selection.trim()];
	return chars.length <= MAX_SELECTION_CHARS ? chars.join("") : chars.slice(0, MAX_SELECTION_CHARS).join("");
}

/** The text to send: the context line, then the learner's own text. */
export function encodeStudyContext(ctx: StudyContext, text: string): string {
	const payload = { documentId: ctx.documentId, page: ctx.page, selection: clip(ctx.selection) };
	return `${STUDY_CONTEXT_PREFIX}${JSON.stringify(payload)}\n${text}`;
}

/** The context and the learner's text, or null when the message has no valid context line. */
export function parseStudyContext(message: string): { context: StudyContext; text: string } | null {
	if (!message.startsWith(STUDY_CONTEXT_PREFIX)) return null;
	const newline = message.indexOf("\n");
	const line = newline === -1 ? message : message.slice(0, newline);
	let raw: unknown;
	try {
		raw = JSON.parse(line.slice(STUDY_CONTEXT_PREFIX.length));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) return null;
	if (r.selection !== undefined && typeof r.selection !== "string") return null;
	return {
		context: { documentId: r.documentId, page: r.page, selection: clip(typeof r.selection === "string" ? r.selection : "") },
		text: newline === -1 ? "" : message.slice(newline + 1),
	};
}

/** Plain text of a stored user message (a string, or the text parts of a content array). */
export function userMessageText(message: { role: string; content: unknown }): string {
	if (message.role !== "user") return "";
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.map((part) =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/** The context of the NEWEST user message, or null when that message has none. */
export function latestStudyContext(messages: readonly { role: string; content: unknown }[]): StudyContext | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		return parseStudyContext(userMessageText(m))?.context ?? null;
	}
	return null;
}

export interface PageCitation {
	page: number;
	/** Offsets of the whole `(p. N)` in the searched text. */
	start: number;
	end: number;
}

/** Every `(p. N)` in the text, in order. N is a positive integer. */
export function pageCitations(text: string): PageCitation[] {
	const found: PageCitation[] = [];
	for (const m of text.matchAll(/\(p\.\s*(\d{1,5})\)/g)) {
		const page = Number(m[1]);
		if (page >= 1) found.push({ page, start: m.index, end: m.index + m[0].length });
	}
	return found;
}

/** The page of the citation that covers `offset`, or null. */
export function citationAt(text: string, offset: number): number | null {
	return pageCitations(text).find((c) => offset >= c.start && offset < c.end)?.page ?? null;
}
```

In `src/core/ext/index.ts`, add this line after `export { isPracticeLike } from "./practice/session-kind.ts";`:

```ts
export * from "./study/context.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-context.test.ts tests/ext-study-core-barrel.test.ts`
Expected: `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0` (12 + 2).

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/study/context.ts src/core/ext/index.ts tests/ext-study-context.test.ts tests/ext-study-core-barrel.test.ts
git commit -m "feat(ext): study context line and page citations" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Documents, reading and node-page links (pure event derivations)

REQ-study-01 and REQ-study-05 (identity and the one conversation per document), REQ-study-03 (last page and dwell), REQ-study-10 (links). Parsers skip corrupt lines; derivations replay the file in order.

**Files:**
- Create: `src/core/ext/study/documents.ts`, `src/core/ext/study/reading.ts`, `src/core/ext/study/links.ts`
- Test: `tests/ext-study-events.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-events.test.ts`

```typescript
// tests/ext-study-events.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentOfChat, deriveDocuments, parseDocumentEvent, type DocumentEvent } from "../src/core/ext/study/documents.ts";
import { deriveReading, parseReadingEvent, type ReadingEvent } from "../src/core/ext/study/reading.ts";
import { linkedPages, nodeIdsOnPages, parseStudyLinkEvent, sourcesOfNode, type StudyLinkEvent } from "../src/core/ext/study/links.ts";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const t = (s: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, s)).toISOString();

describe("documents.jsonl (REQ-study-01, REQ-study-05)", () => {
	const reg = (id: string, title: string, at = t(0)): DocumentEvent => ({ type: "registered", documentId: id, title, pageCount: 10, at });
	it("the same file registered twice is the same document; the first event wins", () => {
		const docs = deriveDocuments([reg(D1, "First"), reg(D1, "Second", t(5)), reg(D2, "Other")]);
		assert.deepEqual(docs.map((d) => [d.id, d.title]), [[D1, "First"], [D2, "Other"]]);
	});
	it("exactly one conversation per document: the first chat event wins", () => {
		const docs = deriveDocuments([
			reg(D1, "A"),
			{ type: "chat", documentId: D1, chatId: "chat_1", at: t(1) },
			{ type: "chat", documentId: D1, chatId: "chat_2", at: t(2) },
		]);
		assert.equal(docs[0]!.chatId, "chat_1");
		assert.equal(documentOfChat(docs, "chat_1")?.id, D1);
		assert.equal(documentOfChat(docs, "chat_2"), null);
	});
	it("a chat event for an unregistered document is ignored", () => {
		assert.deepEqual(deriveDocuments([{ type: "chat", documentId: D1, chatId: "c", at: t(0) }]), []);
	});
	it("rejects malformed events", () => {
		const ok = { type: "registered", documentId: D1, title: " A ", pageCount: 3, at: t(0) };
		assert.deepEqual(parseDocumentEvent(ok), { type: "registered", documentId: D1, title: "A", pageCount: 3, at: t(0) });
		for (const bad of [
			{ ...ok, documentId: "xyz" },
			{ ...ok, documentId: "ABCDEF".repeat(11).slice(0, 64) },
			{ ...ok, title: "  " },
			{ ...ok, pageCount: 0 },
			{ ...ok, pageCount: 2.5 },
			{ ...ok, at: "yesterday" },
			{ type: "chat", documentId: D1, chatId: "", at: t(0) },
			{ type: "other", documentId: D1, at: t(0) },
			null,
		]) {
			assert.equal(parseDocumentEvent(bad), null, JSON.stringify(bad));
		}
	});
});

describe("reading.jsonl (REQ-study-03)", () => {
	const visit = (page: number, s: number, documentId = D1): ReadingEvent => ({ type: "visit", documentId, page, at: t(s) });
	const close = (s: number, documentId = D1): ReadingEvent => ({ type: "close", documentId, at: t(s) });

	it("restores the last page visited", () => {
		assert.deepEqual(deriveReading([visit(3, 0), visit(7, 2)], D1).lastPage, 7);
		assert.equal(deriveReading([], D1).lastPage, null);
	});
	it("a page is read after the dwell time (default 5 s) and not before", () => {
		const s = deriveReading([visit(1, 0), visit(2, 4), visit(3, 9), close(30)], D1);
		assert.deepEqual(s.readPages, [2, 3]); // page 1: 4 s, page 2: 5 s (boundary counts), page 3: 21 s
	});
	it("the newest visit has no end yet and is not read until something follows it", () => {
		assert.deepEqual(deriveReading([visit(1, 0)], D1).readPages, []);
		assert.deepEqual(deriveReading([visit(1, 0), close(60)], D1).readPages, [1]);
	});
	it("a close ends the visit, so time after the close does not count for the next visit's page", () => {
		const s = deriveReading([visit(1, 0), close(1), visit(2, 100)], D1);
		assert.deepEqual(s.readPages, []);
		assert.equal(s.lastPage, 2);
	});
	it("other documents' events do not interrupt or count", () => {
		const s = deriveReading([visit(1, 0), visit(9, 2, D2), close(8, D2), visit(4, 12)], D1);
		assert.deepEqual(s.readPages, [1]);
	});
	it("honours a custom dwell and ignores pages beyond the page count", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 2), close(3)], D1, { dwellSeconds: 2 }).readPages, [1]);
		const s = deriveReading([visit(50, 0), visit(2, 10), close(20)], D1, { pageCount: 10 });
		assert.deepEqual(s.readPages, [2]);
		assert.equal(deriveReading([visit(50, 0)], D1, { pageCount: 10 }).lastPage, null);
	});
	it("a clock that went backwards never counts as dwell", () => {
		assert.deepEqual(deriveReading([visit(1, 30), visit(2, 0), close(1)], D1).readPages, []);
	});
	it("rejects malformed events", () => {
		for (const bad of [{ type: "visit", documentId: D1, page: 0, at: t(0) }, { type: "visit", documentId: "", page: 1, at: t(0) }, { type: "close", documentId: D1, at: "x" }, { type: "move" }, 3]) {
			assert.equal(parseReadingEvent(bad), null, JSON.stringify(bad));
		}
		assert.deepEqual(parseReadingEvent({ type: "close", documentId: D1, at: t(0) }), { type: "close", documentId: D1, at: t(0) });
	});
});

describe("study-links.jsonl (REQ-study-10)", () => {
	const link = (nodeId: string, documentId: string, page: number): StudyLinkEvent => ({ type: "link", nodeId, documentId, page, at: t(0) });
	const events = [link("n_a", D1, 3), link("n_a", D1, 3), link("n_a", D2, 1), link("n_b", D1, 3), link("n_c", D1, 8)];
	it("lists the distinct sources of a node in order of first appearance", () => {
		assert.deepEqual(sourcesOfNode(events, "n_a"), [{ documentId: D1, page: 3 }, { documentId: D2, page: 1 }]);
		assert.deepEqual(sourcesOfNode(events, "n_zzz"), []);
	});
	it("lists the pages of a document that have nodes, and the nodes on given pages", () => {
		assert.deepEqual(linkedPages(events, D1), [3, 8]);
		assert.deepEqual(nodeIdsOnPages(events, D1, [3]), ["n_a", "n_b"]);
		assert.deepEqual(nodeIdsOnPages(events, D1, [4]), []);
	});
	it("rejects malformed events", () => {
		assert.equal(parseStudyLinkEvent({ type: "link", nodeId: "n", documentId: D1, page: 0, at: t(0) }), null);
		assert.equal(parseStudyLinkEvent({ type: "link", nodeId: "", documentId: D1, page: 1, at: t(0) }), null);
		assert.deepEqual(parseStudyLinkEvent(link("n", D1, 2)), link("n", D1, 2));
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-events.test.ts`
Expected: FAIL, `Cannot find module '../src/core/ext/study/documents.ts'`.

- [ ] **Step 3: Implement the three modules**

`src/core/ext/study/documents.ts`

```typescript
// src/core/ext/study/documents.ts
/**
 * documents.jsonl (REQ-study-01, REQ-study-05): registered PDFs and the one
 * conversation bound to each. Server-side module (not in the browser barrel).
 *
 * Event `registered`: the document's identity is the sha256 of the file, so
 * the same file registered twice is the same document (the first event wins).
 * Event `chat`: binds the document's study conversation; the first one wins,
 * which is what makes the conversation unique per document.
 */

export const DOCUMENT_ID_RE = /^[0-9a-f]{64}$/;

export type DocumentEvent =
	| { type: "registered"; documentId: string; title: string; pageCount: number; at: string }
	| { type: "chat"; documentId: string; chatId: string; at: string };

export interface StudyDocument {
	id: string;
	title: string;
	pageCount: number;
	registeredAt: string;
	/** The document's conversation, or null until it is first opened. */
	chatId: string | null;
}

const validAt = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function parseDocumentEvent(raw: unknown): DocumentEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || !DOCUMENT_ID_RE.test(r.documentId) || !validAt(r.at)) return null;
	if (r.type === "registered") {
		if (typeof r.title !== "string" || r.title.trim() === "") return null;
		if (typeof r.pageCount !== "number" || !Number.isInteger(r.pageCount) || r.pageCount < 1) return null;
		return { type: "registered", documentId: r.documentId, title: r.title.trim(), pageCount: r.pageCount, at: r.at };
	}
	if (r.type === "chat") {
		if (typeof r.chatId !== "string" || r.chatId === "") return null;
		return { type: "chat", documentId: r.documentId, chatId: r.chatId, at: r.at };
	}
	return null;
}

/** Replay in file order. A `chat` event for an unregistered document is ignored. */
export function deriveDocuments(events: readonly DocumentEvent[]): StudyDocument[] {
	const docs = new Map<string, StudyDocument>();
	for (const e of events) {
		if (e.type === "registered") {
			if (!docs.has(e.documentId)) {
				docs.set(e.documentId, { id: e.documentId, title: e.title, pageCount: e.pageCount, registeredAt: e.at, chatId: null });
			}
			continue;
		}
		const doc = docs.get(e.documentId);
		if (doc !== undefined && doc.chatId === null) doc.chatId = e.chatId;
	}
	return [...docs.values()];
}

/** The document a study conversation belongs to, or null. */
export function documentOfChat(docs: readonly StudyDocument[], chatId: string): StudyDocument | null {
	return docs.find((d) => d.chatId === chatId) ?? null;
}
```

`src/core/ext/study/reading.ts`

```typescript
// src/core/ext/study/reading.ts
/**
 * reading.jsonl (REQ-study-03). Events are page movements:
 *   visit {documentId, page, at}  the learner arrived on a page
 *   close {documentId, at}        the learner left the document
 * Derived state: the last page visited (restored when the document opens) and
 * the set of pages READ. A visit lasts until the next event of the same
 * document (a visit or a close); a page is read when some visit to it lasted
 * at least the dwell time. The newest visit has no end yet, so it counts as
 * read only once another event follows it.
 */

export const DEFAULT_DWELL_SECONDS = 5;

export type ReadingEvent =
	| { type: "visit"; documentId: string; page: number; at: string }
	| { type: "close"; documentId: string; at: string };

export interface ReadingState {
	/** Page of the newest visit; null when the document was never opened. */
	lastPage: number | null;
	/** Ascending, distinct. */
	readPages: number[];
}

export function parseReadingEvent(raw: unknown): ReadingEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "close") return { type: "close", documentId: r.documentId, at: r.at };
	if (r.type === "visit") {
		if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) return null;
		return { type: "visit", documentId: r.documentId, page: r.page, at: r.at };
	}
	return null;
}

export function deriveReading(
	events: readonly ReadingEvent[],
	documentId: string,
	opts: { dwellSeconds?: number; pageCount?: number } = {},
): ReadingState {
	const dwellMs = (opts.dwellSeconds ?? DEFAULT_DWELL_SECONDS) * 1000;
	const inRange = (page: number): boolean => opts.pageCount === undefined || page <= opts.pageCount;
	const read = new Set<number>();
	let lastPage: number | null = null;
	let open: { page: number; at: number } | null = null;
	for (const e of events) {
		if (e.documentId !== documentId) continue;
		const at = Date.parse(e.at);
		if (open !== null && at - open.at >= dwellMs && inRange(open.page)) read.add(open.page);
		if (e.type === "visit") {
			open = { page: e.page, at };
			lastPage = e.page;
		} else {
			open = null;
		}
	}
	return { lastPage: lastPage !== null && inRange(lastPage) ? lastPage : null, readPages: [...read].sort((a, b) => a - b) };
}
```

`src/core/ext/study/links.ts`

```typescript
// src/core/ext/study/links.ts
/**
 * study-links.jsonl (REQ-study-10): which nodes came from which page of which
 * document. Append-only; nothing here is derived from the content ledgers, so
 * a node that no longer exists is filtered by the caller at read time.
 */

export interface StudyLinkEvent {
	type: "link";
	nodeId: string;
	documentId: string;
	page: number;
	at: string;
}

export interface NodeSource {
	documentId: string;
	page: number;
}

export function parseStudyLinkEvent(raw: unknown): StudyLinkEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "link") return null;
	if (typeof r.nodeId !== "string" || r.nodeId === "" || typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) return null;
	if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
	return { type: "link", nodeId: r.nodeId, documentId: r.documentId, page: r.page, at: r.at };
}

/** The (document, page) pairs a node came from: distinct, in order of first appearance. */
export function sourcesOfNode(events: readonly StudyLinkEvent[], nodeId: string): NodeSource[] {
	const seen = new Set<string>();
	const out: NodeSource[] = [];
	for (const e of events) {
		if (e.nodeId !== nodeId) continue;
		const key = `${e.documentId}\u0000${e.page}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ documentId: e.documentId, page: e.page });
	}
	return out;
}

/** Pages of a document that already have at least one node, ascending. */
export function linkedPages(events: readonly StudyLinkEvent[], documentId: string): number[] {
	return [...new Set(events.filter((e) => e.documentId === documentId).map((e) => e.page))].sort((a, b) => a - b);
}

/** Distinct node ids linked to any of the pages. */
export function nodeIdsOnPages(events: readonly StudyLinkEvent[], documentId: string, pages: readonly number[]): string[] {
	const want = new Set(pages);
	return [...new Set(events.filter((e) => e.documentId === documentId && want.has(e.page)).map((e) => e.nodeId))];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-events.test.ts`
Expected: `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/study/documents.ts src/core/ext/study/reading.ts src/core/ext/study/links.ts tests/ext-study-events.test.ts
git commit -m "feat(ext): study documents, reading and link derivations" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Drafts, node matching, source path and ports (pure)

REQ-study-11 (drafts for pages read and not processed, skipping what exists), REQ-study-09 (equivalent node chosen deterministically; the source identity of a confirmed proposition), plus the two ports the service and the store share.

**Files:**
- Create: `src/core/ext/study/drafts.ts`, `src/core/ext/study/card-node.ts`, `src/core/ext/study/source-path.ts`, `src/core/ext/study/ports.ts`
- Test: `tests/ext-study-drafts.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-drafts.test.ts`

```typescript
// tests/ext-study-drafts.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickCardNode } from "../src/core/ext/study/card-node.ts";
import { deriveDrafts, dropRepeats, parseDraftEvent, processedPages, sameProposition, type DraftEvent } from "../src/core/ext/study/drafts.ts";

const AT = "2026-11-04T10:00:00.000Z";
const proposed = (draftId: string, page: number, proposition = `P ${draftId}`): DraftEvent => ({
	type: "proposed", draftId, documentId: "doc", page, proposition, question: "Q?", answer: "A.", at: AT,
});

describe("study-drafts.jsonl (REQ-study-11, REQ-study-12)", () => {
	it("a draft is pending until the first decision, which is final", () => {
		const d = deriveDrafts([
			proposed("d1", 2), proposed("d2", 3),
			{ type: "decided", draftId: "d1", decision: "approved", at: AT },
			{ type: "decided", draftId: "d1", decision: "rejected", at: AT },
		]);
		assert.deepEqual(d.map((x) => [x.id, x.status]), [["d1", "approved"], ["d2", "pending"]]);
	});
	it("a decision for an unknown draft is ignored; the first proposal of an id defines it", () => {
		const d = deriveDrafts([{ type: "decided", draftId: "zz", decision: "approved", at: AT }, proposed("d1", 2, "first"), proposed("d1", 9, "second")]);
		assert.deepEqual(d.map((x) => [x.id, x.page, x.proposition]), [["d1", 2, "first"]]);
	});
	it("collects the pages a complete run has handled, per document", () => {
		const events: DraftEvent[] = [
			{ type: "pages_processed", documentId: "doc", pages: [3, 1], at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [3, 5], at: AT },
			{ type: "pages_processed", documentId: "other", pages: [9], at: AT },
		];
		assert.deepEqual(processedPages(events, "doc"), [1, 3, 5]);
	});
	it("rejects malformed events", () => {
		for (const bad of [
			{ ...proposed("d", 1), proposition: " " },
			{ ...proposed("d", 0) },
			{ type: "decided", draftId: "d", decision: "maybe", at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [], at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [1, 0], at: AT },
			{ ...proposed("d", 1), at: "x" },
		]) {
			assert.equal(parseDraftEvent(bad), null, JSON.stringify(bad));
		}
		assert.equal(parseDraftEvent(proposed("d", 1))?.type, "proposed");
	});
});

describe("dropRepeats (REQ-study-11: skip what already exists)", () => {
	it("treats case, spacing and a final full stop as no difference", () => {
		assert.equal(sameProposition("A σ-algebra is closed under complement.", "a  σ-algebra is closed\nunder complement"), true);
		assert.equal(sameProposition("A holds.", "B holds."), false);
	});
	it("drops candidates equal to an existing statement or to an earlier candidate", () => {
		const c = [
			{ page: 1, proposition: "X is closed." },
			{ page: 1, proposition: "x is closed" },
			{ page: 2, proposition: "Y is open." },
			{ page: 2, proposition: "Z is dense." },
		];
		assert.deepEqual(dropRepeats(c, ["Y is open"], 5).map((x) => x.proposition), ["X is closed.", "Z is dense."]);
	});
	it("keeps at most perPage per page, in order", () => {
		const c = [1, 2, 3, 4].map((i) => ({ page: 7, proposition: `fact ${i}` }));
		assert.deepEqual(dropRepeats(c, [], 2).map((x) => x.proposition), ["fact 1", "fact 2"]);
	});
});

describe("pickCardNode (REQ-study-09)", () => {
	const n = (id: string, statement: string, name = id, aliases: string[] = []) => ({ id, name, statement, aliases });
	it("chooses the node closest to the proposition", () => {
		const nodes = [n("n_a", "Every convergent sequence is bounded."), n("n_b", "A sigma algebra is closed under countable unions.")];
		assert.equal(pickCardNode("A sigma-algebra is closed under countable unions", nodes), "n_b");
	});
	it("uses aliases (the pipeline links equivalent phrasings to one node)", () => {
		const nodes = [n("n_a", "Totally different words here."), n("n_b", "Unrelated statement.", "n_b", ["Compact sets are closed and bounded"])];
		assert.equal(pickCardNode("compact sets are closed and bounded", nodes), "n_b");
	});
	it("a tie goes to the first node; no nodes gives null", () => {
		assert.equal(pickCardNode("zzz", [n("n_a", "qqq"), n("n_b", "www")]), "n_a");
		assert.equal(pickCardNode("anything", []), null);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-drafts.test.ts`
Expected: FAIL, `Cannot find module '../src/core/ext/study/card-node.ts'`.

- [ ] **Step 3: Implement**

`src/core/ext/study/drafts.ts`

```typescript
// src/core/ext/study/drafts.ts
/**
 * study-drafts.jsonl (REQ-study-11, REQ-study-12): what the "complete" run
 * proposes. Draft nodes cannot live in the content graph (only the extraction
 * pipeline writes it), so a proposal is an event here until the learner
 * approves it; only approval sends the proposition to the pipeline.
 *
 *   proposed        {draftId, documentId, page, proposition, question, answer, at}
 *   decided         {draftId, decision: approved | rejected, at}
 *   pages_processed {documentId, pages, at}   pages a complete run has handled
 */

import { normalizeForMatch } from "../quote.ts";

export type DraftEvent =
	| {
			type: "proposed";
			draftId: string;
			documentId: string;
			page: number;
			proposition: string;
			question: string;
			answer: string;
			at: string;
	  }
	| { type: "decided"; draftId: string; decision: "approved" | "rejected"; at: string }
	| { type: "pages_processed"; documentId: string; pages: number[]; at: string };

export type DraftStatus = "pending" | "approved" | "rejected";

export interface Draft {
	id: string;
	documentId: string;
	page: number;
	proposition: string;
	question: string;
	answer: string;
	status: DraftStatus;
	proposedAt: string;
}

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const validAt = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isPage = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

export function parseDraftEvent(raw: unknown): DraftEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!validAt(r.at)) return null;
	if (r.type === "proposed") {
		if (!nonBlank(r.draftId) || !nonBlank(r.documentId) || !isPage(r.page)) return null;
		if (!nonBlank(r.proposition) || !nonBlank(r.question) || !nonBlank(r.answer)) return null;
		return {
			type: "proposed",
			draftId: r.draftId,
			documentId: r.documentId,
			page: r.page,
			proposition: r.proposition.trim(),
			question: r.question.trim(),
			answer: r.answer.trim(),
			at: r.at,
		};
	}
	if (r.type === "decided") {
		if (!nonBlank(r.draftId) || (r.decision !== "approved" && r.decision !== "rejected")) return null;
		return { type: "decided", draftId: r.draftId, decision: r.decision, at: r.at };
	}
	if (r.type === "pages_processed") {
		if (!nonBlank(r.documentId) || !Array.isArray(r.pages) || r.pages.length === 0 || !r.pages.every(isPage)) return null;
		return { type: "pages_processed", documentId: r.documentId, pages: [...r.pages] as number[], at: r.at };
	}
	return null;
}

/** Replay in file order. The first `proposed` per id defines the draft; the first `decided` wins; `decided` for an unknown draft is ignored. */
export function deriveDrafts(events: readonly DraftEvent[]): Draft[] {
	const drafts = new Map<string, Draft>();
	const decided = new Set<string>();
	for (const e of events) {
		if (e.type === "proposed") {
			if (drafts.has(e.draftId)) continue;
			drafts.set(e.draftId, {
				id: e.draftId,
				documentId: e.documentId,
				page: e.page,
				proposition: e.proposition,
				question: e.question,
				answer: e.answer,
				status: "pending",
				proposedAt: e.at,
			});
		} else if (e.type === "decided") {
			const d = drafts.get(e.draftId);
			if (d === undefined || decided.has(e.draftId)) continue;
			decided.add(e.draftId);
			d.status = e.decision;
		}
	}
	return [...drafts.values()];
}

/** Pages a complete run has handled for a document, ascending and distinct. */
export function processedPages(events: readonly DraftEvent[], documentId: string): number[] {
	const pages = new Set<number>();
	for (const e of events) if (e.type === "pages_processed" && e.documentId === documentId) for (const p of e.pages) pages.add(p);
	return [...pages].sort((a, b) => a - b);
}

/** Two propositions are the same when they match after normalization and without a final full stop. */
export function sameProposition(a: string, b: string): boolean {
	const norm = (s: string) => normalizeForMatch(s, "join").replace(/[.\s]+$/, "");
	return norm(a) === norm(b);
}

/**
 * Drops candidates that repeat something that already exists (REQ-study-11:
 * skip what is already there) or an earlier candidate, then keeps at most
 * `perPage` per page, in the order given.
 */
export function dropRepeats<T extends { page: number; proposition: string }>(
	candidates: readonly T[],
	existing: readonly string[],
	perPage: number,
): T[] {
	const kept: T[] = [];
	const perPageCount = new Map<number, number>();
	for (const c of candidates) {
		if (existing.some((e) => sameProposition(e, c.proposition))) continue;
		if (kept.some((k) => sameProposition(k.proposition, c.proposition))) continue;
		const n = perPageCount.get(c.page) ?? 0;
		if (n >= perPage) continue;
		perPageCount.set(c.page, n + 1);
		kept.push(c);
	}
	return kept;
}
```

`src/core/ext/study/card-node.ts`

```typescript
// src/core/ext/study/card-node.ts
/**
 * Which node a confirmed card attaches to (REQ-study-09). The extraction
 * pipeline may return several nodes for one proposition (the proposition plus
 * premises it spelled out), or link it to an existing equivalent node. The
 * card goes to the node whose statement is closest to the proposition by word
 * overlap (Jaccard); a tie goes to the first node in the order given.
 */

import { normalizeForMatch } from "../quote.ts";

export interface CandidateNode {
	id: string;
	name: string;
	statement: string;
	aliases: readonly string[];
}

function words(text: string): Set<string> {
	return new Set(normalizeForMatch(text, "join").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared++;
	return shared / (a.size + b.size - shared);
}

export function pickCardNode(proposition: string, nodes: readonly CandidateNode[]): string | null {
	const target = words(proposition);
	let best: { id: string; score: number } | null = null;
	for (const n of nodes) {
		const score = Math.max(jaccard(target, words(n.statement)), ...n.aliases.map((a) => jaccard(target, words(a))), jaccard(target, words(n.name)));
		if (best === null || score > best.score) best = { id: n.id, score };
	}
	return best?.id ?? null;
}
```

`src/core/ext/study/source-path.ts`

```typescript
// src/core/ext/study/source-path.ts
/**
 * The identity of a confirmed proposition as a notes source. The extraction
 * pipeline's front door (importNotes) keys a source by its file path, so each
 * proposition gets its own pseudo-path: stable for the same document, page and
 * text (re-confirming the same proposition re-runs against the same source),
 * different for any other. The path is never read from disk.
 */

import { createHash } from "node:crypto";

export function slugOf(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug === "" ? "document" : slug;
}

export function studySourcePath(title: string, page: number, proposition: string): string {
	const digest = createHash("sha256").update(proposition.trim(), "utf8").digest("hex").slice(0, 8);
	return `study/${slugOf(title)}/p${String(page).padStart(4, "0")}-${digest}.md`;
}

/** The text handed to the pipeline: the proposition alone, so nothing else can be extracted from it. */
export function studySourceText(proposition: string): string {
	return `${proposition.trim()}\n`;
}
```

`src/core/ext/study/ports.ts`

```typescript
// src/core/ext/study/ports.ts
/** Ports of the assisted-study stage. Adapters live in src/store/ext/, the composition in src/server/ext/stores.ts. */

import { DOCUMENT_ID_RE } from "./documents.ts";

/** The shape of an event ledger (store/ext/ledger.ts createLedger fits it). */
export interface LedgerLike<T> {
	append(event: T): void;
	readAll(): T[];
}

/** The stored copy of each registered PDF and its extracted page texts (data/ext/documents/). */
export interface DocumentFiles {
	/** Writes documents/<sha256>.pdf (idempotent) and returns the id and the stored absolute path. */
	putPdf(bytes: Uint8Array): { id: string; path: string };
	/** Absolute path of the stored copy, or null for an invalid id or a missing file. */
	pdfPath(id: string): string | null;
	/** Writes documents/<id>.pages.json: one string per page, page 1 first. */
	putPages(id: string, pages: readonly string[]): void;
	/** The page texts, or null when absent or unreadable. */
	getPages(id: string): string[] | null;
}

export const isDocumentId = (id: string): boolean => DOCUMENT_ID_RE.test(id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-drafts.test.ts`
Expected: `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/study/drafts.ts src/core/ext/study/card-node.ts src/core/ext/study/source-path.ts src/core/ext/study/ports.ts tests/ext-study-drafts.test.ts
git commit -m "feat(ext): study drafts, node matching, source path and ports" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Document store and the four ledgers

REQ-study-01 (stored copy at `data/ext/documents/<sha256>.pdf`, same file same id). The store writes the PDF through a temp file and a rename (`writeFileAtomicSync` takes text only), and the page texts atomically as JSON.

**Files:**
- Create: `src/store/ext/documents-store.ts`
- Modify: `src/server/ext/stores.ts`
- Test: `tests/ext-study-documents-store.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-documents-store.test.ts`

```typescript
// tests/ext-study-documents-store.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDocumentFiles } from "../src/store/ext/documents-store.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-docs-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("document files (REQ-study-01)", () => {
	const bytes = new TextEncoder().encode("%PDF-1.4 pretend");
	const sha = createHash("sha256").update(bytes).digest("hex");

	it("stores the copy under its sha256 and returns the same id for the same bytes", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const a = files.putPdf(bytes);
		const b = files.putPdf(bytes);
		assert.equal(a.id, sha);
		assert.deepEqual(a, b);
		assert.equal(a.path, path.join(dir, "documents", `${sha}.pdf`));
		assert.deepEqual(fs.readFileSync(a.path), Buffer.from(bytes));
		assert.equal(fs.existsSync(path.join(dir, "format.json")), true);
		assert.deepEqual(fs.readdirSync(path.join(dir, "documents")), [`${sha}.pdf`]);
	});
	it("finds a stored copy by id and refuses anything that is not a sha256", () => {
		const files = createDocumentFiles(tmp());
		assert.equal(files.pdfPath(sha), null);
		files.putPdf(bytes);
		assert.ok(files.pdfPath(sha)?.endsWith(`${sha}.pdf`));
		for (const bad of ["../x", "", "abc", sha.toUpperCase(), `${sha}/../..`]) assert.equal(files.pdfPath(bad), null, bad);
	});
	it("round-trips the page texts and reads null for absent or damaged files", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		assert.equal(files.getPages(sha), null);
		files.putPages(sha, ["page one", "", "page three"]);
		assert.deepEqual(files.getPages(sha), ["page one", "", "page three"]);
		fs.writeFileSync(path.join(dir, "documents", `${sha}.pages.json`), "{not json");
		assert.equal(files.getPages(sha), null);
		fs.writeFileSync(path.join(dir, "documents", `${sha}.pages.json`), JSON.stringify([1, 2]));
		assert.equal(files.getPages(sha), null);
		assert.throws(() => files.putPages("nope", []), /invalid document id/);
	});
	it("refuses to read when the stamp is newer than this build (REQ-int-01)", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		assert.throws(() => createDocumentFiles(dir).pdfPath(sha), /format version 99/);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-documents-store.test.ts`
Expected: FAIL, `Cannot find module '../src/store/ext/documents-store.ts'`.

- [ ] **Step 3: Implement the store**

`src/store/ext/documents-store.ts`

```typescript
// src/store/ext/documents-store.ts
/**
 * data/ext/documents/<sha256>.pdf (the stored copy) and <sha256>.pages.json
 * (extracted page texts). Content-addressed and written atomically (temp
 * file then rename), like the snapshot store; the same stamp doctrine as the ledgers.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDocumentId, type DocumentFiles } from "../../core/ext/study/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createDocumentFiles(extDir: string): DocumentFiles {
	const root = path.join(extDir, "documents");
	const pdfFile = (id: string): string => path.join(root, `${id}.pdf`);
	const pagesFile = (id: string): string => path.join(root, `${id}.pages.json`);
	return {
		putPdf(bytes) {
			const id = createHash("sha256").update(bytes).digest("hex");
			const file = pdfFile(id);
			if (!fs.existsSync(file)) {
				assertExtFormat(extDir);
				ensureExtFormat(extDir);
				fs.mkdirSync(root, { recursive: true });
				// Bytes, not text: write beside the target and rename, so a reader never sees half a PDF.
				const tmp = `${file}.tmp-${randomUUID()}`;
				fs.writeFileSync(tmp, bytes);
				fs.renameSync(tmp, file);
			}
			return { id, path: file };
		},
		pdfPath(id) {
			if (!isDocumentId(id)) return null;
			assertExtFormat(extDir);
			return fs.existsSync(pdfFile(id)) ? pdfFile(id) : null;
		},
		putPages(id, pages) {
			if (!isDocumentId(id)) throw new Error(`documents store: invalid document id ${id}`);
			assertExtFormat(extDir);
			ensureExtFormat(extDir);
			fs.mkdirSync(root, { recursive: true });
			writeFileAtomicSync(pagesFile(id), `${JSON.stringify(pages)}\n`, { allowInPlaceFallback: true });
		},
		getPages(id) {
			if (!isDocumentId(id)) return null;
			assertExtFormat(extDir);
			try {
				const raw: unknown = JSON.parse(fs.readFileSync(pagesFile(id), "utf-8"));
				return Array.isArray(raw) && raw.every((p) => typeof p === "string") ? (raw as string[]) : null;
			} catch {
				return null;
			}
		},
	};
}
```

- [ ] **Step 4: Wire the ledgers into the extension composition root**

In `src/server/ext/stores.ts`, add these imports next to the other `parse*Event` / store imports:

```ts
import { parseDocumentEvent } from "../../core/ext/study/documents.ts";
import { parseDraftEvent } from "../../core/ext/study/drafts.ts";
import { parseStudyLinkEvent } from "../../core/ext/study/links.ts";
import { parseReadingEvent } from "../../core/ext/study/reading.ts";
import { createDocumentFiles } from "../../store/ext/documents-store.ts";
```

and add these members to the `extStores` object, after `explanationsStore`:

```ts
	documentsLedger: createLedger(EXT_PATHS.dir, "documents.jsonl", parseDocumentEvent),
	readingLedger: createLedger(EXT_PATHS.dir, "reading.jsonl", parseReadingEvent),
	studyLinksLedger: createLedger(EXT_PATHS.dir, "study-links.jsonl", parseStudyLinkEvent),
	studyDraftsLedger: createLedger(EXT_PATHS.dir, "study-drafts.jsonl", parseDraftEvent),
	documentFiles: createDocumentFiles(EXT_PATHS.dir),
```

- [ ] **Step 5: Run the test and the type check**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-documents-store.test.ts && npx tsc --noEmit`
Expected: `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`; `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/store/ext/documents-store.ts src/server/ext/stores.ts tests/ext-study-documents-store.test.ts
git commit -m "feat(ext): document store and study ledgers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Page texts from the PDF

The study tools and the "complete" run need the text of each page. Upstream's `pdfExtract(path, "all")` returns markdown with `--- Page N ---` separators; this task splits it into one string per page.

**Files:**
- Create: `src/agent/ext/study/pdf-pages.ts`
- Test: `tests/ext-study-pdf-pages.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-pdf-pages.test.ts`

```typescript
// tests/ext-study-pdf-pages.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readDocumentPages, splitExtractedPages } from "../src/agent/ext/study/pdf-pages.ts";
import { buildOutlinePdf } from "./helpers/outline-pdf.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-pdf-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, bytes: Uint8Array): string => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, bytes);
	return p;
};

describe("splitExtractedPages", () => {
	it("splits on the page headers and keeps empty pages", () => {
		assert.deepEqual(splitExtractedPages("--- Page 1 ---\nalpha\nbeta\n--- Page 2 ---\n--- Page 3 ---\ngamma"), ["alpha\nbeta", "", "gamma"]);
	});
	it("refuses out-of-order numbering", () => {
		assert.throws(() => splitExtractedPages("--- Page 1 ---\na\n--- Page 3 ---\nb"), /expected page 2, found page 3/);
	});
	it("gives no pages for text without headers", () => {
		assert.deepEqual(splitExtractedPages("No pages selected — page spec matched nothing."), []);
	});
});

describe("readDocumentPages", () => {
	it("returns one text per page and the page count", async () => {
		const pdf = write("a.pdf", buildOutlinePdf(["alpha page", "beta page", "gamma page"]));
		const { pageCount, pages } = await readDocumentPages(pdf);
		assert.equal(pageCount, 3);
		assert.match(pages[0]!, /alpha page/);
		assert.match(pages[2]!, /gamma page/);
	});
	it("gives an empty string for a page without text", async () => {
		const pdf = write("b.pdf", tinyPdf([{ runs: [{ text: "only text page", x: 72, y: 700 }] }, { image: true }]));
		const { pages } = await readDocumentPages(pdf);
		assert.equal(pages.length, 2);
		assert.match(pages[0]!, /only text page/);
		assert.equal(pages[1]!.trim(), "");
	});
	it("throws for a file that is not a PDF", async () => {
		await assert.rejects(readDocumentPages(write("c.pdf", new TextEncoder().encode("not a pdf"))));
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-pdf-pages.test.ts`
Expected: FAIL, `Cannot find module '../src/agent/ext/study/pdf-pages.ts'`.

- [ ] **Step 3: Implement**

`src/agent/ext/study/pdf-pages.ts`

```typescript
// src/agent/ext/study/pdf-pages.ts
/**
 * The text of every page of a PDF, one string per page (page 1 first), through
 * upstream's math-aware extraction (pdf-ops pdfExtract, the same text the
 * verification stage's quote check reads). A page with no text (a scan or a
 * figure) is the empty string.
 */

import { pdfExtract } from "../../subagents/pdf-ops.ts";

const HEADER = /^--- Page (\d+) ---\n?/gm;

/** Splits pdfExtract's `--- Page N ---` output. Pages must come numbered 1..n in order. */
export function splitExtractedPages(markdown: string): string[] {
	const heads = [...markdown.matchAll(HEADER)];
	const pages: string[] = [];
	for (const [i, head] of heads.entries()) {
		if (Number(head[1]) !== i + 1) throw new Error(`pdf pages: expected page ${i + 1}, found page ${head[1]}`);
		const start = head.index + head[0].length;
		const end = i + 1 < heads.length ? heads[i + 1]!.index : markdown.length;
		pages.push(markdown.slice(start, end).replace(/\n$/, ""));
	}
	return pages;
}

export async function readDocumentPages(pdfPath: string): Promise<{ pageCount: number; pages: string[] }> {
	const pages = splitExtractedPages(await pdfExtract(pdfPath, "all"));
	if (pages.length === 0) throw new Error("pdf pages: the PDF has no pages");
	return { pageCount: pages.length, pages };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-pdf-pages.test.ts`
Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/study/pdf-pages.ts tests/ext-study-pdf-pages.test.ts
git commit -m "feat(ext): split extracted PDF text into pages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The study agent (tools, prompt, construction)

REQ-study-06 (the agent receives the current page's text and the selection), REQ-study-07 (a `read_page` tool, citations as `(p. N)`), REQ-study-12 (the agent has no way to write cards or graph content). The agent is built through upstream's `createPracticeAgent` seam, exactly like the review and office-hours agents.

**Files:**
- Create: `src/agent/ext/study/study-tools.ts`, `src/agent/ext/study/study-instructions.ts`, `src/agent/ext/study/study-agent.ts`
- Test: `tests/ext-study-tools.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-tools.test.ts`

```typescript
// tests/ext-study-tools.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStudyAgent } from "../src/agent/ext/study/study-agent.ts";
import { STUDY_INSTRUCTIONS, studyPrompt } from "../src/agent/ext/study/study-instructions.ts";
import { formatPage, MAX_PAGE_CHARS, MAX_SEARCH_HITS, studyTools, type StudyToolContext } from "../src/agent/ext/study/study-tools.ts";
import { encodeStudyContext } from "../src/core/ext/study/context.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const DOC = "d".repeat(64);
const PAGES = ["Cover.", "A sigma algebra is a family closed under complement.", "", "Proofs by induction."];

function ctxFor(messages: LhMessage[], over: Partial<StudyToolContext> = {}): StudyToolContext {
	return {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages }) },
		document: () => ({ id: DOC, title: "Probability", pageCount: PAGES.length }),
		pageText: (p) => PAGES[p - 1] ?? null,
		search: (q) => PAGES.flatMap((t, i) => (t.toLowerCase().includes(q.toLowerCase()) ? [{ page: i + 1, snippet: t.slice(0, 40) }] : [])),
		...over,
	};
}
const text = (r: unknown): string => JSON.stringify(r);

describe("read_page and search_pages (REQ-study-07)", () => {
	it("registers exactly the two read-only tools", () => {
		assert.deepEqual(Object.keys(studyTools(ctxFor([]))).sort(), ["read_page", "search_pages"]);
	});
	it("read_page returns the page under a header that names the page and the page count", async () => {
		const out = await studyTools(ctxFor([])).read_page!.execute("t", { page: 2 } as never);
		assert.match(text(out), /Probability, page 2 of 4 ---\\nA sigma algebra is a family/);
	});
	it("read_page says so for a page without text, and refuses a page beyond the end", async () => {
		const tools = studyTools(ctxFor([]));
		assert.match(text(await tools.read_page!.execute("t", { page: 3 } as never)), /no extractable text/);
		assert.match(text(await tools.read_page!.execute("t", { page: 9 } as never)), /beyond the last page \(4\)/);
	});
	it("read_page truncates a very long page", () => {
		const out = formatPage("T", 1, 1, "x".repeat(MAX_PAGE_CHARS + 50));
		assert.match(out, /\[page truncated\]$/);
	});
	it("search_pages cites hits as (p. N), caps them, and reports no match", async () => {
		const tools = studyTools(ctxFor([]));
		assert.match(text(await tools.search_pages!.execute("t", { query: "SIGMA" } as never)), /\(p\. 2\) A sigma algebra/);
		assert.match(text(await tools.search_pages!.execute("t", { query: "zebra" } as never)), /No page contains .*zebra/);
		const many = studyTools(ctxFor([], { search: () => Array.from({ length: 30 }, (_, i) => ({ page: i + 1, snippet: "s" })) }));
		const out = (await many.search_pages!.execute("t", { query: "ab" } as never)) as { details: string };
		assert.equal(out.details.split("\n").length, MAX_SEARCH_HITS);
	});
	it("says so when the document is gone", async () => {
		const tools = studyTools(ctxFor([], { document: () => null }));
		assert.match(text(await tools.read_page!.execute("t", { page: 1 } as never)), /not available/);
	});
});

describe("the per-turn prompt (REQ-study-06)", () => {
	const message = (page: number, selection: string) => newUserMessage(encodeStudyContext({ documentId: DOC, page, selection }, "What is this?"));
	it("includes the text of the page named by the newest message and the selection", () => {
		const prompt = studyPrompt(ctxFor([message(2, "closed under complement")]));
		assert.ok(prompt.startsWith(STUDY_INSTRUCTIONS));
		assert.match(prompt, /on page 2\. Its text:\n<<<PAGE\nA sigma algebra is a family closed under complement\.\nPAGE>>>/);
		assert.match(prompt, /<<<SELECTION\nclosed under complement\nSELECTION>>>/);
	});
	it("uses the newest message's page, not an older one", () => {
		const prompt = studyPrompt(ctxFor([message(2, ""), message(4, "")]));
		assert.match(prompt, /on page 4/);
		assert.doesNotMatch(prompt, /SELECTION/);
	});
	it("gives only the fixed rules when the message has no context or names another document or a missing page", () => {
		assert.doesNotMatch(studyPrompt(ctxFor([newUserMessage("plain")])), /The learner is on page/);
		const other = newUserMessage(encodeStudyContext({ documentId: "e".repeat(64), page: 2, selection: "" }, "q"));
		assert.doesNotMatch(studyPrompt(ctxFor([other])), /The learner is on page/);
		assert.doesNotMatch(studyPrompt(ctxFor([message(40, "")])), /The learner is on page/);
	});
	it("marks a page without text", () => {
		assert.match(studyPrompt(ctxFor([message(3, "")])), /\(no extractable text on this page\)/);
	});
	it("tells the model when the document is unavailable", () => {
		assert.match(studyPrompt(ctxFor([], { document: () => null })), /document is not available/);
	});
	it("the instructions ask for (p. N) citations and forbid making cards", () => {
		assert.match(STUDY_INSTRUCTIONS, /\(p\. N\)/);
		assert.match(STUDY_INSTRUCTIONS, /do not create cards/i);
	});
	it("builds an agent", () => {
		const agent = createStudyAgent(ctxFor([]), {
			engine: { model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never, streamFn: (async () => { throw new Error("not streamed"); }) as never },
		});
		assert.equal(typeof agent.prompt, "function");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-tools.test.ts`
Expected: FAIL, `Cannot find module '../src/agent/ext/study/study-agent.ts'`.

- [ ] **Step 3: Implement**

`src/agent/ext/study/study-tools.ts`

```typescript
// src/agent/ext/study/study-tools.ts
/**
 * THE STUDY AGENT'S TOOLS (REQ-study-07): it can read any page of the
 * session's document and search the document for a phrase. Both read the text
 * extracted when the document was registered; neither writes anything.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../../core/native-messages.ts";
import { invalidInputResult, toToolResult } from "../../tool-execute.ts";
import { healToolRecord } from "../../tools/heal.ts";

/** Longest page text handed to the model. */
export const MAX_PAGE_CHARS = 12_000;
export const MAX_SEARCH_HITS = 10;

export interface StudyToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
	/** The session's document, or null when it cannot be found. */
	document(): { id: string; title: string; pageCount: number } | null;
	/** Text of a page (1-based), or null when out of range. */
	pageText(page: number): string | null;
	/** Case-insensitive literal search across all pages. */
	search(query: string): Array<{ page: number; snippet: string }>;
}

export function clipPage(text: string): string {
	return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[page truncated]` : text;
}

/** The page as the model reads it: a header with the page number, then the text. */
export function formatPage(title: string, page: number, pageCount: number, text: string | null): string {
	const head = `--- ${title}, page ${page} of ${pageCount} ---`;
	if (text === null || text.trim() === "") return `${head}\n(This page has no extractable text: it may be a scan or a figure.)`;
	return `${head}\n${clipPage(text)}`;
}

const readInput = Type.Object({ page: Type.Integer({ minimum: 1, description: "Page number, 1-based." }) });
const searchInput = Type.Object({ query: Type.String({ minLength: 2, description: "Words or a phrase to find, ignoring case." }) });

export function studyTools(ctx: StudyToolContext): Record<string, AgentTool<any>> {
	const read_page: AgentTool<typeof readInput> = {
		name: "read_page",
		label: "read_page",
		description: "Read one page of the document the learner is studying. Use it for pages other than the one already given in your instructions. Cite what you use as (p. N).",
		parameters: readInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const doc = ctx.document();
			if (doc === null) return toToolResult("The session's document is not available.");
			if (input.page > doc.pageCount) return invalidInputResult("read_page", [`page ${input.page} is beyond the last page (${doc.pageCount})`]);
			return toToolResult(formatPage(doc.title, input.page, doc.pageCount, ctx.pageText(input.page)));
		},
	};

	const search_pages: AgentTool<typeof searchInput> = {
		name: "search_pages",
		label: "search_pages",
		description: "Find the pages of the document that contain a word or phrase. Returns up to 10 pages with a short snippet; read a page afterwards with read_page.",
		parameters: searchInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const hits = ctx.search(input.query).slice(0, MAX_SEARCH_HITS);
			if (hits.length === 0) return toToolResult(`No page contains "${input.query}".`);
			return toToolResult(hits.map((h) => `(p. ${h.page}) ${h.snippet}`).join("\n"));
		},
	};

	return healToolRecord({ read_page, search_pages });
}
```

`src/agent/ext/study/study-instructions.ts`

```typescript
// src/agent/ext/study/study-instructions.ts
/**
 * The study session's system prompt: fixed rules plus, per turn, the page the
 * learner is on (REQ-study-06). The agent is rebuilt for every turn, so this is
 * composed from the newest user message each time.
 */

import { latestStudyContext } from "../../../core/ext/study/context.ts";
import type { StudyToolContext } from "./study-tools.ts";
import { clipPage } from "./study-tools.ts";

export const STUDY_INSTRUCTIONS = [
	"You are a study companion. The learner is reading a document and asks you questions about it as they go.",
	"",
	"How to answer",
	"- Ground every answer in the document. The page the learner is on is given below; for other pages use read_page, and use search_pages to find where something is discussed.",
	"- Cite the pages you rely on as (p. N), for example (p. 12). The learner clicks a citation to jump to that page. Write only page numbers that exist in the document.",
	"- If the document does not say it, say so, then answer from general knowledge and mark it clearly as not from the document.",
	"- When the learner selected text, the question is about that text.",
	"- Explain simply first, then precisely. Reply in the learner's language.",
	"",
	"What you do not do",
	"- You do not create cards, nodes or notes. The learner makes cards with the Card button next to the page.",
	"- You do not judge whether the learner is right unless the document settles it; then quote or cite the page.",
	"",
	"Each learner message begins with a line starting [study-context]. It carries the page and the selection; it is metadata, do not repeat it.",
].join("\n");

/** The full prompt for one turn. */
export function studyPrompt(ctx: StudyToolContext): string {
	const doc = ctx.document();
	if (doc === null) return `${STUDY_INSTRUCTIONS}\n\nThe session's document is not available: tell the learner and stop.`;
	const parts = [STUDY_INSTRUCTIONS, "", `Document: ${doc.title} (${doc.pageCount} pages).`];
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	const current = latestStudyContext(messages);
	if (current !== null && current.documentId === doc.id && current.page <= doc.pageCount) {
		const text = ctx.pageText(current.page);
		parts.push("", `The learner is on page ${current.page}. Its text:`, "<<<PAGE", text === null || text.trim() === "" ? "(no extractable text on this page)" : clipPage(text), "PAGE>>>");
		if (current.selection !== "") parts.push("", "The learner selected:", "<<<SELECTION", current.selection, "SELECTION>>>");
	}
	return parts.join("\n");
}
```

`src/agent/ext/study/study-agent.ts`

```typescript
// src/agent/ext/study/study-agent.ts
/**
 * The study session's agent: the practice agent's construction (a bare tool
 * registry, ordinary final prose) with its own tools and a prompt composed per
 * turn. Same seam as the review and office-hours agents.
 */

import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { studyPrompt } from "./study-instructions.ts";
import { studyTools, type StudyToolContext } from "./study-tools.ts";

export function createStudyAgent(ctx: StudyToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: studyTools(ctx), instructions: studyPrompt(ctx) },
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-tools.test.ts`
Expected: `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/study tests/ext-study-tools.test.ts
git commit -m "feat(ext): study agent with page tools" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The two drafting calls

REQ-study-08 (the agent drafts proposition, question and answer for a card) and REQ-study-11 (a headless call proposes drafts for one page). Both go through the lecture stage's `runStructured` (a structured submit agent with a `CostGate`), role `teacher`, cost source `study`.

**Files:**
- Create: `src/agent/ext/study/draft-writer.ts`
- Test: `tests/ext-study-draft-writer.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-study-draft-writer.test.ts`

```typescript
// tests/ext-study-draft-writer.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { cardPrompt, draftCard, MAX_PROPOSITION_CHARS, pagesPrompt, proposePageDrafts } from "../src/agent/ext/study/draft-writer.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (name: string, input: unknown): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall(name, input as never, { id: `${name}-1` })], { stopReason: "toolUse" });
function gate(blocked = false): CostGate & { recorded: { usd: number; source: string }[] } {
	const g = { recorded: [] as { usd: number; source: string }[], allowed: () => !blocked, record: (usd: number, source: string) => void g.recorded.push({ usd, source }) };
	return g;
}
const priceStep = () => 0.25;
const card = { proposition: " A sigma algebra is closed under complement. ", question: "What is a sigma algebra closed under?", answer: "Complement and countable unions." };

describe("draftCard (REQ-study-08)", () => {
	it("returns the trimmed proposition and the question/answer, and bills source 'study'", async () => {
		const g = gate();
		const out = await draftCard({ engine: fauxEngine([submit("submit_card", card)]), gate: g, priceStep }, { title: "Prob", page: 3, from: "selection", text: "sigma algebra" });
		assert.deepEqual(out, { ...card, proposition: "A sigma algebra is closed under complement." });
		assert.deepEqual(g.recorded[0], { usd: 0.25, source: "study" });
	});
	it("makes the model retry an empty field or an over-long proposition inside its turn budget", async () => {
		const engine = fauxEngine([
			submit("submit_card", { ...card, answer: "  " }),
			submit("submit_card", { ...card, proposition: "x".repeat(MAX_PROPOSITION_CHARS + 1) }),
			submit("submit_card", card),
		]);
		const out = await draftCard({ engine, gate: gate(), priceStep }, { title: "Prob", page: 3, from: "page", text: "t" });
		assert.equal(out.answer, card.answer);
	});
	it("refuses to call the model when the gate is closed", async () => {
		await assert.rejects(draftCard({ engine: fauxEngine([submit("submit_card", card)]), gate: gate(true), priceStep }, { title: "T", page: 1, from: "page", text: "t" }), (e: unknown) => e instanceof CostCeilingError);
	});
	it("the prompt names the document, the page and whether the text is a selection", () => {
		assert.match(cardPrompt({ title: "Prob", page: 3, from: "selection", text: "abc" }), /Prob, page 3\.\nThe learner selected this passage:\n<<<TEXT\nabc\nTEXT>>>/);
		assert.match(cardPrompt({ title: "Prob", page: 3, from: "page", text: "abc" }), /asked for a card from this page/);
	});
});

describe("proposePageDrafts (REQ-study-11)", () => {
	const input = { title: "Prob", pages: [{ page: 4, text: "four" }, { page: 5, text: "five" }], known: [{ page: 4, statement: "Already here." }] };
	it("returns drafts with their pages", async () => {
		const drafts = [{ page: 5, ...card }];
		const out = await proposePageDrafts({ engine: fauxEngine([submit("submit_drafts", { drafts })]), gate: gate(), priceStep }, input);
		assert.deepEqual(out, [{ page: 5, ...card, proposition: "A sigma algebra is closed under complement." }]);
	});
	it("allows an empty list", async () => {
		assert.deepEqual(await proposePageDrafts({ engine: fauxEngine([submit("submit_drafts", { drafts: [] })]), gate: gate(), priceStep }, input), []);
	});
	it("makes the model retry a page that was not given", async () => {
		const engine = fauxEngine([submit("submit_drafts", { drafts: [{ page: 9, ...card }] }), submit("submit_drafts", { drafts: [{ page: 4, ...card }] })]);
		const out = await proposePageDrafts({ engine, gate: gate(), priceStep }, input);
		assert.equal(out[0]!.page, 4);
	});
	it("the prompt lists what is already known and each page between markers", () => {
		const p = pagesPrompt(input);
		assert.match(p, /Already known \(do not repeat\):\n- \(p\. 4\) Already here\./);
		assert.match(p, /<<<PAGE 4\nfour\nPAGE 4>>>\n<<<PAGE 5\nfive\nPAGE 5>>>/);
	});
	it("refuses to call the model when the gate is closed", async () => {
		await assert.rejects(proposePageDrafts({ engine: fauxEngine([]), gate: gate(true), priceStep }, input), (e: unknown) => e instanceof CostCeilingError);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-draft-writer.test.ts`
Expected: FAIL, `Cannot find module '../src/agent/ext/study/draft-writer.ts'`.

- [ ] **Step 3: Implement**

`src/agent/ext/study/draft-writer.ts`

```typescript
// src/agent/ext/study/draft-writer.ts
/**
 * The two model calls of the study stage (REQ-study-08, REQ-study-11), each a
 * single schema-validated submission (runStructured, which feeds the cost gate
 * per billed step):
 *   - draftCard: one proposition and one question/answer from a selection or a
 *     page, for the learner to edit and confirm;
 *   - proposePageDrafts: drafts for several pages at once ("complete").
 * Neither writes anything; what the learner confirms is handled by the
 * study service.
 */

import { Type } from "typebox";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import type { PiEngine } from "../../models.ts";
import { runStructured, type StepPricer } from "../lecture/structured.ts";

export interface DraftWriterDeps {
	engine: PiEngine;
	gate: CostGate;
	priceStep: StepPricer;
	signal?: AbortSignal;
}

export interface CardDraft {
	proposition: string;
	question: string;
	answer: string;
}

export interface PageDraft extends CardDraft {
	page: number;
}

export const MAX_PROPOSITION_CHARS = 400;

const CARD_RULES = [
	"A proposition is ONE self-contained statement that is true on its own: it names what it talks about and never says 'this', 'above', 'the previous theorem' or 'as shown'.",
	"A question/answer pair tests that proposition: the question can be answered without seeing the page; the answer is short.",
	"Use only what the text says. Do not add facts. Write in the language of the text.",
].join("\n");

export const CARD_SYSTEM = `You turn a passage of a document the learner is studying into one flashcard.\n${CARD_RULES}`;
export const PAGES_SYSTEM = `You propose flashcards for pages of a document the learner has read. Propose only what matters for understanding the document (definitions, theorems, key facts); skip examples' arithmetic, remarks and anything in the already-known list. At most 5 per page, none for a page with nothing worth a card.\n${CARD_RULES}`;

const CardSchema = Type.Object({
	proposition: Type.String({ description: "One self-contained statement." }),
	question: Type.String(),
	answer: Type.String(),
});

const PagesSchema = Type.Object({
	drafts: Type.Array(
		Type.Object({
			page: Type.Integer({ minimum: 1, description: "The page the proposition comes from." }),
			proposition: Type.String(),
			question: Type.String(),
			answer: Type.String(),
		}),
	),
});

function fieldProblem(d: CardDraft): string | null {
	for (const key of ["proposition", "question", "answer"] as const) {
		if (d[key].trim() === "") return `${key} must not be empty`;
	}
	if (d.proposition.trim().length > MAX_PROPOSITION_CHARS) return `proposition must be at most ${MAX_PROPOSITION_CHARS} characters: split it or shorten it`;
	return null;
}

export function cardPrompt(input: { title: string; page: number; from: "selection" | "page"; text: string }): string {
	const what = input.from === "selection" ? "The learner selected this passage" : "The learner asked for a card from this page";
	return `Document: ${input.title}, page ${input.page}.\n${what}:\n<<<TEXT\n${input.text}\nTEXT>>>`;
}

export async function draftCard(
	deps: DraftWriterDeps,
	input: { title: string; page: number; from: "selection" | "page"; text: string },
): Promise<CardDraft> {
	const out = await runStructured<CardDraft>({
		...deps,
		costSource: "study",
		role: "teacher",
		toolName: "submit_card",
		toolDescription: "Submit the proposition and the question/answer.",
		parameters: CardSchema,
		systemPrompt: CARD_SYSTEM,
		prompt: cardPrompt(input),
		validate: fieldProblem,
	});
	return { proposition: out.proposition.trim(), question: out.question.trim(), answer: out.answer.trim() };
}

export function pagesPrompt(input: { title: string; pages: Array<{ page: number; text: string }>; known: Array<{ page: number; statement: string }> }): string {
	const parts = [`Document: ${input.title}.`];
	if (input.known.length > 0) {
		parts.push("Already known (do not repeat):", ...input.known.map((k) => `- (p. ${k.page}) ${k.statement}`));
	}
	for (const p of input.pages) parts.push(`<<<PAGE ${p.page}\n${p.text}\nPAGE ${p.page}>>>`);
	return parts.join("\n");
}

export async function proposePageDrafts(
	deps: DraftWriterDeps,
	input: { title: string; pages: Array<{ page: number; text: string }>; known: Array<{ page: number; statement: string }> },
): Promise<PageDraft[]> {
	const wanted = new Set(input.pages.map((p) => p.page));
	const out = await runStructured<{ drafts: PageDraft[] }>({
		...deps,
		costSource: "study",
		role: "teacher",
		toolName: "submit_drafts",
		toolDescription: "Submit the proposed cards, each with the page it comes from. An empty list is allowed.",
		parameters: PagesSchema,
		systemPrompt: PAGES_SYSTEM,
		prompt: pagesPrompt(input),
		validate: (v) => {
			for (const d of v.drafts) {
				if (!wanted.has(d.page)) return `page ${d.page} is not one of the pages given (${[...wanted].join(", ")})`;
				const problem = fieldProblem(d);
				if (problem !== null) return `page ${d.page}: ${problem}`;
			}
			return null;
		},
	});
	return out.drafts.map((d) => ({ page: d.page, proposition: d.proposition.trim(), question: d.question.trim(), answer: d.answer.trim() }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-draft-writer.test.ts`
Expected: `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/study/draft-writer.ts tests/ext-study-draft-writer.test.ts
git commit -m "feat(ext): card and page draft writers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The study service (documents, cards, goal, complete, decide)

The use cases, behind injected ports (ledgers, files, PDF reader, library, gate, writers, importer, card creators). One file, because the use cases share the `attach` step (import a proposition, pick its node, link it, create the card); the tests are split in two files by topic. REQ coverage: 01, 02, 03, 05, 08, 09, 10, 11, 12, 13 and REQ-goal-01 (a goal from a document, origin `pdf`).

Behaviours worth knowing before you read the code:
- `registerDocument` validates an absolute `.pdf` path, the `%PDF-` magic and the size cap, refuses a PDF with no extractable text (422), stores the copy, and registers a primary entry in the source library (REQ-study-02).
- `open` creates the document's one conversation the first time and returns the same one afterwards (REQ-study-05).
- `confirmCard` is the one place a proposition reaches the graph: import, find the nodes the source produced (`nodesFromSource`), `pickCardNode`, link node and page, create the user card, pin by default. A pipeline failure becomes a 502 and nothing is linked.
- `complete` is single-flight per document, gate-checked before every batch of `COMPLETE_BATCH_PAGES` pages, handles `CostCeilingError` by stopping cleanly with `ceilingReached: true`, writes only `proposed` and `pages_processed` events (REQ-study-11, 12, 13).
- `decideDrafts`: an unedited approval creates an agent card and approves it; an edited approval is the learner authoring a card (a user card) and so goes through `confirmCard`'s path.

**Files:**
- Create: `tests/helpers/study-fakes.ts`, `src/server/ext/study-service.ts`
- Test: `tests/ext-study-service.test.ts`, `tests/ext-study-complete.test.ts`

- [ ] **Step 1: Write the test helper**

`tests/helpers/study-fakes.ts`

```typescript
// tests/helpers/study-fakes.ts
/** In-memory dependencies for the study service tests. */

import { createHash } from "node:crypto";
import type { CardDraft, PageDraft } from "../../src/agent/ext/study/draft-writer.ts";
import { createSourceLibrary } from "../../src/core/ext/sources.ts";
import type { CandidateNode } from "../../src/core/ext/study/card-node.ts";
import type { DocumentEvent } from "../../src/core/ext/study/documents.ts";
import type { DraftEvent } from "../../src/core/ext/study/drafts.ts";
import type { StudyLinkEvent } from "../../src/core/ext/study/links.ts";
import type { DocumentFiles, LedgerLike } from "../../src/core/ext/study/ports.ts";
import type { ReadingEvent } from "../../src/core/ext/study/reading.ts";
import { createStudyService, type StudyServiceDeps } from "../../src/server/ext/study-service.ts";
import { fakeGate, memSourcesStore } from "./ext-fakes.ts";

export const memLedger = <T>(): LedgerLike<T> & { events: T[] } => {
	const events: T[] = [];
	return { events, append: (e) => void events.push(e), readAll: () => [...events] };
};

export function memFiles(): DocumentFiles & { pdfs: Map<string, Uint8Array>; pages: Map<string, string[]> } {
	const pdfs = new Map<string, Uint8Array>();
	const pages = new Map<string, string[]>();
	return {
		pdfs,
		pages,
		putPdf(bytes) {
			const id = createHash("sha256").update(bytes).digest("hex");
			pdfs.set(id, bytes);
			return { id, path: `/data/ext/documents/${id}.pdf` };
		},
		pdfPath: (id) => (pdfs.has(id) ? `/data/ext/documents/${id}.pdf` : null),
		putPages: (id, p) => void pages.set(id, [...p]),
		getPages: (id) => pages.get(id) ?? null,
	};
}

export const PDF_A = new TextEncoder().encode("%PDF-1.4 book A");
export const PDF_B = new TextEncoder().encode("%PDF-1.4 book B");
export const idOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const BOOK_PAGES = ["Cover page.", "A sigma algebra is closed under complement.", "", "Every convergent sequence is bounded.", "Compact sets are closed."];

export interface StudyHarness {
	svc: ReturnType<typeof createStudyService>;
	/** A new service over the same ledgers and files, as after an app restart (the page cache is empty). */
	restart(): void;
	fail: { draft: boolean; pipeline: boolean };
	documents: ReturnType<typeof memLedger<DocumentEvent>>;
	reading: ReturnType<typeof memLedger<ReadingEvent>>;
	links: ReturnType<typeof memLedger<StudyLinkEvent>>;
	drafts: ReturnType<typeof memLedger<DraftEvent>>;
	files: ReturnType<typeof memFiles>;
	gate: ReturnType<typeof fakeGate>;
	library: ReturnType<typeof createSourceLibrary>;
	clock: { t: number };
	imports: Array<{ filePath: string; text: string }>;
	cards: { created: unknown[]; proposed: unknown[]; approved: string[]; pinned: string[] };
	chats: string[];
	goals: unknown[];
	pageCalls: Array<{ title: string; pages: Array<{ page: number; text: string }>; known: Array<{ page: number; statement: string }> }>;
	cardCalls: Array<{ title: string; page: number; from: string; text: string }>;
	/** What the fake pipeline returns for the next import(s): by default one node per import. */
	pipeline: { next: CandidateNode[] | null; bySource: Map<string, CandidateNode[]> };
	byte: { files: Map<string, Uint8Array> };
}

export function studyHarness(opts: {
	proposals?: PageDraft[][] | (() => Promise<PageDraft[]>);
	cardDraft?: CardDraft;
	pages?: string[];
	existingNodes?: CandidateNode[];
	maxPdfBytes?: number;
	/** Called each time the page-draft writer is asked, before it answers. */
	onPropose?: () => void;
} = {}): StudyHarness {
	const fail = { draft: false, pipeline: false };
	const documents = memLedger<DocumentEvent>();
	const reading = memLedger<ReadingEvent>();
	const links = memLedger<StudyLinkEvent>();
	const drafts = memLedger<DraftEvent>();
	const files = memFiles();
	const gate = fakeGate();
	const library = createSourceLibrary(memSourcesStore());
	const clock = { t: Date.UTC(2026, 10, 4, 10, 0, 0) };
	const imports: StudyHarness["imports"] = [];
	const cards: StudyHarness["cards"] = { created: [], proposed: [], approved: [], pinned: [] };
	const chats: string[] = [];
	const goals: unknown[] = [];
	const pageCalls: StudyHarness["pageCalls"] = [];
	const cardCalls: StudyHarness["cardCalls"] = [];
	const pipeline: StudyHarness["pipeline"] = { next: null, bySource: new Map() };
	const byte = { files: new Map<string, Uint8Array>([["/books/a.pdf", PDF_A], ["/books/b.pdf", PDF_B]]) };
	const queue = Array.isArray(opts.proposals) ? [...opts.proposals] : [];
	let nodeSeq = 0;
	let cardSeq = 0;
	const nodes = new Map<string, CandidateNode>((opts.existingNodes ?? []).map((n) => [n.id, n]));

	const deps: StudyServiceDeps = {
		documents, reading, links, drafts, files, library, gate,
		...(opts.maxPdfBytes !== undefined ? { maxPdfBytes: opts.maxPdfBytes } : {}),
		readFile: async (p) => {
			const b = byte.files.get(p);
			if (b === undefined) throw new Error("ENOENT");
			return b;
		},
		readPages: async () => {
			const pages = opts.pages ?? BOOK_PAGES;
			return { pageCount: pages.length, pages };
		},
		createSession: (title) => {
			chats.push(title);
			return { id: `chat_${chats.length}` };
		},
		writers: {
			draftCard: async (input) => {
				if (fail.draft) throw new Error("model unavailable");
				cardCalls.push(input);
				return opts.cardDraft ?? { proposition: "P.", question: "Q?", answer: "A." };
			},
			proposePageDrafts: async (input) => {
				pageCalls.push({ title: input.title, pages: input.pages, known: input.known });
				opts.onPropose?.();
				if (typeof opts.proposals === "function") return opts.proposals();
				return queue.shift() ?? [];
			},
		},
		nodesByIds: (ids) => ids.flatMap((id) => (nodes.has(id) ? [nodes.get(id)!] : [])),
		importProposition: async (input) => {
			if (fail.pipeline) throw new Error("no model configured");
			imports.push(input);
			const made = pipeline.next ?? [{ id: `n_${++nodeSeq}`, name: `Node ${nodeSeq}`, statement: input.text.trim(), aliases: [] }];
			pipeline.next = null;
			for (const n of made) nodes.set(n.id, n);
			pipeline.bySource.set(input.filePath, made);
		},
		nodesFromSource: (filePath) => pipeline.bySource.get(filePath) ?? [],
		cards: {
			createUser: (input) => {
				cards.created.push(input);
				return `card_${++cardSeq}`;
			},
			proposeAgent: (input) => {
				cards.proposed.push(input);
				return `card_${++cardSeq}`;
			},
			approve: (id) => void cards.approved.push(id),
			pin: (id) => void cards.pinned.push(id),
		},
		createGoal: (input) => {
			goals.push(input);
			return { id: "goal_1" };
		},
		now: () => new Date(clock.t).toISOString(),
		newId: (() => {
			let i = 0;
			return () => `id${++i}`;
		})(),
	};
	const harness: StudyHarness = {
		svc: createStudyService(deps),
		restart: () => void (harness.svc = createStudyService(deps)),
		fail,
		documents, reading, links, drafts, files, gate, library, clock, imports, cards, chats, goals, pageCalls, cardCalls, pipeline, byte,
	};
	return harness;
}

/** Registers book A and returns its id. */
export async function registerA(h: StudyHarness): Promise<string> {
	return (await h.svc.registerDocument({ path: "/books/a.pdf" })).id;
}

/** Reads the given pages (5 seconds each) and closes. */
export function readPages(h: StudyHarness, documentId: string, pages: number[]): void {
	for (const page of pages) {
		h.svc.recordReading({ documentId, kind: "visit", page });
		h.clock.t += 6000;
	}
	h.svc.recordReading({ documentId, kind: "close" });
	h.clock.t += 1000;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/ext-study-service.test.ts`

```typescript
// tests/ext-study-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeStudyContext } from "../src/core/ext/study/context.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { StudyError } from "../src/server/ext/study-service.ts";
import { BOOK_PAGES, idOf, PDF_A, PDF_B, readPages, registerA, studyHarness } from "./helpers/study-fakes.ts";

const rejectsWith = (p: Promise<unknown>, status: number, re: RegExp) =>
	assert.rejects(p, (e: unknown) => e instanceof StudyError && e.status === status && re.test(e.message));

describe("registering a document (REQ-study-01, REQ-study-02)", () => {
	it("stores a copy, records sha256 id, title and page count, and writes the page texts", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		assert.equal(doc.id, idOf(PDF_A));
		assert.equal(doc.title, "a");
		assert.equal(doc.pageCount, BOOK_PAGES.length);
		assert.equal(h.files.pdfs.has(doc.id), true);
		assert.deepEqual(h.files.pages.get(doc.id), BOOK_PAGES);
		assert.deepEqual(h.documents.events.map((e) => e.type), ["registered"]);
	});
	it("the same file is the same document: no second event, no second copy", async () => {
		const h = studyHarness();
		const a = await h.svc.registerDocument({ path: "/books/a.pdf" });
		h.byte.files.set("/elsewhere/copy.pdf", PDF_A);
		const b = await h.svc.registerDocument({ path: "/elsewhere/copy.pdf", title: "Other name" });
		assert.equal(b.id, a.id);
		assert.equal(b.title, "a");
		assert.equal(h.documents.events.length, 1);
		assert.equal(h.files.pdfs.size, 1);
	});
	it("a custom title is used for a new document", async () => {
		const h = studyHarness();
		assert.equal((await h.svc.registerDocument({ path: "/books/b.pdf", title: "  Probability  " })).title, "Probability");
	});
	it("registers the stored copy as an ACTIVE PRIMARY source, once", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		await h.svc.registerDocument({ path: "/books/a.pdf" });
		const entries = h.library.list();
		assert.equal(entries.length, 1);
		assert.deepEqual(
			[entries[0]!.kind, entries[0]!.locator, entries[0]!.tier, entries[0]!.status, entries[0]!.label],
			["pdf", `/data/ext/documents/${doc.id}.pdf`, "primary", "active", "a"],
		);
	});
	it("promotes a source entry that was only proposed", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		const entry = h.library.list()[0]!;
		h.library.setStatus(entry.id, "proposed", "secondary");
		await h.svc.open(doc.id);
		assert.deepEqual([h.library.list()[0]!.status, h.library.list()[0]!.tier], ["active", "primary"]);
	});
	it("refuses a relative path, a non-pdf name, an unreadable file, a non-PDF and an oversized file", async () => {
		const h = studyHarness();
		await rejectsWith(h.svc.registerDocument({ path: "books/a.pdf" }), 400, /absolute path/);
		await rejectsWith(h.svc.registerDocument({ path: "/books/a.txt" }), 400, /absolute path/);
		await rejectsWith(h.svc.registerDocument({ path: "/books/missing.pdf" }), 404, /cannot be read/);
		h.byte.files.set("/books/fake.pdf", new TextEncoder().encode("hello"));
		await rejectsWith(h.svc.registerDocument({ path: "/books/fake.pdf" }), 400, /not a PDF/);
		const small = studyHarness({ maxPdfBytes: 10 });
		await rejectsWith(small.svc.registerDocument({ path: "/books/a.pdf" }), 400, /too large/);
		assert.equal(h.documents.events.length, 0);
	});
	it("refuses a PDF with no extractable text (a scan) and writes no event", async () => {
		const h = studyHarness({ pages: ["", "  ", ""] });
		await rejectsWith(h.svc.registerDocument({ path: "/books/a.pdf" }), 422, /no extractable text/);
		assert.equal(h.documents.events.length, 0);
		assert.equal(h.library.list().length, 0);
	});
	it("lists documents with the reading summary", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await h.svc.registerDocument({ path: "/books/b.pdf" });
		readPages(h, id, [2, 4]);
		const list = h.svc.listDocuments();
		assert.deepEqual(list.map((d) => [d.title, d.lastPage, d.readCount]), [["a", 4, 2], ["b", null, 0]]);
		assert.notEqual(list[0]!.id, idOf(PDF_B));
	});
});

describe("one conversation per document (REQ-study-05)", () => {
	it("the first open creates a study chat, every later open returns the same one", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const first = await h.svc.open(id);
		const second = await h.svc.open(id);
		assert.equal(first.chatId, second.chatId);
		assert.deepEqual(h.chats, ["Study: a"]);
		assert.equal(h.documents.events.filter((e) => e.type === "chat").length, 1);
	});
	it("two documents have two conversations; an unknown document is a 404", async () => {
		const h = studyHarness();
		const a = await registerA(h);
		const b = (await h.svc.registerDocument({ path: "/books/b.pdf" })).id;
		assert.notEqual((await h.svc.open(a)).chatId, (await h.svc.open(b)).chatId);
		await rejectsWith(h.svc.open("f".repeat(64)), 404, /unknown document/);
	});
	it("re-extracts the page texts on open when the file was lost", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.files.pages.clear();
		h.restart();
		await h.svc.open(id);
		assert.deepEqual(h.files.pages.get(id), BOOK_PAGES);
	});
});

describe("reading position (REQ-study-03)", () => {
	it("resumes on the last page visited and reports the pages read", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.equal((await h.svc.open(id)).page, 1);
		readPages(h, id, [2, 3]);
		h.svc.recordReading({ documentId: id, kind: "visit", page: 5 });
		const open = await h.svc.open(id);
		assert.equal(open.page, 5);
		assert.deepEqual(open.readPages, [2, 3]);
	});
	it("refuses a page outside the document and an unknown document", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		for (const page of [0, 6, 1.5, "2", undefined]) assert.throws(() => h.svc.recordReading({ documentId: id, kind: "visit", page }), /page must be a whole number from 1 to 5/, String(page));
		assert.throws(() => h.svc.recordReading({ documentId: "e".repeat(64), kind: "close" }), /unknown document/);
		assert.equal(h.reading.events.length, 0);
	});
});

describe("the conversation's tool context (REQ-study-06, REQ-study-07)", () => {
	it("finds the document by chat id and serves page text and search", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const { chatId } = await h.svc.open(id);
		const ctx = h.svc.toolContext(chatId, { getChat: () => ({ messages: [newUserMessage(encodeStudyContext({ documentId: id, page: 2, selection: "" }, "q"))] }) });
		assert.deepEqual(ctx.document(), { id, title: "a", pageCount: 5 });
		assert.equal(ctx.pageText(2), BOOK_PAGES[1]);
		assert.equal(ctx.pageText(0), null);
		assert.equal(ctx.pageText(6), null);
		assert.deepEqual(ctx.search("SIGMA").map((x) => x.page), [2]);
		assert.match(ctx.search("bounded")[0]!.snippet, /Every convergent sequence is bounded/);
		assert.deepEqual(ctx.search("  "), []);
	});
	it("an unknown chat has no document", () => {
		const h = studyHarness();
		const ctx = h.svc.toolContext("chat_x", { getChat: () => null });
		assert.equal(ctx.document(), null);
		assert.equal(ctx.pageText(1), null);
		assert.deepEqual(ctx.search("a"), []);
	});
});

describe("drafting a card (REQ-study-08)", () => {
	it("drafts from the selection when there is one, otherwise from the page", async () => {
		const h = studyHarness({ cardDraft: { proposition: "Sigma algebras are closed under complement.", question: "Q?", answer: "A." } });
		const id = await registerA(h);
		const d = await h.svc.draftCard({ documentId: id, page: 2, selection: "  closed under complement " });
		assert.equal(d.proposition, "Sigma algebras are closed under complement.");
		await h.svc.draftCard({ documentId: id, page: 2 });
		assert.deepEqual(h.cardCalls.map((c) => [c.from, c.text, c.page, c.title]), [
			["selection", "closed under complement", 2, "a"],
			["page", BOOK_PAGES[1], 2, "a"],
		]);
	});
	it("a page without text and no selection cannot be drafted; a huge selection is refused", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 3 }), 422, /no text/);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 2, selection: "x".repeat(6001) }), 400, /select less text/);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 9 }), 400, /page must be/);
	});
	it("a model failure is a 502 with a plain message", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.fail.draft = true;
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 2 }), 502, /could not draft a card: model unavailable/);
	});
});

describe("confirming a card (REQ-study-09, REQ-study-10, REQ-study-12)", () => {
	const good = { proposition: "A sigma algebra is closed under complement.", question: "Closed under what?", answer: "Complement." };
	it("sends ONLY the proposition through the pipeline, then links the node to the page and attaches an active user card", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(h.imports.length, 1);
		assert.match(h.imports[0]!.filePath, /^study\/a\/p0002-[0-9a-f]{8}\.md$/);
		assert.equal(h.imports[0]!.text, `${good.proposition}\n`);
		assert.deepEqual(h.links.events.map((e) => [e.nodeId, e.documentId, e.page]), [[r.nodeId, id, 2]]);
		assert.deepEqual(h.cards.created, [{ nodeId: r.nodeId, question: good.question, answer: good.answer }]);
		assert.deepEqual(h.cards.proposed, []);
	});
	it("pins the node by default and not when pin is false", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const a = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		await h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: "Another one.", pin: false });
		assert.deepEqual(h.cards.pinned, [a.nodeId]);
	});
	it("attaches the card to the node closest to the proposition and links every node the import produced", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.pipeline.next = [
			{ id: "n_premise", name: "Premise", statement: "Complements exist.", aliases: [] },
			{ id: "n_main", name: "Main", statement: "A sigma algebra is closed under complement.", aliases: [] },
		];
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(r.nodeId, "n_main");
		assert.deepEqual(r.nodeIds, ["n_premise", "n_main"]);
		assert.deepEqual(h.links.events.map((e) => e.nodeId), ["n_premise", "n_main"]);
	});
	it("an equivalent existing node is linked, not duplicated (the pipeline returns the existing node)", async () => {
		const h = studyHarness({ existingNodes: [{ id: "n_old", name: "Old", statement: "Sigma algebras are closed under complements.", aliases: [] }] });
		const id = await registerA(h);
		h.pipeline.next = [{ id: "n_old", name: "Old", statement: "Sigma algebras are closed under complements.", aliases: [] }];
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(r.nodeId, "n_old");
	});
	it("writes nothing when the pipeline finds no proposition", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.pipeline.next = [];
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good }), 422, /found no proposition/);
		assert.deepEqual([h.links.events.length, h.cards.created.length, h.cards.pinned.length], [0, 0, 0]);
	});
	it("a pipeline failure is a 502 and writes nothing", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.fail.pipeline = true;
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good }), 502, /nothing was added: no model configured/);
		assert.deepEqual([h.links.events.length, h.cards.created.length, h.cards.pinned.length], [0, 0, 0]);
	});
	it("validates every field before any write", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: " " }), 400, /proposition is required/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, question: undefined }), 400, /question is required/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, answer: "x".repeat(2001) }), 400, /answer is too long/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: "x".repeat(401) }), 400, /proposition is too long/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 0, ...good }), 400, /page must be/);
		assert.equal(h.imports.length, 0);
	});
});

describe("a goal from a document (REQ-goal-01)", () => {
	it("creates a goal whose origin reference is the document", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.deepEqual(h.svc.startGoal({ documentId: id, title: " Master chapter 1 ", statement: "I can state the axioms of a sigma algebra." }), { goalId: "goal_1" });
		assert.deepEqual(h.goals, [{ title: "Master chapter 1", statement: "I can state the axioms of a sigma algebra.", originRef: id }]);
		assert.throws(() => h.svc.startGoal({ documentId: id, title: "", statement: "x" }), /title is required/);
	});
});
```

`tests/ext-study-complete.test.ts`

```typescript
// tests/ext-study-complete.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { deriveDrafts } from "../src/core/ext/study/drafts.ts";
import { COMPLETE_BATCH_PAGES, MAX_DRAFTS_PER_PAGE, StudyError } from "../src/server/ext/study-service.ts";
import { readPages, registerA, studyHarness } from "./helpers/study-fakes.ts";

const draft = (page: number, n: number) => ({ page, proposition: `Fact ${n} on page ${page}.`, question: `Q${n}?`, answer: `A${n}.` });

describe("complete (REQ-study-11, REQ-study-12)", () => {
	it("proposes drafts only for pages read and not yet processed, and writes no node, link or card", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1), draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2, 4]);
		h.svc.recordReading({ documentId: id, kind: "visit", page: 5 }); // visited but not read (no dwell)
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 2, pages: [2, 4], remaining: 0, ceilingReached: false });
		assert.deepEqual(h.pageCalls[0]!.pages.map((p) => p.page), [2, 4]);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => [d.page, d.status]), [[2, "pending"], [4, "pending"]]);
		assert.deepEqual([h.imports.length, h.links.events.length, h.cards.created.length, h.cards.proposed.length, h.cards.pinned.length], [0, 0, 0, 0, 0]);
	});
	it("a second run does not offer the same pages again", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await h.svc.complete(id);
		const again = await h.svc.complete(id);
		assert.deepEqual(again, { proposed: 0, pages: [], remaining: 0, ceilingReached: false });
		assert.equal(h.pageCalls.length, 1);
	});
	it("a page read later is offered by the next run", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)], [draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await h.svc.complete(id);
		readPages(h, id, [4]);
		const r = await h.svc.complete(id);
		assert.deepEqual(r.pages, [4]);
	});
	it("tells the model what already exists on those pages and drops proposals that repeat it", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1), { page: 2, proposition: "A sigma algebra is closed under complement.", question: "Q?", answer: "A." }, draft(2, 3)]] });
		const id = await registerA(h);
		h.pipeline.next = [{ id: "n_have", name: "Have", statement: "A sigma algebra is closed under complement", aliases: [] }];
		await h.svc.confirmCard({ documentId: id, page: 2, proposition: "A sigma algebra is closed under complement.", question: "Q?", answer: "A." });
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.deepEqual(h.pageCalls[0]!.known, [{ page: 2, statement: "A sigma algebra is closed under complement" }]);
		assert.equal(r.proposed, 2);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.proposition), ["Fact 1 on page 2.", "Fact 3 on page 2."]);
	});
	it("ignores proposals for pages outside the batch and keeps at most five per page", async () => {
		const many = Array.from({ length: MAX_DRAFTS_PER_PAGE + 3 }, (_, i) => draft(2, i + 1));
		const h = studyHarness({ proposals: [[...many, draft(5, 99)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.equal(r.proposed, MAX_DRAFTS_PER_PAGE);
		assert.equal(h.svc.listDrafts(id).every((d) => d.page === 2), true);
	});
	it("a page with no text is marked processed without calling the model", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		readPages(h, id, [3]); // page 3 is empty in the fixture
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [3], remaining: 0, ceilingReached: false });
		assert.equal(h.pageCalls.length, 0);
	});
	it("sends pages in batches", async () => {
		const pages = Array.from({ length: 10 }, (_, i) => `Text of page ${i + 1}.`);
		const h = studyHarness({ pages, proposals: [[], [], []] });
		const id = await registerA(h);
		readPages(h, id, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const r = await h.svc.complete(id);
		assert.deepEqual(h.pageCalls.map((c) => c.pages.length), [COMPLETE_BATCH_PAGES, COMPLETE_BATCH_PAGES, 1]);
		assert.equal(r.pages.length, 9);
	});
	it("nothing read means nothing to do", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.deepEqual(await h.svc.complete(id), { proposed: 0, pages: [], remaining: 0, ceilingReached: false });
	});
});

describe("complete and the daily ceiling (REQ-study-13)", () => {
	it("does not call the model when the ceiling is already reached, and leaves the pages unprocessed", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		h.gate.open = false;
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [], remaining: 1, ceilingReached: true });
		assert.equal(h.pageCalls.length, 0);
		h.gate.open = true;
		assert.equal((await h.svc.complete(id)).proposed, 1);
	});
	it("stops between batches when the ceiling is reached mid-run and keeps what was done", async () => {
		const pages = Array.from({ length: 8 }, (_, i) => `Text of page ${i + 1}.`);
		const gateRef: { close: () => void } = { close: () => {} };
		const h = studyHarness({ pages, proposals: [[draft(1, 1)], [draft(5, 2)]], onPropose: () => gateRef.close() });
		gateRef.close = () => void (h.gate.open = false); // the first batch spends the rest of the day
		const id = await registerA(h);
		readPages(h, id, [1, 2, 3, 4, 5, 6]);
		const r = await h.svc.complete(id);
		assert.deepEqual([r.pages, r.remaining, r.ceilingReached, r.proposed], [[1, 2, 3, 4], 2, true, 1]);
	});
	it("a CostCeilingError from the writer ends the run cleanly without marking the batch processed", async () => {
		const h = studyHarness({ proposals: () => Promise.reject(new CostCeilingError("spent")) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [], remaining: 1, ceilingReached: true });
		assert.equal(h.drafts.events.length, 0);
	});
	it("any other writer failure propagates and marks nothing", async () => {
		const h = studyHarness({ proposals: () => Promise.reject(new Error("boom")) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await assert.rejects(h.svc.complete(id), /boom/);
		assert.equal(h.drafts.events.length, 0);
	});
	it("refuses a second run while one is in progress", async () => {
		let release!: () => void;
		const gateOpen = new Promise<void>((r) => (release = r));
		const h = studyHarness({ proposals: () => gateOpen.then(() => []) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const first = h.svc.complete(id);
		await assert.rejects(h.svc.complete(id), (e: unknown) => e instanceof StudyError && e.status === 409);
		release();
		await first;
		assert.equal((await h.svc.complete(id)).pages.length, 0);
	});
});

describe("deciding drafts (REQ-study-11, REQ-study-12)", () => {
	async function withDrafts() {
		const h = studyHarness({ proposals: [[draft(2, 1), draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2, 4]);
		await h.svc.complete(id);
		const [d1, d2] = h.svc.listDrafts(id);
		return { h, id, d1: d1!, d2: d2! };
	}
	it("approving an unedited draft creates an agent card that is then approved, attached to a node linked to the page", async () => {
		const { h, d1 } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }], reject: [] });
		assert.equal(r.approved.length, 1);
		assert.equal(h.imports[0]!.text, `${d1.proposition}\n`);
		assert.deepEqual(h.cards.proposed, [{ nodeId: r.approved[0]!.nodeId, question: d1.question, answer: d1.answer }]);
		assert.deepEqual(h.cards.approved, [r.approved[0]!.cardId]);
		assert.deepEqual(h.cards.created, []);
		assert.deepEqual(h.links.events.map((e) => e.page), [2]);
		assert.equal(deriveDrafts(h.drafts.events).find((d) => d.id === d1.id)!.status, "approved");
	});
	it("an edited draft becomes a user card with the edited text", async () => {
		const { h, d1 } = await withDrafts();
		await h.svc.decideDrafts({ approve: [{ draftId: d1.id, question: "A better question?" }], reject: [] });
		assert.deepEqual(h.cards.created, [{ nodeId: "n_1", question: "A better question?", answer: d1.answer }]);
		assert.deepEqual(h.cards.proposed, []);
	});
	it("rejecting writes only a decision; a decided draft cannot be decided again", async () => {
		const { h, id, d1, d2 } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [], reject: [d1.id] });
		assert.deepEqual(r.rejected, [d1.id]);
		assert.equal(h.imports.length, 0);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.id), [d2.id]);
		const again = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }], reject: [d1.id] });
		assert.deepEqual(again.failed.map((f) => f.error), ["not a pending draft", "not a pending draft"]);
		assert.equal(h.imports.length, 0);
	});
	it("one failing approval does not stop the others and leaves its draft pending", async () => {
		const { h, id, d1, d2 } = await withDrafts();
		h.pipeline.next = [];
		const r = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }, { draftId: d2.id }], reject: [] });
		assert.equal(r.failed.length, 1);
		assert.match(r.failed[0]!.error, /found no proposition/);
		assert.equal(r.approved.length, 1);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.id), [d1.id]);
	});
	it("an unknown draft id fails without effect", async () => {
		const { h } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [{ draftId: "draft_nope" }], reject: ["draft_nope2"] });
		assert.equal(r.failed.length, 2);
		assert.equal(h.imports.length, 0);
	});
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-service.test.ts tests/ext-study-complete.test.ts`
Expected: FAIL, `Cannot find module '../src/server/ext/study-service.ts'`.

- [ ] **Step 4: Implement the service**

`src/server/ext/study-service.ts`

```typescript
// src/server/ext/study-service.ts
/**
 * Assisted study (child spec 7). Everything impure is injected; the live
 * wiring is study-live.ts.
 *
 * A document is a registered PDF with ONE conversation (a chat of kind
 * `study`). Nothing from a document reaches the graph unless the learner
 * confirms a proposition (REQ-study-12): confirmation sends that one
 * proposition through the extraction pipeline's notes front door, then links
 * and cards are written to the extension ledgers. The "complete" run only
 * proposes: its drafts are events in study-drafts.jsonl until approved.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CardDraft, PageDraft } from "../../agent/ext/study/draft-writer.ts";
import { MAX_PROPOSITION_CHARS } from "../../agent/ext/study/draft-writer.ts";
import { CostCeilingError } from "../../agent/ext/lecture/structured.ts";
import type { StudyToolContext } from "../../agent/ext/study/study-tools.ts";
import { pickCardNode, type CandidateNode } from "../../core/ext/study/card-node.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import { deriveDocuments, documentOfChat, type DocumentEvent, type StudyDocument } from "../../core/ext/study/documents.ts";
import { deriveDrafts, dropRepeats, processedPages, type Draft, type DraftEvent } from "../../core/ext/study/drafts.ts";
import { nodeIdsOnPages, type StudyLinkEvent } from "../../core/ext/study/links.ts";
import type { DocumentFiles, LedgerLike } from "../../core/ext/study/ports.ts";
import { deriveReading, type ReadingEvent } from "../../core/ext/study/reading.ts";
import { studySourcePath, studySourceText } from "../../core/ext/study/source-path.ts";
import { HttpError } from "./http-error.ts";

export class StudyError extends HttpError {}

export const MAX_PDF_BYTES = 200 * 1024 * 1024;
/** Pages per model call in a complete run. */
export const COMPLETE_BATCH_PAGES = 4;
/** Most proposals kept per page in a complete run. */
export const MAX_DRAFTS_PER_PAGE = 5;
/** Longest text a card draft is made from. */
export const MAX_DRAFT_SOURCE_CHARS = 6000;
const MAX_FIELD_CHARS = 2000;

export interface StudyServiceDeps {
	documents: LedgerLike<DocumentEvent>;
	reading: LedgerLike<ReadingEvent>;
	links: LedgerLike<StudyLinkEvent>;
	drafts: LedgerLike<DraftEvent>;
	files: DocumentFiles;
	/** The bytes of a local file; rejects when it cannot be read. */
	readFile(filePath: string): Promise<Uint8Array>;
	/** Largest PDF accepted (default MAX_PDF_BYTES). */
	maxPdfBytes?: number;
	readPages(pdfPath: string): Promise<{ pageCount: number; pages: string[] }>;
	library: SourceLibrary;
	gate: CostGate;
	/** Creates a `study` chat. */
	createSession(title: string): { id: string };
	writers: {
		/** User-initiated: not blocked by the daily ceiling. */
		draftCard(input: { title: string; page: number; from: "selection" | "page"; text: string }): Promise<CardDraft>;
		/** Background: the writer refuses with CostCeilingError once the ceiling is reached. */
		proposePageDrafts(input: {
			title: string;
			pages: Array<{ page: number; text: string }>;
			known: Array<{ page: number; statement: string }>;
		}): Promise<PageDraft[]>;
	};
	nodesByIds(ids: readonly string[]): CandidateNode[];
	/** Runs the extraction pipeline's notes front door over one proposition. */
	importProposition(input: { filePath: string; text: string }): Promise<void>;
	/** Nodes whose provenance is the given notes source (created or linked by that import). */
	nodesFromSource(filePath: string): CandidateNode[];
	cards: {
		createUser(input: { nodeId: string; question: string; answer: string }): string;
		proposeAgent(input: { nodeId: string; question: string; answer: string }): string;
		approve(cardId: string): void;
		pin(nodeId: string): void;
	};
	createGoal(input: { title: string; statement: string; originRef: string }): { id: string };
	now?: () => string;
	newId?: () => string;
}

export interface DocumentView {
	id: string;
	title: string;
	pageCount: number;
	chatId: string | null;
	lastPage: number | null;
	readCount: number;
}

export interface OpenView {
	document: DocumentView;
	chatId: string;
	/** Where to resume: the last page visited, or 1. */
	page: number;
	readPages: number[];
}

export interface CardContent {
	proposition: string;
	question: string;
	answer: string;
}

export interface ConfirmResult {
	cardId: string;
	/** The node the card is attached to. */
	nodeId: string;
	/** Every node the proposition produced or was linked to; all are linked to the page. */
	nodeIds: string[];
}

export interface CompleteResult {
	proposed: number;
	/** Pages handled by this run. */
	pages: number[];
	/** Read pages still waiting (because the ceiling was reached). */
	remaining: number;
	ceilingReached: boolean;
}

export interface DecideResult {
	approved: Array<{ draftId: string } & ConfirmResult>;
	rejected: string[];
	failed: Array<{ draftId: string; error: string }>;
}

function text(v: unknown, field: string, max: number): string {
	if (typeof v !== "string" || v.trim() === "") throw new StudyError(400, `${field} is required`);
	if ([...v].length > max) throw new StudyError(400, `${field} is too long (at most ${max} characters)`);
	return v.trim();
}

export function createStudyService(deps: StudyServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(5).toString("hex"));
	const pageCache = new Map<string, string[]>();
	const running = new Set<string>();

	const allDocuments = (): StudyDocument[] => deriveDocuments(deps.documents.readAll());
	function documentById(id: string): StudyDocument {
		const doc = allDocuments().find((d) => d.id === id);
		if (doc === undefined) throw new StudyError(404, "unknown document");
		return doc;
	}
	function checkPage(doc: StudyDocument, page: unknown): number {
		if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > doc.pageCount) {
			throw new StudyError(400, `page must be a whole number from 1 to ${doc.pageCount}`);
		}
		return page;
	}
	function view(doc: StudyDocument): DocumentView {
		const state = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount });
		return { id: doc.id, title: doc.title, pageCount: doc.pageCount, chatId: doc.chatId, lastPage: state.lastPage, readCount: state.readPages.length };
	}
	function pagesOf(id: string): string[] | null {
		const cached = pageCache.get(id);
		if (cached !== undefined) return cached;
		const pages = deps.files.getPages(id);
		if (pages !== null) pageCache.set(id, pages);
		return pages;
	}
	/** Re-extracts the page texts when the file is missing (a crash between the copy and the extraction). */
	async function ensurePages(doc: StudyDocument): Promise<string[]> {
		const have = pagesOf(doc.id);
		if (have !== null) return have;
		const stored = deps.files.pdfPath(doc.id);
		if (stored === null) throw new StudyError(409, "the stored copy of this document is missing: register it again");
		const { pages } = await deps.readPages(stored);
		deps.files.putPages(doc.id, pages);
		pageCache.set(doc.id, pages);
		return pages;
	}
	function pageTextOf(doc: StudyDocument, page: number): string | null {
		if (page < 1 || page > doc.pageCount) return null;
		return pagesOf(doc.id)?.[page - 1] ?? null;
	}
	/** REQ-study-02: idempotent, and it promotes an entry that was proposed or demoted. */
	function ensureInLibrary(doc: StudyDocument): void {
		const stored = deps.files.pdfPath(doc.id);
		if (stored !== null) registerBookAsPrimary(deps.library, stored, doc.title);
	}

	// ─── documents (REQ-study-01, 02, 05) ──────────────────────────────────

	async function registerDocument(input: { path: unknown; title?: unknown }): Promise<DocumentView> {
		const source = text(input.path, "path", 4096);
		if (!path.isAbsolute(source) || !source.toLowerCase().endsWith(".pdf")) throw new StudyError(400, "path must be the absolute path of a .pdf file");
		let bytes: Uint8Array;
		try {
			bytes = await deps.readFile(source);
		} catch {
			throw new StudyError(404, "that file cannot be read");
		}
		if (bytes.length > (deps.maxPdfBytes ?? MAX_PDF_BYTES)) throw new StudyError(400, "that PDF is too large (limit 200 MB)");
		if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") throw new StudyError(400, "that file is not a PDF");

		const stored = deps.files.putPdf(bytes);
		const known = allDocuments().find((d) => d.id === stored.id);
		if (known !== undefined) {
			await ensurePages(known);
			ensureInLibrary(known);
			return view(known);
		}
		let extracted: { pageCount: number; pages: string[] };
		try {
			extracted = await deps.readPages(stored.path);
		} catch {
			throw new StudyError(422, "this PDF could not be read (it may be damaged or encrypted)");
		}
		if (extracted.pages.every((p) => p.trim() === "")) {
			throw new StudyError(422, "this PDF has no extractable text (a scan); OCR is not supported");
		}
		const title = typeof input.title === "string" && input.title.trim() !== "" ? input.title.trim() : path.basename(source, path.extname(source));
		deps.files.putPages(stored.id, extracted.pages);
		pageCache.set(stored.id, extracted.pages);
		deps.documents.append({ type: "registered", documentId: stored.id, title, pageCount: extracted.pageCount, at: now() });
		const doc = documentById(stored.id);
		ensureInLibrary(doc);
		return view(doc);
	}

	function listDocuments(): DocumentView[] {
		return allDocuments().map(view);
	}

	/** REQ-study-05: the first call creates the conversation, every later call returns it. Synchronous between the read and the append. */
	async function open(documentId: string): Promise<OpenView> {
		let doc = documentById(documentId);
		await ensurePages(doc);
		ensureInLibrary(doc);
		if (doc.chatId === null) {
			const chat = deps.createSession(`Study: ${doc.title}`);
			deps.documents.append({ type: "chat", documentId: doc.id, chatId: chat.id, at: now() });
			doc = documentById(documentId);
		}
		const state = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount });
		return { document: view(doc), chatId: doc.chatId!, page: state.lastPage ?? 1, readPages: state.readPages };
	}

	function pdfFile(documentId: string): string {
		const stored = deps.files.pdfPath(documentById(documentId).id);
		if (stored === null) throw new StudyError(404, "the stored copy of this document is missing");
		return stored;
	}

	// ─── reading (REQ-study-03) ────────────────────────────────────────────

	function recordReading(input: { documentId: string; kind: "visit" | "close"; page?: unknown }): void {
		const doc = documentById(input.documentId);
		if (input.kind === "close") {
			deps.reading.append({ type: "close", documentId: doc.id, at: now() });
			return;
		}
		deps.reading.append({ type: "visit", documentId: doc.id, page: checkPage(doc, input.page), at: now() });
	}

	// ─── the conversation's tools (REQ-study-06, 07) ───────────────────────

	function toolContext(chatId: string, chatStore: StudyToolContext["chatStore"]): StudyToolContext {
		const doc = (): StudyDocument | null => documentOfChat(allDocuments(), chatId);
		return {
			chatId,
			chatStore,
			document: () => {
				const d = doc();
				return d === null ? null : { id: d.id, title: d.title, pageCount: d.pageCount };
			},
			pageText: (page) => {
				const d = doc();
				return d === null ? null : pageTextOf(d, page);
			},
			search: (query) => {
				const d = doc();
				const pages = d === null ? null : pagesOf(d.id);
				const needle = query.trim().toLowerCase();
				if (pages === null || needle === "") return [];
				const hits: Array<{ page: number; snippet: string }> = [];
				for (const [i, p] of pages.entries()) {
					const at = p.toLowerCase().indexOf(needle);
					if (at === -1) continue;
					const from = Math.max(0, at - 40);
					hits.push({ page: i + 1, snippet: p.slice(from, at + needle.length + 60).replace(/\s+/g, " ").trim() });
					if (hits.length >= 50) break;
				}
				return hits;
			},
		};
	}

	// ─── cards (REQ-study-08, 09, 10, 12) ──────────────────────────────────

	async function draftCard(input: { documentId: string; page: unknown; selection?: unknown }): Promise<CardDraft> {
		const doc = documentById(input.documentId);
		const page = checkPage(doc, input.page);
		const selection = typeof input.selection === "string" ? input.selection.trim() : "";
		if ([...selection].length > MAX_DRAFT_SOURCE_CHARS) throw new StudyError(400, `select less text (at most ${MAX_DRAFT_SOURCE_CHARS} characters)`);
		const from = selection !== "" ? "selection" : "page";
		const source = from === "selection" ? selection : (pageTextOf(doc, page) ?? "").trim().slice(0, MAX_DRAFT_SOURCE_CHARS);
		if (source === "") throw new StudyError(422, "this page has no text to make a card from: select text or write the card yourself");
		try {
			return await deps.writers.draftCard({ title: doc.title, page, from, text: source });
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new StudyError(502, `the model could not draft a card: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** The one path from a confirmed proposition to a node, a card and a link. */
	async function attach(doc: StudyDocument, page: number, c: CardContent, author: "user" | "agent", pin: boolean): Promise<ConfirmResult> {
		const filePath = studySourcePath(doc.title, page, c.proposition);
		try {
			await deps.importProposition({ filePath, text: studySourceText(c.proposition) });
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new StudyError(502, `the extraction pipeline failed, so nothing was added: ${e instanceof Error ? e.message : String(e)}`);
		}
		const nodes = deps.nodesFromSource(filePath);
		if (nodes.length === 0) {
			throw new StudyError(422, "the extraction pipeline found no proposition in this text, so nothing was added: rephrase the proposition and try again");
		}
		const nodeId = pickCardNode(c.proposition, nodes)!;
		const at = now();
		for (const n of nodes) deps.links.append({ type: "link", nodeId: n.id, documentId: doc.id, page, at });
		const body = { nodeId, question: c.question, answer: c.answer };
		let cardId: string;
		if (author === "user") {
			cardId = deps.cards.createUser(body);
		} else {
			cardId = deps.cards.proposeAgent(body);
			deps.cards.approve(cardId);
		}
		if (pin) deps.cards.pin(nodeId);
		return { cardId, nodeId, nodeIds: nodes.map((n) => n.id) };
	}

	function cardContent(raw: { proposition?: unknown; question?: unknown; answer?: unknown }): CardContent {
		return {
			proposition: text(raw.proposition, "proposition", MAX_PROPOSITION_CHARS),
			question: text(raw.question, "question", MAX_FIELD_CHARS),
			answer: text(raw.answer, "answer", MAX_FIELD_CHARS),
		};
	}

	/** REQ-study-08/09: the learner's confirmation. `pin` (default true) puts the node in the review deck even outside any goal. */
	async function confirmCard(input: { documentId: string; page: unknown; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }): Promise<ConfirmResult> {
		const doc = documentById(input.documentId);
		return attach(doc, checkPage(doc, input.page), cardContent(input), "user", input.pin !== false);
	}

	// ─── complete (REQ-study-11, 12, 13) ───────────────────────────────────

	function knownOnPages(doc: StudyDocument, pages: readonly number[]): Array<{ page: number; statement: string }> {
		const known: Array<{ page: number; statement: string }> = [];
		const linkEvents = deps.links.readAll();
		for (const page of pages) {
			const ids = nodeIdsOnPages(linkEvents, doc.id, [page]);
			for (const n of deps.nodesByIds(ids)) known.push({ page, statement: n.statement });
		}
		for (const d of deriveDrafts(deps.drafts.readAll())) {
			if (d.documentId === doc.id && pages.includes(d.page)) known.push({ page: d.page, statement: d.proposition });
		}
		return known;
	}

	async function complete(documentId: string): Promise<CompleteResult> {
		const doc = documentById(documentId);
		if (running.has(doc.id)) throw new StudyError(409, "a complete run is already in progress for this document");
		running.add(doc.id);
		try {
			await ensurePages(doc);
			const read = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount }).readPages;
			const done = new Set(processedPages(deps.drafts.readAll(), doc.id));
			const todo = read.filter((p) => !done.has(p));
			const handled: number[] = [];
			let proposed = 0;
			let ceilingReached = false;
			for (let i = 0; i < todo.length; i += COMPLETE_BATCH_PAGES) {
				const batch = todo.slice(i, i + COMPLETE_BATCH_PAGES);
				if (!deps.gate.allowed()) {
					ceilingReached = true;
					break;
				}
				const withText = batch.map((page) => ({ page, text: (pageTextOf(doc, page) ?? "").trim() })).filter((p) => p.text !== "");
				let drafts: PageDraft[] = [];
				if (withText.length > 0) {
					const known = knownOnPages(doc, batch);
					try {
						drafts = await deps.writers.proposePageDrafts({ title: doc.title, pages: withText, known });
					} catch (e) {
						if (e instanceof CostCeilingError) {
							ceilingReached = true;
							break;
						}
						throw e;
					}
					drafts = dropRepeats(
						drafts.filter((d) => batch.includes(d.page)),
						known.map((k) => k.statement),
						MAX_DRAFTS_PER_PAGE,
					);
				}
				for (const d of drafts) {
					deps.drafts.append({ type: "proposed", draftId: `draft_${newId()}`, documentId: doc.id, page: d.page, proposition: d.proposition, question: d.question, answer: d.answer, at: now() });
				}
				deps.drafts.append({ type: "pages_processed", documentId: doc.id, pages: batch, at: now() });
				proposed += drafts.length;
				handled.push(...batch);
			}
			return { proposed, pages: handled, remaining: todo.length - handled.length, ceilingReached };
		} finally {
			running.delete(doc.id);
		}
	}

	function listDrafts(documentId: string): Draft[] {
		const doc = documentById(documentId);
		return deriveDrafts(deps.drafts.readAll()).filter((d) => d.documentId === doc.id && d.status === "pending");
	}

	/** REQ-study-11: nothing becomes a card or a node without the learner's approval; approval may carry edits. */
	async function decideDrafts(input: {
		approve: Array<{ draftId: string; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }>;
		reject: string[];
	}): Promise<DecideResult> {
		const result: DecideResult = { approved: [], rejected: [], failed: [] };
		const byId = new Map(deriveDrafts(deps.drafts.readAll()).map((d) => [d.id, d] as const));
		for (const item of input.approve) {
			const draft = byId.get(item.draftId);
			if (draft === undefined || draft.status !== "pending") {
				result.failed.push({ draftId: item.draftId, error: "not a pending draft" });
				continue;
			}
			try {
				const doc = documentById(draft.documentId);
				const content = cardContent({
					proposition: item.proposition ?? draft.proposition,
					question: item.question ?? draft.question,
					answer: item.answer ?? draft.answer,
				});
				const edited = content.proposition !== draft.proposition || content.question !== draft.question || content.answer !== draft.answer;
				const done = await attach(doc, draft.page, content, edited ? "user" : "agent", item.pin !== false);
				deps.drafts.append({ type: "decided", draftId: draft.id, decision: "approved", at: now() });
				result.approved.push({ draftId: draft.id, ...done });
			} catch (e) {
				if (!(e instanceof HttpError)) throw e;
				result.failed.push({ draftId: item.draftId, error: e.message });
			}
		}
		for (const draftId of input.reject) {
			const draft = byId.get(draftId);
			if (draft === undefined || draft.status !== "pending") {
				result.failed.push({ draftId, error: "not a pending draft" });
				continue;
			}
			deps.drafts.append({ type: "decided", draftId, decision: "rejected", at: now() });
			result.rejected.push(draftId);
		}
		return result;
	}

	// ─── goal from a document (umbrella REQ-goal-01) ───────────────────────

	function startGoal(input: { documentId: string; title: unknown; statement: unknown }): { goalId: string } {
		const doc = documentById(input.documentId);
		const goal = deps.createGoal({ title: text(input.title, "title", 200), statement: text(input.statement, "statement", MAX_PROPOSITION_CHARS), originRef: doc.id });
		return { goalId: goal.id };
	}

	return { registerDocument, listDocuments, open, pdfFile, recordReading, toolContext, draftCard, confirmCard, complete, listDrafts, decideDrafts, startGoal };
}

export type StudyService = ReturnType<typeof createStudyService>;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-service.test.ts tests/ext-study-complete.test.ts`
Expected: `ℹ tests 44`, `ℹ pass 44`, `ℹ fail 0` (26 + 18).

- [ ] **Step 6: Type check and lint the new files**

Run: `npx tsc --noEmit && npx eslint src/server/ext/study-service.ts tests/helpers/study-fakes.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/server/ext/study-service.ts tests/helpers/study-fakes.ts tests/ext-study-service.test.ts tests/ext-study-complete.test.ts
git commit -m "feat(ext): study service" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The `study` session kind, request parsing and live wiring

REQ-mode-01 (the kind), REQ-study-04 (a study chat is a real chat the agent serves), REQ-study-12 (practice-like: no chat-level extraction). This task contains the upstream touchpoints in `src/`. It also adds `study-input.ts` (request-body parsing for the routes), `study-engine.ts` (the teacher-slot engine, kept apart from `lecture-live.ts` so `chat-handler.ts` never imports back into itself) and `study-live.ts` (the only wiring file).

**Files:**
- Create: `src/server/ext/study-input.ts`, `src/server/ext/study-engine.ts`, `src/server/ext/study-live.ts`
- Modify: `src/core/contracts/chat.ts`, `src/core/ports.ts`, `src/store/chats.ts`, `src/core/ext/practice/session-kind.ts`, `src/server/chat-handler.ts`, `src/server/ext/index.ts`, `app/chat/[id]/page.tsx`
- Test: `tests/ext-study-kind.test.ts`, `tests/ext-study-input.test.ts`; update `tests/ext-session-kind.test.ts`, `tests/ext-practice-like-sites.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/ext-study-kind.test.ts`

```typescript
// tests/ext-study-kind.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { isPracticeLike } from "../src/core/index.ts";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind study (REQ-mode-01, REQ-study-04, REQ-study-12)", () => {
	it("createChat(kind: 'study') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Study: Probability", "study");
		assert.equal(chat.kind, "study");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "study");
	});
	it("the other kinds are unchanged", () => {
		assert.equal(chatStore.createChat("o", "office_hours").kind, "office_hours");
		assert.equal(chatStore.createChat("r", "review").kind, "review");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
	it("a study session is practice-like: the chat-level extraction never runs on it, so only confirmed propositions reach the graph", () => {
		assert.equal(isPracticeLike("study"), true);
		for (const k of ["teach", undefined, "other"]) assert.equal(isPracticeLike(k), false, String(k));
	});
});
```

`tests/ext-study-input.test.ts`

```typescript
// tests/ext-study-input.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecision, requireString } from "../src/server/ext/study-input.ts";
import { StudyError } from "../src/server/ext/study-service.ts";

const bad = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof StudyError && e.status === 400 && re.test(e.message));

describe("study request parsing", () => {
	it("requireString returns a non-empty string and refuses anything else", () => {
		assert.equal(requireString({ documentId: "abc" }, "documentId"), "abc");
		bad(() => requireString({ documentId: "" }, "documentId"), /documentId is required/);
		bad(() => requireString({ documentId: 7 }, "documentId"), /documentId is required/);
		bad(() => requireString({}, "documentId"), /documentId is required/);
	});
	it("parseDecision keeps edits and defaults to empty lists", () => {
		assert.deepEqual(parseDecision({}), { approve: [], reject: [] });
		assert.deepEqual(parseDecision({ approve: [{ draftId: "d1", question: "Q?", extra: 1 }], reject: ["d2"] }), {
			approve: [{ draftId: "d1", proposition: undefined, question: "Q?", answer: undefined, pin: undefined }],
			reject: ["d2"],
		});
	});
	it("parseDecision refuses non-lists, items without a draftId, non-string rejections and huge requests", () => {
		bad(() => parseDecision({ approve: "d1" }), /must be lists/);
		bad(() => parseDecision({ approve: [{}] }), /needs a draftId/);
		bad(() => parseDecision({ approve: [null] }), /needs a draftId/);
		bad(() => parseDecision({ reject: [3] }), /listed by draftId/);
		bad(() => parseDecision({ reject: Array.from({ length: 201 }, (_, i) => `d${i}`) }), /too many/);
	});
});
```

In `tests/ext-session-kind.test.ts`, replace the first test with:

```ts
test("isPracticeLike: practice, review, office_hours and study are practice-like", () => {
	for (const k of ["practice", "review", "office_hours", "study"]) assert.equal(isPracticeLike(k), true, k);
});
```

In `tests/ext-practice-like-sites.test.ts`, replace the test title and the `kinds` line with:

```ts
it("chain source directory hides practice, review, office_hours and study sessions", () => {
	const kinds = ["practice", "review", "office_hours", "study", "teach"] as const;
```

- [ ] **Step 2: Run them to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-kind.test.ts tests/ext-study-input.test.ts tests/ext-session-kind.test.ts tests/ext-practice-like-sites.test.ts`
Expected: FAIL (`createChat("...", "study")` is a type error at runtime as `kind` is dropped: `chat.kind` is `undefined`; `isPracticeLike("study")` is `false`; `Cannot find module '../src/server/ext/study-input.ts'`).

- [ ] **Step 3: Widen the kind (touchpoints, one token each)**

`src/core/contracts/chat.ts`:

```ts
export type ChatKind = "teach" | "practice" | "review" | "office_hours" | "study";
```

`src/core/ports.ts` (the `ChatStore` interface):

```ts
	createChat(title: string, kind?: "practice" | "review" | "office_hours" | "study"): ChatRecord;
```

`src/store/chats.ts`:

```ts
function createChat(title: string, kind?: "practice" | "review" | "office_hours" | "study"): ChatRecord {
```

`src/core/ext/practice/session-kind.ts` (replace the file content):

```ts
// src/core/ext/practice/session-kind.ts
import type { ChatKind } from "../../contracts/chat.ts";

/**
 * Sessions that write nothing to the graph and compact like practice:
 * `practice` plus the extension's `review`, `office_hours` and `study` kinds.
 * The single definition; layers import it instead of re-testing the kinds.
 */
export const isPracticeLike = (kind: ChatKind | string | undefined): boolean =>
	kind === "practice" || kind === "review" || kind === "office_hours" || kind === "study";
```

`app/chat/[id]/page.tsx`, the `kind=` prop of `<Chat>`:

```tsx
			kind={chat.kind === "review" || chat.kind === "office_hours" || chat.kind === "study" ? "teach" : (chat.kind ?? "teach")}
```

- [ ] **Step 4: Write the three server files**

`src/server/ext/study-input.ts`

```typescript
// src/server/ext/study-input.ts
/** Request-body parsing for the study routes. Anything malformed is a 400 StudyError. */

import { StudyError } from "./study-service.ts";

export function requireString(body: Record<string, unknown>, field: string): string {
	const v = body[field];
	if (typeof v !== "string" || v === "") throw new StudyError(400, `${field} is required`);
	return v;
}

export interface Decision {
	approve: Array<{ draftId: string; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }>;
	reject: string[];
}

/** { approve?: [{draftId, proposition?, question?, answer?, pin?}], reject?: [draftId] } */
export function parseDecision(body: Record<string, unknown>): Decision {
	const approveRaw = body.approve ?? [];
	const rejectRaw = body.reject ?? [];
	if (!Array.isArray(approveRaw) || !Array.isArray(rejectRaw)) throw new StudyError(400, "approve and reject must be lists");
	if (approveRaw.length + rejectRaw.length > 200) throw new StudyError(400, "too many drafts in one request");
	const approve = approveRaw.map((item) => {
		if (typeof item !== "object" || item === null || typeof (item as { draftId?: unknown }).draftId !== "string") {
			throw new StudyError(400, "every approved draft needs a draftId");
		}
		const r = item as Record<string, unknown>;
		return { draftId: r.draftId as string, proposition: r.proposition, question: r.question, answer: r.answer, pin: r.pin };
	});
	const reject = rejectRaw.map((id) => {
		if (typeof id !== "string") throw new StudyError(400, "rejected drafts are listed by draftId");
		return id;
	});
	return { approve, reject };
}
```

`src/server/ext/study-engine.ts`

```typescript
// src/server/ext/study-engine.ts
/**
 * The teacher-slot engine and the writer dependencies of the study stage's
 * background model work. Kept apart from lecture-live.ts so that the chat
 * handler (which imports practice-live.ts) never imports back into itself.
 */

import type { WriterDeps } from "../../agent/ext/lecture/writers.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { ROLE_SLOT } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { stores } from "../stores.ts";
import { liveCostGate, livePriceStep } from "./cost-live.ts";

/** The teacher slot's engine, fresh per run (a settings change lands immediately). Throws with a readable reason. */
export function teacherEngine(): PiEngine {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new Error("lectures and exercises need a model for the teacher role: configure the models in settings");
	if (!providerKeyPresent(spec.provider)) throw new Error(`no API key for provider ${spec.provider}`);
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.teacher]?.cacheRetention);
}

export const writerDeps = (): WriterDeps => ({ engine: teacherEngine(), gate: liveCostGate, priceStep: livePriceStep });
```

`src/server/ext/study-live.ts`

```typescript
// src/server/ext/study-live.ts
/**
 * Composition of the assisted-study stage: the live stores, the teacher-slot
 * engine for the two drafting calls, the shared cost gate, and upstream's
 * notes import for confirmed propositions. Only wiring; the logic is in
 * study-service.ts.
 *
 * chat-handler.ts imports this module (the `study` session's agent), and the
 * notes import lives in chat-handler.ts, so the import goes through a dynamic
 * import() at call time: no static cycle.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { draftCard, proposePageDrafts } from "../../agent/ext/study/draft-writer.ts";
import { readDocumentPages } from "../../agent/ext/study/pdf-pages.ts";
import { emit } from "../../core/events.ts";
import { getGraph } from "../../core/graph.ts";
import { createGoal } from "../../core/ext/goal-service.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { approveCard, createUserCard, proposeAgentCard, setPinned } from "../../core/ext/review-service.ts";
import type { CandidateNode } from "../../core/ext/study/card-node.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";
import { createStudyService } from "./study-service.ts";

const sourceIdOf = (filePath: string): string => `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

const reviewDeps = () => ({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	reviewStore: extStores.reviewStore,
	cardsStore: extStores.cardsStore,
});

const candidates = (pick: (n: ReturnType<typeof getGraph>["nodes"][number]) => boolean): CandidateNode[] =>
	getGraph(stores.graphStore)
		.nodes.filter(pick)
		.map((n) => ({ id: n.id, name: n.name, statement: n.statement, aliases: n.aliases }));

/** A card drafted on the learner's request is not blocked by the daily ceiling (it is spend, so it is still recorded). */
const userInitiatedGate = { allowed: () => true, record: liveCostGate.record };

export const studyService = createStudyService({
	documents: extStores.documentsLedger,
	reading: extStores.readingLedger,
	links: extStores.studyLinksLedger,
	drafts: extStores.studyDraftsLedger,
	files: extStores.documentFiles,
	readFile: async (p) => new Uint8Array(await fs.readFile(p)),
	readPages: readDocumentPages,
	library: createSourceLibrary(extStores.sourcesStore),
	gate: liveCostGate,
	createSession: (title) => stores.chatStore.createChat(title, "study"),
	writers: {
		draftCard: (input) => draftCard({ ...writerDeps(), gate: userInitiatedGate }, input),
		proposePageDrafts: (input) => proposePageDrafts(writerDeps(), input),
	},
	nodesByIds: (ids) => {
		const want = new Set(ids);
		return candidates((n) => want.has(n.id));
	},
	importProposition: async ({ filePath, text }) => {
		const { extraction } = await import("../chat-handler.ts");
		sourceDirectory.registerImport(filePath);
		try {
			await extraction.importNotes({ filePath, text });
		} finally {
			emit("sources-changed", {});
		}
	},
	nodesFromSource: (filePath) => {
		const id = sourceIdOf(filePath);
		return candidates((n) => n.provenance.some((p) => p.chatId === id));
	},
	cards: {
		createUser: (input) => createUserCard(input, reviewDeps()),
		proposeAgent: (input) => proposeAgentCard(input, reviewDeps()),
		approve: (cardId) => approveCard(cardId, reviewDeps()),
		pin: (nodeId) => setPinned(nodeId, true, reviewDeps()),
	},
	createGoal: ({ title, statement, originRef }) =>
		createGoal({ title, statement, origin: "pdf", originRef }, { graphStore: stores.graphStore, goalsStore: extStores.goalsStore }),
});

/** The stored PDF of a document, for the viewer. Throws StudyError 404 for an unknown document. */
export function readStudyPdf(documentId: string): Buffer {
	return readFileSync(studyService.pdfFile(documentId));
}
```

- [ ] **Step 5: The server barrel and the chat-handler branch**

`src/server/ext/index.ts`, after `export * from "./practice-live.ts";`:

```ts
export * from "./study-live.ts";
export { StudyError } from "./study-service.ts";
export { parseDecision, requireString } from "./study-input.ts";
```

`src/server/chat-handler.ts`, two imports (next to the `createReviewAgent` and `practiceService` imports):

```ts
import { createStudyAgent } from "../agent/ext/study/study-agent.ts";
```

```ts
import { studyService } from "./ext/study-live.ts";
```

and the agent branch, placed right after the `office_hours` branch and before the `review` branch:

```ts
		: record.kind === "study"
			? createStudyAgent(studyService.toolContext(chatId, stores.chatStore), agentOpts)
```

(The surrounding chain is `record.kind === "office_hours" ? createOfficeHoursAgent(...) : <your branch> : record.kind === "review" ? ...`; keep the `:` before each branch.)

- [ ] **Step 6: Run the tests, the type check and the lint**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-kind.test.ts tests/ext-study-input.test.ts tests/ext-session-kind.test.ts tests/ext-practice-like-sites.test.ts && npx tsc --noEmit && npx eslint src/server src/core/ext src/store`
Expected: `ℹ tests 9` (3 + 3 + 2 + 1), `ℹ pass 9`, `ℹ fail 0`; `tsc` and ESLint print nothing. If ESLint reports a layering error on `study-live.ts`, the dynamic `import("../chat-handler.ts")` is the sanctioned way around the cycle; do not turn it into a static import.

- [ ] **Step 7: Commit**

```bash
git add src/core src/store src/server app/chat tests/ext-study-kind.test.ts tests/ext-study-input.test.ts tests/ext-session-kind.test.ts tests/ext-practice-like-sites.test.ts
git commit -m "feat(ext): study session kind, request parsing and live wiring" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: "Source in your documents" in the node panel

REQ-study-10: a node's panel shows the document and page it came from and opens the document there. The panel already has a reserved provider seam (`panel-providers.ts`); this adds one member to the sources type, one line to the builder, one provider, and one section to the view.

**Files:**
- Modify: `src/core/ext/node-panel-types.ts`, `src/core/ext/node-panel.ts`, `src/server/ext/panel-providers.ts`, `components/ext/node-panel-view.tsx`
- Test: `tests/ext-study-panel.test.ts` (new); update `tests/ext-node-panel.test.ts`, `tests/ext-node-panel-ui.test.tsx`

- [ ] **Step 1: Write the failing tests**

`tests/ext-study-panel.test.ts`

```typescript
// tests/ext-study-panel.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-panel-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { extStores } = await import("../src/server/ext/stores.ts");
const { panelSources } = await import("../src/server/ext/panel-providers.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DOC = "c".repeat(64);
const AT = "2026-11-04T10:00:00.000Z";

describe("study sources in the node panel (REQ-study-10)", () => {
	it("lists the document title and page a node came from", () => {
		extStores.documentsLedger.append({ type: "registered", documentId: DOC, title: "Probability", pageCount: 200, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 12, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 12, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 40, at: AT });
		assert.deepEqual(panelSources.studySources?.("n_a"), [
			{ documentId: DOC, title: "Probability", page: 12 },
			{ documentId: DOC, title: "Probability", page: 40 },
		]);
	});
	it("lists none for a node without links, and skips a link to a document that is not registered", () => {
		assert.deepEqual(panelSources.studySources?.("n_none"), []);
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_orphan", documentId: "e".repeat(64), page: 1, at: AT });
		assert.deepEqual(panelSources.studySources?.("n_orphan"), []);
	});
});
```

In `tests/ext-node-panel.test.ts`: in the test that asserts the empty panel, replace the `deepEqual` of `citingLectures, cards, review, goals` with:

```ts
		assert.deepEqual([p?.citingLectures, p?.studySources, p?.cards, p?.review, p?.goals], [[], [], [], null, []]);
```

and in the test with full sources, add `studySources` after `lecturesCiting`, and one assertion after the `citingLectures` assertion:

```ts
				studySources: () => [{ documentId: "d1", title: "Probability", page: 12 }],
```

```ts
		assert.deepEqual(p?.studySources, [{ documentId: "d1", title: "Probability", page: 12 }]);
```

In `tests/ext-node-panel-ui.test.tsx`: in the `data()` fixture add, after `citingLectures`:

```ts
		studySources: [{ documentId: "d".repeat(64), title: "Probability", page: 12 }],
```

and add this test after the explanation "no source context" test:

```tsx
it("shows where in the learner's documents the node came from, linking to that page (REQ-study-10)", async () => {
	await mount(props());
	const link = q('[data-testid="panel-study-sources"] a');
	assert.equal(link?.textContent, "Probability, p. 12");
	assert.equal(link?.getAttribute("href"), `/study/${"d".repeat(64)}?page=12`);
	await act(async () => { root!.render(<NodePanelView {...props({ data: data({ studySources: [] }) })} />); });
	assert.match(q('[data-testid="panel-study-sources"]')?.textContent ?? "", /None\./);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-panel.test.ts tests/ext-node-panel.test.ts tests/ext-node-panel-ui.test.tsx`
Expected: FAIL (`panelSources.studySources` is not a function; `p.studySources` is `undefined`; no element `panel-study-sources`).

- [ ] **Step 3: Implement**

`src/core/ext/node-panel-types.ts`: add the type before `PanelCard`, the optional provider in `PanelSources`, and the field in the panel data:

```ts
/** A page of a registered document the node came from (assisted study, REQ-study-10). */
export interface PanelStudySource {
	documentId: string;
	title: string;
	page: number;
}
```

```ts
	studySources?(nodeId: string): PanelStudySource[];
```

(in `PanelSources`, after `lecturesCiting?`) and

```ts
	/** Where in the learner's documents the node came from (study-links), with the document's title. */
	studySources: PanelStudySource[];
```

(in the panel data interface, after `citingLectures`).

`src/core/ext/node-panel.ts`, in the object returned by `buildNodePanel`, after `citingLectures`:

```ts
		studySources: input.sources.studySources?.(nodeId) ?? [],
```

`src/server/ext/panel-providers.ts`: two imports and one provider (after `lecturesCiting`):

```ts
import { deriveDocuments } from "../../core/ext/study/documents.ts";
import { sourcesOfNode } from "../../core/ext/study/links.ts";
```

```ts
	studySources: (nodeId) => {
		const docs = deriveDocuments(extStores.documentsLedger.readAll());
		return sourcesOfNode(extStores.studyLinksLedger.readAll(), nodeId).flatMap((s) => {
			const doc = docs.find((d) => d.id === s.documentId);
			return doc === undefined ? [] : [{ documentId: doc.id, title: doc.title, page: s.page }];
		});
	},
```

`components/ext/node-panel-view.tsx`, a new section after "Lectures that cite it":

```tsx
			<Section title="Source in your documents" testId="panel-study-sources">
				{data.studySources.length === 0 ? (
					<p className="text-muted-foreground">None.</p>
				) : (
					data.studySources.map((s) => (
						<p key={`${s.documentId}:${s.page}`}>
							<a className="underline" href={`/study/${s.documentId}?page=${s.page}`}>
								{s.title}, p. {s.page}
							</a>
						</p>
					))
				)}
			</Section>
```

- [ ] **Step 4: Run the tests, the type check and the lint**

Run: `NODE_ENV=test npx tsx --test tests/ext-study-panel.test.ts tests/ext-node-panel.test.ts tests/ext-node-panel-ui.test.tsx && npx tsc --noEmit && npx eslint src/core/ext src/server/ext components/ext`
Expected: `ℹ tests 26` (2 + 11 + 13), `ℹ pass 26`, `ℹ fail 0`; no `tsc` or ESLint output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/node-panel-types.ts src/core/ext/node-panel.ts src/server/ext/panel-providers.ts components/ext/node-panel-view.tsx tests/ext-study-panel.test.ts tests/ext-node-panel.test.ts tests/ext-node-panel-ui.test.tsx
git commit -m "feat(ext): node panel shows where a node came from in the learner's documents" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: HTTP routes

Thin routes over `studyService` (no logic of their own; errors go through `httpErrorResponse`). There is no unit test for a route file in this fork (the service tests cover the behaviour); the check here is type and lint, and Task 17's smoke exercises them through the browser. `/api` requests need the desktop capability header (`proxy.ts`), which the browser sends on its own same-origin calls in the running app.

| Route | Body / query | Result |
|---|---|---|
| `GET /api/ext/study/documents` | | `{documents}` with reading summary |
| `POST /api/ext/study/documents` | `{path, title?}` | 201 the document |
| `POST /api/ext/study/documents/[id]` | | `{document, chatId, page, readPages}` (opens or resumes the one conversation) |
| `GET /api/ext/study/documents/[id]/pdf` | | the stored bytes, `application/pdf` |
| `POST /api/ext/study/reading` | `{documentId, kind: "visit"\|"close", page?}` | 204 |
| `POST /api/ext/study/cards` | `{action: "draft"\|"confirm", ...}` | `{proposition, question, answer}`, or `{cardId, nodeId, nodeIds}` |
| `GET /api/ext/study/drafts?documentId=` | | `{drafts}` pending |
| `POST /api/ext/study/drafts` | `{action: "complete"\|"decide", ...}` | the run summary, or the decision outcome |
| `POST /api/ext/study/goal` | `{documentId, title, statement}` | the goal |

**Files:**
- Create: the seven route files under `app/api/ext/study/`

- [ ] **Step 1: Write the routes**

`app/api/ext/study/documents/route.ts`

```typescript
import { httpErrorResponse, readJsonObject, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** The registered documents with their reading summary. */
export async function GET() {
	return Response.json({ documents: studyService.listDocuments() });
}

/** POST { path, title? }: registers the PDF at an absolute local path (REQ-study-01). → 201 the document. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(await studyService.registerDocument({ path: body.path, title: body.title }), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/documents/[id]/route.ts`

```typescript
import { httpErrorResponse, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** Opens a document: creates its one conversation the first time (REQ-study-05). → { document, chatId, page, readPages }. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json(await studyService.open(id));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/documents/[id]/pdf/route.ts`

```typescript
import { httpErrorResponse, readStudyPdf } from "@/src/server";

export const dynamic = "force-dynamic";

/** The stored copy of the document's PDF, for the viewer. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const bytes = readStudyPdf(id);
		return new Response(new Uint8Array(bytes), {
			headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=3600" },
		});
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/reading/route.ts`

```typescript
import { httpErrorResponse, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { documentId, kind: "visit", page } or { documentId, kind: "close" } (REQ-study-03). → 204. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const documentId = requireString(body, "documentId");
		if (body.kind !== "visit" && body.kind !== "close") throw new StudyError(400, 'kind must be "visit" or "close"');
		studyService.recordReading({ documentId, kind: body.kind, page: body.page });
		return new Response(null, { status: 204 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/cards/route.ts`

```typescript
import { httpErrorResponse, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST { action: "draft", documentId, page, selection? } → the model's { proposition, question, answer } (REQ-study-08).
 * POST { action: "confirm", documentId, page, proposition, question, answer, pin? } → { cardId, nodeId, nodeIds } (REQ-study-09, 10).
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const documentId = requireString(body, "documentId");
		if (body.action === "draft") return Response.json(await studyService.draftCard({ documentId, page: body.page, selection: body.selection }));
		if (body.action === "confirm") {
			return Response.json(
				await studyService.confirmCard({
					documentId,
					page: body.page,
					proposition: body.proposition,
					question: body.question,
					answer: body.answer,
					pin: body.pin,
				}),
			);
		}
		throw new StudyError(400, 'action must be "draft" or "confirm"');
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/drafts/route.ts`

```typescript
import { httpErrorResponse, parseDecision, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?documentId=…: the pending drafts of a document. */
export async function GET(req: Request) {
	try {
		const documentId = new URL(req.url).searchParams.get("documentId") ?? "";
		if (documentId === "") throw new StudyError(400, "documentId is required");
		return Response.json({ drafts: studyService.listDrafts(documentId) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/**
 * POST { action: "complete", documentId }: proposes drafts for pages read and not yet processed (REQ-study-11, 13).
 * POST { action: "decide", approve?, reject? }: the batch approval. Nothing is written to the graph before this.
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		if (body.action === "complete") return Response.json(await studyService.complete(requireString(body, "documentId")));
		if (body.action === "decide") return Response.json(await studyService.decideDrafts(parseDecision(body)));
		throw new StudyError(400, 'action must be "complete" or "decide"');
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

`app/api/ext/study/goal/route.ts`

```typescript
import { httpErrorResponse, readJsonObject, requireString, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { documentId, title, statement }: starts a goal from a document (umbrella REQ-goal-01). → { goalId }. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(studyService.startGoal({ documentId: requireString(body, "documentId"), title: body.title, statement: body.statement }), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
```

- [ ] **Step 2: Type check and lint**

Run: `npx tsc --noEmit && npx eslint app/api/ext/study`
Expected: no output. (`app/` imports only `@/src/server`; ESLint fails the build otherwise.)

- [ ] **Step 3: Commit**

```bash
git add app/api/ext/study
git commit -m "feat(ext): study HTTP routes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Click on a citation (browser helper)

REQ-study-07: `(p. N)` in the conversation moves the viewer. The agent writes plain text, so the helper finds the citation under a click from the caret position instead of changing how upstream renders messages.

**Files:**
- Create: `components/ext/citation-click.ts`
- Test: `tests/ext-citation-click.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-citation-click.test.ts`

```typescript
// tests/ext-citation-click.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageAtCaret, pageFromPoint } from "../components/ext/citation-click.ts";

const text = (s: string) => ({ nodeType: 3, textContent: s });
const S = "Defined on (p. 12), proved later.";

describe("page citation under a click (REQ-study-07)", () => {
	it("finds the page from a caret inside the citation", () => {
		const at = S.indexOf("(p. 12)");
		assert.equal(pageAtCaret(text(S), at + 3), 12);
		assert.equal(pageAtCaret(text(S), at), 12);
	});
	it("accepts the caret just after the closing parenthesis", () => {
		assert.equal(pageAtCaret(text(S), S.indexOf("(p. 12)") + "(p. 12)".length), 12);
	});
	it("is null elsewhere, for an element node and for no node", () => {
		assert.equal(pageAtCaret(text(S), 2), null);
		assert.equal(pageAtCaret(text(S), S.length), null);
		assert.equal(pageAtCaret({ nodeType: 1, textContent: S }, 12), null);
		assert.equal(pageAtCaret(null, 0), null);
	});
	it("pageFromPoint reads the caret range of the document, and is null when the browser has none", () => {
		const doc = { caretRangeFromPoint: () => ({ startContainer: text(S), startOffset: 14 }) } as unknown as Document;
		assert.equal(pageFromPoint(doc, 1, 1), 12);
		assert.equal(pageFromPoint({} as Document, 1, 1), null);
		assert.equal(pageFromPoint({ caretRangeFromPoint: () => null } as unknown as Document, 1, 1), null);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-citation-click.test.ts`
Expected: FAIL, `Cannot find module '../components/ext/citation-click.ts'`.

- [ ] **Step 3: Implement**

`components/ext/citation-click.ts`

```typescript
/**
 * Clickable page citations (REQ-study-07). The agent writes `(p. N)` as plain
 * text; the study view finds the citation under a click from the caret
 * position, so no change to how upstream renders messages is needed.
 */

import { citationAt } from "@/src/core";

/** The page cited at a caret position inside a text node, or null. A click on the right half of the closing parenthesis puts the caret just after it, so the previous character counts too. */
export function pageAtCaret(node: { nodeType: number; textContent: string | null } | null, offset: number): number | null {
	if (node === null || node.nodeType !== 3) return null;
	const text = node.textContent ?? "";
	return citationAt(text, offset) ?? (offset > 0 ? citationAt(text, offset - 1) : null);
}

/** The page cited under a viewport point, or null. */
export function pageFromPoint(doc: Document, x: number, y: number): number | null {
	const range = doc.caretRangeFromPoint?.(x, y);
	return range ? pageAtCaret(range.startContainer, range.startOffset) : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-citation-click.test.ts`
Expected: `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add components/ext/citation-click.ts tests/ext-citation-click.test.ts
git commit -m "feat(ext): clickable page citations" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The PDF viewer component

REQ-study-04 (the PDF beside the conversation) and the text layer that makes REQ-study-06's selection possible. `pdfjs-dist` 6.3.289 API, checked against the installed package: `getDocument({data})` returns a loading task (its `destroy()` releases the document; `PDFDocumentProxy.destroy` does not exist in v6), `page.render({canvas, viewport, transform})`, `new TextLayer({textContentSource, container, viewport})`. The text layer needs the `--total-scale-factor` CSS variable and `pdfjs-dist/web/pdf_viewer.css`. The library is imported dynamically inside an effect so it never runs on the server, and the worker comes from `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`, which Turbopack bundles.

There is no unit test: this is DOM and canvas code that needs a real PDF engine. It was exercised in a throwaway Electron window and compiled by a scratch Turbopack build. Task 17's smoke is the acceptance check.

**Files:**
- Create: `components/ext/pdf-viewer.tsx`

- [ ] **Step 1: Write the component**

`components/ext/pdf-viewer.tsx`

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfJs = typeof import("pdfjs-dist");
type LoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;

let pdfjsPromise: Promise<PdfJs> | null = null;
/** pdf.js is loaded on first use, in the browser only (the module touches DOM globals at load time). */
function loadPdfjs(): Promise<PdfJs> {
	pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
		lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return lib;
	});
	return pdfjsPromise;
}

/**
 * One page of a stored PDF: a canvas for the picture and a transparent text
 * layer above it, so the learner can select text (REQ-study-04, 08). The page
 * is a prop; navigation controls belong to the parent.
 */
export function PdfViewer({ documentId, page, onError }: { documentId: string; page: number; onError?: (message: string) => void }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textRef = useRef<HTMLDivElement>(null);
	const [doc, setDoc] = useState<PdfDocument | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

	// Load the document once per id.
	useEffect(() => {
		let cancelled = false;
		let task: LoadingTask | null = null;
		setDoc(null);
		setStatus("loading");
		void (async () => {
			try {
				const [lib, res] = await Promise.all([loadPdfjs(), fetch(`/api/ext/study/documents/${documentId}/pdf`)]);
				if (!res.ok) throw new Error(`the PDF could not be loaded (${res.status})`);
				const data = new Uint8Array(await res.arrayBuffer());
				task = lib.getDocument({ data });
				const loaded = await task.promise;
				if (!cancelled) setDoc(loaded);
			} catch (e) {
				if (cancelled) return;
				setStatus("failed");
				onError?.(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
			void task?.destroy();
		};
	}, [documentId, onError]);

	// Draw the current page.
	useEffect(() => {
		if (doc === null) return;
		let cancelled = false;
		let cancelRender: (() => void) | null = null;
		void (async () => {
			try {
				const lib = await loadPdfjs();
				const pdfPage = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
				const host = hostRef.current;
				const canvas = canvasRef.current;
				const textLayer = textRef.current;
				if (cancelled || !host || !canvas || !textLayer) return;
				const scale = (host.clientWidth || 800) / pdfPage.getViewport({ scale: 1 }).width;
				const viewport = pdfPage.getViewport({ scale });
				const dpr = window.devicePixelRatio || 1;
				canvas.width = Math.floor(viewport.width * dpr);
				canvas.height = Math.floor(viewport.height * dpr);
				canvas.style.width = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;
				textLayer.replaceChildren();
				textLayer.style.width = `${viewport.width}px`;
				textLayer.style.height = `${viewport.height}px`;
				textLayer.style.setProperty("--total-scale-factor", String(scale));
				const render = pdfPage.render({ canvas, viewport, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) });
				const layer = new lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textLayer, viewport });
				cancelRender = () => {
					render.cancel();
					layer.cancel();
				};
				await Promise.all([render.promise, layer.render()]);
				if (!cancelled) setStatus("ready");
			} catch (e) {
				if (cancelled || (e as { name?: string })?.name === "RenderingCancelledException") return;
				setStatus("failed");
				onError?.(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
			cancelRender?.();
		};
	}, [doc, page, onError]);

	return (
		<div ref={hostRef} data-testid="pdf-viewer" className="relative w-full overflow-auto">
			{status === "loading" ? <p className="p-4 text-sm text-muted-foreground">Loading the document…</p> : null}
			{status === "failed" ? <p className="p-4 text-sm text-destructive">The PDF could not be shown.</p> : null}
			<div className="relative" style={{ display: status === "failed" ? "none" : "block" }}>
				<canvas ref={canvasRef} className="block" />
				<div ref={textRef} className="textLayer" data-testid="pdf-text-layer" />
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Type check and lint**

Run: `npx tsc --noEmit && npx eslint components/ext/pdf-viewer.tsx`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/ext/pdf-viewer.tsx
git commit -m "feat(ext): PDF viewer with a text layer" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The study screens and the one `chat.tsx` seam

REQ-study-03 (the view reports page visits and closes), REQ-study-04, REQ-study-06 (page and selection attached to every message), REQ-study-07 (citation click), REQ-study-08 (card from selection, page, or written by hand; the learner edits and confirms), REQ-study-11 (Complete button and the drafts list with approve and reject), REQ-goal-01 (start a goal from the document). The layout is functional only; the visual design belongs to the UI session (non-goal of the spec).

`components/chat.tsx` gains one optional prop, `transformOutgoing`, applied where a composer send and a steer leave the browser. It is the only way to prepend the context line without forking the composer. The `[study-context]` line is therefore visible in the transcript as the first line of each of the learner's messages; hiding it is UI-session work.

**Files:**
- Create: `components/ext/study-home.tsx`, `components/ext/study-view.tsx`, `app/study/page.tsx`, `app/study/[documentId]/page.tsx`
- Modify: `components/chat.tsx`

- [ ] **Step 1: The `chat.tsx` seam**

In the props destructuring, after `kind = "teach",` add `transformOutgoing,`:

```tsx
	kind = "teach",
	transformOutgoing,
}: {
```

In the props type, after the `initialConfigured?: boolean;` member add:

```tsx
	/** Extension seam (docs/ext/TOUCHPOINTS.md): rewrites the text of a composer send or steer just before it is sent. The study view uses it to prepend the page and the selection. */
	transformOutgoing?: (text: string) => string;
```

In `doSend`, replace `void send({ type: "text", text: t });` with:

```tsx
		void send({ type: "text", text: transformOutgoing ? transformOutgoing(t) : t });
```

In `doSteerOrSend`, replace `void steer(t);` with:

```tsx
			void steer(transformOutgoing ? transformOutgoing(t) : t);
```

- [ ] **Step 2: The home page and the document page**

`components/ext/study-home.tsx`

```tsx
"use client";

import Link from "next/link";
import { useState } from "react";

interface DocumentRow {
	id: string;
	title: string;
	pageCount: number;
	lastPage: number | null;
	readCount: number;
}

/** The list of registered documents and the form that registers a PDF from a local path (REQ-study-01). */
export function StudyHome({ initial }: { initial: DocumentRow[] }) {
	const [documents, setDocuments] = useState(initial);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function register() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/ext/study/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path.trim() }) });
			const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			if (!res.ok) {
				setError(typeof json.error === "string" ? json.error : "Request failed.");
				return;
			}
			const list = await fetch("/api/ext/study/documents");
			if (list.ok) setDocuments(((await list.json()) as { documents: DocumentRow[] }).documents);
			setPath("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Add a PDF</h2>
				<p className="text-sm text-muted-foreground">Paste the full path of a PDF on this computer. A copy is stored and the PDF becomes a primary source for checking what you learn from it.</p>
				<input className="rounded border px-2 py-1" placeholder="/Users/you/Books/probability.pdf" value={path} onChange={(e) => setPath(e.target.value)} />
				<button type="button" className="self-start rounded border px-3 py-1" disabled={busy || path.trim() === ""} onClick={() => void register()}>
					{busy ? "Reading the PDF…" : "Add"}
				</button>
				{error !== null ? <p className="text-destructive">{error}</p> : null}
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Your documents</h2>
				{documents.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
				{documents.map((d) => (
					<p key={d.id}>
						<Link className="underline" href={`/study/${d.id}`}>
							{d.title}
						</Link>{" "}
						<span className="text-sm text-muted-foreground">
							{d.pageCount} pages, {d.readCount} read{d.lastPage !== null ? `, last on p. ${d.lastPage}` : ""}
						</span>
					</p>
				))}
			</section>
		</div>
	);
}
```

`app/study/page.tsx`

```tsx
import { StudyHome } from "@/components/ext/study-home";
import { studyService } from "@/src/server";

export const dynamic = "force-dynamic";

export default function StudyPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Study</h1>
			<StudyHome initial={studyService.listDocuments()} />
		</main>
	);
}
```

`app/study/[documentId]/page.tsx`

```tsx
import { notFound } from "next/navigation";
import { StudyView } from "@/components/ext/study-view";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, StudyError, studyService, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function StudyDocumentPage({
	params,
	searchParams,
}: {
	params: Promise<{ documentId: string }>;
	searchParams: Promise<{ page?: string }>;
}) {
	const [{ documentId }, { page }] = await Promise.all([params, searchParams]);
	let opened;
	try {
		opened = await studyService.open(documentId);
	} catch (e) {
		if (e instanceof StudyError && e.status === 404) notFound();
		throw e;
	}
	const chat = getChat(opened.chatId);
	if (!chat) notFound();
	const wanted = Number(page);
	const start = Number.isInteger(wanted) && wanted >= 1 && wanted <= opened.document.pageCount ? wanted : opened.page;
	return (
		<StudyView
			document={{ id: opened.document.id, title: opened.document.title, pageCount: opened.document.pageCount }}
			startPage={start}
			chat={{
				chatId: chat.id,
				title: chat.title,
				initialMessages: chat.messages,
				initialError: turnFailure(chat.id),
				initialConfigured: slotsConfigured(readSettingsRecord()?.models),
				initiallyInFlight: isTurnRunning(chat.id),
				initiallyCompacting: compactionInFlight(chat.id),
			}}
		/>
	);
}
```

- [ ] **Step 3: The study view**

`components/ext/study-view.tsx`

```tsx
"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { encodeStudyContext } from "@/src/core";
import { Chat } from "@/components/chat";
import { pageFromPoint } from "./citation-click";
import { openNodePanel } from "./open-node";
import { PdfViewer } from "./pdf-viewer";

type ChatProps = Pick<
	ComponentProps<typeof Chat>,
	"chatId" | "title" | "initialMessages" | "initialError" | "initialConfigured" | "initiallyInFlight" | "initiallyCompacting"
>;

interface CardForm {
	page: number;
	proposition: string;
	question: string;
	answer: string;
}
interface DraftRow {
	id: string;
	page: number;
	proposition: string;
	question: string;
	answer: string;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
	const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const errorOf = (json: Record<string, unknown>): string => (typeof json.error === "string" ? json.error : "Request failed.");

/**
 * The study session (REQ-study-04): the PDF on the left, the document's one
 * conversation on the right. Every message the learner sends is prefixed with
 * the page and the selection (REQ-study-06); `(p. N)` in the conversation
 * moves the viewer (REQ-study-07). Layout is functional only; the visual
 * design belongs to the UI session.
 */
export function StudyView({ document: doc, startPage, chat }: { document: { id: string; title: string; pageCount: number }; startPage: number; chat: ChatProps }) {
	const [page, setPage] = useState(startPage);
	const [selection, setSelection] = useState("");
	const [form, setForm] = useState<CardForm | null>(null);
	const [pin, setPin] = useState(true);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<DraftRow[]>([]);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [goal, setGoal] = useState({ title: "", statement: "" });
	const chatColumn = useRef<HTMLDivElement>(null);
	const pageRef = useRef(page);
	const selectionRef = useRef(selection);
	pageRef.current = page;
	selectionRef.current = selection;

	// Reading events (REQ-study-03): a visit on every page change, a close when the window is hidden or closed.
	const report = useCallback((body: Record<string, unknown>, keepalive = false) => {
		void fetch("/api/ext/study/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id, ...body }), keepalive }).catch(() => undefined);
	}, [doc.id]);
	useEffect(() => {
		report({ kind: "visit", page });
	}, [page, report]);
	useEffect(() => {
		const onVisibility = () => (document.visibilityState === "hidden" ? report({ kind: "close" }, true) : report({ kind: "visit", page: pageRef.current }));
		const onHide = () => report({ kind: "close" }, true);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onHide);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onHide);
			report({ kind: "close" }, true);
		};
	}, [report]);

	// The selection is sticky: clicking into the composer collapses the browser's selection, but the chip keeps it until sent or cleared.
	useEffect(() => {
		const onSelect = () => {
			const sel = window.getSelection();
			const text = sel?.toString().trim() ?? "";
			const inField = sel?.anchorNode instanceof Node && (sel.anchorNode.parentElement?.closest("textarea,input,[contenteditable='true']") ?? null) !== null;
			if (text !== "" && !inField) setSelection(text);
		};
		document.addEventListener("selectionchange", onSelect);
		return () => document.removeEventListener("selectionchange", onSelect);
	}, []);

	// A click on "(p. N)" in the conversation moves the viewer.
	useEffect(() => {
		const el = chatColumn.current;
		if (!el) return;
		const onClick = (e: MouseEvent) => {
			const cited = pageFromPoint(document, e.clientX, e.clientY);
			if (cited !== null && cited <= doc.pageCount) setPage(cited);
		};
		el.addEventListener("click", onClick);
		return () => el.removeEventListener("click", onClick);
	}, [doc.pageCount]);

	const transformOutgoing = useCallback(
		(text: string) => {
			const out = encodeStudyContext({ documentId: doc.id, page: pageRef.current, selection: selectionRef.current }, text);
			setSelection("");
			return out;
		},
		[doc.id],
	);

	const go = (p: number) => setPage(Math.min(Math.max(1, p), doc.pageCount));

	async function draftCard(from: "selection" | "page") {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "draft", documentId: doc.id, page, ...(from === "selection" ? { selection } : {}) });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setForm({ page, proposition: String(r.json.proposition ?? ""), question: String(r.json.question ?? ""), answer: String(r.json.answer ?? "") });
	}
	async function confirmCard() {
		if (form === null) return;
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "confirm", documentId: doc.id, ...form, pin });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setForm(null);
		setMessage("Card added.");
		if (typeof r.json.nodeId === "string") openNodePanel(r.json.nodeId);
	}
	async function loadDrafts() {
		const res = await fetch(`/api/ext/study/drafts?documentId=${doc.id}`);
		if (res.ok) setDrafts(((await res.json()) as { drafts: DraftRow[] }).drafts);
		setChosen(new Set());
	}
	useEffect(() => void loadDrafts(), []);
	async function complete() {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/drafts", { action: "complete", documentId: doc.id });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setMessage(`${String(r.json.proposed)} draft(s) proposed from ${(r.json.pages as number[]).length} page(s).${r.json.ceilingReached === true ? " The daily cost ceiling was reached: run it again tomorrow for the rest." : ""}`);
		await loadDrafts();
	}
	async function decide(kind: "approve" | "reject") {
		const ids = [...chosen];
		if (ids.length === 0) return;
		setBusy(true);
		const r = await post("/api/ext/study/drafts", { action: "decide", ...(kind === "approve" ? { approve: ids.map((draftId) => ({ draftId, pin })) } : { reject: ids }) });
		setBusy(false);
		if (!r.ok) setMessage(errorOf(r.json));
		else {
			const failed = (r.json.failed as Array<{ error: string }>).length;
			setMessage(`${kind === "approve" ? (r.json.approved as unknown[]).length : (r.json.rejected as unknown[]).length} done${failed > 0 ? `, ${failed} failed` : ""}.`);
		}
		await loadDrafts();
	}
	async function startGoal() {
		const r = await post("/api/ext/study/goal", { documentId: doc.id, ...goal });
		setMessage(r.ok ? "Goal created." : errorOf(r.json));
		if (r.ok) setGoal({ title: "", statement: "" });
	}

	const field = "w-full rounded border px-2 py-1 text-sm";
	return (
		<div className="flex h-dvh min-h-0 w-full" data-testid="study-view">
			<section className="flex min-h-0 w-1/2 flex-col border-r">
				<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
					<strong className="mr-2 truncate">{doc.title}</strong>
					<button type="button" className="rounded border px-2" disabled={page <= 1} onClick={() => go(page - 1)}>‹</button>
					<input aria-label="Page" className="w-14 rounded border px-1 text-center" value={page} onChange={(e) => go(Number(e.target.value) || 1)} />
					<span>/ {doc.pageCount}</span>
					<button type="button" className="rounded border px-2" disabled={page >= doc.pageCount} onClick={() => go(page + 1)}>›</button>
				</header>
				<div className="min-h-0 flex-1 overflow-auto bg-muted/30">
					<PdfViewer documentId={doc.id} page={page} onError={setMessage} />
				</div>
				<div className="max-h-[45%] overflow-auto border-t px-3 py-2 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<button type="button" className="rounded border px-2 py-1" disabled={busy || selection === ""} onClick={() => void draftCard("selection")}>Card from selection</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void draftCard("page")}>Card from page</button>
						<button type="button" className="rounded border px-2 py-1" onClick={() => setForm({ page, proposition: "", question: "", answer: "" })}>Write a card</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void complete()}>Complete</button>
						<label className="flex items-center gap-1"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Add to my review</label>
					</div>
					{selection !== "" ? (
						<p className="mt-2 text-muted-foreground" data-testid="study-selection">
							Selected: “{selection.length > 120 ? `${selection.slice(0, 120)}…` : selection}” <button type="button" className="underline" onClick={() => setSelection("")}>clear</button>
						</p>
					) : null}
					{message !== null ? <p className="mt-2" data-testid="study-message">{message}</p> : null}
					{form !== null ? (
						<div className="mt-2 flex flex-col gap-1" data-testid="study-card-form">
							<p className="text-muted-foreground">Card for page {form.page}. Edit, then confirm: the proposition is added to your graph.</p>
							<label>Proposition<textarea className={field} rows={2} value={form.proposition} onChange={(e) => setForm({ ...form, proposition: e.target.value })} /></label>
							<label>Question<textarea className={field} rows={2} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} /></label>
							<label>Answer<textarea className={field} rows={2} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} /></label>
							<div className="flex gap-2">
								<button type="button" className="rounded border px-3 py-1" disabled={busy} onClick={() => void confirmCard()}>Confirm</button>
								<button type="button" className="rounded border px-3 py-1" onClick={() => setForm(null)}>Cancel</button>
							</div>
						</div>
					) : null}
					{drafts.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1" data-testid="study-drafts">
							<h3 className="font-medium">Proposed cards ({drafts.length})</h3>
							{drafts.map((d) => (
								<label key={d.id} className="flex items-start gap-2">
									<input type="checkbox" checked={chosen.has(d.id)} onChange={(e) => setChosen((prev) => { const next = new Set(prev); if (e.target.checked) next.add(d.id); else next.delete(d.id); return next; })} />
									<span><button type="button" className="underline" onClick={(e) => { e.preventDefault(); go(d.page); }}>p. {d.page}</button> {d.proposition}<br /><span className="text-muted-foreground">{d.question} → {d.answer}</span></span>
								</label>
							))}
							<div className="flex gap-2">
								<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("approve")}>Approve selected</button>
								<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("reject")}>Reject selected</button>
							</div>
						</div>
					) : null}
					<details className="mt-3">
						<summary className="cursor-pointer">Start a goal from this document</summary>
						<div className="mt-1 flex flex-col gap-1">
							<input className={field} placeholder="Goal title" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} />
							<textarea className={field} rows={2} placeholder="The proposition you want to master" value={goal.statement} onChange={(e) => setGoal({ ...goal, statement: e.target.value })} />
							<button type="button" className="self-start rounded border px-3 py-1" disabled={goal.title.trim() === "" || goal.statement.trim() === ""} onClick={() => void startGoal()}>Create goal</button>
						</div>
					</details>
				</div>
			</section>
			<section ref={chatColumn} className="min-h-0 w-1/2 overflow-auto">
				<Chat key={chat.chatId} {...chat} kind="teach" transformOutgoing={transformOutgoing} />
			</section>
		</div>
	);
}
```

- [ ] **Step 4: Type check, lint and the whole component test set**

Run: `npx tsc --noEmit && npx eslint app/study components/ext components/chat.tsx && NODE_ENV=test npx tsx --test tests/ext-*.test.ts tests/ext-*.test.tsx`
Expected: no `tsc` or ESLint output; all tests pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add components/ext/study-home.tsx components/ext/study-view.tsx components/chat.tsx app/study
git commit -m "feat(ext): study screens" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Contracts and touchpoints (REQ-study-14, REQ-port-01)

This task only edits documentation, but it is part of the product: a later rewrite of the core must be able to reproduce these formats from the contract alone. Append the sections below to `docs/ext/CONTRACTS.md` and the rows below to the table in `docs/ext/TOUCHPOINTS.md`. Do not touch other sections. In `TOUCHPOINTS.md`, also delete the sentence "Planned (not yet touched): the PDF viewer and MCP dependencies in `package.json`." only if the MCP half has been done by another plan; otherwise change it to "Planned (not yet touched): the MCP dependency in `package.json`." (the PDF viewer needs no dependency change: `pdfjs-dist` was already installed).

**Files:**
- Modify: `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md`

- [ ] **Step 1: Append to `docs/ext/CONTRACTS.md`**

~~~markdown
## `documents.jsonl` (ledger)

Event `registered`: `{type:"registered", documentId, title, pageCount, at}`. `documentId` is the lowercase-hex sha256 (64 chars) of the PDF file's bytes; `title` non-empty; `pageCount` a positive integer.
Event `chat`: `{type:"chat", documentId, chatId, at}`; binds the document's one study conversation.

Derivation (`deriveDocuments`, `documentOfChat`): replay in file order; the first `registered` per `documentId` defines the document (the same file registered twice is one document); the first `chat` per document wins, so there is exactly one conversation per document; a `chat` for an unregistered document is ignored. `documentOfChat(chatId)` is the inverse lookup.

Stored files, content-addressed under `documents/`: `<documentId>.pdf` (a byte copy, written through a temp file and renamed) and `<documentId>.pages.json` (a JSON array of strings, one per page, page 1 first; a cache of the extracted text, rebuilt when absent).

## `reading.jsonl` (ledger)

Event `visit`: `{type:"visit", documentId, page, at}` (page a positive integer). Event `close`: `{type:"close", documentId, at}`.

Derivation (`deriveReading(events, documentId, {dwellSeconds = 5, pageCount})`): replay the document's events in file order. A visit lasts until the next event of the same document (a visit or a close). A page is READ when some visit to it lasted at least `dwellSeconds`. The newest visit has no end and counts only once a later event follows. `lastPage` is the page of the newest visit. Pages greater than `pageCount` (when given) are ignored. `readPages` is ascending and distinct.

## `study-links.jsonl` (ledger)

Event `link`: `{type:"link", nodeId, documentId, page, at}`. Append-only. `sourcesOfNode` returns the distinct `(documentId, page)` pairs of a node in order of first appearance; `linkedPages(documentId)` the ascending distinct pages that have at least one node; `nodeIdsOnPages(documentId, pages)` the distinct node ids on those pages. Nothing here is derived from the content ledgers: a link to a node that no longer exists is filtered by the reader.

## `study-drafts.jsonl` (ledger)

Event `proposed`: `{type:"proposed", draftId, documentId, page, proposition, question, answer, at}` (all strings non-blank, page a positive integer). Event `decided`: `{type:"decided", draftId, decision, at}` with `decision` in `approved` | `rejected`. Event `pages_processed`: `{type:"pages_processed", documentId, pages, at}` (non-empty array of positive integers): the pages a "complete" run has handled.

Derivation (`deriveDrafts`): replay in file order; the first `proposed` per `draftId` defines the draft with status `pending`; the first `decided` per draft wins; a `decided` for an unknown draft is ignored. `processedPages(documentId)` is the ascending distinct union of `pages_processed`. Drafts are never graph content: only approval sends the proposition to the extraction pipeline.

### Complete (the run that writes `proposed` events)

Pages offered: read (`deriveReading`) and not in `processedPages`, ascending. Each batch of 4 pages is checked against the daily cost ceiling before the call; when it is reached the run stops with `ceilingReached` and the pages not yet handled stay unprocessed. The model proposes candidates; `dropRepeats` removes any whose proposition equals (`sameProposition`: `normalizeForMatch(…, "join")` equal after stripping trailing full stops and whitespace) the statement of a node linked to a page of the batch, the proposition of any draft (pending, approved or rejected) on those pages, or an earlier candidate, then keeps at most 5 per page. Propositions are at most 400 characters. Every handled page is recorded in a `pages_processed` event, including pages that produced nothing.

### Confirming a card (the only road into the graph)

The proposition text alone is imported as a notes source with the pseudo-path `study/<slug>/p<page, 4 digits>-<sha256(proposition.trim())[0..8]>.md` (`<slug>` is the title NFKD-normalised, diacritics removed, lowercased, non-alphanumerics collapsed to `-`, at most 40 characters, `document` when empty); the source text is the trimmed proposition plus a newline. The pipeline may create or link nodes. The card attaches to the node returned by `pickCardNode`: the candidate maximising the Jaccard overlap of word sets (`normalizeForMatch(·, "join")` split on non-letter-or-digit, words of at least 2 characters) between the proposition and the node's statement, any alias, or its name; a tie goes to the first candidate; with no candidate the confirmation fails and nothing is linked. A `link` event is appended for the node and page. A user-confirmed card is `active`; an unedited approved draft is an agent card approved by the learner. The node is pinned unless the learner opted out.

## The study message context line

A user message in a `study` session is `[study-context] <JSON>` + `\n` + the learner's text. `<JSON>` is `{"documentId": string, "page": positive integer, "selection": string}`; the selection is cut to 2000 characters; `JSON.stringify` escapes newlines so the first line ends at the first `\n`. A message without a valid first line has no context. The agent's prompt for a turn is composed from the NEWEST user message's context (and no earlier one) plus the text of that page.

`pageCitations(text)` finds every `(p. N)` (regex `\(p\.\s*(\d{1,5})\)`, N at least 1) with its start and end offsets; `citationAt(text, offset)` returns the page of the citation covering `offset`, if any.
~~~

- [ ] **Step 2: Append to the table in `docs/ext/TOUCHPOINTS.md`** (columns: File, Why, Added in; the last column is `Assisted study` for all rows)

~~~markdown
| `src/core/contracts/chat.ts` | `ChatKind` gains `"study"` | Assisted study |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"study"` | Assisted study |
| `src/store/chats.ts` | `createChat` type widened to the same kinds | Assisted study |
| `src/server/chat-handler.ts` | imports `createStudyAgent` and `studyService`; the study agent branch | Assisted study |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for a `study` session | Assisted study |
| `components/chat.tsx` | optional `transformOutgoing` prop, applied on send and on steer (the study view prepends the page and selection) | Assisted study |
| `components/ext/node-panel-view.tsx` | "Source in your documents" section | Assisted study |
~~~

(`session-kind.ts`, the barrels, `stores.ts`, `panel-providers.ts` and `node-panel*.ts` are extension files and need no row.)

- [ ] **Step 3: Commit**

```bash
git add docs/ext/CONTRACTS.md docs/ext/TOUCHPOINTS.md
git commit -m "docs(ext): assisted study contracts and touchpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Full verification and manual smoke

**Files:** none.

- [ ] **Step 1: Everything automatic**

```bash
cd <repo>
source ~/.nvm/nvm.sh && nvm use 26
npx tsc --noEmit
npx eslint .
NODE_ENV=test npx tsx --test tests/*.test.ts tests/*.test.tsx
```

Expected: `tsc` and ESLint print nothing; the suite ends with `ℹ fail 0`. Any failure outside `ext-*` tests that mentions `ChatKind`, `createChat` or `isPracticeLike` is a missed touchpoint edit from Task 10.

- [ ] **Step 2: Start the app**

Run: `npm run dev` (or `npm run desktop:dev` for the Electron shell, which sends the capability header on its own). Note: Next 16 with Turbopack breaks on a symlinked `node_modules`; use the real install in the fork.

- [ ] **Step 3: Smoke, in order** (needs a configured teacher model and key; steps 1 to 4 and 9 do not)
  1. Open `/study`. Register the author's `dispense_Prob_1.pdf` by absolute path: it appears in the list with its page count. Register it again: still one entry.
  2. Open it: the PDF renders on the left (canvas plus selectable text) and an empty conversation on the right. Move with the arrows and the page box; reload the page: it reopens on the last page (REQ-study-03).
  3. Select a sentence on a text page: the "Selected:" chip shows it. Send "what does this mean?": the agent answers about that page and cites `(p. N)`. Click a `(p. N)` in the answer: the viewer jumps.
  4. Reopen `/study/<id>` from the list: the same conversation resumes (REQ-study-05).
  5. "Card from selection": a proposition, question and answer appear editable. Edit one word, Confirm: "Card added", and the node panel opens on the new node (REQ-study-08, 09).
  6. In the node panel: "Source in your documents" shows `title, p. N` and its link reopens the document at that page (REQ-study-10).
  7. Read three pages for more than five seconds each, then press "Complete": a count of drafts proposed appears (REQ-study-11); approve one, reject one. The approved one is a card in the review deck; the rejected one is gone from the list.
  8. Lower the daily cost ceiling in settings below the day's spend and press "Complete" again: it stops and says the ceiling was reached (REQ-study-13); card drafting by hand still works (decision 4).
  9. Check `data/ext/`: `documents.jsonl`, `reading.jsonl`, `study-links.jsonl`, `study-drafts.jsonl` and `documents/<sha256>.pdf` exist, and `format.json` is unchanged.

- [ ] **Step 4: Nothing to commit.** Report which smoke steps were run and the result of each.

---

## Self-review

### 1. Spec coverage (by REQ id)

| REQ | Where |
|---|---|
| REQ-study-01 sha256 id, title, page count, stored copy, same file same document | Tasks 3 (`deriveDocuments`), 5 (store), 9 (`registerDocument`, tests "same file twice") |
| REQ-study-02 active primary library entry | Task 9 (`registerDocument` -> `registerBookAsPrimary`; test asserts the entry) |
| REQ-study-03 reading ledger, last page restored, 5 s dwell | Tasks 3 (`deriveReading`), 9 (`recordReading`, `listDocuments`), 15 (view reports visit and close), 17 smoke step 2 |
| REQ-study-04 PDF beside the conversation | Tasks 10 (kind, agent branch), 14 (viewer), 15 (view); layout is functional only |
| REQ-study-05 one conversation per document | Task 3 (first `chat` wins), Task 9 (`open` test: second open returns the same chat) |
| REQ-study-06 page and selection on each message; page text to the agent | Tasks 2 (context line), 7 (`studyPrompt` from the newest context), 15 (`transformOutgoing`) |
| REQ-study-07 `read_page`/`search_pages`, `(p. N)`, clickable | Tasks 2 (citations), 7 (tools, instructions), 13 (click), 15 (wiring) |
| REQ-study-08 card from selection, page or agent answer; agent drafts, user confirms or edits | Tasks 8 (`draftCard`), 9 (`draftCard`/`confirmCard`), 15 (UI). "From an agent answer" works by selecting the answer text (decision for the user, below) |
| REQ-study-09 confirmed proposition through the pipeline, equivalents linked | Tasks 4 (`pickCardNode`, `studySourcePath`), 9 (`confirmCard` through `importProposition` = `importNotes`; link-append is the pipeline's) |
| REQ-study-10 links, panel section, open at page | Tasks 3 (links), 9 (link on confirm), 11 (panel), 17 smoke step 6 |
| REQ-study-11 complete: drafts for pages read and not processed, page numbers, skip existing, nothing active unapproved | Tasks 4 (`dropRepeats`, `processedPages`), 8 (`proposePageDrafts`), 9 (`complete`, `decideDrafts`) |
| REQ-study-12 nothing enters the graph unless selected, asked or approved | Task 10 (`isPracticeLike("study")` suppresses chat-level extraction), Task 7 (no write tool), Task 9 (only `confirmCard` and approval reach the pipeline) |
| REQ-study-13 complete subject to the daily ceiling | Task 9 (gate per batch, `CostCeilingError` stops cleanly, tests), Task 17 smoke step 8 |
| REQ-study-14 contracts documented | Task 16 |
| REQ-goal-01 (PDF origin) | Task 9 (`startGoal`, `createGoal` with origin `pdf`), Task 15 (form) |
| REQ-mode-01 (study kind in the shared chat) | Task 10; the mode selector control itself is the UI session's (see gaps) |
| REQ-cost-01 | Task 9 (shares `liveCostGate`; reading unaffected) |
| REQ-port-01 | Task 16 |

### 2. Placeholder scan

Every code step embeds the complete file or, for edits to existing files, the exact lines to add or replace. No "TODO", "TBD", "similar to", "add validation". The two places that say "if ... otherwise" (Task 16's `TOUCHPOINTS.md` sentence, Task 10's note about the `:` in the ternary chain) give both exact outcomes.

### 3. Type consistency

Names are used identically across tasks: `StudyContext`, `encodeStudyContext`, `latestStudyContext` (Task 2, used in 7, 15); `deriveDocuments`/`documentOfChat`/`StudyDocument` (3, used in 9, 11); `deriveReading` (3, 9); `sourcesOfNode`/`linkedPages`/`nodeIdsOnPages` (3, 9, 11); `deriveDrafts`/`processedPages`/`dropRepeats`/`pickCardNode`/`studySourcePath` (4, 9); `DocumentFiles`/`LedgerLike` (4, 5, 9); `StudyToolContext` (7, 9's `toolContext`, 10); `draftCard`/`proposePageDrafts`/`DraftWriterDeps` (8, 10); `StudyError`/`parseDecision`/`requireString` (9, 10, 12). `tsc --noEmit` clean over all of them in the scratch copy.

### 4. Gaps and decisions for the user

**REQ gaps.** None of REQ-study-01..14 is unimplemented. Partial:
- **REQ-study-04** is functional only: a two-column split with plain controls. Visual design is a stated non-goal (UI session).
- **REQ-mode-01**: the `study` kind exists and `/study` is its entry point, but there is no mode selector control and the sidebar does not link to `/study`. Study chats opened from the sidebar via `/chat/<id>` show the conversation without the PDF.
- **Scanned PDFs** (no text layer) are refused; no OCR.

**Decisions that need the user** (defaults are in the plan, listed in order of how much they would change the build):
1. **Path registration versus upload** (decision 1). Upload would need a body-size change in `proxy.ts` (a touchpoint) for large books.
2. **The extra file `study-drafts.jsonl`** (decision 2). The alternative is storing proposals in the chat record, which would touch upstream types.
3. **Pin by default** on confirmed cards (decision 3).
4. **Interactive drafting is not ceiling-gated** (decision 4).
5. **The `[study-context]` line shows in the transcript** as the first line of each learner message; hiding it is UI-session work. It is also what costs the one `chat.tsx` touchpoint.
6. **One extraction run per confirmed card** creates many small sources in the source directory (decision 7).
7. **The dwell rule's last visit.** The page you are on when you close the window counts as read only if a later event follows it; the viewer sends a `close` on hide and on unload to cover that.
8. **"From an agent answer"** means selecting the answer's text and using "Card from selection"; a per-message "make a card" button would need another `chat.tsx` touchpoint.
9. **Draft edits during approval** are supported by the API (`approve: [{draftId, proposition?, question?, answer?}]`) but the first UI only approves or rejects; editing a proposed card happens by writing one by hand.
10. **Merge risk with the research-loop plan** on the `ChatKind` / `createChat` lines and the `chat-handler.ts` ternary chain (both add a branch); keep both sides.
