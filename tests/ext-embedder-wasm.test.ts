import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clsNormalize, meanPoolNormalize } from "../src/server/ext/embedder-wasm.ts";

const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));

describe("meanPoolNormalize", () => {
	it("averages only unmasked tokens and returns a unit vector", () => {
		// 3 tokens x dim 2; the last token is padding and must not count.
		const v = meanPoolNormalize([1, 0, 3, 0, 100, 100], [1n, 1n, 0n], 2);
		assert.ok(Math.abs(norm(v) - 1) < 1e-6);
		assert.ok(Math.abs(v[0]! - 1) < 1e-6 && Math.abs(v[1]!) < 1e-6);
	});
	it("refuses an all-masked input", () => {
		assert.throws(() => meanPoolNormalize([1, 2], [0], 2), /no tokens/);
	});
	it("keeps a zero vector instead of dividing by zero", () => {
		assert.deepEqual(Array.from(meanPoolNormalize([0, 0], [1], 2)), [0, 0]);
	});
});

describe("clsNormalize", () => {
	it("takes the first token and normalises it", () => {
		const v = clsNormalize([3, 4, 9, 9], 2);
		assert.ok(Math.abs(v[0]! - 0.6) < 1e-6 && Math.abs(v[1]! - 0.8) < 1e-6);
	});
});
