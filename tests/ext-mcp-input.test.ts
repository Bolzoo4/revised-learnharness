// tests/ext-mcp-input.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureOf, INTERNAL_MESSAGE, ToolError } from "../src/core/ext/mcp/errors.ts";
import {
	instantMs, optionalEnum, optionalInt, parseDepth, parseInstant, parseLocalDate, plainObject, requireId, requireQuery, requireText,
} from "../src/core/ext/mcp/input.ts";
import { capText, clampLimit, fitToBudget, page, round1, round4, textPage } from "../src/core/ext/mcp/limits.ts";

const code = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return e instanceof ToolError ? e.code : `other:${String(e)}`;
	}
	return "no error";
};

describe("limits (REQ-mcp-08)", () => {
	it("clampLimit: invalid values mean the default, big values are capped", () => {
		for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 2.5, "5", null, {}]) assert.equal(clampLimit(bad, 20, 50), 20);
		assert.equal(clampLimit(1, 20, 50), 1);
		assert.equal(clampLimit(50, 20, 50), 50);
		assert.equal(clampLimit(51, 20, 50), 50);
		assert.equal(clampLimit(1_000_000, 20, 50), 50);
	});

	it("fitToBudget drops items from the end until the serialized page fits, and says so", () => {
		const p = page(["a".repeat(100), "b".repeat(100), "c".repeat(100)], 3);
		assert.deepEqual(fitToBudget(p, 10_000), p);
		const fit = fitToBudget(p, 250);
		assert.equal(fit.count, 2);
		assert.equal(fit.truncated, true);
		assert.deepEqual(fitToBudget(p, 5), { items: [], count: 0, truncated: true });
	});

	it("capText leaves a fitting text alone and marks a cut explicitly", () => {
		assert.equal(capText("abc", 3), "abc");
		assert.equal(capText("abcd", 3), "abc… [truncated: 1 more characters]");
		assert.equal(capText("", 3), "");
	});

	it("capText never ends in half a surrogate pair", () => {
		const emoji = "a😀b"; // a, high, low, b
		assert.equal(capText(emoji, 2), "a… [truncated: 3 more characters]");
		assert.equal(capText(emoji, 3), "a😀… [truncated: 1 more characters]");
	});

	it("page reports count and truncated; a zero or negative limit yields an empty page", () => {
		assert.deepEqual(page([1, 2, 3], 2), { items: [1, 2], count: 2, truncated: true });
		assert.deepEqual(page([1, 2], 2), { items: [1, 2], count: 2, truncated: false });
		assert.deepEqual(page([], 5), { items: [], count: 0, truncated: false });
		assert.deepEqual(page([1], 0), { items: [], count: 0, truncated: true });
		assert.deepEqual(page([1], -4), { items: [], count: 0, truncated: true });
	});

	it("textPage caps every item", () => {
		const p = textPage(["abcdef", "x"], 5, 3);
		assert.equal(p.items[0], "abc… [truncated: 3 more characters]");
		assert.equal(p.items[1], "x");
	});

	it("numbers are finite or null", () => {
		assert.equal(round4(Number.NaN), null);
		assert.equal(round4(Number.POSITIVE_INFINITY), null);
		assert.equal(round4(0.123456), 0.1235);
		assert.equal(round1(Number.NaN), 0);
		assert.equal(round1(2.449), 2.4);
	});
});

describe("input validation", () => {
	it("requireId: exact, non-blank, bounded, no control characters", () => {
		assert.equal(requireId("n_1", "id"), "n_1");
		assert.equal(requireId(" n_1", "id"), " n_1"); // not trimmed: it simply will not be found
		for (const bad of [undefined, null, 5, {}, [], "", "   ", "a\nb", "a\u0000b", "x".repeat(201)]) assert.equal(code(() => requireId(bad, "id")), "invalid_input");
	});

	it("requireQuery collapses whitespace and refuses empty or oversized queries", () => {
		assert.equal(requireQuery("  sigma \t algebra\n"), "sigma algebra");
		assert.equal(requireQuery("a\u0000b"), "a b");
		for (const bad of [undefined, 5, "", "   ", "\n\t", "x".repeat(201), "a b c d e f g h i"]) assert.equal(code(() => requireQuery(bad)), "invalid_input");
		assert.equal(requireQuery("a b c d e f g h"), "a b c d e f g h");
	});

	it("optionalEnum and optionalInt are closed", () => {
		assert.equal(optionalEnum(undefined, ["a", "b"] as const, "f"), undefined);
		assert.equal(optionalEnum("a", ["a", "b"] as const, "f"), "a");
		for (const bad of ["c", "", 1, null, "A", "toString", "__proto__"]) assert.equal(code(() => optionalEnum(bad, ["a", "b"] as const, "f")), "invalid_input");
		assert.equal(optionalInt(undefined, "n", 1, 5), undefined);
		assert.equal(optionalInt(3, "n", 1, 5), 3);
		for (const bad of [0, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) assert.equal(code(() => optionalInt(bad, "n", 1, 5)), "invalid_input");
	});

	it("parseDepth is 1 or 2, default 1", () => {
		assert.equal(parseDepth(undefined), 1);
		assert.equal(parseDepth(2), 2);
		for (const bad of [0, 3, 1.5, "1", null, Number.NaN]) assert.equal(code(() => parseDepth(bad)), "invalid_input");
	});

	it("parseLocalDate accepts real calendar dates only", () => {
		assert.equal(parseLocalDate("2026-11-04", "date").iso, "2026-11-04");
		assert.equal(parseLocalDate("2028-02-29", "date").day, 29); // leap year
		for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "0050-01-01", "2026-1-4", "26-11-04", "2026-11-04T00:00:00Z", "", 20261104, null, undefined]) {
			assert.equal(code(() => parseLocalDate(bad, "date")), "invalid_input", String(bad));
		}
	});

	it("parseInstant needs an explicit zone and normalises to UTC", () => {
		assert.equal(parseInstant("2026-11-04T10:00:00Z", "since"), "2026-11-04T10:00:00.000Z");
		assert.equal(parseInstant("2026-11-04T10:00:00+01:00", "since"), "2026-11-04T09:00:00.000Z");
		assert.equal(parseInstant("2026-11-04T10:00Z", "since"), "2026-11-04T10:00:00.000Z");
		for (const bad of ["2026-11-04", "2026-11-04T10:00:00", "garbage 2026", "2026-13-04T10:00:00Z", "2026-11-04T25:00:00Z", "", 5, null]) {
			assert.equal(code(() => parseInstant(bad, "since")), "invalid_input", String(bad));
		}
	});

	it("parseInstant refuses impossible calendar dates (Date.parse would roll them over)", () => {
		for (const bad of ["2026-02-30T10:00:00Z", "2027-02-29T10:00:00+01:00", "2026-04-31T00:00:00Z", "2026-11-31T23:59:59.999Z", "2026-00-10T10:00:00Z"]) {
			assert.equal(code(() => parseInstant(bad, "since")), "invalid_input", bad);
		}
		assert.equal(parseInstant("2028-02-29T10:00:00Z", "since"), "2028-02-29T10:00:00.000Z", "a real leap day");
	});

	it("instantMs never yields NaN", () => {
		assert.equal(instantMs("not a date"), Number.NEGATIVE_INFINITY);
		assert.equal(instantMs("2026-11-04T10:00:00.000Z"), Date.parse("2026-11-04T10:00:00.000Z"));
	});

	it("plainObject: absent is {}, arrays and primitives are refused", () => {
		assert.deepEqual(plainObject(undefined), {});
		assert.deepEqual(plainObject(null), {});
		assert.deepEqual(plainObject({ a: 1 }), { a: 1 });
		for (const bad of [[], [1], "x", 5, true]) assert.equal(code(() => plainObject(bad)), "invalid_input");
	});
});

describe("failureOf (no error leakage)", () => {
	it("keeps a ToolError's code and fixed message", () => {
		assert.deepEqual(failureOf(new ToolError("not_found", "No node.")), { error: { code: "not_found", message: "No node." } });
	});
	it("turns anything else into the generic internal failure", () => {
		const leaky = Object.assign(new Error("ENOENT: no such file /Users/secret/x"), { code: "ENOENT" });
		assert.deepEqual(failureOf(leaky), { error: { code: "internal", message: INTERNAL_MESSAGE } });
		assert.deepEqual(failureOf("a string"), { error: { code: "internal", message: INTERNAL_MESSAGE } });
		assert.deepEqual(failureOf(undefined), { error: { code: "internal", message: INTERNAL_MESSAGE } });
	});
});
