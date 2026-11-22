// src/core/ext/mcp/propose-links.ts
/**
 * suggest_links (REQ-search-10): the nodes most similar to a given node that it is not yet linked to. It only
 * proposes. The agent or the learner creates a link (create_link), and this read never writes.
 *
 * "Linked" means a typed link in either direction, or a shared chain (premises and conclusion of one argument).
 */

import type { GraphChain } from "../../contracts.ts";
import { getGraph } from "../../graph.ts";
import type { Link } from "../links.ts";
import type { ScoredId } from "../embedder.ts";
import { rankIndex } from "../vector-index.ts";
import type { Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { requireId } from "./input.ts";
import { capText, clampLimit, LIMITS, page } from "./limits.ts";
import type { RunOptions } from "./ports.ts";

/** Node ids linked to `target` by a typed link (either direction) or by a chain it belongs to. Excludes `target`. */
export function linkedNodeIds(target: string, links: readonly Link[], chains: readonly GraphChain[]): Set<string> {
	const out = new Set<string>();
	for (const link of links) {
		if (link.from === target) out.add(link.to);
		if (link.to === target) out.add(link.from);
	}
	for (const chain of chains) {
		const members = [...chain.premises, chain.conclusion];
		if (members.includes(target)) for (const m of members) out.add(m);
	}
	out.delete(target);
	return out;
}

/**
 * The first `k` candidates of a best-first ranking that are neither the target nor linked to it. Pure: the caller
 * supplies the ranking (the similarity of every node to the target) and the existing links and chains.
 */
export function proposeLinks(target: string, ranked: readonly ScoredId[], links: readonly Link[], chains: readonly GraphChain[], k: number): ScoredId[] {
	if (!(k > 0)) return [];
	const excluded = linkedNodeIds(target, links, chains);
	excluded.add(target);
	return ranked.filter((h) => !excluded.has(h.id)).slice(0, Math.floor(k));
}

const unavailable = (reason: string) => `semantic suggestions unavailable: ${reason}`;

/**
 * The read-only tool. Argument and node checks throw synchronously, like every other tool; the semantic index
 * loads asynchronously, so the answer is a promise.
 */
export function suggestLinks(call: Call, input: Record<string, unknown>, _opts: RunOptions): Promise<SuggestOutput> {
	const id = requireId(input.id, "id");
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const { nodes, chains } = getGraph(call.graph);
	if (!nodes.some((n) => n.id === id)) throw new ToolError("not_found", `No node with id "${capText(id, 60)}".`);
	const links = call.review.linksStore?.readLinks() ?? [];
	return answerSuggestions(call, id, limit, nodes, chains, links);
}

export interface SuggestOutput {
	id: string;
	count: number;
	truncated: boolean;
	note?: string;
	items: Array<{ id: string; name: string; statement: string; score: number }>;
}

async function answerSuggestions(
	call: Call,
	id: string,
	limit: number,
	nodes: ReadonlyArray<{ id: string; name: string; statement: string }>,
	chains: readonly GraphChain[],
	links: readonly Link[],
): Promise<SuggestOutput> {
	const empty = (note: string): SuggestOutput => ({ id, note, count: 0, truncated: false, items: [] });
	const port = call.deps.semantic;
	if (port === undefined) return empty(unavailable("the semantic index is not configured"));
	const state = await port.load();
	if (!state.ok) return empty(unavailable(state.reason));

	const row = state.index.ids.indexOf(id);
	if (row < 0) return empty("this node is not indexed yet");
	const target = state.index.vectors.subarray(row * state.index.dim, (row + 1) * state.index.dim);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const ranked = rankIndex(state.index, target).filter((h) => byId.has(h.id));
	const p = page(proposeLinks(id, ranked, links, chains, Number.MAX_SAFE_INTEGER), limit);
	return {
		id,
		count: p.count,
		truncated: p.truncated,
		items: p.items.map((h) => {
			const n = byId.get(h.id)!;
			return {
				id: n.id,
				name: capText(n.name, LIMITS.nameChars),
				statement: capText(n.statement, LIMITS.listStatementChars),
				score: Math.round(h.score * 1000) / 1000,
			};
		}),
	};
}
