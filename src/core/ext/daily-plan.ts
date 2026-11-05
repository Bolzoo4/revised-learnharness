// src/core/ext/daily-plan.ts
/**
 * The daily plan (REQ-pl-05, REQ-pl-11, REQ-pl-12, REQ-pl-16): a PURE
 * function of the deck, the derived states, the review history, the time
 * and the parameters. The budget is time, not a card count:
 *
 *   remaining = budget - time already spent today
 *   capacity  = floor(remaining / mean cost of the due items)
 *   newQuota  = max(0, capacity - due), and 0 when due > backlogFactor * capacity
 *
 * With this capacity the backlog clause is already implied by max(0, ...)
 * (due > 1.5 x capacity means due > capacity); it is kept because REQ-pl-11
 * states it, so a future change of the capacity definition cannot drop it.
 *
 * Order: goal priority (high first), then forgetting risk (1 - recall).
 * Whatever does not fit the remaining time is DEFERRED, never dropped.
 */

import { recallProbability } from "./fsrs.ts";
import type { DeckEntry } from "./deck.ts";
import type { NodeState } from "./review-state.ts";
import type { ReviewEvent } from "./review.ts";

export interface PlanParams {
	budgetSec: number;
	dialogicCap: number;
	backlogFactor: number;
	defaultDurationSec: { fixed: number; dialogic: number };
}

export const DEFAULT_PLAN_PARAMS: PlanParams = {
	budgetSec: 25 * 60,
	dialogicCap: 5,
	backlogFactor: 1.5,
	defaultDurationSec: { fixed: 20, dialogic: 180 },
};

export interface ReviewStats {
	/** Median observed duration per channel; null until there is data. */
	medianSec: { fixed: number | null; dialogic: number | null };
	/** Seconds of real reviews since `dayStart`. */
	spentTodaySec: number;
	/** Dialogic reviews since `dayStart`. */
	dialogicToday: number;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Only real fixed/dialogic reviews with a positive duration count toward medians. */
export function computeReviewStats(events: readonly ReviewEvent[], dayStart: string): ReviewStats {
	const fixed: number[] = [];
	const dialogic: number[] = [];
	let spent = 0;
	let dialogicToday = 0;
	const start = Date.parse(dayStart);
	for (const e of events) {
		if (e.type !== "review") continue;
		if (e.channel === "fixed" && e.durationSec > 0) fixed.push(e.durationSec);
		if (e.channel === "dialogic" && e.durationSec > 0) dialogic.push(e.durationSec);
		if (Date.parse(e.at) >= start) {
			spent += e.durationSec;
			if (e.channel === "dialogic") dialogicToday += 1;
		}
	}
	return { medianSec: { fixed: median(fixed), dialogic: median(dialogic) }, spentTodaySec: spent, dialogicToday };
}

export interface PlanItem {
	nodeId: string;
	channel: "fixed" | "dialogic";
	reason: "due" | "new";
	priority: number;
	/** 1 - recall probability at plan time (1 for a new node). */
	risk: number;
}

export interface DailyPlan {
	/** In review order, fitting the remaining time. */
	items: PlanItem[];
	/** Valid but beyond today's time: tomorrow's problem, never dropped. */
	deferred: PlanItem[];
	/** Nodes assigned to the fixed channel that have no active card yet. */
	needsCard: string[];
	due: number;
	capacity: number;
	newQuota: number;
	remainingSec: number;
}

export interface PlanInput {
	now: string;
	deck: readonly DeckEntry[];
	states: ReadonlyMap<string, NodeState>;
	stats: ReviewStats;
	hasActiveCard: (nodeId: string) => boolean;
	params: PlanParams;
}

export function dailyPlan(input: PlanInput): DailyPlan {
	const { now, deck, states, stats, params } = input;
	const nowMs = Date.parse(now);
	const cost = (channel: "fixed" | "dialogic"): number =>
		stats.medianSec[channel] ?? params.defaultDurationSec[channel];

	const dueEntries: Array<{ entry: DeckEntry; risk: number }> = [];
	const newEntries: DeckEntry[] = [];
	for (const entry of deck) {
		const state = states.get(entry.nodeId);
		if (state === undefined) newEntries.push(entry);
		else if (state.card.due.getTime() <= nowMs) {
			dueEntries.push({ entry, risk: 1 - recallProbability(state.card, now) });
		}
	}
	dueEntries.sort(
		(a, b) => b.entry.priority - a.entry.priority || b.risk - a.risk || a.entry.nodeId.localeCompare(b.entry.nodeId),
	);
	newEntries.sort((a, b) => b.priority - a.priority || a.nodeId.localeCompare(b.nodeId));

	const needsCard: string[] = [];
	let dialogicLeft = Math.max(0, params.dialogicCap - stats.dialogicToday);
	/** REQ-pl-05: pin wins; a chain-concluded node is dialogic while the daily cap lasts; overflow falls back to fixed. */
	const assign = (entry: DeckEntry): "fixed" | "dialogic" | null => {
		let channel: "fixed" | "dialogic";
		if (entry.channelPin !== null) {
			channel = entry.channelPin;
			if (channel === "dialogic") dialogicLeft = Math.max(0, dialogicLeft - 1);
		} else if (entry.hasChain && dialogicLeft > 0) {
			channel = "dialogic";
			dialogicLeft -= 1;
		} else channel = "fixed";
		if (channel === "fixed" && !input.hasActiveCard(entry.nodeId)) {
			needsCard.push(entry.nodeId);
			return null;
		}
		return channel;
	};

	const due: PlanItem[] = [];
	for (const { entry, risk } of dueEntries) {
		const channel = assign(entry);
		if (channel !== null) due.push({ nodeId: entry.nodeId, channel, reason: "due", priority: entry.priority, risk });
	}

	const remainingSec = Math.max(0, params.budgetSec - stats.spentTodaySec);
	const meanCost =
		due.length === 0 ? cost("fixed") : due.reduce((sum, i) => sum + cost(i.channel), 0) / due.length;
	const capacity = Math.floor(remainingSec / meanCost);
	const newQuota = due.length > params.backlogFactor * capacity ? 0 : Math.max(0, capacity - due.length);

	const fresh: PlanItem[] = [];
	for (const entry of newEntries) {
		if (fresh.length >= newQuota) break;
		const channel = assign(entry);
		if (channel !== null) fresh.push({ nodeId: entry.nodeId, channel, reason: "new", priority: entry.priority, risk: 1 });
	}

	const items: PlanItem[] = [];
	const deferred: PlanItem[] = [];
	let used = 0;
	let full = false;
	for (const item of [...due, ...fresh]) {
		const c = cost(item.channel);
		if (!full && used + c <= remainingSec) {
			items.push(item);
			used += c;
		} else {
			full = true;
			deferred.push(item);
		}
	}
	return { items, deferred, needsCard, due: due.length, capacity, newQuota, remainingSec };
}
