import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { designationOf, parseOfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";

const T = "2026-11-04T10:00:00.000Z";
const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m)",
	stance: "matches",
	...over,
});

describe("office-hours events", () => {
	const hash = "a".repeat(64);
	it("round-trips and resolves the latest designation of a chat", () => {
		const d1 = parseOfficeHoursEvent({ type: "designated", chatId: "c1", label: "L1", sha256: hash, at: T })!;
		const d2 = parseOfficeHoursEvent({ type: "designated", chatId: "c1", label: "L2", sha256: hash, exercise: { setId: "s", exerciseId: "e" }, at: T })!;
		const v = parseOfficeHoursEvent({ type: "verdict", chatId: "c1", outcome: "differs", items: [item({})], discarded: 1, at: T })!;
		assert.equal(designationOf([d1, v, d2], "c1")?.label, "L2");
		assert.equal(designationOf([d1], "other"), null);
	});
	it("rejects malformed events", () => {
		assert.equal(parseOfficeHoursEvent({ type: "designated", chatId: "c", label: "L", sha256: "xyz", at: T }), null);
		assert.equal(parseOfficeHoursEvent({ type: "verdict", chatId: "c", outcome: "correct", items: [], discarded: 0, at: T }), null);
	});
});
