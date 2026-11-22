// src/core/ext/goals.ts
/**
 * Goals (umbrella spec: REQ-goal-01, REQ-goal-02). A goal is one or more
 * TARGET NODES the learner wants to master; its SCOPE is the targets plus
 * the transitive closure of their premises over the chains. Goals are an
 * event log (store events, derive state); this module is pure.
 *
 * Weights (REQ-graph-agent-17/18): each goal carries a weight in 0..1 for the
 * chain closure and for each link type (default 1). See goalScopeWeighted for
 * the exact rule.
 */

import type { GraphChain } from "../contracts.ts";
import { LINK_TYPES, type LinkType } from "./links.ts";

export type GoalOrigin = "chat" | "user" | "pdf" | "agent";
export type GoalStatus = "active" | "paused" | "reached";

/** Weight of the premise closure ("chain") and of each link type, inside one goal. Each in 0..1. */
export type GoalWeights = Record<"chain" | LinkType, number>;
export const DEFAULT_WEIGHTS: Readonly<GoalWeights> = Object.freeze({
	chain: 1,
	evolution: 1,
	sequence: 1,
	"case-of": 1,
	"part-of": 1,
	analogy: 1,
	contrast: 1,
});
const WEIGHT_KEYS: readonly string[] = ["chain", ...LINK_TYPES];

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
			/** Absent = DEFAULT_WEIGHTS (events written before weights existed). */
			weights?: GoalWeights;
			at: string;
	  }
	| { type: "status"; goalId: string; status: GoalStatus; at: string }
	| { type: "weights"; goalId: string; weights: GoalWeights; at: string };

export interface Goal {
	id: string;
	title: string;
	origin: GoalOrigin;
	originRef: string;
	targetNodeIds: string[];
	priority: number;
	status: GoalStatus;
	weights: GoalWeights;
	createdAt: string;
	updatedAt: string;
}

const ORIGINS = new Set<string>(["chat", "user", "pdf", "agent"]);
const STATUSES = new Set<string>(["active", "paused", "reached"]);

export function isValidGoalPriority(p: unknown): p is number {
	return typeof p === "number" && Number.isInteger(p) && p >= MIN_GOAL_PRIORITY && p <= MAX_GOAL_PRIORITY;
}

/**
 * Checks a weights object and returns only the keys it gives. Rejects non-objects,
 * non-finite or out-of-range numbers, and unknown keys. Missing keys are NOT filled here.
 */
export function validateWeightsPatch(
	raw: unknown,
): { ok: true; patch: Partial<GoalWeights> } | { ok: false; problems: string[] } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, problems: ["weights must be an object of key to number"] };
	}
	const problems: string[] = [];
	const patch: Partial<GoalWeights> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!WEIGHT_KEYS.includes(key)) {
			problems.push(`unknown weight key "${key}"`);
			continue;
		}
		if (typeof value !== "number" || !Number.isFinite(value)) {
			problems.push(`weight "${key}" must be a finite number`);
			continue;
		}
		if (value < 0 || value > 1) problems.push(`weight "${key}" must be between 0 and 1, got ${value}`);
		else patch[key as keyof GoalWeights] = value;
	}
	return problems.length > 0 ? { ok: false, problems } : { ok: true, patch };
}

/** A full weights object: a PARTIAL input over DEFAULT_WEIGHTS (missing keys are 1). */
export function validateWeights(
	raw: unknown,
): { ok: true; weights: GoalWeights } | { ok: false; problems: string[] } {
	const r = validateWeightsPatch(raw);
	if (!r.ok) return r;
	return { ok: true, weights: { ...DEFAULT_WEIGHTS, ...r.patch } };
}

export function parseGoalEvent(raw: unknown): GoalEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.goalId !== "string" || r.goalId === "" || typeof r.at !== "string") return null;
	if (r.type === "status") {
		if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
		return { type: "status", goalId: r.goalId, status: r.status as GoalStatus, at: r.at };
	}
	if (r.type === "weights") {
		const w = validateWeights(r.weights);
		if (!w.ok) return null;
		return { type: "weights", goalId: r.goalId, weights: w.weights, at: r.at };
	}
	if (r.type === "created") {
		if (typeof r.title !== "string" || r.title === "") return null;
		if (typeof r.origin !== "string" || !ORIGINS.has(r.origin)) return null;
		if (typeof r.originRef !== "string") return null;
		if (!Array.isArray(r.targetNodeIds) || r.targetNodeIds.length === 0) return null;
		if (!r.targetNodeIds.every((id) => typeof id === "string" && id !== "")) return null;
		if (!isValidGoalPriority(r.priority)) return null;
		let weights: GoalWeights | undefined;
		if (r.weights !== undefined) {
			const w = validateWeights(r.weights);
			if (!w.ok) return null;
			weights = w.weights;
		}
		return {
			type: "created",
			goalId: r.goalId,
			title: r.title,
			origin: r.origin as GoalOrigin,
			originRef: r.originRef,
			targetNodeIds: [...(r.targetNodeIds as string[])],
			priority: r.priority,
			...(weights ? { weights } : {}),
			at: r.at,
		};
	}
	return null;
}

/** Replay the events in order. A duplicate `created` for a known id and a `status`/`weights` for an unknown goal are ignored. */
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
				weights: { ...DEFAULT_WEIGHTS, ...e.weights },
				createdAt: e.at,
				updatedAt: e.at,
			});
		} else if (e.type === "weights") {
			const goal = goals.get(e.goalId);
			if (goal === undefined) continue;
			goal.weights = { ...e.weights }; // latest wins
			goal.updatedAt = e.at;
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

/**
 * The weighted scope of one goal: node id to weight, weight > 0 only.
 *
 * RULE (REQ-graph-agent-18):
 *  1. Every target weighs 1.
 *  2. Every node in the chain closure of the targets (goalScope) weighs `weights.chain`.
 *  3. Links: a link with one endpoint already in scope (weight > 0) brings the other
 *     endpoint in at `weights[linkType]`. Links are followed in both directions
 *     (scope is about relevance, not direction). This repeats until nothing changes,
 *     so link-added nodes can bring in further links.
 *  4. A node's weight is the MAX over every connection that reaches it. A connection's
 *     weight is its own type weight, NOT multiplied along a path. Nodes reached only
 *     through weight 0 are excluded and do not seed further links.
 *  5. Link-added nodes do NOT pull in chain premises: the chain closure is taken from
 *     the targets only.
 * With all weights 1 and no links the keys are exactly goalScope(targets, chains).
 */
export function goalScopeWeighted(
	goal: Pick<Goal, "targetNodeIds" | "weights">,
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	links: readonly { from: string; to: string; linkType: LinkType }[] = [],
): Map<string, number> {
	const out = new Map<string, number>();
	for (const id of goal.targetNodeIds) out.set(id, 1);
	const chainWeight = goal.weights.chain;
	if (chainWeight > 0) {
		for (const id of goalScope(goal.targetNodeIds, chains)) {
			if (!out.has(id)) out.set(id, chainWeight);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const link of links) {
			const linkWeight = goal.weights[link.linkType];
			if (linkWeight <= 0) continue;
			for (const [from, to] of [
				[link.from, link.to],
				[link.to, link.from],
			] as const) {
				if ((out.get(from) ?? 0) <= 0) continue;
				if ((out.get(to) ?? 0) < linkWeight) {
					out.set(to, linkWeight);
					changed = true;
				}
			}
		}
	}
	return out;
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
