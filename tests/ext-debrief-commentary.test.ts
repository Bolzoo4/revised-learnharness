// tests/ext-debrief-commentary.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCommentary, COMMENTARY_HEADINGS, MAX_PART_CHARS, renderCommentary, type Commentary } from "../src/core/ext/debrief/commentary.ts";

const ok: Commentary = { observations: "You did 12 reviews (reviews = 12).", stateOfLearning: "Goal A is 4/10 solid.", critique: "Reviews were skipped on two days.", suggestion: "Start with the 3 due dialogic items." };

describe("commentary structure (REQ-deb-04)", () => {
	it("renders the four parts in a fixed order under fixed headings", () => {
		const md = renderCommentary(ok);
		const order = Object.values(COMMENTARY_HEADINGS).map((h) => md.indexOf(`## ${h}`));
		assert.ok(order.every((i) => i >= 0));
		assert.deepEqual([...order].sort((a, b) => a - b), order);
		assert.match(md, /reviews = 12/);
	});
	it("flags every missing, blank, non-string or oversized part", () => {
		assert.deepEqual(checkCommentary(ok), []);
		assert.equal(checkCommentary({ ...ok, critique: "   " }).length, 1);
		assert.equal(checkCommentary({ ...ok, suggestion: undefined }).length, 1);
		assert.equal(checkCommentary({ ...ok, observations: 7 as unknown as string }).length, 1);
		assert.equal(checkCommentary({ ...ok, stateOfLearning: "x".repeat(MAX_PART_CHARS + 1) }).length, 1);
		assert.equal(checkCommentary({}).length, 4);
	});
	it("refuses to render an unusable commentary", () => {
		assert.throws(() => renderCommentary({ ...ok, critique: "" }), /critique is empty/);
	});
	it("a part cannot open its own headings: such a commentary is refused, not stored", () => {
		assert.throws(() => renderCommentary({ ...ok, critique: "# Fake heading\nBody\n\n\n\nMore" }), /critique contains a heading/);
	});
});
