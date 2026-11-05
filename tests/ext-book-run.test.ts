import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectChapters, mapPool, runBook, type BookRunDeps } from "../src/agent/ext/lecture/book-run.ts";

const done = { state: "done" as const, lectureIds: [], uncoveredNodeIds: [] };

function deps(over: Partial<BookRunDeps> = {}): BookRunDeps {
	return {
		readBookmarks: async () => ({ pageCount: 30, bookmarks: [{ title: "A", page: 1 }, { title: "B", page: 11 }] }),
		readPageTexts: async () => ["p1", "p2"],
		detectChaptersWithLlm: async () => { throw new Error("must not be called"); },
		runChapter: async () => done,
		...over,
	};
}

describe("detectChapters", () => {
	it("uses valid bookmarks without calling the model", async () => {
		const ch = await detectChapters(deps());
		assert.deepEqual(ch.map((c) => [c.title, c.pageStart, c.pageEnd]), [["A", 1, 10], ["B", 11, 30]]);
	});
	it("falls back to the model when there are no bookmarks, validating its answer", async () => {
		const d = deps({
			readBookmarks: async () => ({ pageCount: 10, bookmarks: [] }),
			detectChaptersWithLlm: async (excerpt, pages) => (assert.match(excerpt, /PAGE 1/), assert.equal(pages, 10), [{ title: "X", page: 1 }]),
		});
		assert.equal((await detectChapters(d)).length, 1);
	});
	it("rejects an invalid model proposal", async () => {
		const d = deps({ readBookmarks: async () => ({ pageCount: 10, bookmarks: [] }), detectChaptersWithLlm: async () => [{ title: "X", page: 50 }] });
		await assert.rejects(detectChapters(d), /chapter detection failed/);
	});
	it("falls back too when the bookmarks themselves are invalid", async () => {
		const d = deps({ readBookmarks: async () => ({ pageCount: 10, bookmarks: [{ title: "A", page: 99 }] }), detectChaptersWithLlm: async () => [{ title: "Z", page: 2 }] });
		assert.equal((await detectChapters(d))[0]!.title, "Z");
	});
});

describe("runBook", () => {
	it("registers the source once and runs every chapter, keeping order", async () => {
		let registered = 0;
		const r = await runBook({ bookId: "b1", bookTitle: "T" }, deps({ registerSource: () => void registered++, runChapter: async (c) => ({ ...done, lectureIds: [c.title] }) }));
		assert.equal(registered, 1);
		assert.deepEqual(r.chapters.map((c) => c.result.lectureIds[0]), ["A", "B"]);
	});
	it("works without a source library", async () => {
		await runBook({ bookId: "b1", bookTitle: "T" }, deps());
	});
});

describe("mapPool", () => {
	it("never exceeds the limit and returns results in input order", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return n * 10;
		});
		assert.equal(peak, 2);
		assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
	});
	it("handles an empty list", async () => {
		assert.deepEqual(await mapPool([], 3, async (x) => x), []);
	});
});
