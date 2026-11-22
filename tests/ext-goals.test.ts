// tests/ext-goals.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_GOAL_PRIORITY,
	DEFAULT_WEIGHTS,
	activeScope,
	deriveGoals,
	goalScope,
	goalScopeWeighted,
	parseGoalEvent,
	validateWeights,
	type GoalEvent,
	type GoalWeights,
} from "../src/core/ext/goals.ts";

type LinkLike = { from: string; to: string; linkType: "evolution" | "sequence" | "case-of" | "part-of" | "analogy" | "contrast" };

const created = (goalId: string, targets: string[], at = "2026-11-04T10:00:00.000Z"): Extract<GoalEvent, { type: "created" }> => ({
	type: "created",
	goalId,
	title: `Goal ${goalId}`,
	origin: "user",
	originRef: "",
	targetNodeIds: targets,
	priority: DEFAULT_GOAL_PRIORITY,
	at,
});

describe("parseGoalEvent", () => {
	it("accepts a well-formed created event", () => {
		assert.deepEqual(parseGoalEvent(created("goal_a", ["n_1"])), created("goal_a", ["n_1"]));
	});
	it("accepts a status event", () => {
		const e = { type: "status", goalId: "goal_a", status: "paused", at: "t" };
		assert.deepEqual(parseGoalEvent(e), e);
	});
	it("rejects bad shapes", () => {
		const base = created("goal_a", ["n_1"]);
		for (const bad of [
			null,
			"x",
			{ ...base, goalId: "" },
			{ ...base, title: "" },
			{ ...base, origin: "web" },
			{ ...base, targetNodeIds: [] },
			{ ...base, targetNodeIds: [""] },
			{ ...base, priority: 0 },
			{ ...base, priority: 6 },
			{ ...base, priority: 2.5 },
			{ type: "status", goalId: "goal_a", status: "done", at: "t" },
			{ type: "other", goalId: "goal_a", at: "t" },
		]) {
			assert.equal(parseGoalEvent(bad), null, JSON.stringify(bad));
		}
	});
});

describe("deriveGoals", () => {
	it("starts active and applies status events in order", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ type: "status", goalId: "goal_a", status: "paused", at: "2026-11-04T11:00:00.000Z" },
			{ type: "status", goalId: "goal_a", status: "reached", at: "2026-11-04T12:00:00.000Z" },
		]);
		assert.equal(goals.length, 1);
		assert.equal(goals[0]?.status, "reached");
		assert.equal(goals[0]?.createdAt, "2026-11-04T10:00:00.000Z");
		assert.equal(goals[0]?.updatedAt, "2026-11-04T12:00:00.000Z");
	});
	it("ignores a duplicate created and a status for an unknown goal", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ ...created("goal_a", ["n_2"]), title: "other" },
			{ type: "status", goalId: "goal_zzz", status: "paused", at: "t" },
		]);
		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0]?.targetNodeIds, ["n_1"]);
		assert.equal(goals[0]?.title, "Goal goal_a");
	});
	it("keeps creation order", () => {
		const ids = deriveGoals([created("goal_b", ["n_1"]), created("goal_a", ["n_2"])]).map((g) => g.id);
		assert.deepEqual(ids, ["goal_b", "goal_a"]);
	});
});

describe("goalScope", () => {
	const chains = [
		{ premises: ["n_a", "n_b"], conclusion: "n_c" },
		{ premises: ["n_c", "n_d"], conclusion: "n_t" },
		{ premises: ["n_x"], conclusion: "n_unrelated" },
	];
	it("is the target plus the transitive premise closure", () => {
		assert.deepEqual(new Set(goalScope(["n_t"], chains)), new Set(["n_t", "n_c", "n_d", "n_a", "n_b"]));
	});
	it("is just the targets when no chain concludes them", () => {
		assert.deepEqual(goalScope(["n_solo"], chains), ["n_solo"]);
	});
	it("lists each id once and starts with the targets", () => {
		const out = goalScope(["n_t", "n_c"], chains);
		assert.equal(new Set(out).size, out.length);
		assert.deepEqual(out.slice(0, 2), ["n_t", "n_c"]);
	});
	it("terminates on a cycle", () => {
		const cyc = [
			{ premises: ["n_b"], conclusion: "n_a" },
			{ premises: ["n_a"], conclusion: "n_b" },
		];
		assert.deepEqual(new Set(goalScope(["n_a"], cyc)), new Set(["n_a", "n_b"]));
	});
});

describe("activeScope", () => {
	it("unions the scopes of active goals only", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_t"]),
			created("goal_b", ["n_other"]),
			{ type: "status", goalId: "goal_b", status: "paused", at: "t" },
		]);
		const chains = [{ premises: ["n_p"], conclusion: "n_t" }];
		assert.deepEqual(new Set(activeScope(goals, chains)), new Set(["n_t", "n_p"]));
	});
});

describe("weights (REQ-graph-agent-17)", () => {
	const ALL_KEYS = ["chain", "evolution", "sequence", "case-of", "part-of", "analogy", "contrast"];
	it("DEFAULT_WEIGHTS is 1 for every key", () => {
		assert.deepEqual(Object.keys(DEFAULT_WEIGHTS).sort(), [...ALL_KEYS].sort());
		assert.ok(Object.values(DEFAULT_WEIGHTS).every((w) => w === 1));
	});
	it("validateWeights fills missing keys with 1 and accepts boundary values", () => {
		const r = validateWeights({ chain: 0, analogy: 0.4 });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.weights.chain, 0);
			assert.equal(r.weights.analogy, 0.4);
			assert.equal(r.weights.evolution, 1);
		}
		assert.equal(validateWeights({ contrast: 1 }).ok, true);
		assert.equal(validateWeights({}).ok, true);
	});
	it("validateWeights rejects non-objects, non-numbers, NaN, out of range and unknown keys", () => {
		for (const bad of [null, "x", [], { chain: "0.5" }, { chain: NaN }, { chain: -0.1 }, { chain: 1.01 }, { chain: Infinity }, { cites: 0.5 }]) {
			const r = validateWeights(bad);
			assert.equal(r.ok, false, JSON.stringify(bad));
			if (!r.ok) assert.ok(r.problems.length > 0);
		}
	});
	it("a created event without weights still parses (old ledger) and with valid weights keeps them", () => {
		const old = created("goal_a", ["n_1"]);
		assert.deepEqual(parseGoalEvent(old), old);
		const withW = { ...created("goal_a", ["n_1"]), weights: { ...DEFAULT_WEIGHTS, analogy: 0 } };
		assert.deepEqual(parseGoalEvent(withW), withW);
		assert.equal(parseGoalEvent({ ...old, weights: { analogy: 2 } }), null);
	});
	it("accepts origin agent", () => {
		assert.equal(parseGoalEvent({ ...created("goal_a", ["n_1"]), origin: "agent" })?.type, "created");
		assert.equal(deriveGoals([{ ...created("goal_a", ["n_1"]), origin: "agent" }])[0]?.origin, "agent");
	});
	it("derives default weights for old events and the latest weights event wins", () => {
		assert.deepEqual(deriveGoals([created("goal_a", ["n_1"])])[0]?.weights, DEFAULT_WEIGHTS);
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ type: "weights", goalId: "goal_a", weights: { ...DEFAULT_WEIGHTS, chain: 0.5 }, at: "t1" },
			{ type: "weights", goalId: "goal_a", weights: { ...DEFAULT_WEIGHTS, chain: 0.2 }, at: "t2" },
			{ type: "weights", goalId: "goal_zzz", weights: DEFAULT_WEIGHTS, at: "t3" },
		]);
		assert.equal(goals[0]?.weights.chain, 0.2);
		assert.equal(goals[0]?.updatedAt, "t2");
	});
	it("parses a weights event and rejects an invalid one", () => {
		const e = { type: "weights", goalId: "goal_a", weights: { contrast: 0.3 }, at: "t" };
		assert.deepEqual(parseGoalEvent(e), { type: "weights", goalId: "goal_a", weights: { ...DEFAULT_WEIGHTS, contrast: 0.3 }, at: "t" });
		assert.equal(parseGoalEvent({ ...e, weights: { contrast: 7 } }), null);
		assert.equal(parseGoalEvent({ ...e, weights: { bogus: 0.1 } }), null);
	});
});

describe("goalScopeWeighted", () => {
	const chains = [
		{ premises: ["n_a", "n_b"], conclusion: "n_c" },
		{ premises: ["n_c"], conclusion: "n_t" },
	];
	const weighted = (targets: string[], over: Partial<GoalWeights>, cs = chains, links: LinkLike[] = []) =>
		goalScopeWeighted({ targetNodeIds: targets, weights: { ...DEFAULT_WEIGHTS, ...over } }, cs, links);

	it("targets weigh 1; chain-reached nodes weigh the chain weight", () => {
		const m = weighted(["n_t"], { chain: 0.7 });
		assert.equal(m.get("n_t"), 1);
		assert.equal(m.get("n_c"), 0.7);
		assert.equal(m.get("n_a"), 0.7);
		assert.equal(m.size, 4);
	});
	it("with all weights 1 and no links the keys equal goalScope", () => {
		const m = weighted(["n_t"], {});
		assert.deepEqual(new Set(m.keys()), new Set(goalScope(["n_t"], chains)));
		assert.ok([...m.values()].every((w) => w === 1));
	});
	it("a link from a scope node brings the other end in at the link weight", () => {
		const m = weighted(["n_t"], { analogy: 0.4 }, chains, [{ from: "n_t", to: "n_x", linkType: "analogy" }]);
		assert.equal(m.get("n_x"), 0.4);
	});
	it("a node reached by a chain (0.7) and a link (0.4) weighs the highest, 0.7", () => {
		const m = weighted(["n_t"], { chain: 0.7, analogy: 0.4 }, chains, [{ from: "n_t", to: "n_a", linkType: "analogy" }]);
		assert.equal(m.get("n_a"), 0.7);
		const m2 = weighted(["n_t"], { chain: 0.3, analogy: 0.9 }, chains, [{ from: "n_t", to: "n_a", linkType: "analogy" }]);
		assert.equal(m2.get("n_a"), 0.9);
	});
	it("weight 0 excludes: a zero chain weight drops the premises, a zero link weight drops the linked node", () => {
		const m = weighted(["n_t"], { chain: 0, analogy: 0 }, chains, [{ from: "n_t", to: "n_x", linkType: "analogy" }]);
		assert.deepEqual([...m.keys()], ["n_t"]);
	});
	it("links are followed to a fixpoint through link-added nodes, but add no chain premises of those nodes", () => {
		const cs = [{ premises: ["n_p"], conclusion: "n_x" }];
		const links: LinkLike[] = [
			{ from: "n_t", to: "n_y", linkType: "evolution" },
			{ from: "n_y", to: "n_z", linkType: "contrast" },
		];
		const m = weighted(["n_t"], { evolution: 0.6, contrast: 0.5 }, cs, links);
		assert.equal(m.get("n_y"), 0.6);
		assert.equal(m.get("n_z"), 0.5);
		assert.equal(m.has("n_p"), false);
	});
	it("a link whose endpoints are both outside the scope does nothing", () => {
		const m = weighted(["n_t"], {}, chains, [{ from: "n_u", to: "n_v", linkType: "analogy" }]);
		assert.equal(m.has("n_u"), false);
		assert.equal(m.has("n_v"), false);
	});
});

describe("parseGoalEvent: the idempotency key of an agent-created goal (REQ-graph-agent-08)", () => {
	const KEY = "a".repeat(64);
	const base = { type: "created", goalId: "goal_k", title: "T", origin: "agent", originRef: "T", targetNodeIds: ["n_1"], priority: 3, at: "2026-11-22T10:00:00.000Z" };

	it("keeps a valid idemKey", () => {
		assert.deepEqual(parseGoalEvent({ ...base, idemKey: KEY }), { ...base, idemKey: KEY } as never);
	});

	it("an event without idemKey (written before the key existed) still parses, with no key", () => {
		const parsed = parseGoalEvent(base) as Record<string, unknown>;
		assert.ok(parsed);
		assert.equal("idemKey" in parsed, false);
	});

	it("an idemKey that is not a non-empty string makes the event invalid", () => {
		assert.equal(parseGoalEvent({ ...base, idemKey: 7 }), null);
		assert.equal(parseGoalEvent({ ...base, idemKey: "" }), null);
	});
});

describe("parseGoalEvent: matchedExisting and identityChecked of an agent goal (REQ-graph-agent-27)", () => {
	const base = { type: "created", goalId: "goal_m", title: "T", origin: "agent", originRef: "T", targetNodeIds: ["n_1"], priority: 3, at: "2026-11-22T10:00:00.000Z" };

	it("keeps valid values, and an event without them still parses", () => {
		assert.equal((parseGoalEvent({ ...base, matchedExisting: 2, identityChecked: false }) as { matchedExisting?: number }).matchedExisting, 2);
		assert.ok(parseGoalEvent(base));
	});

	it("a negative or fractional matchedExisting, or a non-boolean identityChecked, makes the event invalid", () => {
		assert.equal(parseGoalEvent({ ...base, matchedExisting: -1 }), null);
		assert.equal(parseGoalEvent({ ...base, matchedExisting: 1.5 }), null);
		assert.equal(parseGoalEvent({ ...base, identityChecked: "yes" }), null);
	});
});
