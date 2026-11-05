import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitOutline, TARGET_WORDS, type OutlineBlock } from "../src/core/ext/lecture/split.ts";
import { buildChapterDetectExcerpt, chaptersFromStarts, normalizeBookmarks, plainChapterText, validateChapterStarts } from "../src/core/ext/lecture/chapters.ts";

const b = (kind: OutlineBlock["kind"], title: string = kind): OutlineBlock => ({ title, kind, summary: "s" });

describe("splitOutline", () => {
	it("keeps a small chapter in one lecture", () => {
		assert.equal(splitOutline([b("definition"), b("example")]).length, 1);
	});
	it("splits when the estimate would pass the target, preserving order", () => {
		const blocks = Array.from({ length: 8 }, (_, i) => b("theorem", `t${i}`)); // 8 x 375 = 3000
		const lectures = splitOutline(blocks);
		assert.deepEqual(lectures.map((l) => l.length), [5, 3]); // 5 x 375 = 1875 <= 2000
		assert.deepEqual(lectures.flat().map((x) => x.title), blocks.map((x) => x.title));
	});
	it("gives an oversize block its own lecture and never produces an empty one", () => {
		const lectures = splitOutline([b("theorem")], 100);
		assert.equal(lectures.length, 1);
		assert.deepEqual(splitOutline([], TARGET_WORDS), []);
	});
	it("is independent of any page count (outline only)", () => {
		const a = splitOutline([b("definition"), b("theorem"), b("example")]);
		assert.equal(a.length, 1);
	});
});

describe("chapters", () => {
	it("derives page ranges and indexes", () => {
		const ch = chaptersFromStarts([{ title: " One ", page: 1 }, { title: "Two", page: 11 }, { title: "Three", page: 30 }], 50);
		assert.deepEqual(ch, [
			{ index: 1, title: "One", pageStart: 1, pageEnd: 10 },
			{ index: 2, title: "Two", pageStart: 11, pageEnd: 29 },
			{ index: 3, title: "Three", pageStart: 30, pageEnd: 50 },
		]);
	});
	it("rejects out-of-range, non-increasing and empty proposals", () => {
		assert.match(validateChapterStarts([], 10).join(), /no chapters/);
		assert.match(validateChapterStarts([{ title: "A", page: 0 }], 10).join(), /outside 1\.\.10/);
		assert.match(validateChapterStarts([{ title: "A", page: 5 }, { title: "B", page: 5 }], 10).join(), /strictly increase/);
		assert.match(validateChapterStarts([{ title: " ", page: 2 }], 10).join(), /empty title/);
		assert.deepEqual(validateChapterStarts([{ title: "A", page: 1 }, { title: "B", page: 9 }], 10), []);
	});
	it("normalizes bookmarks: drops blanks, repeated pages and going backwards", () => {
		const out = normalizeBookmarks([
			{ title: "A", page: 1 }, { title: "A.1", page: 1 }, { title: "", page: 3 }, { title: "B", page: 7 }, { title: "stray", page: 2 },
		]);
		assert.deepEqual(out, [{ title: "A", page: 1 }, { title: "B", page: 7 }]);
	});
	it("builds the detect excerpt and strips page headers", () => {
		const ex = buildChapterDetectExcerpt(["p1 text", "p2 text", "", "Chapter 3\nbody"], 2);
		assert.equal(ex, "===== PAGE 1 =====\np1 text\n===== PAGE 2 =====\np2 text\n[page 4] Chapter 3");
		assert.equal(plainChapterText("--- Page 3 ---\nhello\n--- Page 4 ---\nworld"), "hello\nworld");
	});
});
