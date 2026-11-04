// src/core/ext/goals.ts
/**
 * Goals (umbrella spec: REQ-goal-01, REQ-goal-02). A goal is one or more
 * TARGET NODES the learner wants to master; its SCOPE is the targets plus
 * the transitive closure of their premises over the chains. Goals are an
 * event log (store events, derive state); this module is pure.
 */

import type { GraphChain } from "../contracts.ts";

export type GoalOrigin = "chat" | "user" | "pdf";
export type GoalStatus = "active" | "paused" | "reached";

export const MIN_GOAL_PRIORITY = 1;
export const MAX_GOAL_PRIORITY = 5;
export const DEFAULT_GOAL_PRIORITY = 3;

export type GoalEvent =
	| {
			type: "created";
			goalId: string;
			title: string;
			origin: GoalOrigin;
			originRef: string;
			targetNodeIds: string[];
			priority: number;
			at: string;
	  }
	| { type: "status"; goalId: string; status: GoalStatus; at: string };

export interface Goal {
	id: string;
	title: string;
	origin: GoalOrigin;
	originRef: string;
	targetNodeIds: string[];
	priority: number;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
}

const ORIGINS = new Set<string>(["chat", "user", "pdf"]);
const STATUSES = new Set<string>(["active", "paused", "reached"]);

export function isValidGoalPriority(p: unknown): p is number {
	return typeof p === "number" && Number.isInteger(p) && p >= MIN_GOAL_PRIORITY && p <= MAX_GOAL_PRIORITY;
}

export function parseGoalEvent(raw: unknown): GoalEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.goalId !== "string" || r.goalId === "" || typeof r.at !== "string") return null;
	if (r.type === "status") {
		if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
		return { type: "status", goalId: r.goalId, status: r.status as GoalStatus, at: r.at };
	}
	if (r.type === "created") {
		if (typeof r.title !== "string" || r.title === "") return null;
		if (typeof r.origin !== "string" || !ORIGINS.has(r.origin)) return null;
		if (typeof r.originRef !== "string") return null;
		if (!Array.isArray(r.targetNodeIds) || r.targetNodeIds.length === 0) return null;
		if (!r.targetNodeIds.every((id) => typeof id === "string" && id !== "")) return null;
		if (!isValidGoalPriority(r.priority)) return null;
		return {
			type: "created",
			goalId: r.goalId,
			title: r.title,
			origin: r.origin as GoalOrigin,
			originRef: r.originRef,
			targetNodeIds: [...(r.targetNodeIds as string[])],
			priority: r.priority,
			at: r.at,
		};
	}
	return null;
}

/** Replay the events in order. A duplicate `created` for a known id and a `status` for an unknown goal are ignored. */
export function deriveGoals(events: readonly GoalEvent[]): Goal[] {
	const goals = new Map<string, Goal>();
	for (const e of events) {
		if (e.type === "created") {
			if (goals.has(e.goalId)) continue;
			goals.set(e.goalId, {
				id: e.goalId,
				title: e.title,
				origin: e.origin,
				originRef: e.originRef,
				targetNodeIds: [...e.targetNodeIds],
				priority: e.priority,
				status: "active",
				createdAt: e.at,
				updatedAt: e.at,
			});
		} else {
			const goal = goals.get(e.goalId);
			if (goal === undefined) continue;
			goal.status = e.status;
			goal.updatedAt = e.at;
		}
	}
	return [...goals.values()];
}

/** The targets plus the transitive closure of their premises over `chains`. Cycle-safe; each id once; targets first. */
export function goalScope(
	targetNodeIds: readonly string[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
): string[] {
	const premisesOf = new Map<string, string[][]>();
	for (const chain of chains) {
		const bucket = premisesOf.get(chain.conclusion);
		if (bucket === undefined) premisesOf.set(chain.conclusion, [chain.premises]);
		else bucket.push(chain.premises);
	}
	const seen = new Set<string>();
	const queue = [...targetNodeIds];
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		for (const premises of premisesOf.get(id) ?? []) {
			for (const premise of premises) if (!seen.has(premise)) queue.push(premise);
		}
	}
	return [...seen];
}

/** The union of the scopes of all active goals. */
export function activeScope(goals: readonly Goal[], chains: readonly Pick<GraphChain, "premises" | "conclusion">[]): string[] {
	const out = new Set<string>();
	for (const goal of goals) {
		if (goal.status !== "active") continue;
		for (const id of goalScope(goal.targetNodeIds, chains)) out.add(id);
	}
	return [...out];
}
