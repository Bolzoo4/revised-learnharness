// tests/ext-review-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveGoals } from "../src/core/ext/goals.ts";
import { computePlan, goalReadinessReport, nextItem } from "../src/core/ext/review-queries.ts";
import {
	applyExerciseResult, approveCard, createUserCard, proposeAgentCard, recordReview, retireCard,
	ReviewInputError, setChannelPin, setGoalRetention, setPinned, setRetired, snapshot,
} from "../src/core/ext/review-service.ts";
import { addGoal, chain, harness, node, type Harness } from "./helpers/ext-memory-stores.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T10:00:00.000Z";
const later = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();
const DAY_START = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;

/** a, b are facts; c is concluded from a and b. */
function world(): Harness {
	const h = harness({ nodes: [node("a"), node("b"), node("c")], chains: [chain("arg_1", ["a", "b"], "c")], now: T0 });
	addGoal(h, "goal_1", ["c"]);
	return h;
}
const fixedReview = (h: Harness, nodeId: string, rating = 3, durationSec = 15) =>
	recordReview({ nodeId, channel: "fixed", rating, durationSec }, h.deps);

describe("ReviewInputError", () => {
	const kindOf = (fn: () => unknown): string | undefined => {
		try {
			fn();
		} catch (e) {
			return e instanceof ReviewInputError ? e.kind : `other:${String(e)}`;
		}
		return undefined;
	};
	it("tells an unknown target (unknown) from a rule violation (invalid)", () => {
		const h = world();
		assert.equal(kindOf(() => fixedReview(h, "ghost")), "unknown");
		assert.equal(kindOf(() => setPinned("ghost", true, h.deps)), "unknown");
		assert.equal(kindOf(() => setGoalRetention("nope", 0.9, h.deps)), "unknown");
		assert.equal(kindOf(() => approveCard("nope", h.deps)), "unknown");
		assert.equal(kindOf(() => fixedReview(h, "a", 7)), "invalid");
		assert.equal(kindOf(() => setGoalRetention("goal_1", 0.99, h.deps)), "invalid");
		assert.equal(kindOf(() => applyExerciseResult({ goalId: "goal_1", results: [] }, h.deps)), "invalid");
	});
});

describe("recordReview", () => {
	it("appends a review event and returns the next due date", () => {
		const h = world();
		const res = fixedReview(h, "a");
		assert.equal(h.review.events.length, 1);
		assert.equal(h.review.events[0]?.type, "review");
		assert.ok(Date.parse(res.dueAt) > Date.parse(T0));
	});

	it("rejects an unknown node, a bad rating and a negative duration without writing", () => {
		const h = world();
		assert.throws(() => fixedReview(h, "ghost"), /unknown node/);
		assert.throws(() => fixedReview(h, "a", 7), /rating/);
		assert.throws(() => fixedReview(h, "a", 3, -1), /durationSec/);
		assert.equal(h.review.events.length, 0);
	});

	it("rejects weak premises on a fixed review, or ones that are not premises of the node", () => {
		const h = world();
		assert.throws(() => recordReview({ nodeId: "c", channel: "fixed", rating: 3, durationSec: 5, weakPremises: ["a"] }, h.deps), /dialogic/);
		assert.throws(() => recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 5, weakPremises: ["zzz"] }, h.deps), /not a premise/);
		assert.equal(h.review.events.length, 0);
	});

	it("a successful dialogic review credits every premise that has a state and is not weak (REQ-pl-09)", () => {
		const h = world();
		fixedReview(h, "a");
		fixedReview(h, "b");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100, weakPremises: ["b"] }, h.deps);
		assert.deepEqual(res.credited, ["a"]);
		assert.deepEqual(res.penalised, []);
		const implicit = h.review.events.filter((e) => e.type === "implicit");
		assert.equal(implicit.length, 1);
		assert.deepEqual(implicit[0], { type: "implicit", nodeId: "a", viaNodeId: "c", outcome: "credit", at: later(3) });
	});

	it("a Hard (2) dialogic review still counts as a success for the premises", () => {
		const h = world();
		fixedReview(h, "a");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 2, durationSec: 100 }, h.deps);
		assert.deepEqual(res.credited, ["a"]);
	});

	it("a failed dialogic review penalises ONLY the premises flagged weak", () => {
		const h = world();
		fixedReview(h, "a");
		fixedReview(h, "b");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 1, durationSec: 100, weakPremises: ["b"] }, h.deps);
		assert.deepEqual(res.penalised, ["b"]);
		assert.deepEqual(res.credited, []);
		const snap = snapshot(h.deps, h.clock.now);
		assert.equal(snap.states.get("b")?.card.lapses, 1);
		assert.equal(snap.states.get("a")?.card.lapses, 0);
	});

	it("a failed dialogic review with no weak premise penalises nobody", () => {
		const h = world();
		fixedReview(h, "a");
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 1, durationSec: 100 }, h.deps);
		assert.deepEqual(res.penalised, []);
		assert.equal(h.review.events.filter((e) => e.type === "implicit").length, 0);
	});

	it("never credits a premise that has no state yet", () => {
		const h = world();
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100 }, h.deps);
		assert.deepEqual(res.credited, []);
	});

	it("records the weak premises and the question on the dialogic event, and never writes the content graph (REQ-pl-15)", () => {
		const h = world();
		recordReview({ nodeId: "c", channel: "dialogic", rating: 2, durationSec: 100, question: "Why does b matter?", weakPremises: ["b"] }, h.deps);
		const ev = h.review.events[0];
		assert.equal(ev?.type === "review" && ev.question, "Why does b matter?");
		assert.deepEqual(ev?.type === "review" && ev.weakPremises, ["b"]);
		assert.equal(h.deps.graphStore.readNodes().length, 3);
		assert.equal(h.deps.graphStore.readChains().length, 1);
	});
});

describe("cards", () => {
	it("a user card is active at once; an agent card is a draft until approved (REQ-pl-02, REQ-pl-03)", () => {
		const h = world();
		const user = createUserCard({ nodeId: "a", question: "Q1", answer: "A1" }, h.deps);
		const agent = proposeAgentCard({ nodeId: "b", question: "Q2", answer: "A2" }, h.deps);
		assert.equal(computePlan(h.deps, DAY_START(T0)).snap.cards.find((c) => c.id === user)?.status, "active");
		const plan = () => computePlan(h.deps, DAY_START(T0)).plan;
		assert.equal(plan().items.some((i) => i.nodeId === "b"), false, "a draft is not scheduled");
		assert.ok(plan().needsCard.includes("b"));
		approveCard(agent, h.deps);
		assert.equal(plan().items.some((i) => i.nodeId === "b"), true);
		retireCard(agent, h.deps);
		assert.equal(plan().items.some((i) => i.nodeId === "b"), false);
	});

	it("only a draft can be approved; unknown cards and nodes are rejected", () => {
		const h = world();
		const user = createUserCard({ nodeId: "a", question: "Q", answer: "A" }, h.deps);
		assert.throws(() => approveCard(user, h.deps), /draft/);
		assert.throws(() => approveCard("nope", h.deps), /unknown card/);
		assert.throws(() => createUserCard({ nodeId: "ghost", question: "Q", answer: "A" }, h.deps), /unknown node/);
		assert.throws(() => proposeAgentCard({ nodeId: "ghost", question: "Q", answer: "A" }, h.deps), /unknown node/);
	});
});

describe("plan and next item", () => {
	it("serves a chain node through dialogic review with its premises, then a fact through its card (REQ-pl-06, REQ-pl-07)", () => {
		// ids chosen so the chain node sorts first among equal-priority new nodes
		const h = harness({ nodes: [node("c0"), node("p1"), node("p2")], chains: [chain("arg_1", ["p1", "p2"], "c0")], now: T0 });
		addGoal(h, "goal_1", ["c0"]);
		createUserCard({ nodeId: "p1", question: "What is p1?", answer: "It is p1." }, h.deps);
		createUserCard({ nodeId: "p2", question: "What is p2?", answer: "It is p2." }, h.deps);
		const first = nextItem(h.deps, DAY_START(T0));
		assert.equal(first.kind, "item");
		if (first.kind !== "item") return;
		assert.equal(first.nodeId, "c0");
		assert.equal(first.channel, "dialogic");
		assert.deepEqual(first.premises.map((p) => p.id), ["p1", "p2"]);
		assert.equal(first.card, undefined);
		assert.equal(first.trust, "unverified");
		recordReview({ nodeId: "c0", channel: "dialogic", rating: 3, durationSec: 100 }, h.deps);
		const second = nextItem(h.deps, DAY_START(T0));
		assert.equal(second.kind, "item");
		if (second.kind !== "item") return;
		assert.equal(second.channel, "fixed");
		assert.equal(second.card?.question, `What is ${second.nodeId}?`);
		assert.equal(second.remainingItems, 2);
	});

	it("tells the dialogic agent what it asked last time so it asks a new question", () => {
		const h = world();
		recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100, question: "Q one" }, h.deps);
		h.clock.now = later(30);
		const item = nextItem(h.deps, DAY_START(h.clock.now));
		assert.equal(item.kind, "item");
		if (item.kind === "item" && item.nodeId === "c") assert.deepEqual(item.recentQuestions, ["Q one"]);
	});

	it("is empty when nothing is plannable, and reports the nodes that need a card", () => {
		const h = harness({ nodes: [node("a")], now: T0 });
		addGoal(h, "goal_1", ["a"]);
		const item = nextItem(h.deps, DAY_START(T0));
		assert.deepEqual(item, { kind: "empty", deferred: 0, needsCard: ["a"] });
	});

	it("paused goals leave the deck but keep their state (REQ-pl-13)", () => {
		const h = world();
		fixedReview(h, "a");
		h.goals.appendEvent({ type: "status", goalId: "goal_1", status: "paused", at: T0 });
		h.clock.now = later(30);
		const { plan, snap } = computePlan(h.deps, DAY_START(h.clock.now));
		assert.deepEqual(plan.items, []);
		assert.equal(snap.states.has("a"), true);
	});

	it("a derivable node leaves the deck unless pinned (REQ-pl-10)", () => {
		const h = world();
		fixedReview(h, "a", 4);
		fixedReview(h, "b", 4);
		const ids = () => computePlan(h.deps, DAY_START(T0)).plan.items.map((i) => i.nodeId);
		assert.equal(ids().includes("c"), false);
		setPinned("c", true, h.deps);
		assert.equal(ids().includes("c"), true);
	});

	it("a retired node leaves the deck; pinning brings it back (and the reverse)", () => {
		const h = world();
		createUserCard({ nodeId: "a", question: "Q", answer: "A" }, h.deps);
		const has = () => computePlan(h.deps, DAY_START(T0)).plan.items.some((i) => i.nodeId === "a");
		assert.equal(has(), true);
		setRetired("a", true, h.deps);
		assert.equal(has(), false);
		setPinned("a", true, h.deps);
		assert.equal(has(), true);
		setRetired("a", true, h.deps);
		assert.equal(has(), false);
	});

	it("a channel pin moves a chain node to the fixed channel", () => {
		const h = world();
		createUserCard({ nodeId: "c", question: "Q", answer: "A" }, h.deps);
		setChannelPin("c", "fixed", h.deps);
		const item = computePlan(h.deps, DAY_START(T0)).plan.items.find((i) => i.nodeId === "c");
		assert.equal(item?.channel, "fixed");
		setChannelPin("c", null, h.deps);
		assert.equal(computePlan(h.deps, DAY_START(T0)).plan.items.find((i) => i.nodeId === "c")?.channel, "dialogic");
	});

	it("events for a node deleted from the graph are ignored", () => {
		const h = world();
		fixedReview(h, "a");
		const graph = h.deps.graphStore as unknown as { rewriteLedgers(n: { nodes: ReturnType<typeof node>[] }): void };
		graph.rewriteLedgers({ nodes: [node("b"), node("c")] });
		assert.equal(snapshot(h.deps, T0).states.has("a"), false);
	});
});

describe("retention per goal (REQ-pl-08)", () => {
	it("a higher retention gives a nearer due date for the same history", () => {
		const dueWith = (retention: number | null): number => {
			const h = world();
			if (retention !== null) setGoalRetention("goal_1", retention, h.deps);
			fixedReview(h, "a");
			h.clock.now = later(3);
			fixedReview(h, "a");
			return snapshot(h.deps, h.clock.now).states.get("a")!.card.scheduled_days;
		};
		assert.ok(dueWith(0.95) < dueWith(null));
		assert.ok(dueWith(0.8) > dueWith(null));
	});
	it("rejects an out-of-range retention and an unknown goal", () => {
		const h = world();
		assert.throws(() => setGoalRetention("goal_1", 0.99, h.deps), /retention/);
		assert.throws(() => setGoalRetention("nope", 0.9, h.deps), /unknown goal/);
	});
});

describe("applyExerciseResult (REQ-pl-14)", () => {
	it("passing every target marks the goal reached and credits the nodes", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }, { nodeId: "a", outcome: "passed" }] }, h.deps);
		assert.equal(res.reached, true);
		assert.equal(deriveGoals(h.goals.events)[0]?.status, "reached");
		const ex = h.review.events.filter((e) => e.type === "review" && e.channel === "exercise");
		assert.equal(ex.length, 2);
		assert.equal(snapshot(h.deps, T0).states.has("c"), true);
	});

	it("a weak or failed node reopens it as due and does not reach the goal", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }, { nodeId: "a", outcome: "weak" }] }, h.deps);
		assert.equal(res.reached, false);
		assert.equal(deriveGoals(h.goals.events)[0]?.status, "active");
		const a = h.review.events.find((e) => e.type === "review" && e.nodeId === "a");
		assert.equal(a?.type === "review" && a.rating, 1);
	});

	it("a passed set that misses a target does not reach the goal", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "a", outcome: "passed" }] }, h.deps);
		assert.equal(res.reached, false);
	});

	it("validates before writing: unknown goal, unknown node, empty set, non-active goal", () => {
		const h = world();
		assert.throws(() => applyExerciseResult({ goalId: "nope", results: [{ nodeId: "c", outcome: "passed" }] }, h.deps), /unknown goal/);
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "ghost", outcome: "passed" }] }, h.deps), /unknown node/);
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [] }, h.deps), /at least one/);
		h.goals.appendEvent({ type: "status", goalId: "goal_1", status: "paused", at: T0 });
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }] }, h.deps), /active/);
		assert.equal(h.review.events.length, 0);
	});
});

describe("goalReadinessReport", () => {
	it("reports the solid fraction of each active goal's scope", () => {
		const h = world();
		for (const id of ["a", "b", "c"]) fixedReview(h, id, 4);
		const [r] = goalReadinessReport(h.deps);
		assert.equal(r?.goalId, "goal_1");
		assert.equal(r?.total, 3);
		assert.equal(r?.solid, 3);
		assert.equal(r?.ready, true);
	});
});
