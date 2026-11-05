// src/core/ext/study/card-node.ts
/**
 * Which node a confirmed card attaches to (REQ-study-09). The extraction
 * pipeline may return several nodes for one proposition (the proposition plus
 * premises it spelled out), or link it to an existing equivalent node. The
 * card goes to the node whose statement is closest to the proposition by word
 * overlap (Jaccard); a tie goes to the first node in the order given.
 */

import { normalizeForMatch } from "../quote.ts";

export interface CandidateNode {
	id: string;
	name: string;
	statement: string;
	aliases: readonly string[];
}

function words(text: string): Set<string> {
	return new Set(normalizeForMatch(text, "join").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared++;
	return shared / (a.size + b.size - shared);
}

export function pickCardNode(proposition: string, nodes: readonly CandidateNode[]): string | null {
	const target = words(proposition);
	let best: { id: string; score: number } | null = null;
	for (const n of nodes) {
		const score = Math.max(jaccard(target, words(n.statement)), ...n.aliases.map((a) => jaccard(target, words(a))), jaccard(target, words(n.name)));
		if (best === null || score > best.score) best = { id: n.id, score };
	}
	return best?.id ?? null;
}
