// tests/ext-study-core-hardening.test.ts
// Hardening tests for the study core, from the review findings: bounded page
// numbers, bounded titles and texts, bounded context lines, linear work on
// large inputs, and the source path identity.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PAGE, MAX_TEXT_CHARS, MAX_TITLE_CHARS, flattenText } from "../src/core/ext/study/bounds.ts";
import {
	MAX_CONTEXT_LINE_CHARS,
	MAX_SELECTION_CHARS,
	encodeStudyContext,
	parseStudyContext,
} from "../src/core/ext/study/context.ts";
import { parseDocumentEvent } from "../src/core/ext/study/documents.ts";
import { dropRepeats, parseDraftEvent } from "../src/core/ext/study/drafts.ts";
import { parseStudyLinkEvent } from "../src/core/ext/study/links.ts";
import { DEFAULT_DWELL_SECONDS, deriveReading, parseReadingEvent, type ReadingEvent } from "../src/core/ext/study/reading.ts";
import { studySourcePath, studySourceText } from "../src/core/ext/study/source-path.ts";

const ID_A = "a".repeat(64);
const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function timed<T>(fn: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = fn();
	return { value, ms: performance.now() - start };
}

describe("page numbers are bounded to MAX_PAGE in every parser", () => {
	it("the cap is 100000", () => {
		assert.equal(MAX_PAGE, 100000);
	});

	it("context: the cap itself is kept, one above is rejected", () => {
		const ok = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: MAX_PAGE }, "t"));
		assert.equal(ok?.context.page, MAX_PAGE);
		const raw = `[study-context] ${JSON.stringify({ documentId: ID_A, page: MAX_PAGE + 1 })}\nt`;
		assert.equal(parseStudyContext(raw), null);
	});

	it("reading: a visit above the cap is rejected; a non-integer page is rejected", () => {
		assert.equal(parseReadingEvent({ type: "visit", documentId: ID_A, page: MAX_PAGE + 1, at: at(0) }), null);
		assert.equal(parseReadingEvent({ type: "visit", documentId: ID_A, page: 2.5, at: at(0) }), null);
		assert.equal(parseReadingEvent({ type: "visit", documentId: ID_A, page: MAX_PAGE, at: at(0) })?.type, "visit");
	});

	it("links: a page above the cap is rejected; a non-integer page is rejected", () => {
		const base = { type: "link", nodeId: "n1", documentId: ID_A, at: at(0) };
		assert.equal(parseStudyLinkEvent({ ...base, page: MAX_PAGE + 1 }), null);
		assert.equal(parseStudyLinkEvent({ ...base, page: 1.5 }), null);
		assert.notEqual(parseStudyLinkEvent({ ...base, page: MAX_PAGE }), null);
	});

	it("documents: a pageCount above the cap or non-integer is rejected", () => {
		const base = { type: "registered", documentId: ID_A, title: "Book", at: at(0) };
		assert.equal(parseDocumentEvent({ ...base, pageCount: MAX_PAGE + 1 }), null);
		assert.equal(parseDocumentEvent({ ...base, pageCount: 3.25 }), null);
		assert.equal(parseDocumentEvent({ ...base, pageCount: MAX_PAGE })?.type, "registered");
	});

	it("drafts: a page above the cap is rejected", () => {
		const draft = { type: "proposed", draftId: "d1", documentId: ID_A, proposition: "A", question: "q", answer: "a", at: at(0) };
		assert.equal(parseDraftEvent({ ...draft, page: MAX_PAGE + 1 }), null);
		assert.equal(parseDraftEvent({ ...draft, page: MAX_PAGE })?.type, "proposed");
	});
});

describe("document titles are flattened and capped", () => {
	it("cap is 200 characters", () => {
		assert.equal(MAX_TITLE_CHARS, 200);
	});

	it("line breaks and runs of spaces collapse to one space", () => {
		const e = parseDocumentEvent({ type: "registered", documentId: ID_A, title: "  Algebra\r\n\n  Lineare\u2028\tI  ", pageCount: 3, at: at(0) });
		assert.equal(e?.type === "registered" ? e.title : null, "Algebra Lineare I");
	});

	it("a long title is cut to 200 characters", () => {
		const e = parseDocumentEvent({ type: "registered", documentId: ID_A, title: "x".repeat(5000), pageCount: 3, at: at(0) });
		assert.equal(e?.type === "registered" ? e.title.length : -1, MAX_TITLE_CHARS);
	});

	it("a title that is only whitespace is still rejected", () => {
		assert.equal(parseDocumentEvent({ type: "registered", documentId: ID_A, title: " \r\n\t ", pageCount: 3, at: at(0) }), null);
	});
});

describe("flattenText", () => {
	it("is one line with no leading or trailing space", () => {
		assert.equal(flattenText("  a\r\nb\rc\u2028d\u2029e\n", 100), "a b c d e");
	});

	it("never cuts a surrogate pair in half", () => {
		const out = flattenText("😀".repeat(10), 5);
		assert.equal(out, "😀😀");
		assert.ok(out.length <= 5);
	});

	it("a text already within the cap is returned unchanged after flattening", () => {
		assert.equal(flattenText("short", MAX_TEXT_CHARS), "short");
	});
});

describe("drafts: proposition, question and answer are single-line and capped", () => {
	it("a multi-line proposition is stored as one line", () => {
		const e = parseDraftEvent({
			type: "proposed",
			draftId: "d1",
			documentId: ID_A,
			page: 2,
			proposition: "A is\n# Heading\ncompact",
			question: "q\r\nmore",
			answer: "a",
			at: at(0),
		});
		assert.equal(e?.type === "proposed" ? e.proposition : null, "A is # Heading compact");
		assert.equal(e?.type === "proposed" ? e.question : null, "q more");
	});

	it("a very long answer is cut to the text cap", () => {
		const e = parseDraftEvent({
			type: "proposed",
			draftId: "d1",
			documentId: ID_A,
			page: 2,
			proposition: "A",
			question: "q",
			answer: "w ".repeat(50000),
			at: at(0),
		});
		assert.ok(e?.type === "proposed" && e.answer.length <= MAX_TEXT_CHARS);
	});
});

describe("context: selection and first line bounds", () => {
	it("a selection of 1 MB is cut quickly to the cap", () => {
		const big = "ab".repeat(500000);
		const { value, ms } = timed(() => encodeStudyContext({ documentId: ID_A, page: 1, selection: big }, "t"));
		const parsed = parseStudyContext(value);
		assert.equal(parsed?.context.selection.length, MAX_SELECTION_CHARS);
		assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
	});

	it("a context line longer than the cap is refused before parsing", () => {
		const line = `[study-context] ${JSON.stringify({ documentId: ID_A, page: 1, selection: "x".repeat(MAX_CONTEXT_LINE_CHARS) })}`;
		assert.ok(line.length > MAX_CONTEXT_LINE_CHARS);
		assert.equal(parseStudyContext(`${line}\ntext`), null);
	});

	it("a context line with no newline longer than the cap is refused too", () => {
		assert.equal(parseStudyContext(`[study-context] ${"1".repeat(MAX_CONTEXT_LINE_CHARS + 10)}`), null);
	});

	it("the worst-case escaped selection still fits under the line cap", () => {
		const worst = "\u0001".repeat(MAX_SELECTION_CHARS);
		const msg = encodeStudyContext({ documentId: ID_A, page: 1, selection: worst }, "t");
		assert.ok(msg.indexOf("\n") <= MAX_CONTEXT_LINE_CHARS);
		assert.equal(parseStudyContext(msg)?.context.selection, worst);
	});
});

describe("reading: dwell is open-ended", () => {
	it("DEFAULT_DWELL_SECONDS is 5", () => {
		assert.equal(DEFAULT_DWELL_SECONDS, 5);
	});

	it("a visit followed by a very long idle gap still counts as read (dwell is at least the threshold)", () => {
		const events: ReadingEvent[] = [
			{ type: "visit", documentId: ID_A, page: 4, at: at(0) },
			{ type: "close", documentId: ID_A, at: at(60 * 60 * 3) },
		];
		assert.deepEqual(deriveReading(events, ID_A).readPages, [4]);
	});
});

describe("studySourcePath identity", () => {
	it("the same title on two documents gives two paths when the document ids differ", () => {
		const a = studySourcePath("Book", 1, "A is compact", ID_A);
		const b = studySourcePath("Book", 1, "A is compact", "b".repeat(64));
		assert.notEqual(a, b);
	});

	it("the same document id gives the same path again", () => {
		assert.equal(studySourcePath("Book", 1, "A is compact", ID_A), studySourcePath("Book", 1, "A is compact", ID_A));
	});

	it("a proposition longer than the text cap is identified by its bounded text", () => {
		const head = "x".repeat(MAX_TEXT_CHARS);
		assert.equal(studySourcePath("T", 1, head + "tail one"), studySourcePath("T", 1, head + "tail two"));
	});

	it("the path has no empty, dot or dot-dot segment for a title made only of punctuation", () => {
		const p = studySourcePath("...", 1, "A is compact");
		assert.ok(p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), p);
	});
});

describe("studySourceText bounds", () => {
	it("a long proposition is cut to the text cap, on one line", () => {
		const t = studySourceText("word\n".repeat(5000));
		assert.ok(t.trimEnd().length <= MAX_TEXT_CHARS);
		assert.equal(t.split(/\r\n|\r|\n|\u2028|\u2029/).length, 2);
	});
});

describe("dropRepeats stays linear on repeated trailing stops", () => {
	it("a 20k-stop proposition is compared quickly", () => {
		const cands = [{ page: 1, proposition: `${"x".repeat(20000)}.` }];
		const { value, ms } = timed(() => dropRepeats(cands, ["x"], 5));
		assert.equal(value.length, 1);
		assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
	});
});
