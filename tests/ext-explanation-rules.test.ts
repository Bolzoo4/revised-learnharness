// tests/ext-explanation-rules.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	concludingFingerprint,
	explanationForm,
	isComplex,
	isStale,
	premiseDepth,
} from "../src/core/ext/explanation-rules.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("concludingFingerprint", () => {
	it("is empty for a node no chain concludes", () => {
		assert.equal(concludingFingerprint("n_a", [c(["n_a"], "n_b")]), "");
	});

	it("ignores premise order, duplicates and chain order", () => {
		const one = concludingFingerprint("n_x", [c(["n_b", "n_a"], "n_x"), c(["n_c"], "n_x")]);
		const two = concludingFingerprint("n_x", [c(["n_c"], "n_x"), c(["n_a", "n_b", "n_a"], "n_x")]);
		assert.equal(one, two);
		assert.equal(one, "n_a,n_b|n_c");
	});

	it("changes when an argument is added or a premise changes, and ignores other conclusions", () => {
		const base = [c(["n_a"], "n_x")];
		const before = concludingFingerprint("n_x", base);
		assert.notEqual(concludingFingerprint("n_x", [...base, c(["n_b"], "n_x")]), before);
		assert.notEqual(concludingFingerprint("n_x", [c(["n_z"], "n_x")]), before);
		assert.equal(concludingFingerprint("n_x", [...base, c(["n_b"], "n_other")]), before);
	});
});

describe("isStale (REQ-node-03)", () => {
	it("is stale exactly when the stored fingerprint differs from the current chains", () => {
		const chains = [c(["n_a"], "n_x")];
		assert.equal(isStale({ fingerprint: "n_a" }, "n_x", chains), false);
		assert.equal(isStale({ fingerprint: "" }, "n_x", chains), true);
		assert.equal(isStale({ fingerprint: "n_a" }, "n_x", [...chains, c(["n_b"], "n_x")]), true);
	});
});

describe("premiseDepth and isComplex (REQ-node-06)", () => {
	const ladder = [c(["n_a"], "n_b"), c(["n_b"], "n_c"), c(["n_c"], "n_d")];

	it("depth counts the longest premise path", () => {
		assert.equal(premiseDepth("n_a", ladder), 0);
		assert.equal(premiseDepth("n_b", ladder), 1);
		assert.equal(premiseDepth("n_c", ladder), 2);
		assert.equal(premiseDepth("n_d", ladder), 3);
	});

	it("depth 3 is complex, depth 2 is not", () => {
		assert.equal(isComplex("n_d", ladder), true);
		assert.equal(isComplex("n_c", ladder), false);
	});

	it("a chain with 3 premises is complex, with 2 it is not, duplicates do not count", () => {
		assert.equal(isComplex("n_x", [c(["n_a", "n_b", "n_c"], "n_x")]), true);
		assert.equal(isComplex("n_x", [c(["n_a", "n_b"], "n_x")]), false);
		assert.equal(isComplex("n_x", [c(["n_a", "n_a", "n_b"], "n_x")]), false);
	});

	it("an alternative argument with 3 premises makes the node complex", () => {
		assert.equal(isComplex("n_x", [c(["n_a"], "n_x"), c(["n_b", "n_c", "n_d"], "n_x")]), true);
	});

	it("terminates on a cycle", () => {
		const loop = [c(["n_x"], "n_y"), c(["n_y"], "n_x")];
		assert.equal(Number.isFinite(premiseDepth("n_x", loop)), true);
	});

	it("explanationForm maps complexity to the long form", () => {
		assert.equal(explanationForm("n_d", ladder), "long");
		assert.equal(explanationForm("n_a", ladder), "short");
	});
});
