// src/core/ext/debrief/weekly.ts
/**
 * @node ext/debrief/weekly
 * The weekly window and the weekly facts (REQ-deb-02, REQ-deb-03). Pure and
 * deterministic: the clock arrives as an argument and the week is computed
 * with LOCAL calendar arithmetic (the learner's Sunday evening, not UTC's).
 */

import type { GraphChain } from "../../contracts.ts";
import { DERIVABLE_RECALL } from "../deck.ts";
import { recallProbability } from "../fsrs.ts";
import { activeScope, goalScope, type Goal } from "../goals.ts";
import { DEFAULT_IMPLICIT_WEIGHT, deriveNodeStates } from "../review-state.ts";
import type { ReviewEvent } from "../review.ts";
import type { TrustLevel } from "../trust.ts";
import { SESSION_KINDS, type JournalEvent, type SessionKind } from "./journal.ts";

export interface WeeklyWindow {
	/** Local date (YYYY-MM-DD) of `start`; the weekly entry's idempotency key. */
	weekOf: string;
	start: string;
	end: string;
	/** The local calendar days the window touches, clipped to it (the first and the last are partial, so there are 7 or 8). */
	days: Array<{ date: string; start: string; end: string }>;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The most recent weekly boundary at or before `now`: the given weekday
 * (0 = Sunday) at the given local hour. The window is the seven days
 * ending at that boundary. Missed boundaries are not backfilled: only the
 * latest one is returned, so opening the app after a long absence yields one
 * synthesis, not a queue.
 */
export function weeklyWindow(now: Date, weekday: number, hour: number): WeeklyWindow {
	const wd = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 0;
	const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 18;
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
	end.setDate(end.getDate() - ((end.getDay() - wd + 7) % 7));
	if (end.getTime() > now.getTime()) end.setDate(end.getDate() - 7);
	const start = new Date(end);
	start.setDate(start.getDate() - 7);
	const days: WeeklyWindow["days"] = [];
	for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate()); day.getTime() < end.getTime(); day.setDate(day.getDate() + 1)) {
		const next = new Date(day);
		next.setDate(day.getDate() + 1);
		const from = new Date(Math.max(day.getTime(), start.getTime()));
		const to = new Date(Math.min(next.getTime(), end.getTime()));
		days.push({ date: localDate(day), start: from.toISOString(), end: to.toISOString() });
	}
	return { weekOf: localDate(start), start: start.toISOString(), end: end.toISOString(), days };
}

export interface WeeklyFacts {
	kind: "weekly";
	weekOf: string;
	windowStart: string;
	windowEnd: string;
	budgetSec: number;
	/** Seconds of fixed and dialogic reviews per day against the daily budget. */
	days: Array<{ date: string; reviews: number; reviewSec: number }>;
	/** Scope nodes with a review state that were due at each end of the window. */
	backlog: { dueAtStart: number; dueAtEnd: number; trend: "up" | "down" | "flat" };
	/** Reviews of nodes reviewed before (a first review says nothing about retention). */
	retention: { reviews: number; recalled: number; rate: number | null };
	/** Goals that are not paused: nodes of the scope recalled at least 0.85 at each end of the window. */
	goals: Array<{ goalId: string; title: string; status: string; total: number; solidAtStart: number; solidAtEnd: number; delta: number }>;
	/** Nodes of the active scope by trust level. */
	trust: { total: number; sourced: number; contested: number; refuted: number; unverified: number };
	/** Debriefs written inside the window, by session kind. */
	sessions: Record<SessionKind, number>;
}

export interface WeeklyInput {
	window: WeeklyWindow;
	reviewEvents: readonly ReviewEvent[];
	goals: readonly Goal[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	nodeIds: ReadonlySet<string>;
	retentionOf(nodeId: string): number;
	trustOf(nodeId: string): TrustLevel;
	journal: readonly JournalEvent[];
	budgetSec: number;
}

const t = (iso: string): number => Date.parse(iso);

export function computeWeeklyFacts(input: WeeklyInput): WeeklyFacts {
	const { window: w } = input;
	// FSRS refuses a review that precedes the previous one, so a ledger whose file order is not chronological
	// (a clock set back) is replayed in time order here; the sort is stable, so equal instants keep file order.
	const events = [...input.reviewEvents].sort((a, b) => t(a.at) - t(b.at));
	const startMs = t(w.start);
	const endMs = t(w.end);
	const exists = (id: string): boolean => input.nodeIds.has(id);
	const stateAt = (atMs: number) =>
		deriveNodeStates(events.filter((e) => t(e.at) <= atMs), { retentionOf: input.retentionOf, exists, implicitWeight: DEFAULT_IMPLICIT_WEIGHT });
	const atStart = stateAt(startMs);
	const atEnd = stateAt(endMs);
	const recallIn = (states: ReturnType<typeof stateAt>, ms: number) => (id: string) => recallProbability(states.get(id)?.card ?? null, new Date(ms).toISOString());

	const scope = activeScope(input.goals, input.chains).filter(exists);
	const dueAt = (states: ReturnType<typeof stateAt>, ms: number) => scope.filter((id) => (states.get(id)?.card.due.getTime() ?? Number.POSITIVE_INFINITY) <= ms).length;
	const dueAtStart = dueAt(atStart, startMs);
	const dueAtEnd = dueAt(atEnd, endMs);

	const days = w.days.map((d) => ({ date: d.date, reviews: 0, reviewSec: 0, startMs: t(d.start), endMs: t(d.end) }));
	const seen = new Set<string>();
	let retReviews = 0;
	let recalled = 0;
	for (const e of events) {
		if (e.type !== "review" || !exists(e.nodeId)) continue;
		const at = t(e.at);
		if (Number.isNaN(at)) continue;
		const inside = at >= startMs && at < endMs;
		if (inside && e.channel !== "exercise") {
			const day = days.find((d) => at >= d.startMs && at < d.endMs);
			if (day) {
				day.reviews += 1;
				day.reviewSec += e.durationSec;
			}
			if (seen.has(e.nodeId)) {
				retReviews += 1;
				if (e.rating >= 2) recalled += 1;
			}
		}
		if (at < endMs) seen.add(e.nodeId);
	}

	const goals = input.goals
		.filter((g) => g.status !== "paused")
		.map((g) => {
			const gs = goalScope(g.targetNodeIds, input.chains).filter(exists);
			const solid = (states: ReturnType<typeof stateAt>, ms: number) => gs.filter((id) => recallIn(states, ms)(id) >= DERIVABLE_RECALL).length;
			const solidAtStart = solid(atStart, startMs);
			const solidAtEnd = solid(atEnd, endMs);
			return { goalId: g.id, title: g.title, status: g.status, total: gs.length, solidAtStart, solidAtEnd, delta: solidAtEnd - solidAtStart };
		});

	const trust = { total: scope.length, sourced: 0, contested: 0, refuted: 0, unverified: 0 };
	for (const id of scope) trust[input.trustOf(id)] += 1;

	const sessions = Object.fromEntries(SESSION_KINDS.map((k) => [k, 0])) as Record<SessionKind, number>;
	const counted = new Set<string>();
	for (const e of input.journal) {
		if (e.kind !== "session" || e.sessionKind === null || e.sessionId === null || counted.has(e.sessionId)) continue;
		counted.add(e.sessionId);
		const at = t(e.at);
		if (at >= startMs && at < endMs) sessions[e.sessionKind] += 1;
	}

	const budget = Number.isFinite(input.budgetSec) && input.budgetSec > 0 ? input.budgetSec : 0;
	return {
		kind: "weekly",
		weekOf: w.weekOf,
		windowStart: w.start,
		windowEnd: w.end,
		budgetSec: budget,
		days: days.map(({ date, reviews, reviewSec }) => ({ date, reviews, reviewSec: Math.round(reviewSec) })),
		backlog: { dueAtStart, dueAtEnd, trend: dueAtEnd > dueAtStart ? "up" : dueAtEnd < dueAtStart ? "down" : "flat" },
		retention: { reviews: retReviews, recalled, rate: retReviews > 0 ? Math.round((recalled / retReviews) * 1000) / 1000 : null },
		goals,
		trust,
		sessions,
	};
}

/** A week with no reviews, no debriefed session and no active goal says nothing; no entry is written for it. */
export function hasWeeklySubstance(f: WeeklyFacts): boolean {
	const sessions = Object.values(f.sessions).reduce((a, b) => a + b, 0);
	return f.retention.reviews > 0 || f.days.some((d) => d.reviews > 0) || sessions > 0 || f.goals.some((g) => g.status === "active");
}
