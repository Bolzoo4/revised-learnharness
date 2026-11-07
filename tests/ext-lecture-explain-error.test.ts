import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainChapterError, NO_SUBMIT_HINT } from "../src/core/ext/lecture/explain-error.ts";

const EXTRACTOR = "the extractor never submitted findings";

describe("explainChapterError", () => {
	it("shows a part repeated by the owner's six retries once, with its count", () => {
		const raw = Array.from({ length: 6 }, () => EXTRACTOR).join("; ");
		const out = explainChapterError(raw);
		assert.equal(out, `${EXTRACTOR} (x6). ${NO_SUBMIT_HINT}`);
		assert.equal(out.split(EXTRACTOR).length - 1, 1, "the phrase appears once");
	});
	it("adds the plain hint once for 'ended without calling' (outline and lecture stages)", () => {
		const out = explainChapterError("the model ended without calling submit_lecture");
		assert.equal(out, `the model ended without calling submit_lecture. ${NO_SUBMIT_HINT}`);
	});
	it("adds the hint once when both phrases appear, and not twice", () => {
		const out = explainChapterError("the model ended without calling submit_outline; the extractor never submitted findings");
		assert.equal(out.split(NO_SUBMIT_HINT).length - 1, 1);
		assert.ok(out.startsWith("the model ended without calling submit_outline; the extractor never submitted findings. "));
	});
	it("keeps the order of first appearance and drops blank parts", () => {
		assert.equal(explainChapterError("b; a;  ; b; a; c"), "b (x2); a (x2); c");
	});
	it("leaves an ordinary error alone, without the hint", () => {
		assert.equal(explainChapterError("lecture 1 stayed invalid after 3 attempts: unknown node n_ghost000"), "lecture 1 stayed invalid after 3 attempts: unknown node n_ghost000");
	});
	it("answers the hint alone when the text is only the stop phrase", () => {
		assert.equal(explainChapterError("never submitted"), `never submitted. ${NO_SUBMIT_HINT}`);
		assert.equal(explainChapterError(" ; "), "");
	});
});
