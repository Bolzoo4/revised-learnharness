// tests/ext-daily-plan.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeReviewStats, dailyPlan, DEFAULT_PLAN_PARAMS, type PlanInput } from "../src/core/ext/daily-plan.ts";
import type { DeckEntry } from "../src/core/ext/deck.ts";
import { newCard, reviewCard } from "../src/core/ext/fsrs.ts";
import type { NodeState } from "../src/core/ext/review-state.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T08:00:00.000Z";
const NOW = "2026-11-10T08:00:00.000Z"; // 6 days after T0: every card reviewed at T0 with Good is due
const DAY_START = "2026-11-10T00:00:00.000Z";

const entry = (nodeId: string, over: Partial<DeckEntry> = {}): DeckEntry => ({
	nodeId, priority: 3, pinned: false, channelPin: null, hasChain: false, ...over,
});
function reviewedAt(nodeId: string, at: string, rating: 1 | 2 | 3 | 4 = 3): NodeState {
	return { nodeId, card: reviewCard(newCard(at), rating, at, 0.9), fixedReviews: 1 };
}
function input(over: Partial<PlanInput> & { deck: DeckEntry[] }): PlanInput {
	return {
		now: NOW,
		states: new Map(),
		stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 0, dialogicToday: 0 },
		hasActiveCard: () => true,
		params: DEFAULT_PLAN_PARAMS,
		...over,
	};
}
const ids = (items: Array<{ nodeId: string }>) => items.map((i) => i.nodeId);

describe("computeReviewStats", () => {
	const ev = (channel: "fixed" | "dialogic" | "exercise", durationSec: number, at: string): ReviewEvent => ({
		type: "review", nodeId: "n", channel, rating: 3, durationSec, at,
	});
	it("takes medians per channel from real reviews only, and sums time since the day start", () => {
		const stats = computeReviewStats(
			[ev("fixed", 10, T0), ev("fixed", 30, T0), ev("fixed", 20, NOW), ev("dialogic", 100, NOW), ev("exercise", 0, NOW)],
			DAY_START,
		);
		assert.equal(stats.medianSec.fixed, 20);
		assert.equal(stats.medianSec.dialogic, 100);
		assert.equal(stats.spentTodaySec, 120);
		assert.equal(stats.dialogicToday, 1);
	});
	it("has no median before there is data", () => {
		assert.deepEqual(computeReviewStats([], DAY_START).medianSec, { fixed: null, dialogic: null });
	});
});

describe("dailyPlan quota (REQ-pl-11)", () => {
	it("defaults: 25 min / 20 s = 75 cards of capacity; new quota = capacity - due", () => {
		const deck = [...Array.from({ length: 80 }, (_, i) => entry(`n${String(i).padStart(3, "0")}`))];
		const states = new Map([["n000", reviewedAt("n000", T0)], ["n001", reviewedAt("n001", T0)]]);
		const plan = dailyPlan(input({ deck, states }));
		assert.equal(plan.capacity, 75);
		assert.equal(plan.due, 2);
		assert.equal(plan.newQuota, 73);
		assert.equal(plan.items.length, 75);
		assert.equal(plan.deferred.length, 0);
	});

	it("the quota is zero when due exceeds 1.5 x capacity", () => {
		const deck = Array.from({ length: 5 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const params = { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 }; // capacity 3 at 20 s; 5 due > 4.5
		const plan = dailyPlan(input({ deck: [...deck, entry("zz-new")], states, params }));
		assert.equal(plan.capacity, 3);
		assert.equal(plan.due, 5);
		assert.equal(plan.newQuota, 0);
		assert.equal(ids(plan.items).includes("zz-new"), false);
	});

	it("at due == capacity the quota is zero but nothing is deferred beyond the budget", () => {
		const deck = Array.from({ length: 3 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const plan = dailyPlan(input({ deck: [...deck, entry("zz-new")], states, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 } }));
		assert.equal(plan.newQuota, 0);
		assert.equal(plan.items.length, 3);
	});

	it("time already spent today shrinks the remaining budget", () => {
		const plan = dailyPlan(input({
			deck: [entry("a")],
			stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 1500 - 40, dialogicToday: 0 },
		}));
		assert.equal(plan.remainingSec, 40);
		assert.equal(plan.capacity, 2);
	});

	it("uses the observed median once it exists", () => {
		const plan = dailyPlan(input({
			deck: [entry("a")],
			stats: { medianSec: { fixed: 50, dialogic: null }, spentTodaySec: 0, dialogicToday: 0 },
		}));
		assert.equal(plan.capacity, 30);
	});
});

describe("dailyPlan order and deferral (REQ-pl-12)", () => {
	it("orders due items by goal priority, then by forgetting risk", () => {
		const deck = [entry("low-risk-hi", { priority: 5 }), entry("lo", { priority: 1 }), entry("high-risk-hi", { priority: 5 })];
		const states = new Map([
			["low-risk-hi", reviewedAt("low-risk-hi", "2026-11-08T08:00:00.000Z")],
			["lo", reviewedAt("lo", T0)],
			["high-risk-hi", reviewedAt("high-risk-hi", T0)],
		]);
		// make "low-risk-hi" due too: force its due date into the past
		states.get("low-risk-hi")!.card.due = new Date(Date.parse(NOW) - 1000);
		const plan = dailyPlan(input({ deck, states }));
		assert.deepEqual(ids(plan.items), ["high-risk-hi", "low-risk-hi", "lo"]);
	});

	it("defers what does not fit the time, in order, and never drops it", () => {
		const deck = Array.from({ length: 6 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const plan = dailyPlan(input({ deck, states, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 } }));
		assert.equal(plan.items.length, 3);
		assert.equal(plan.deferred.length, 3);
		assert.deepEqual(ids([...plan.items, ...plan.deferred]).sort(), deck.map((d) => d.nodeId).sort());
	});

	it("does not list a card that is not yet due", () => {
		const states = new Map([["a", reviewedAt("a", NOW)]]);
		assert.deepEqual(dailyPlan(input({ deck: [entry("a")], states })).items, []);
	});

	it("is deterministic (REQ-pl-16)", () => {
		const deck = [entry("b"), entry("a")];
		assert.deepEqual(dailyPlan(input({ deck })), dailyPlan(input({ deck })));
	});
});

describe("dailyPlan channel assignment (REQ-pl-05)", () => {
	const chained = (n: number) => Array.from({ length: n }, (_, i) => entry(`c${i}`, { hasChain: true }));

	it("a fact is fixed; a chain-concluded node is dialogic up to the daily cap, then falls back to fixed", () => {
		const plan = dailyPlan(input({ deck: [entry("fact"), ...chained(7)] }));
		const channelOf = (id: string) => plan.items.find((i) => i.nodeId === id)?.channel;
		assert.equal(channelOf("fact"), "fixed");
		assert.equal(plan.items.filter((i) => i.channel === "dialogic").length, 5);
		assert.equal(channelOf("c4"), "dialogic");
		assert.equal(channelOf("c5"), "fixed");
	});

	it("dialogic reviews already done today use up the cap", () => {
		const plan = dailyPlan(input({
			deck: chained(3),
			stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 0, dialogicToday: 4 },
		}));
		assert.equal(plan.items.filter((i) => i.channel === "dialogic").length, 1);
	});

	it("a pinned channel wins, even beyond the cap", () => {
		const deck = [...chained(5), entry("f", { hasChain: true, channelPin: "fixed" }), entry("d", { channelPin: "dialogic" })];
		const plan = dailyPlan(input({ deck }));
		assert.equal(plan.items.find((i) => i.nodeId === "f")?.channel, "fixed");
		assert.equal(plan.items.find((i) => i.nodeId === "d")?.channel, "dialogic");
	});

	it("a node needing the fixed channel but with no active card is reported, not planned", () => {
		const plan = dailyPlan(input({ deck: [entry("nocard"), entry("ok")], hasActiveCard: (id) => id === "ok" }));
		assert.deepEqual(plan.needsCard, ["nocard"]);
		assert.deepEqual(ids(plan.items), ["ok"]);
	});

	it("a dialogic review costs its median, so fewer fit the budget", () => {
		const deck = chained(5);
		const plan = dailyPlan(input({ deck, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 360 } }));
		assert.equal(plan.items.length, 2); // 2 x 180 s
		assert.equal(plan.deferred.length, 3);
	});
});
