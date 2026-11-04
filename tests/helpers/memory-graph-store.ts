// tests/helpers/memory-graph-store.ts
/**
 * An in-memory GraphStore for tests that run upstream's pure merger
 * (core/graph.ts mergeFindings) without touching data/graph. It implements
 * only the ledger methods the merger uses; every other method throws, so a
 * test that needs more fails loudly instead of silently passing.
 */

import type { CoverageEntry, GraphChain, GraphNode, SessionCheckpoint } from "../../src/core/contracts.ts";
import type { GraphStore } from "../../src/core/ports.ts";

export function createMemoryGraphStore(): GraphStore {
	let nodes: GraphNode[] = [];
	let chains: GraphChain[] = [];
	let checkpoints: SessionCheckpoint[] = [];
	let coverage: CoverageEntry[] = [];
	const implemented = {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => [...nodes],
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => [...chains],
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => [...checkpoints],
		appendCoverage: (c: CoverageEntry) => void coverage.push(c),
		readCoverage: () => [...coverage],
		rewriteLedgers: (next: {
			nodes?: GraphNode[];
			chains?: GraphChain[];
			coverage?: CoverageEntry[];
			checkpoints?: SessionCheckpoint[];
		}) => {
			if (next.nodes !== undefined) nodes = [...next.nodes];
			if (next.chains !== undefined) chains = [...next.chains];
			if (next.coverage !== undefined) coverage = [...next.coverage];
			if (next.checkpoints !== undefined) checkpoints = [...next.checkpoints];
		},
	};
	return new Proxy(implemented, {
		get(target, prop) {
			if (prop in target) return target[prop as keyof typeof target];
			throw new Error(`memory graph store: ${String(prop)} is not implemented`);
		},
	}) as unknown as GraphStore;
}
