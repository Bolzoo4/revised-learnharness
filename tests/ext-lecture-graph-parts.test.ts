import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRAPH_PART_CHARS, splitForGraphImport } from "../src/core/ext/lecture/graph-parts.ts";

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");

describe("splitForGraphImport", () => {
	it("gives no part for an empty chapter and one part for a short one", () => {
		assert.deepEqual(splitForGraphImport(""), []);
		assert.deepEqual(splitForGraphImport("  \n\n  "), []);
		assert.deepEqual(splitForGraphImport("A short chapter.\n\nWith two paragraphs."), ["A short chapter.\n\nWith two paragraphs."]);
	});
	it("packs paragraphs up to the limit and never splits a paragraph that fits", () => {
		const a = "a".repeat(5000);
		const b = "b".repeat(5000);
		const c = "c".repeat(100);
		const parts = splitForGraphImport([a, b, c].join("\n\n"), 8000);
		assert.deepEqual(parts, [a, `${b}\n\n${c}`]);
	});
	it("hard-splits a paragraph longer than the limit at a space, and keeps every part within the limit", () => {
		const text = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
		const parts = splitForGraphImport(text, 1000);
		assert.ok(parts.length > 1);
		assert.ok(parts.every((p) => p.length <= 1000));
		assert.deepEqual(parts.flatMap(words), words(text));
	});
	it("is deterministic, so a retry re-reads the same parts", () => {
		const text = Array.from({ length: 3000 }, (_, i) => `token${i}`).join(" ") + "\n\n" + "x".repeat(20000);
		assert.deepEqual(splitForGraphImport(text), splitForGraphImport(text));
	});
	it("uses 8000 characters by default, well under the notes chunk budget", () => {
		assert.equal(GRAPH_PART_CHARS, 8000);
		const parts = splitForGraphImport("y".repeat(20000));
		assert.ok(parts.every((p) => p.length <= GRAPH_PART_CHARS));
	});
});
