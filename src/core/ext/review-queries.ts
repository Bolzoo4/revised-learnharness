// src/core/ext/review-queries.ts
/**
 * The read side of the personal layer: today's plan, the next item the
 * review agent should run, and per-goal readiness. Nothing here writes.
 */

import { computeDeck, goalReadiness, premisesOf } from "./deck.ts";
import { computeReviewStats, dailyPlan, DEFAULT_PLAN_PARAMS, type DailyPlan, type PlanParams } from "./daily-plan.ts";
import { goalScope } from "./goals.ts";
import { pickVariant, activeCardsOf } from "./cards.ts";
import { nowOf, snapshot, type ReviewDeps, type Snapshot } from "./review-service.ts";

/**
 * ASSUMED INTERFACE (child spec 1, source verification, planned in
 * parallel): the trust level of a node derived from its latest
 * verification event. Until that spec lands the composition root passes
 * `() => "unverified"`.
 */
export type TrustLevel = "unverified" | "sourced" | "contested" | "refuted";

export interface QueryDeps extends ReviewDeps {
	params?: PlanParams;
	trustOf?: (nodeId: string) => TrustLevel;
}

export function computePlan(deps: QueryDeps, dayStart: string): { plan: DailyPlan; snap: Snapshot } {
	const snap = snapshot(deps, nowOf(deps));
	const deck = computeDeck({
		goals: snap.goals,
		chains: snap.chains,
		nodeIds: snap.nodeIds,
		marks: snap.marks,
		recall: snap.recall,
	});
	const stats = computeReviewStats(deps.reviewStore.readEvents(), dayStart);
	const plan = dailyPlan({
		now: snap.now,
		deck,
		states: snap.states,
		stats,
		hasActiveCard: (id) => activeCardsOf(snap.cards, id).length > 0,
		params: deps.params ?? DEFAULT_PLAN_PARAMS,
	});
	return { plan, snap };
}

export interface PremiseView {
	id: string;
	name: string;
	statement: string;
}

export type NextItem =
	| {
			kind: "item";
			nodeId: string;
			name: string;
			statement: string;
			trust: TrustLevel;
			channel: "fixed" | "dialogic";
			reason: "due" | "new";
			/** Read from the CURRENT chains (umbrella REQ-review-05). Empty for a fact. */
			premises: PremiseView[];
			/** Fixed channel only: the variant to show (the answer is for the agent, not the learner). */
			card?: { cardId: string; question: string; answer: string };
			/** The last questions asked on this node, so the agent asks a new one (REQ-pl-07). */
			recentQuestions: string[];
			remainingItems: number;
	  }
	| { kind: "empty"; deferred: number; needsCard: string[] };

export function nextItem(deps: QueryDeps, dayStart: string): NextItem {
	const { plan, snap } = computePlan(deps, dayStart);
	const first = plan.items[0];
	if (first === undefined) {
		return { kind: "empty", deferred: plan.deferred.length, needsCard: plan.needsCard };
	}
	const node = snap.nodes.find((n) => n.id === first.nodeId);
	if (node === undefined) return { kind: "empty", deferred: plan.deferred.length, needsCard: plan.needsCard };
	const premises: PremiseView[] = premisesOf(first.nodeId, snap.chains).flatMap((id) => {
		const p = snap.nodes.find((n) => n.id === id);
		return p === undefined ? [] : [{ id, name: p.name, statement: p.statement }];
	});
	const variant =
		first.channel === "fixed"
			? pickVariant(snap.cards, first.nodeId, snap.states.get(first.nodeId)?.fixedReviews ?? 0)
			: undefined;
	const recentQuestions = deps.reviewStore
		.readEvents()
		.flatMap((e) => (e.type === "review" && e.nodeId === first.nodeId && e.question !== undefined ? [e.question] : []))
		.slice(-3);
	return {
		kind: "item",
		nodeId: node.id,
		name: node.name,
		statement: node.statement,
		trust: deps.trustOf?.(node.id) ?? "unverified",
		channel: first.channel,
		reason: first.reason,
		premises,
		...(variant ? { card: { cardId: variant.id, question: variant.question, answer: variant.answer } } : {}),
		recentQuestions,
		remainingItems: plan.items.length,
	};
}

/** Per-goal readiness for the exercise set (spec: "when most of a goal's scope is solid"). */
export function goalReadinessReport(
	deps: ReviewDeps,
): Array<{ goalId: string; title: string; solid: number; total: number; ready: boolean }> {
	const snap = snapshot(deps, nowOf(deps));
	return snap.goals
		.filter((g) => g.status === "active")
		.map((g) => ({
			goalId: g.id,
			title: g.title,
			...goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall),
		}));
}

export interface NodeReviewView {
	dueAt: string | null;
	reps: number;
	pinned: boolean;
	retired: boolean;
}

/** Review state of one node for the node panel; null when it has no state and no manual mark. */
export function nodeReviewView(deps: ReviewDeps, nodeId: string): NodeReviewView | null {
	const snap = snapshot(deps, nowOf(deps));
	const state = snap.states.get(nodeId);
	const pinned = snap.marks.pinned.has(nodeId);
	const retired = snap.marks.retired.has(nodeId);
	if (state === undefined && !pinned && !retired) return null;
	return { dueAt: state ? state.card.due.toISOString() : null, reps: state?.card.reps ?? 0, pinned, retired };
}
