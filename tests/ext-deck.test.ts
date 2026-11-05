// tests/ext-deck.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimNodes, computeDeck, goalReadiness, isDerivable, premisesOf } from "../src/core/ext/deck.ts";
import type { Goal } from "../src/core/ext/goals.ts";
import type { Marks } from "../src/core/ext/review-state.ts";

const AT = "2026-11-04T10:00:00.000Z";
const goal = (id: string, targets: string[], over: Partial<Goal> = {}): Goal => ({
	id, title: id, origin: "user", originRef: "", targetNodeIds: targets, priority: 3, status: "active", createdAt: AT, updatedAt: AT, ...over,
});
const noMarks = (): Marks => ({ pinned: new Set(), retired: new Set(), channelPin: new Map(), retention: new Map() });
const chain = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("isDerivable (REQ-pl-10)", () => {
	const chains = [chain(["a", "b"], "c")];
	it("is true only when EVERY premise of some chain is at recall >= 0.85", () => {
		assert.equal(isDerivable("c", chains, () => 0.85), true);
		assert.equal(isDerivable("c", chains, (id) => (id === "a" ? 0.95 : 0.84)), false);
		assert.equal(isDerivable("c", chains, () => 0), false);
	});
	it("a fact (no chain) is never derivable", () => {
		assert.equal(isDerivable("a", chains, () => 1), false);
	});
	it("one solid alternative chain is enough", () => {
		const alt = [chain(["a", "b"], "c"), chain(["d"], "c")];
		assert.equal(isDerivable("c", alt, (id) => (id === "d" ? 0.9 : 0)), true);
	});
});

describe("computeDeck (umbrella REQ-review-02, REQ-pl-13)", () => {
	const chains = [chain(["a", "b"], "c")];
	const base = { chains, nodeIds: new Set(["a", "b", "c", "x"]), marks: noMarks(), recall: () => 0 };

	it("is the scope of active goals", () => {
		const deck = computeDeck({ ...base, goals: [goal("g1", ["c"])] });
		assert.deepEqual(deck.map((d) => d.nodeId), ["a", "b", "c"]);
		assert.equal(deck.find((d) => d.nodeId === "c")?.hasChain, true);
		assert.equal(deck.find((d) => d.nodeId === "a")?.hasChain, false);
	});

	it("excludes the nodes of a paused goal", () => {
		assert.deepEqual(computeDeck({ ...base, goals: [goal("g1", ["c"], { status: "paused" })] }), []);
	});

	it("drops a derivable node unless pinned, and drops retired unless pinned", () => {
		const solid = { ...base, goals: [goal("g1", ["c"])], recall: (id: string) => (id === "c" ? 0 : 0.9) };
		assert.deepEqual(computeDeck(solid).map((d) => d.nodeId), ["a", "b"]);
		const pinned = { ...solid, marks: { ...noMarks(), pinned: new Set(["c"]) } };
		assert.deepEqual(computeDeck(pinned).map((d) => d.nodeId), ["a", "b", "c"]);
		const retired = { ...base, goals: [goal("g1", ["c"])], marks: { ...noMarks(), retired: new Set(["a"]) } };
		assert.deepEqual(computeDeck(retired).map((d) => d.nodeId), ["b", "c"]);
	});

	it("adds a pinned node outside any goal, and ignores nodes that no longer exist", () => {
		const marks = { ...noMarks(), pinned: new Set(["x", "ghost"]) };
		assert.deepEqual(computeDeck({ ...base, goals: [], marks }).map((d) => d.nodeId), ["x"]);
	});

	it("carries the priority of the highest-priority goal containing the node", () => {
		const deck = computeDeck({ ...base, goals: [goal("g1", ["c"], { priority: 2 }), goal("g2", ["a"], { priority: 5 })] });
		assert.equal(deck.find((d) => d.nodeId === "a")?.priority, 5);
		assert.equal(deck.find((d) => d.nodeId === "b")?.priority, 2);
	});
});

describe("claimNodes (REQ-pl-08)", () => {
	it("a node in several goals takes the retention of its highest-priority goal", () => {
		const marks = { retention: new Map([["g_low", 0.8], ["g_high", 0.95]]) };
		const info = claimNodes([goal("g_low", ["a"], { priority: 1 }), goal("g_high", ["a"], { priority: 4 })], [], marks);
		assert.equal(info.get("a")?.retention, 0.95);
		assert.equal(info.get("a")?.priority, 4);
	});
	it("defaults to 0.9 and breaks priority ties by creation time", () => {
		const early = goal("g_early", ["a"], { createdAt: "2026-11-01T00:00:00.000Z" });
		const late = goal("g_late", ["a"], { createdAt: "2026-11-02T00:00:00.000Z" });
		const info = claimNodes([late, early], [], { retention: new Map([["g_late", 0.8]]) });
		assert.equal(info.get("a")?.retention, 0.9);
	});
});

describe("premisesOf and goalReadiness", () => {
	it("premisesOf unions the premises of all chains concluding the node, once each", () => {
		assert.deepEqual(premisesOf("c", [chain(["a", "b"], "c"), chain(["b", "d"], "c"), chain(["z"], "y")]), ["a", "b", "d"]);
	});
	it("a goal is ready when at least 80% of its scope is solid", () => {
		const scope = ["a", "b", "c", "d", "e"];
		assert.equal(goalReadiness(scope, (id) => (id === "e" ? 0 : 0.9)).ready, true);
		assert.equal(goalReadiness(scope, (id) => (id === "d" || id === "e" ? 0 : 0.9)).ready, false);
		assert.equal(goalReadiness([], () => 1).ready, false);
	});
});
