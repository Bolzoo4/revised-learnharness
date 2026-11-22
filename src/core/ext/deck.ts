// src/core/ext/deck.ts
/**
 * The deck (umbrella REQ-review-02, spec REQ-pl-08, REQ-pl-10, REQ-pl-13):
 * scope of ACTIVE goals, minus derivable nodes, minus retired nodes, plus
 * pinned nodes — computed on demand, never stored. Paused goals contribute
 * nothing but their nodes keep their state (the state derivation never
 * looks at goal status). Scope is the WEIGHTED scope (goalScopeWeighted):
 * nodes of weight 0 are not in it.
 */

import type { GraphChain } from "../contracts.ts";
import { DEFAULT_GOAL_PRIORITY, goalScopeWeighted, type Goal } from "./goals.ts";
import { DEFAULT_RETENTION } from "./fsrs.ts";
import type { LinkType } from "./links.ts";
import type { Marks } from "./review-state.ts";

export const DERIVABLE_RECALL = 0.85;

type ChainLike = Pick<GraphChain, "premises" | "conclusion">;
type LinkLike = { from: string; to: string; linkType: LinkType };

export interface NodeGoalInfo {
	priority: number;
	retention: number;
	/** The claiming goal's weight for the node (REQ-graph-agent-18). */
	weight: number;
}

/**
 * For each node in the weighted scope of `goals` (weight > 0), the priority,
 * desired retention and weight of the HIGHEST-PRIORITY goal containing it
 * (ties: earliest created). A goal without a retention override uses
 * DEFAULT_RETENTION (REQ-pl-08).
 */
export function claimNodes(
	goals: readonly Goal[],
	chains: readonly ChainLike[],
	marks: Pick<Marks, "retention">,
	links: readonly LinkLike[] = [],
): Map<string, NodeGoalInfo> {
	const ordered = [...goals].sort(
		(a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	const out = new Map<string, NodeGoalInfo>();
	for (const goal of ordered) {
		const retention = marks.retention.get(goal.id) ?? DEFAULT_RETENTION;
		for (const [id, weight] of goalScopeWeighted(goal, chains, links)) {
			if (!out.has(id)) out.set(id, { priority: goal.priority, retention, weight });
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
	/** The claiming goal's weight; 1 for a pinned node outside every goal. */
	weight: number;
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
	/** Typed links: they bring nodes into a goal's scope at the link-type weight. */
	links?: readonly LinkLike[];
}

export function computeDeck(input: DeckInput): DeckEntry[] {
	const active = input.goals.filter((g) => g.status === "active");
	const claimed = claimNodes(active, input.chains, input.marks, input.links ?? []);
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
			weight: claimed.get(id)?.weight ?? 1,
			pinned,
			channelPin: input.marks.channelPin.get(id) ?? null,
			hasChain: hasChain(id, input.chains),
		});
	}
	return out;
}

/**
 * Readiness of a goal scope. `scope` is a weighted scope (node to weight, from
 * goalScopeWeighted) or a plain list (every node weighs 1). The fraction is the
 * sum of the weights of solid nodes over the sum of all weights; ready when it
 * reaches READY_FRACTION. `solid` and `total` are node counts.
 */
export const READY_FRACTION = 0.8;
export function goalReadiness(
	scope: ReadonlyMap<string, number> | readonly string[],
	recall: (nodeId: string) => number,
): { solid: number; total: number; fraction: number; ready: boolean } {
	const weighted: ReadonlyMap<string, number> = Array.isArray(scope)
		? new Map(scope.map((id): [string, number] => [id, 1]))
		: (scope as ReadonlyMap<string, number>);
	let solidWeight = 0;
	let totalWeight = 0;
	let solid = 0;
	for (const [id, w] of weighted) {
		totalWeight += w;
		if (recall(id) >= DERIVABLE_RECALL) {
			solidWeight += w;
			solid += 1;
		}
	}
	const fraction = totalWeight > 0 ? solidWeight / totalWeight : 0;
	return { solid, total: weighted.size, fraction, ready: totalWeight > 0 && fraction >= READY_FRACTION };
}
