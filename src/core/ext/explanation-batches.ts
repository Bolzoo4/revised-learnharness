// src/core/ext/explanation-batches.ts
/**
 * Batches of NEIGHBOURING nodes for a chapter run (REQ-node-04). One model
 * call writes one batch, so nodes that explain each other should share a
 * call. Rule: order the requested ids by a breadth-first walk over the
 * undirected premise/conclusion adjacency among the requested ids (each
 * component starts at its smallest id, neighbours visited in id order), then
 * cut that order into batches of `batchSize`. Deterministic.
 */

import type { GraphChain } from "../contracts.ts";

export const DEFAULT_BATCH_SIZE = 6;

export function planBatches(
	nodeIds: readonly string[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	batchSize: number = DEFAULT_BATCH_SIZE,
): string[][] {
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new RangeError(`planBatches: batchSize must be a positive integer, got ${batchSize}`);
	}
	const ids = [...new Set(nodeIds)].sort();
	const inSet = new Set(ids);
	const adjacent = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
	for (const chain of chains) {
		if (!inSet.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (!inSet.has(premise) || premise === chain.conclusion) continue;
			adjacent.get(premise)?.add(chain.conclusion);
			adjacent.get(chain.conclusion)?.add(premise);
		}
	}
	const order: string[] = [];
	const seen = new Set<string>();
	for (const start of ids) {
		if (seen.has(start)) continue;
		seen.add(start);
		const queue = [start];
		while (queue.length > 0) {
			const id = queue.shift();
			if (id === undefined) break;
			order.push(id);
			for (const next of [...(adjacent.get(id) ?? [])].sort()) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
	}
	const batches: string[][] = [];
	for (let i = 0; i < order.length; i += batchSize) batches.push(order.slice(i, i + batchSize));
	return batches;
}
