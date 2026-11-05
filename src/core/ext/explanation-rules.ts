// src/core/ext/explanation-rules.ts
/**
 * Pure rules of node explanations (node-knowledge spec).
 *  - FINGERPRINT (REQ-node-03): a canonical string of the chains that
 *    conclude a node. Chain ids are not stable (the merger rewrites the
 *    ledger), premises and conclusions are, so the fingerprint is built from
 *    those. Stored with each explanation; a different value now means STALE.
 *  - COMPLEXITY (REQ-node-06): a node is complex when some chain concluding
 *    it has at least 3 distinct premises, or when the longest premise path
 *    below it has length at least 3.
 */

import type { GraphChain } from "../contracts.ts";

type ChainLike = Pick<GraphChain, "premises" | "conclusion">;

export const COMPLEX_MIN_PREMISES = 3;
export const COMPLEX_MIN_DEPTH = 3;

export type ExplanationForm = "short" | "long";

/**
 * Each concluding chain becomes its distinct premise ids sorted (default
 * string order) and joined by ","; the chain strings are de-duplicated,
 * sorted and joined by "|". A node no chain concludes yields "".
 */
export function concludingFingerprint(nodeId: string, chains: readonly ChainLike[]): string {
	const lines = new Set<string>();
	for (const chain of chains) {
		if (chain.conclusion === nodeId) lines.add([...new Set(chain.premises)].sort().join(","));
	}
	return [...lines].sort().join("|");
}

export function isStale(current: { fingerprint: string }, nodeId: string, chains: readonly ChainLike[]): boolean {
	return current.fingerprint !== concludingFingerprint(nodeId, chains);
}

/**
 * Longest premise path below a node: 0 when no chain concludes it, else
 * 1 + the deepest premise over all its concluding chains. Cycle-safe
 * (a premise already on the current path is skipped); the graph is meant to
 * be a DAG, so the cut only guarantees termination.
 */
export function premiseDepth(nodeId: string, chains: readonly ChainLike[]): number {
	const premisesOf = new Map<string, string[]>();
	for (const chain of chains) {
		const bucket = premisesOf.get(chain.conclusion);
		if (bucket === undefined) premisesOf.set(chain.conclusion, [...chain.premises]);
		else bucket.push(...chain.premises);
	}
	const memo = new Map<string, number>();
	const visit = (id: string, path: ReadonlySet<string>): number => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		const premises = premisesOf.get(id);
		if (premises === undefined) return 0;
		const next = new Set(path).add(id);
		let best = 0;
		for (const premise of premises) {
			if (next.has(premise)) continue;
			best = Math.max(best, 1 + visit(premise, next));
		}
		memo.set(id, best);
		return best;
	};
	return visit(nodeId, new Set());
}

export function isComplex(nodeId: string, chains: readonly ChainLike[]): boolean {
	for (const chain of chains) {
		if (chain.conclusion === nodeId && new Set(chain.premises).size >= COMPLEX_MIN_PREMISES) return true;
	}
	return premiseDepth(nodeId, chains) >= COMPLEX_MIN_DEPTH;
}

export function explanationForm(nodeId: string, chains: readonly ChainLike[]): ExplanationForm {
	return isComplex(nodeId, chains) ? "long" : "short";
}
