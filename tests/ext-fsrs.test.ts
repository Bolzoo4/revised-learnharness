// tests/ext-fsrs.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { implicitCredit, newCard, recallProbability, reviewCard } from "../src/core/ext/fsrs.ts";

const T0 = "2026-11-04T10:00:00.000Z";
const DAY = 86_400_000;
const after = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

describe("fsrs wrapper", () => {
	it("a first Good review schedules whole days ahead (no learning steps)", () => {
		const card = reviewCard(newCard(T0), 3, T0, 0.9);
		assert.ok(card.stability > 0);
		assert.ok(card.scheduled_days >= 1);
		assert.equal(card.due.getTime(), Date.parse(T0) + card.scheduled_days * DAY);
	});

	it("is deterministic", () => {
		const a = reviewCard(reviewCard(newCard(T0), 3, T0, 0.9), 3, after(T0, 3), 0.9);
		const b = reviewCard(reviewCard(newCard(T0), 3, T0, 0.9), 3, after(T0, 3), 0.9);
		assert.deepEqual(a, b);
	});

	it("a higher desired retention schedules a nearer due date", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const lo = reviewCard(base, 3, after(T0, 3), 0.8);
		const hi = reviewCard(base, 3, after(T0, 3), 0.95);
		assert.ok(hi.scheduled_days < lo.scheduled_days);
	});

	it("recall probability is 0 for a card never reviewed, 1 at review time, and falls with time", () => {
		assert.equal(recallProbability(null, T0), 0);
		assert.equal(recallProbability(newCard(T0), T0), 0);
		const card = reviewCard(newCard(T0), 3, T0, 0.9);
		assert.equal(recallProbability(card, T0), 1);
		const later = recallProbability(card, after(T0, 5));
		assert.ok(later < 1 && later > 0);
		assert.ok(recallProbability(card, after(T0, 20)) < later);
	});

	it("implicit credit moves stability by w times the gap to a real Good review", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const at = after(T0, 3);
		const real = reviewCard(base, 3, at, 0.9).stability;
		const half = implicitCredit(base, at, 0.9, 0.5);
		const full = implicitCredit(base, at, 0.9, 1);
		assert.ok(Math.abs(half.stability - (base.stability + 0.5 * (real - base.stability))) < 1e-9);
		assert.ok(Math.abs(full.stability - real) < 1e-9);
		assert.equal(implicitCredit(base, at, 0.9, 0).stability, base.stability);
	});

	it("implicit credit leaves difficulty and counters alone, and restarts the clock", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const at = after(T0, 3);
		const c = implicitCredit(base, at, 0.9, 0.5);
		assert.equal(c.difficulty, base.difficulty);
		assert.equal(c.reps, base.reps);
		assert.equal(c.lapses, base.lapses);
		assert.equal(c.last_review?.toISOString(), at);
		assert.ok(c.due.getTime() > Date.parse(at));
	});
});
