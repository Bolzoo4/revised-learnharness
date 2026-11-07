import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { interruptBook, MAX_RUN_BOOKS, type BookRun } from "../src/core/ext/lecture/run-record.ts";
import { createLectureRunStore } from "../src/store/ext/lecture-runs-store.ts";

const roots: string[] = [];
function dirFor(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-runs-"));
	roots.push(dir);
	return dir;
}
after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const book = (n: number, over: Partial<BookRun> = {}): BookRun => ({
	bookId: `b${String(n).padStart(8, "0")}`,
	title: `Book ${n}`,
	pdfPath: `/data/ext/documents/${String(n).padStart(4, "0")}.pdf`,
	phase: "failed",
	chapters: [
		{ chapter: { index: 1, title: "One", pageStart: 1, pageEnd: 9 }, state: "done", lectures: 2, uncovered: 0 },
		{ chapter: { index: 2, title: "Two", pageStart: 10, pageEnd: 20 }, state: "failed", stage: "outline", lectures: 0, uncovered: 0, error: "boom", updatedAt: "2026-11-06T10:00:00.000Z" },
	],
	startedAt: `2026-11-06T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
	...over,
});

describe("lecture run store", () => {
	it("round-trips the books, chapters, states and checkpoints", () => {
		const dir = dirFor();
		const store = createLectureRunStore(dir);
		const books = [book(1, { chapters: [{ ...book(1).chapters[0]!, importedParts: 3 }, book(1).chapters[1]!] })];
		store.save(books);
		assert.deepEqual(store.load(), books);
		assert.ok(fs.existsSync(path.join(dir, "lecture-runs.json")));
		assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
	});
	it("loads a missing file as empty", () => {
		assert.deepEqual(createLectureRunStore(dirFor()).load(), []);
	});
	it("loads a corrupt file as empty, and a later save replaces it", () => {
		const dir = dirFor();
		fs.writeFileSync(path.join(dir, "lecture-runs.json"), "{ not json");
		const store = createLectureRunStore(dir);
		assert.deepEqual(store.load(), []);
		store.save([book(2)]);
		assert.deepEqual(store.load().map((b) => b.bookId), [book(2).bookId]);
	});
	it("skips the invalid records of a valid file", () => {
		const dir = dirFor();
		fs.writeFileSync(path.join(dir, "lecture-runs.json"), JSON.stringify({ version: 1, books: [{ bookId: "nope" }, book(3)] }));
		assert.deepEqual(createLectureRunStore(dir).load().map((b) => b.bookId), [book(3).bookId]);
	});
	it("bounds the file: at most MAX_RUN_BOOKS are saved, the newest first, and a running book is kept", () => {
		const dir = dirFor();
		const store = createLectureRunStore(dir);
		const many = Array.from({ length: MAX_RUN_BOOKS + 5 }, (_, i) => book(i + 1));
		store.save([...many, book(900, { phase: "running", startedAt: "2000-01-01T00:00:00.000Z" })]);
		const loaded = store.load();
		assert.equal(loaded.length, MAX_RUN_BOOKS);
		assert.ok(loaded.some((b) => b.bookId === book(900).bookId));
		assert.ok(!loaded.some((b) => b.bookId === book(1).bookId), "the oldest finished book is the one dropped");
	});
	it("refuses to save over a file stamped by a newer build", () => {
		const dir = dirFor();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		assert.throws(() => createLectureRunStore(dir).save([book(1)]), /format version 99/);
	});
	it("a book that was running when the file was written comes back interrupted", () => {
		const dir = dirFor();
		const store = createLectureRunStore(dir);
		store.save([book(4, { phase: "running", chapters: [{ chapter: { index: 1, title: "One", pageStart: 1, pageEnd: 9 }, state: "outline", stage: "outline", lectures: 0, uncovered: 0 }] })]);
		const { book: out, interrupted } = interruptBook(store.load()[0]!, "2026-11-07T08:00:00.000Z");
		assert.equal(out.phase, "interrupted");
		assert.equal(out.chapters[0]!.state, "interrupted");
		assert.equal(interrupted.length, 1);
	});
});
