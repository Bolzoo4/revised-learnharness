// Material-before-web guard and retrieval bounds (REQ-ex-05, REQ-ex-09). Adversarial cases first.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXAM_LIMITS, acceptedHits, afterSearch, afterWebCall, clampK, clampTokens, emptyExchange, webRefusal } from "../src/core/ext/exam-session/guard.ts";

describe("search_web guard (REQ-ex-09)", () => {
	it("refuses web search before any search_material call in the exchange", () => {
		assert.notEqual(webRefusal(emptyExchange()), null);
	});
	it("refuses web search after a search that found accepted passages", () => {
		const s = afterSearch(emptyExchange(), 2);
		assert.notEqual(webRefusal(s), null);
	});
	it("a search that found nothing accepted opens web search, once", () => {
		let s = afterSearch(emptyExchange(), 0);
		assert.equal(webRefusal(s), null);
		s = afterWebCall(s);
		assert.notEqual(webRefusal(s), null, "the per-exchange web limit is reached");
	});
	it("a later material hit closes web search again: the material answered", () => {
		const s = afterSearch(afterSearch(emptyExchange(), 0), 1);
		assert.notEqual(webRefusal(s), null);
	});
	it("the limit is a constant the tests can see", () => {
		assert.equal(EXAM_LIMITS.webCallsPerExchange, 1);
	});
	it("refusals are fixed text the model can act on", () => {
		assert.match(webRefusal(emptyExchange()) ?? "", /search_material/);
	});
});

describe("accepted hits", () => {
	it("counts only hits with text and a positive score", () => {
		const hits = [
			{ materialId: "m", title: "t", page: 1, text: "ok", score: 2 },
			{ materialId: "m", title: "t", page: 2, text: "   ", score: 3 },
			{ materialId: "m", title: "t", page: 3, text: "zero score", score: 0 },
			{ materialId: "m", title: "t", page: 4, text: "nan", score: Number.NaN },
		];
		assert.equal(acceptedHits(hits).length, 1);
	});
	it("an empty or junk result is nothing accepted", () => {
		assert.equal(acceptedHits([]).length, 0);
		assert.equal(acceptedHits(null as unknown as never[]).length, 0);
	});
});

describe("retrieval bounds (REQ-ex-05)", () => {
	it("K defaults to 5 and never exceeds 5, whatever the call asks", () => {
		assert.equal(clampK(undefined), 5);
		assert.equal(clampK(100), 5);
		assert.equal(clampK(Number.MAX_SAFE_INTEGER), 5);
		assert.equal(clampK(0), 1);
		assert.equal(clampK(-3), 1);
	});
	it("a non-number or a fraction falls back or floors, never throws", () => {
		assert.equal(clampK("many"), 5);
		assert.equal(clampK(Number.NaN), 5);
		assert.equal(clampK(2.9), 2);
	});
	it("the token cap defaults to 1500 and stays within 100 to 1500", () => {
		assert.equal(clampTokens(undefined), 1500);
		assert.equal(clampTokens(1_000_000), 1500);
		assert.equal(clampTokens(1), 100);
		assert.equal(clampTokens({}), 1500);
	});
});
