import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkVerdictItems, parseVerdictItem, verdictOutcome, type VerdictItem } from "../src/core/ext/practice/verdict.ts";

const SOURCE = "The sum of two even numbers is even because each is twice an integer.\nHence the sum is twice an integer, so it is even.";
const WORK = "Let a=2k and b=2m. Then a+b = 2(k+m), which is twice an integer.";

const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m), which is twice an integer",
	stance: "matches",
	...over,
});

describe("checkVerdictItems (REQ-lec-14)", () => {
	it("keeps an item whose quotes occur, normalized for case, spacing and hyphenation", () => {
		const r = checkVerdictItems([item({ sourceQuote: "EACH is   twice an integer" })], SOURCE, WORK);
		assert.equal(r.kept.length, 1);
		assert.deepEqual(r.discarded, []);
	});
	it("discards an invented source quotation", () => {
		const r = checkVerdictItems([item({ sourceQuote: "the proof is obviously correct as written" })], SOURCE, WORK);
		assert.deepEqual(r.discarded, [{ stepRef: "s1", reason: "quote_not_found" }]);
		assert.equal(r.kept.length, 0);
	});
	it("discards a too-short source quotation", () => {
		assert.equal(checkVerdictItems([item({ sourceQuote: "even" })], SOURCE, WORK).discarded[0]!.reason, "quote_too_short");
	});
	it("discards a too-short work quotation (same minimum as the source check) but not an empty `missing`", () => {
		assert.equal(checkVerdictItems([item({ workQuote: "a+b = 2(k+m)" })], SOURCE, WORK).discarded[0]!.reason, "work_quote_too_short");
		assert.equal(checkVerdictItems([item({ workQuote: "twice", stance: "differs" })], SOURCE, WORK).kept.length, 0);
		assert.equal(checkVerdictItems([item({ workQuote: "", stance: "missing" })], SOURCE, WORK).kept.length, 1);
	});
	it("work quotation boundary: exactly 20 characters is kept, 19 is dropped", () => {
		const work = "thereforeabcdefghijklmnopqrstuvwxyz";
		const twenty = "abcdefghijklmnopqrst";
		assert.equal(twenty.length, 20);
		assert.equal(checkVerdictItems([item({ workQuote: twenty })], SOURCE, work).kept.length, 1);
		const r = checkVerdictItems([item({ workQuote: twenty.slice(0, 19) })], SOURCE, work);
		assert.equal(r.kept.length, 0);
		assert.equal(r.discarded[0]!.reason, "work_quote_too_short");
	});
	it("discards matches/differs whose work quotation is not in the work, but not `missing`", () => {
		assert.equal(checkVerdictItems([item({ workQuote: "this was never written by the student" })], SOURCE, WORK).discarded[0]!.reason, "work_quote_not_found");
		assert.equal(checkVerdictItems([item({ workQuote: "", stance: "matches" })], SOURCE, WORK).discarded[0]!.reason, "work_quote_too_short");
		assert.equal(checkVerdictItems([item({ workQuote: "", stance: "missing" })], SOURCE, WORK).kept.length, 1);
	});
});

describe("verdictOutcome", () => {
	it("is not_verifiable with nothing kept, consistent when all match, differs otherwise", () => {
		assert.equal(verdictOutcome([]), "not_verifiable");
		assert.equal(verdictOutcome([item({})]), "consistent");
		assert.equal(verdictOutcome([item({}), item({ stance: "differs" })]), "differs");
		assert.equal(verdictOutcome([item({ stance: "missing", workQuote: "" })]), "differs");
	});
	it("parses items strictly", () => {
		assert.equal(parseVerdictItem({ ...item({}), stance: "correct" }), null);
		assert.equal(parseVerdictItem(null), null);
		assert.deepEqual(parseVerdictItem(item({})), item({}));
	});
});
