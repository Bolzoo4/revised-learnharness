// src/core/ext/neighbourhood.ts
/**
 * The panel's mini-graph data (REQ-node-13): the nodes within `maxDepth`
 * steps of a centre over the undirected premise-conclusion adjacency of the
 * chains, plus the premise -> conclusion edges among them. Derived from
 * chains on every call, never stored. Pure and browser-safe. The radial
 * layout is deliberately trivial (rings by depth): upstream's force layout
 * is tied to the full graph view and is not reused.
 */

import type { GraphChain } from "../contracts.ts";

export interface NeighbourhoodResult {
	nodes: Array<{ id: string; depth: number }>;
	edges: Array<{ from: string; to: string }>;
}

export function neighbourhood(
	centreId: string,
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	maxDepth: 1 | 2,
): NeighbourhoodResult {
	const adjacent = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		let set = adjacent.get(a);
		if (set === undefined) adjacent.set(a, (set = new Set()));
		set.add(b);
	};
	for (const chain of chains) {
		for (const premise of chain.premises) {
			if (premise === chain.conclusion) continue;
			link(premise, chain.conclusion);
			link(chain.conclusion, premise);
		}
	}
	const depth = new Map<string, number>([[centreId, 0]]);
	let frontier = [centreId];
	for (let d = 1; d <= maxDepth; d++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const neighbour of [...(adjacent.get(id) ?? [])].sort()) {
				if (depth.has(neighbour)) continue;
				depth.set(neighbour, d);
				next.push(neighbour);
			}
		}
		frontier = next;
	}
	const nodes = [...depth].map(([id, d]) => ({ id, depth: d })).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const edges: Array<{ from: string; to: string }> = [];
	const seen = new Set<string>();
	for (const chain of chains) {
		if (!depth.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (premise === chain.conclusion || !depth.has(premise)) continue;
			const key = `${premise}\u0000${chain.conclusion}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ from: premise, to: chain.conclusion });
		}
	}
	return { nodes, edges };
}

/** Centre at (0,0); the nodes of depth d evenly spaced on a ring of radius d * ringRadius. */
export function radialPositions(
	nodes: ReadonlyArray<{ id: string; depth: number }>,
	ringRadius: number,
): Record<string, { x: number; y: number }> {
	const out: Record<string, { x: number; y: number }> = {};
	const rings = new Map<number, string[]>();
	for (const n of nodes) {
		const ring = rings.get(n.depth);
		if (ring === undefined) rings.set(n.depth, [n.id]);
		else ring.push(n.id);
	}
	for (const [d, ids] of rings) {
		if (d === 0) {
			for (const id of ids) out[id] = { x: 0, y: 0 };
			continue;
		}
		ids.forEach((id, i) => {
			const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2;
			out[id] = { x: Math.cos(angle) * d * ringRadius, y: Math.sin(angle) * d * ringRadius };
		});
	}
	return out;
}
