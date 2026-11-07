import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	boundRunRecords,
	formatChapterOutcome,
	INTERRUPTED_TEXT,
	interruptBook,
	MAX_RUN_BOOKS,
	parseRunRecords,
	secondsBetween,
	type BookRun,
	type ChapterRun,
} from "../src/core/ext/lecture/run-record.ts";

const BOOK = "b0123abcd";
const PDF = "/data/ext/documents/abc.pdf";
const ch = (index: number, state: ChapterRun["state"], extra: Partial<ChapterRun> = {}): ChapterRun => ({
	chapter: { index, title: `Title ${index}`, pageStart: index * 10, pageEnd: index * 10 + 9 },
	state,
	lectures: 0,
	uncovered: 0,
	...extra,
});
const book = (over: Partial<BookRun> = {}): BookRun => ({ bookId: BOOK, title: "Probability 1", pdfPath: PDF, phase: "failed", chapters: [ch(1, "done")], startedAt: "2026-11-06T10:00:00.000Z", ...over });

describe("parseRunRecords", () => {
	it("round-trips a valid file", () => {
		const b = book({ chapters: [ch(1, "done", { lectures: 2 }), ch(2, "failed", { error: "boom", stage: "outline", startedAt: "t1", updatedAt: "t2" })] });
		assert.deepEqual(parseRunRecords({ version: 1, books: [b] }), [b]);
	});
	it("reads anything that is not version 1 with the right shape as empty", () => {
		for (const bad of [null, "x", [], {}, { version: 2, books: [book()] }, { version: 1, books: "nope" }]) {
			assert.deepEqual(parseRunRecords(bad), []);
		}
	});
	it("drops a book that does not validate, and keeps the others", () => {
		const good = book();
		const bads = [
			{ ...good, bookId: "not-a-book" },
			{ ...good, pdfPath: "relative/x.pdf" },
			{ ...good, pdfPath: "/data/x.txt" },
			{ ...good, phase: "exploding" },
			{ ...good, chapters: [{ ...ch(1, "done"), state: "unknown" }] },
			{ ...good, chapters: [{ ...ch(1, "done"), chapter: { index: 0, title: "t", pageStart: 1, pageEnd: 2 } }] },
			{ ...good, chapters: [{ ...ch(1, "done"), chapter: { index: 1, title: "t", pageStart: 9, pageEnd: 2 } }] },
		];
		for (const bad of bads) assert.deepEqual(parseRunRecords({ version: 1, books: [bad, good] }), [good]);
	});
	it("keeps the first of two records with one book id, and cuts long texts", () => {
		const long = "e".repeat(5000);
		const first = book({ error: long, title: "T".repeat(400) });
		const parsed = parseRunRecords({ version: 1, books: [first, book({ title: "other" })] });
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0]!.error!.length, 2000);
		assert.equal(parsed[0]!.title.length, 300);
	});
});

describe("boundRunRecords", () => {
	it("keeps at most MAX_RUN_BOOKS, newest first, and always keeps the books still running", () => {
		const many: BookRun[] = Array.from({ length: MAX_RUN_BOOKS + 10 }, (_, i) =>
			book({ bookId: `b${String(i).padStart(8, "0")}`, startedAt: `2026-11-${String(10 + (i % 20)).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}.000Z` }),
		);
		const running = book({ bookId: "b11111111", phase: "running", startedAt: "2020-01-01T00:00:00.000Z" });
		const kept = boundRunRecords([...many, running]);
		assert.equal(kept.length, MAX_RUN_BOOKS);
		assert.ok(kept.some((b) => b.bookId === "b11111111"), "a running book is never dropped");
		const starts = kept.map((b) => b.startedAt);
		assert.deepEqual(starts, [...starts].sort().reverse(), "newest first");
	});
});

describe("interruptBook", () => {
	it("turns every working chapter and a running book into interrupted with the fixed text, and keeps final ones", () => {
		const running = book({
			phase: "running",
			chapters: [ch(1, "done"), ch(2, "graph", { stage: "graph", startedAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:41.000Z" }), ch(3, "queued"), ch(4, "failed", { error: "x" })],
		});
		const { book: out, interrupted } = interruptBook(running, "2026-11-07T08:00:00.000Z");
		assert.equal(out.phase, "interrupted");
		assert.equal(out.error, INTERRUPTED_TEXT);
		assert.deepEqual(out.chapters.map((c) => c.state), ["done", "interrupted", "interrupted", "failed"]);
		assert.equal(out.chapters[1]!.error, INTERRUPTED_TEXT);
		assert.equal(out.chapters[1]!.stage, "graph");
		assert.equal(out.chapters[3]!.error, "x");
		assert.deepEqual(interrupted.map((c) => c.chapter.index), [2, 3]);
	});
	it("leaves a finished book untouched", () => {
		const done = book({ phase: "done" });
		const { book: out, interrupted } = interruptBook(done, "2026-11-07T08:00:00.000Z");
		assert.deepEqual(out, done);
		assert.deepEqual(interrupted, []);
	});
});

describe("formatChapterOutcome", () => {
	it("writes one line with the ids, index, title, state, error, stage and duration, and no path or text", () => {
		const line = formatChapterOutcome({
			bookId: BOOK,
			chapter: { index: 3, title: "Title" },
			state: "failed",
			error: "the model ended without calling submit_outline.  The   model stopped\nbefore calling the tool.",
			stage: "outline",
			seconds: 41,
		});
		assert.equal(line, `[lectures] book ${BOOK} chapter 3 "Title" failed: the model ended without calling submit_outline. The model stopped before calling the tool. (stage outline, 41s)`);
		assert.equal(line.includes(PDF), false);
	});
	it("omits the error when there is none and the duration when unknown", () => {
		assert.equal(formatChapterOutcome({ bookId: BOOK, chapter: { index: 1, title: "A" }, state: "done", stage: "writing" }), `[lectures] book ${BOOK} chapter 1 "A" done (stage writing)`);
		assert.equal(formatChapterOutcome({ bookId: BOOK, chapter: { index: 1, title: "A" }, state: "interrupted" }), `[lectures] book ${BOOK} chapter 1 "A" interrupted (stage queued)`);
	});
});

describe("secondsBetween", () => {
	it("rounds to whole seconds and is unknown without a start", () => {
		assert.equal(secondsBetween("2026-11-06T10:00:00.000Z", "2026-11-06T10:00:41.400Z"), 41);
		assert.equal(secondsBetween(undefined, "2026-11-06T10:00:41.400Z"), undefined);
		assert.equal(secondsBetween("2026-11-06T10:00:00.000Z", "garbage"), undefined);
	});
});
