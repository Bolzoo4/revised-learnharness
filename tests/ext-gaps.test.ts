// tests/ext-gaps.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findGaps, reachFromGoals, type GapInput } from "../src/core/ext/gaps.ts";
import type { Goal } from "../src/core/ext/goals.ts";
import { DEFAULT_RESEARCH_CONFIG } from "../src/core/ext/research-config.ts";

// scope of t = t, p1, p2, q. Nodes above the scope: u1 (distance 1), u2 (2), u3 (3). lone is unreachable.
const chains = [
	{ premises: ["p1", "p2"], conclusion: "t" },
	{ premises: ["q"], conclusion: "p1" },
	{ premises: ["t"], conclusion: "u1" },
	{ premises: ["u1"], conclusion: "u2" },
	{ premises: ["u2"], conclusion: "u3" },
];
const nodes = ["t", "p1", "p2", "q", "u1", "u2", "u3", "lone"].map((id) => ({ id, name: `name-${id}` }));
const goal = (over: Partial<Goal> = {}): Goal => ({
	id: "goal_1",
	title: "g",
	origin: "user",
	originRef: "",
	targetNodeIds: ["t"],
	priority: 3,
	status: "active",
	createdAt: "t",
	updatedAt: "t",
	...over,
});

function input(over: Partial<GapInput> = {}): GapInput {
	return {
		goals: [goal()],
		chains,
		nodes,
		trust: new Map(),
		weakNodeIds: [],
		uncovered: [],
		marks: [],
		markSpendUsd: new Map(),
		config: DEFAULT_RESEARCH_CONFIG,
		...over,
	};
}

describe("reach", () => {
	it("scope nodes are at distance 0; others by hops; the best goal wins", () => {
		const r = reachFromGoals([goal()], chains, 0.5);
		assert.equal(r.get("t")!.distance, 0);
		assert.equal(r.get("q")!.distance, 0);
		assert.equal(r.get("u1")!.distance, 1);
		assert.equal(r.get("u3")!.distance, 3);
		assert.equal(r.has("lone"), false);
		assert.equal(r.get("u1")!.weight, 3 * 0.5);
		const two = reachFromGoals([goal(), goal({ id: "goal_2", priority: 5, targetNodeIds: ["u1"] })], chains, 0.5);
		assert.equal(two.get("u1")!.weight, 5); // priority 5 at distance 0 beats 3 at distance 1
	});

	it("ignores goals that are not active", () => {
		assert.equal(reachFromGoals([goal({ status: "paused" })], chains, 0.5).size, 0);
	});
});

describe("findGaps", () => {
	it("is deterministic: same input, same ordered output", () => {
		const a = findGaps(input());
		assert.deepEqual(a, findGaps(input()));
		assert.deepEqual(a.map((g) => g.id), [...a].sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1)).map((g) => g.id));
	});

	it("no-premises gaps: scope nodes with no concluding chain, scored priority x weight", () => {
		const gaps = findGaps(input());
		assert.equal(gaps.find((g) => g.id === "no-premises:p2")!.score, 3 * 1 * 1);
		assert.equal(gaps.find((g) => g.id === "no-premises:q")!.score, 3);
		assert.equal(gaps.some((g) => g.id === "no-premises:t"), false);
		assert.equal(gaps.some((g) => g.nodeId === "u1"), false); // outside the scope: no such gap type
	});

	it("depth limit: weak premises beyond the default depth 2 are dropped; an expand mark with a depth raises it", () => {
		const base = input({ weakNodeIds: ["u1", "u3"] });
		const gaps = findGaps(base);
		assert.equal(gaps.find((g) => g.id === "weak-premise:u1")!.score, 3 * 0.8 * 0.5);
		assert.equal(gaps.some((g) => g.nodeId === "u3"), false);
		const raised = findGaps({ ...base, marks: [{ id: "m", scope: { kind: "node", id: "u3" }, mark: "expand", maxDepth: 5, note: "", author: "user", at: "t" }] });
		assert.equal(raised.find((g) => g.nodeId === "u3")!.score, 3 * 0.8 * 0.125 * 2);
	});

	it("stop excludes a region; hold keeps verification gaps only", () => {
		const stop = findGaps(input({ marks: [{ id: "m", scope: { kind: "goal", id: "goal_1" }, mark: "stop", note: "", author: "user", at: "t" }] }));
		assert.deepEqual(stop.filter((g) => g.nodeId === "p2"), []);
		const hold = findGaps(input({ marks: [{ id: "m", scope: { kind: "node", id: "p2" }, mark: "hold", note: "", author: "user", at: "t" }] }));
		const p2 = hold.filter((g) => g.nodeId === "p2");
		assert.deepEqual(p2.map((g) => g.type), ["unverified"]);
		assert.equal(p2[0]!.markId, "m");
	});

	it("expand multiplies the score", () => {
		const base = findGaps(input()).find((g) => g.id === "no-premises:p2")!.score;
		const boosted = findGaps(input({ marks: [{ id: "m", scope: { kind: "node", id: "p2" }, mark: "expand", note: "", author: "agent", at: "t" }] }))
			.find((g) => g.id === "no-premises:p2")!.score;
		assert.equal(boosted, base * DEFAULT_RESEARCH_CONFIG.expandBoost);
	});

	it("an exhausted mark budget turns expansion off for that region", () => {
		const marks = [{ id: "m", scope: { kind: "node" as const, id: "p2" }, mark: "expand" as const, budgetUsd: 1, note: "", author: "user" as const, at: "t" }];
		const open = findGaps(input({ marks, markSpendUsd: new Map([["m", 0.5]]) }));
		assert.equal(open.some((g) => g.nodeId === "p2"), true);
		const spent = findGaps(input({ marks, markSpendUsd: new Map([["m", 1]]) }));
		assert.equal(spent.some((g) => g.nodeId === "p2" && g.class === "expansion"), false);
		assert.equal(spent.some((g) => g.nodeId === "p2" && g.class === "verification"), true); // an exhausted budget is a hold
	});

	it("verification gaps: unverified in scope, contested without primary support within reach", () => {
		const trust = new Map([
			["p2", { trust: "sourced" as const, hasPrimarySupport: true }],
			["u1", { trust: "contested" as const, hasPrimarySupport: false }],
			["u2", { trust: "contested" as const, hasPrimarySupport: true }],
		]);
		const gaps = findGaps(input({ trust }));
		assert.equal(gaps.some((g) => g.id === "unverified:p2"), false);
		assert.equal(gaps.some((g) => g.id === "unverified:t"), true);
		assert.equal(gaps.find((g) => g.id === "contested-no-primary:u1")!.score, 3 * 0.9 * 0.5);
		assert.equal(gaps.some((g) => g.nodeId === "u2"), false);
	});

	it("weak premises count only when reachable; one gap per node keeps the best score", () => {
		const gaps = findGaps(input({ weakNodeIds: ["p2", "lone"] }));
		assert.equal(gaps.some((g) => g.nodeId === "lone"), false);
		const p2 = gaps.filter((g) => g.nodeId === "p2");
		assert.equal(p2.length, 1);
		assert.equal(p2[0]!.type, "no-premises"); // weight 1 beats weak-premise 0.8
	});

	it("uncovered chats become nodeless gaps", () => {
		const gaps = findGaps(input({ uncovered: [{ chatId: "chat_1", title: "Lesson", messages: 2 }, { chatId: "chat_2", title: "Empty", messages: 0 }] }));
		const u = gaps.filter((g) => g.type === "uncovered");
		assert.deepEqual(u.map((g) => g.id), ["uncovered:chat_1"]);
		assert.equal(u[0]!.score, 3 * 0.7);
		assert.equal(u[0]!.nodeId, undefined);
	});

	it("with no active goal only uncovered chats yield gaps (default priority)", () => {
		const gaps = findGaps(input({ goals: [], uncovered: [{ chatId: "c", title: "t", messages: 1 }] }));
		assert.deepEqual(gaps.map((g) => g.id), ["uncovered:c"]);
		assert.equal(gaps[0]!.score, 3 * 0.7);
	});
});
