// src/core/ext/deck.ts
/**
 * The deck (umbrella REQ-review-02, spec REQ-pl-08, REQ-pl-10, REQ-pl-13):
 * scope of ACTIVE goals, minus derivable nodes, minus retired nodes, plus
 * pinned nodes — computed on demand, never stored. Paused goals contribute
 * nothing but their nodes keep their state (the state derivation never
 * looks at goal status).
 */

import type { GraphChain } from "../contracts.ts";
import { DEFAULT_GOAL_PRIORITY, goalScope, type Goal } from "./goals.ts";
import { DEFAULT_RETENTION } from "./fsrs.ts";
import type { Marks } from "./review-state.ts";

export const DERIVABLE_RECALL = 0.85;

type ChainLike = Pick<GraphChain, "premises" | "conclusion">;

export interface NodeGoalInfo {
	priority: number;
	retention: number;
}

/**
 * For each node in the scope of `goals`, the priority and desired retention
 * of the HIGHEST-PRIORITY goal containing it (ties: earliest created).
 * A goal without a retention override uses DEFAULT_RETENTION (REQ-pl-08).
 */
export function claimNodes(
	goals: readonly Goal[],
	chains: readonly ChainLike[],
	marks: Pick<Marks, "retention">,
): Map<string, NodeGoalInfo> {
	const ordered = [...goals].sort(
		(a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	const out = new Map<string, NodeGoalInfo>();
	for (const goal of ordered) {
		const retention = marks.retention.get(goal.id) ?? DEFAULT_RETENTION;
		for (const id of goalScope(goal.targetNodeIds, chains)) {
			if (!out.has(id)) out.set(id, { priority: goal.priority, retention });
		}
	}
	return out;
}

/** Some chain concluding `nodeId` has every premise at recall >= threshold (REQ-pl-10). */
export function isDerivable(
	nodeId: string,
	chains: readonly ChainLike[],
	recall: (nodeId: string) => number,
	threshold: number = DERIVABLE_RECALL,
): boolean {
	return chains.some(
		(c) => c.conclusion === nodeId && c.premises.length > 0 && c.premises.every((p) => recall(p) >= threshold),
	);
}

export function hasChain(nodeId: string, chains: readonly ChainLike[]): boolean {
	return chains.some((c) => c.conclusion === nodeId);
}

/** Distinct premises of every chain concluding `nodeId`, read from the CURRENT chains (umbrella REQ-review-05). */
export function premisesOf(nodeId: string, chains: readonly ChainLike[]): string[] {
	const out: string[] = [];
	for (const c of chains) {
		if (c.conclusion !== nodeId) continue;
		for (const p of c.premises) if (!out.includes(p)) out.push(p);
	}
	return out;
}

export interface DeckEntry {
	nodeId: string;
	priority: number;
	pinned: boolean;
	channelPin: "fixed" | "dialogic" | null;
	hasChain: boolean;
}

export interface DeckInput {
	goals: readonly Goal[];
	chains: readonly ChainLike[];
	/** Ids of nodes that currently exist; anything else is dropped. */
	nodeIds: ReadonlySet<string>;
	marks: Marks;
	recall: (nodeId: string) => number;
}

export function computeDeck(input: DeckInput): DeckEntry[] {
	const active = input.goals.filter((g) => g.status === "active");
	const claimed = claimNodes(active, input.chains, input.marks);
	const ids = new Set<string>(claimed.keys());
	for (const id of input.marks.pinned) ids.add(id);
	const out: DeckEntry[] = [];
	for (const id of [...ids].sort()) {
		if (!input.nodeIds.has(id)) continue;
		const pinned = input.marks.pinned.has(id);
		if (input.marks.retired.has(id) && !pinned) continue;
		if (!pinned && isDerivable(id, input.chains, input.recall)) continue;
		out.push({
			nodeId: id,
			priority: claimed.get(id)?.priority ?? DEFAULT_GOAL_PRIORITY,
			pinned,
			channelPin: input.marks.channelPin.get(id) ?? null,
			hasChain: hasChain(id, input.chains),
		});
	}
	return out;
}

/** Fraction of `scope` whose recall is at least the derivable threshold; ready when most is solid. */
export const READY_FRACTION = 0.8;
export function goalReadiness(
	scope: readonly string[],
	recall: (nodeId: string) => number,
): { solid: number; total: number; ready: boolean } {
	const total = scope.length;
	const solid = scope.filter((id) => recall(id) >= DERIVABLE_RECALL).length;
	return { solid, total, ready: total > 0 && solid / total >= READY_FRACTION };
}
