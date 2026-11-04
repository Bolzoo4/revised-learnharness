// tests/ext-quote.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkQuote, normalizeForMatch } from "../src/core/ext/quote.ts";

const SNAP = "The sum of the angles of a triangle in the Euclidean plane\nis equal to one hundred and eighty degrees.";

describe("normalizeForMatch", () => {
	it("collapses whitespace and lowercases", () => {
		assert.equal(normalizeForMatch("  The  Sum\n\tof  ", "join"), "the sum of");
	});
	it("joins a hyphenated line break in join mode and keeps the hyphen in keep mode", () => {
		assert.equal(normalizeForMatch("a well-\nknown fact", "join"), "a wellknown fact");
		assert.equal(normalizeForMatch("a well-\nknown fact", "keep"), "a well-known fact");
	});
	it("folds unicode forms: ligatures, typographic quotes and dashes, soft hyphen", () => {
		assert.equal(normalizeForMatch("ﬁnite ‘x’ “y” a–b co­op", "join"), "finite 'x' \"y\" a-b coop");
	});
});

describe("checkQuote", () => {
	it("accepts an exact substring", () => {
		assert.equal(checkQuote(SNAP, "sum of the angles of a triangle"), "ok");
	});
	it("accepts across a line break, case and spacing differences", () => {
		assert.equal(checkQuote(SNAP, "EUCLIDEAN  plane is equal to one hundred"), "ok");
	});
	it("accepts a compound word whose hyphen fell on a line break", () => {
		assert.equal(checkQuote("this is a well-\nknown theorem of analysis", "a well-known theorem of analysis"), "ok");
		assert.equal(checkQuote("this is an interna-\ntional theorem of analysis", "an international theorem of analysis"), "ok");
	});
	it("rejects text that is not in the snapshot", () => {
		assert.equal(checkQuote(SNAP, "the sum of the angles of a triangle is two hundred degrees"), "quote_not_found");
	});
	it("rejects a quote that is too short to mean anything", () => {
		assert.equal(checkQuote(SNAP, "the sum"), "quote_too_short");
		assert.equal(checkQuote(SNAP, "   "), "quote_too_short");
	});
	it("does not accept a reordered or paraphrased quote (exact match only)", () => {
		assert.equal(checkQuote(SNAP, "equal to one hundred and eighty degrees the sum of the angles"), "quote_not_found");
	});
});
