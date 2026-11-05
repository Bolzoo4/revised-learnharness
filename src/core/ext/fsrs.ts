// src/core/ext/fsrs.ts
/**
 * The ONLY module that imports `ts-fsrs` (pinned 5.4.x: FSRS-6, plain Card
 * shape). Everything else in the extension talks to these four functions,
 * so a library change touches one file. Scheduling is deterministic: no
 * fuzz, and no minute-level learning steps (a first rating schedules whole
 * days, which keeps the daily load countable).
 */

import { createEmptyCard, fsrs, Rating, State, type Card, type FSRS, type Grade } from "ts-fsrs";

export type FsrsCard = Card;
export type RatingValue = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export const DEFAULT_RETENTION = 0.9;
const DAY_MS = 86_400_000;

const schedulers = new Map<number, FSRS>();
function schedulerFor(retention: number): FSRS {
	let s = schedulers.get(retention);
	if (s === undefined) {
		s = fsrs({ request_retention: retention, enable_fuzz: false, enable_short_term: false });
		schedulers.set(retention, s);
	}
	return s;
}

export function newCard(at: string): FsrsCard {
	return createEmptyCard(new Date(at));
}

/** One real FSRS review of `card` at `at` with `rating`. */
export function reviewCard(card: FsrsCard, rating: RatingValue, at: string, retention: number): FsrsCard {
	return schedulerFor(retention).next(card, new Date(at), rating as Grade).card;
}

/** Probability of recall at `now`, using FRACTIONAL elapsed days. 0 for a card never reviewed. */
export function recallProbability(card: FsrsCard | null, now: string): number {
	if (card === null || card.state === State.New || card.last_review === undefined) return 0;
	const elapsedDays = Math.max(0, (Date.parse(now) - card.last_review.getTime()) / DAY_MS);
	return schedulerFor(DEFAULT_RETENTION).forgetting_curve(elapsedDays, card.stability);
}

/**
 * Implicit repetition (REQ-pl-09): `newStability = old + weight * (computed - old)`
 * where `computed` is the stability a real "Good" review at `at` would give.
 * Only stability, last review and due move; difficulty and counters do not.
 */
export function implicitCredit(card: FsrsCard, at: string, retention: number, weight: number): FsrsCard {
	const s = schedulerFor(retention);
	const computed = s.next(card, new Date(at), Rating.Good).card.stability;
	const stability = card.stability + weight * (computed - card.stability);
	const interval = s.next_interval(stability, 0);
	return {
		...card,
		stability,
		last_review: new Date(at),
		elapsed_days: 0,
		scheduled_days: interval,
		due: new Date(Date.parse(at) + interval * DAY_MS),
	};
}
