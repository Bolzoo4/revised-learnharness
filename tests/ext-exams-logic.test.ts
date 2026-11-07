// tests/ext-exams-logic.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canMergeWithNext, collectionTitleValid, pageSpan, practiceEnabled, splitChoice } from "../components/ext/exams-logic.ts";

describe("splitChoice: the cut point comes from the text cursor", () => {
	const text = "Compute the limit. Then prove it.";

	it("accepts a cursor strictly inside the text, with some text on both sides", () => {
		assert.deepEqual(splitChoice(text, 18), { ok: true, at: 18 });
	});

	it("refuses when there is no cursor (null) and says where to put it", () => {
		const r = splitChoice(text, null);
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /cursor/);
	});

	it("refuses a cut at the very start or the very end (one side would be empty)", () => {
		assert.equal(splitChoice(text, 0).ok, false);
		assert.equal(splitChoice(text, text.length).ok, false);
	});

	it("refuses a cut that leaves a side with only whitespace", () => {
		assert.equal(splitChoice("   hello world", 2).ok, false, "the part before the cut is blank");
		assert.equal(splitChoice("hello world   ", 12).ok, false, "the part after the cut is blank");
		assert.equal(splitChoice("abc   def", 3).ok, true, "between the words: both sides have text");
		assert.equal(splitChoice("abc   def", 4).ok, true, "inside the blank run: both sides still have text");
	});

	it("refuses non-integer and out-of-range offsets", () => {
		assert.equal(splitChoice(text, 3.5).ok, false);
		assert.equal(splitChoice(text, -1).ok, false);
		assert.equal(splitChoice(text, text.length + 5).ok, false);
		assert.equal(splitChoice(text, Number.NaN).ok, false);
	});
});

describe("canMergeWithNext", () => {
	it("is possible for every exercise except the last one", () => {
		assert.equal(canMergeWithNext(0, 3), true);
		assert.equal(canMergeWithNext(1, 3), true);
		assert.equal(canMergeWithNext(2, 3), false);
	});
	it("is never possible with a single exercise or an out-of-range index", () => {
		assert.equal(canMergeWithNext(0, 1), false);
		assert.equal(canMergeWithNext(0, 0), false);
		assert.equal(canMergeWithNext(-1, 3), false);
	});
});

describe("pageSpan", () => {
	it("prints one page as p. N and a run as pp. A-B", () => {
		assert.equal(pageSpan({ pageStart: 4, pageEnd: 4 }), "p. 4");
		assert.equal(pageSpan({ pageStart: 4, pageEnd: 6 }), "pp. 4–6");
	});
});

describe("practiceEnabled: practice waits for the review (REQ-ex-03)", () => {
	it("is off until the exam is marked as reviewed", () => {
		assert.equal(practiceEnabled(false), false);
		assert.equal(practiceEnabled(true), true);
	});
});

describe("collectionTitleValid", () => {
	it("needs a title with something other than spaces", () => {
		assert.equal(collectionTitleValid(""), false);
		assert.equal(collectionTitleValid("   "), false);
		assert.equal(collectionTitleValid(" Analisi 1 "), true);
	});
});
