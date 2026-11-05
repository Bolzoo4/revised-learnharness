// tests/ext-explanation-batches.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BATCH_SIZE, planBatches } from "../src/core/ext/explanation-batches.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("planBatches (REQ-node-04)", () => {
	it("groups connected nodes together instead of cutting by id order", () => {
		// n1-n3 are connected, n2-n4 are connected; plain id order would give [n1,n2],[n3,n4]
		const batches = planBatches(["n1", "n2", "n3", "n4"], [c(["n1"], "n3"), c(["n2"], "n4")], 2);
		assert.deepEqual(batches, [
			["n1", "n3"],
			["n2", "n4"],
		]);
	});

	it("walks a chain breadth-first from the smallest id and cuts into batches of the given size", () => {
		const chains = [c(["a"], "b"), c(["b"], "c"), c(["c"], "d")];
		assert.deepEqual(planBatches(["a", "b", "c", "d", "e"], chains, 3), [
			["a", "b", "c"],
			["d", "e"],
		]);
	});

	it("only connects nodes that are both requested", () => {
		assert.deepEqual(planBatches(["a", "c"], [c(["a"], "b"), c(["b"], "c")], 1), [["a"], ["c"]]);
	});

	it("de-duplicates, handles empty input and defaults the size", () => {
		assert.deepEqual(planBatches([], []), []);
		assert.deepEqual(planBatches(["a", "a"], []), [["a"]]);
		const many = Array.from({ length: DEFAULT_BATCH_SIZE + 1 }, (_, i) => `n${String(i).padStart(2, "0")}`);
		const batches = planBatches(many, []);
		assert.equal(batches.length, 2);
		assert.equal(batches[0]?.length, DEFAULT_BATCH_SIZE);
	});

	it("covers every node exactly once", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		const flat = planBatches(ids, [c(["a", "b"], "c"), c(["c"], "g")], 3).flat();
		assert.deepEqual([...flat].sort(), ids);
	});

	it("rejects a batch size below 1", () => {
		assert.throws(() => planBatches(["a"], [], 0), RangeError);
		assert.throws(() => planBatches(["a"], [], 1.5), RangeError);
	});
});
