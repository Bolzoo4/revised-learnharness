// Solution status (REQ-ex-08): pure rules, adversarial cases first.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSolution, normalizeAnswer, sameAnswer, MIN_QUOTE_CHARS } from "../src/core/ext/exam-session/solution.ts";

const EXAM = "Let f(x)=x^2. The derivative of x^2 is 2x, so at x=3 the value is 6 and the tangent has slope 6.";
const CANDIDATE = { steps: "The derivative of x squared is 2x, so at x equal to 3 it is 6.", finalAnswer: "6" };
const SECOND = { approach: "limit definition", steps: "(f(3+h)-f(3))/h = (6h+h^2)/h -> 6 as h->0", finalAnswer: "6" };

describe("normalizeAnswer", () => {
	it("ignores case, whitespace, dollar signs, math delimiters and a trailing period", () => {
		assert.equal(normalizeAnswer(" $ X = 6 $. "), "x=6");
		assert.equal(normalizeAnswer("\\( 6 \\)"), "6");
	});
	it("keeps the content: different numbers stay different", () => {
		assert.equal(sameAnswer("6", "7"), false);
		assert.equal(sameAnswer("", ""), false, "an empty answer agrees with nothing");
	});
});

describe("checkSolution: status (REQ-ex-08)", () => {
	it("is exam only when the presented text is a verbatim (normalised) part of the exam's own solution", () => {
		const r = checkSolution({ candidate: { steps: "The derivative of x^2 is 2x, so at x=3 the value is 6 and the tangent has slope 6.", finalAnswer: "6" }, examSolution: EXAM, supported: false });
		assert.equal(r.status, "exam");
	});
	it("a short answer that happens to appear in the exam solution is NOT an exam solution (no false upgrade)", () => {
		const r = checkSolution({ candidate: { steps: "6", finalAnswer: "6" }, examSolution: EXAM, supported: false });
		assert.notEqual(r.status, "exam");
		assert.ok(MIN_QUOTE_CHARS >= 20, "the quote floor is what stops trivial matches");
	});
	it("a rewritten solution is not exam, even when it gets the same answer", () => {
		const r = checkSolution({ candidate: CANDIDATE, examSolution: EXAM, supported: false });
		assert.notEqual(r.status, "exam");
	});
	it("with no exam solution the status is never exam", () => {
		const r = checkSolution({ candidate: { steps: EXAM, finalAnswer: "6" }, examSolution: undefined, supported: false });
		assert.notEqual(r.status, "exam");
		const blank = checkSolution({ candidate: { steps: EXAM, finalAnswer: "6" }, examSolution: "   ", supported: false });
		assert.notEqual(blank.status, "exam");
	});
	it("material needs a supporting passage the code can see", () => {
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: true }).status, "material");
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: false }).status, "unverified");
	});
	it("derived needs a second derivation that agrees on the final answer", () => {
		assert.equal(checkSolution({ candidate: { ...CANDIDATE, approach: "product rule" }, supported: false, second: SECOND }).status, "derived");
	});
	it("a second derivation with the same approach or the same steps is not independent", () => {
		const sameApproach = { ...SECOND, approach: "Product Rule" };
		assert.equal(checkSolution({ candidate: { ...CANDIDATE, approach: "product rule" }, supported: false, second: sameApproach }).status, "unverified");
		const copiedSteps = { ...SECOND, steps: CANDIDATE.steps };
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: false, second: copiedSteps }).status, "unverified");
	});
	it("a second derivation that disagrees, or gives no answer, does not make it derived", () => {
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: false, second: { ...SECOND, finalAnswer: "7" } }).status, "unverified");
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: false, second: { ...SECOND, finalAnswer: " " } }).status, "unverified");
		assert.equal(checkSolution({ candidate: { steps: "x", finalAnswer: "" }, supported: false, second: SECOND }).status, "unverified");
	});
	it("no downgrade: an exam-quoted solution stays exam whatever the other evidence says", () => {
		const r = checkSolution({ candidate: { steps: "The derivative of x^2 is 2x, so at x=3 the value is 6 and the tangent has slope 6.", finalAnswer: "9" }, examSolution: EXAM, supported: false, second: { ...SECOND, finalAnswer: "9" } });
		assert.equal(r.status, "exam");
	});
	it("material beats derived, and derived beats unverified", () => {
		assert.equal(checkSolution({ candidate: CANDIDATE, supported: true, second: SECOND }).status, "material");
	});
});
