// src/core/ext/mcp/plan.ts
/**
 * get_daily_plan (REQ-mcp-05, REQ-mcp-07). The numbers come from the app's own
 * computePlan (the same pure dailyPlan over the same deck, states, review
 * history and default parameters); this file only adds minutes and counts.
 *
 * `date` (YYYY-MM-DD, the server's local time zone): omitted or today = the
 * app's plan for now. A FUTURE date (at most 30 days ahead) plans that day as
 * of its last millisecond: everything due by then is due, nothing was spent.
 * A past date is refused (it cannot be reconstructed from the ledgers).
 */

import { computeReviewStats, DEFAULT_PLAN_PARAMS } from "../daily-plan.ts";
import { goalReadiness } from "../deck.ts";
import { goalScope } from "../goals.ts";
import { localIsoDate, startOfLocalDay } from "../local-day.ts";
import { computePlan } from "../review-queries.ts";
import type { Call } from "./call.ts";
import { guardReplay } from "./call.ts";
import { invalid } from "./errors.ts";
import { latestExerciseSet } from "./goals.ts";
import { parseLocalDate } from "./input.ts";
import { capText, LIMITS, page, round1 } from "./limits.ts";

const DAY_MS = 86_400_000;

export function getDailyPlan(call: Call, input: Record<string, unknown>) {
	const requested = input.date === undefined ? null : parseLocalDate(input.date, "date");
	const nowDate = new Date(call.now);
	const todayIso = localIsoDate(nowDate);
	let asOf = call.now;
	let dayStart = startOfLocalDay(nowDate);
	let dateIso = todayIso;

	if (requested !== null && requested.iso !== todayIso) {
		const dayMs = new Date(requested.year, requested.month - 1, requested.day).getTime();
		const todayMs = new Date(dayStart).getTime();
		if (dayMs < todayMs) throw invalid("date is in the past: only today and future days can be planned.");
		if (Math.round((dayMs - todayMs) / DAY_MS) > LIMITS.futureDaysMax) throw invalid(`date is more than ${LIMITS.futureDaysMax} days ahead.`);
		dayStart = new Date(dayMs).toISOString();
		asOf = new Date(requested.year, requested.month - 1, requested.day, 23, 59, 59, 999).toISOString();
		dateIso = requested.iso;
	}

	const { plan, snap } = guardReplay(() => computePlan({ ...call.review, now: () => asOf }, dayStart));
	const stats = computeReviewStats(call.review.reviewStore.readEvents(), dayStart);
	const params = DEFAULT_PLAN_PARAMS;
	const cost = (channel: "fixed" | "dialogic"): number => stats.medianSec[channel] ?? params.defaultDurationSec[channel];
	const count = (reason: "due" | "new", channel: "fixed" | "dialogic"): number =>
		plan.items.filter((i) => i.reason === reason && i.channel === channel).length;
	const estimatedSec = plan.items.reduce((sum, i) => sum + cost(i.channel), 0);

	// A goal waits for an exercise set when most of its scope is solid and no set has been applied yet.
	const pending = snap.goals
		.filter((g) => g.status === "active")
		.filter((g) => goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall).ready)
		.filter((g) => {
			const set = latestExerciseSet(call, g.id);
			return set === null || set.applied === null;
		});
	const pendingPage = page(pending, LIMITS.pendingGoalsMax);

	return {
		date: dateIso,
		asOf,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		budgetMinutes: round1(params.budgetSec / 60),
		spentMinutes: round1(stats.spentTodaySec / 60),
		remainingMinutes: round1(plan.remainingSec / 60),
		due: { fixed: count("due", "fixed"), dialogic: count("due", "dialogic"), total: plan.due },
		newItems: { fixed: count("new", "fixed"), dialogic: count("new", "dialogic"), total: plan.items.filter((i) => i.reason === "new").length },
		planned: { total: plan.items.length, estimatedMinutes: round1(estimatedSec / 60) },
		newCardQuota: plan.newQuota,
		capacity: plan.capacity,
		deferred: plan.deferred.length,
		needsCard: plan.needsCard.length,
		exerciseSetPending: pending.length > 0,
		pendingGoals: { ...pendingPage, items: pendingPage.items.map((g) => ({ id: g.id, title: capText(g.title, LIMITS.titleChars) })) },
	};
}
