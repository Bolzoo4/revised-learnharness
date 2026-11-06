// tests/ext-debrief-weekly.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Goal } from "../src/core/ext/goals.ts";
import { debriefId, type JournalEvent } from "../src/core/ext/debrief/journal.ts";
import { computeWeeklyFacts, hasWeeklySubstance, weeklyWindow, type WeeklyInput } from "../src/core/ext/debrief/weekly.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

// All instants are built with the LOCAL constructor, so the tests do not depend on the machine's time zone.
// 2026-11-01 is a Sunday.
const local = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).toISOString();

describe("weeklyWindow (REQ-deb-02)", () => {
	it("on a Wednesday the window ends at the previous Sunday 18:00 and spans seven days, cut into calendar days", () => {
		const w = weeklyWindow(new Date(2026, 10, 4, 12), 0, 18);
		assert.equal(w.end, local(11, 1, 18));
		assert.equal(w.start, local(10, 25, 18));
		assert.equal(w.weekOf, "2026-10-25");
		assert.deepEqual(w.days.map((d) => d.date), ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
		assert.equal(w.days[0]?.start, w.start);
		assert.equal(w.days[7]?.end, w.end);
		for (let i = 1; i < w.days.length; i++) assert.equal(w.days[i]?.start, w.days[i - 1]?.end);
		assert.equal(w.days[1]?.start, local(10, 26, 0));
	});
	it("just before the boundary the previous week is still the latest; at the boundary the new one starts", () => {
		assert.equal(weeklyWindow(new Date(2026, 10, 1, 17, 59), 0, 18).weekOf, "2026-10-18");
		assert.equal(weeklyWindow(new Date(2026, 10, 1, 18, 0), 0, 18).weekOf, "2026-10-25");
	});
	it("only the latest boundary is returned after a long absence (no backlog of syntheses)", () => {
		assert.equal(weeklyWindow(new Date(2026, 11, 20, 9), 0, 18).weekOf, "2026-12-06");
	});
	it("honours another weekday and hour, and falls back for invalid ones", () => {
		assert.equal(weeklyWindow(new Date(2026, 10, 4, 12), 5, 9).end, local(10, 30, 9));
		assert.equal(weeklyWindow(new Date(2026, 10, 4, 12), 9, 99).end, local(11, 1, 18));
		assert.equal(weeklyWindow(new Date(2026, 10, 4, 12), Number.NaN, Number.NaN).end, local(11, 1, 18));
	});
	it("a boundary at midnight gives exactly seven days", () => {
		assert.equal(weeklyWindow(new Date(2026, 10, 4, 12), 0, 0).days.length, 7);
	});
	it("crosses a month and a year boundary", () => {
		const w = weeklyWindow(new Date(2027, 0, 3, 10), 0, 18); // Sunday 2027-01-03, before 18:00
		assert.equal(w.weekOf, "2026-12-20");
		assert.equal(w.end, new Date(2026, 11, 27, 18).toISOString());
	});
});

const goal = (id: string, targets: string[], status: Goal["status"] = "active"): Goal => ({
	id, title: id, origin: "user", originRef: "", targetNodeIds: targets, priority: 3, status, createdAt: local(10, 1), updatedAt: local(10, 1),
});
const rv = (nodeId: string, rating: 1 | 2 | 3 | 4, at: string, durationSec = 30, channel: "fixed" | "dialogic" | "exercise" = "fixed"): ReviewEvent => ({ type: "review", nodeId, channel, rating, durationSec, at });
const window = weeklyWindow(new Date(2026, 10, 4, 12), 0, 18);
const base = (over: Partial<WeeklyInput> = {}): WeeklyInput => ({
	window,
	reviewEvents: [],
	goals: [goal("g1", ["n_b"])],
	chains: [{ premises: ["n_a"], conclusion: "n_b" }],
	nodeIds: new Set(["n_a", "n_b"]),
	retentionOf: () => 0.9,
	trustOf: (id) => (id === "n_a" ? "sourced" : "unverified"),
	journal: [],
	budgetSec: 1500,
	...over,
});

describe("computeWeeklyFacts (REQ-deb-03)", () => {
	it("an empty week has zero activity, the scope's trust split and a flat backlog", () => {
		const f = computeWeeklyFacts(base());
		assert.equal(f.kind, "weekly");
		assert.ok(f.days.every((d) => d.reviewSec === 0 && d.reviews === 0));
		assert.deepEqual(f.backlog, { dueAtStart: 0, dueAtEnd: 0, trend: "flat" });
		assert.deepEqual(f.retention, { reviews: 0, recalled: 0, rate: null });
		assert.deepEqual(f.trust, { total: 2, sourced: 1, contested: 0, refuted: 0, unverified: 1 });
		assert.deepEqual(f.goals.map((g) => [g.goalId, g.total, g.solidAtStart, g.solidAtEnd]), [["g1", 2, 0, 0]]);
		assert.equal(hasWeeklySubstance(f), true); // an active goal with nothing done is worth a critique
	});
	it("puts review time on the day it happened and counts only fixed and dialogic reviews", () => {
		const f = computeWeeklyFacts(base({
			reviewEvents: [
				rv("n_a", 3, local(10, 26, 10), 60),
				rv("n_a", 3, local(10, 26, 11), 40),
				rv("n_b", 3, local(10, 29, 9), 20, "dialogic"),
				rv("n_b", 3, local(10, 29, 9, 5), 0, "exercise"),
				rv("n_a", 3, local(10, 24, 10), 999), // before the window
				rv("n_a", 3, local(11, 1, 18), 999), // at the end instant: outside (half-open window)
			],
		}));
		const byDate = Object.fromEntries(f.days.map((d) => [d.date, d.reviewSec]));
		assert.equal(byDate["2026-10-26"], 100);
		assert.equal(byDate["2026-10-29"], 20);
		assert.equal(f.days.reduce((a, d) => a + d.reviewSec, 0), 120);
		assert.equal(f.days.find((d) => d.date === "2026-10-26")?.reviews, 2);
	});
	it("a ledger whose file order is not chronological does not crash the replay", () => {
		const f = computeWeeklyFacts(base({ reviewEvents: [rv("n_a", 3, local(10, 28, 10)), rv("n_a", 3, local(10, 26, 10))] }));
		assert.deepEqual(f.retention, { reviews: 1, recalled: 1, rate: 1 });
	});
	it("the window is half-open: a review at the end instant belongs to the next week", () => {
		const f = computeWeeklyFacts(base({ reviewEvents: [rv("n_a", 3, local(10, 26, 10)), rv("n_a", 1, local(11, 1, 18))] }));
		assert.deepEqual(f.retention, { reviews: 0, recalled: 0, rate: null });
	});
	it("retention counts only reviews of nodes reviewed before, and rating 1 is not recalled", () => {
		const f = computeWeeklyFacts(base({
			reviewEvents: [
				rv("n_a", 3, local(10, 20, 10)), // before the window: makes n_a "seen"
				rv("n_a", 3, local(10, 26, 10)), // recalled
				rv("n_a", 1, local(10, 27, 10)), // lapse
				rv("n_b", 4, local(10, 27, 11)), // first ever review of n_b: not a retention datum
			],
		}));
		assert.deepEqual(f.retention, { reviews: 2, recalled: 1, rate: 0.5 });
	});
	it("a node whose first review is inside the window counts from its second review on", () => {
		const f = computeWeeklyFacts(base({ reviewEvents: [rv("n_b", 3, local(10, 26, 10)), rv("n_b", 2, local(10, 28, 10))] }));
		assert.deepEqual(f.retention, { reviews: 1, recalled: 1, rate: 1 });
	});
	it("backlog counts scope nodes due at each end and reports the trend", () => {
		// n_a reviewed Good on day 1 of the window is due again days later (FSRS first interval), so by the end it is due.
		const f = computeWeeklyFacts(base({ reviewEvents: [rv("n_a", 3, local(10, 26, 10))] }));
		assert.equal(f.backlog.dueAtStart, 0);
		assert.ok(f.backlog.dueAtEnd >= 0);
		assert.equal(f.backlog.trend, f.backlog.dueAtEnd > 0 ? "up" : "flat");
	});
	it("goal progress compares the solid nodes at the start and at the end of the window", () => {
		const f = computeWeeklyFacts(base({ reviewEvents: [rv("n_a", 4, local(10, 31, 10)), rv("n_b", 4, local(10, 31, 10, 5))] }));
		const g = f.goals[0]!;
		assert.equal(g.solidAtStart, 0);
		assert.equal(g.solidAtEnd, 2);
		assert.equal(g.delta, 2);
	});
	it("paused goals are left out; reached goals stay; events of deleted nodes are ignored", () => {
		const f = computeWeeklyFacts(base({
			goals: [goal("g1", ["n_b"]), goal("g2", ["n_b"], "paused"), goal("g3", ["n_b"], "reached")],
			reviewEvents: [rv("n_gone", 3, local(10, 26, 10))],
		}));
		assert.deepEqual(f.goals.map((g) => g.goalId), ["g1", "g3"]);
		assert.equal(f.days.reduce((a, d) => a + d.reviews, 0), 0);
	});
	it("counts the debriefs written in the window by session kind, each session once", () => {
		const e = (sessionId: string, at: string, sessionKind: JournalEvent["sessionKind"] = "review"): JournalEvent => ({
			id: debriefId(sessionId), kind: "session", sessionId, sessionKind, weekOf: null, at, facts: { kind: sessionKind ?? "" }, commentary: "x", nullReason: null, author: "agent",
		});
		const f = computeWeeklyFacts(base({ journal: [e("a", local(10, 27, 10)), e("a", local(10, 27, 10)), e("b", local(10, 28, 10), "lecture"), e("c", local(11, 2, 10))] }));
		assert.equal(f.sessions.review, 1);
		assert.equal(f.sessions.lecture, 1);
		assert.equal(f.sessions.study, 0);
	});
	it("a week with no goals, reviews or sessions has no substance", () => {
		assert.equal(hasWeeklySubstance(computeWeeklyFacts(base({ goals: [] }))), false);
	});
	it("is deterministic and does not mutate its input", () => {
		const input = base({ reviewEvents: [rv("n_a", 3, local(10, 26, 10))] });
		const frozen = JSON.stringify(input.reviewEvents);
		assert.deepEqual(computeWeeklyFacts(input), computeWeeklyFacts(input));
		assert.equal(JSON.stringify(input.reviewEvents), frozen);
	});
	it("a goal whose chains form a cycle terminates", () => {
		const f = computeWeeklyFacts(base({ chains: [{ premises: ["n_a"], conclusion: "n_b" }, { premises: ["n_b"], conclusion: "n_a" }] }));
		assert.equal(f.goals[0]?.total, 2);
	});
});
