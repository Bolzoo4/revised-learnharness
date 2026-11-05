// src/core/ext/frontier.ts
/**
 * Frontier marks (umbrella spec REQ-res-01, REQ-res-02; research-loop spec
 * REQ-rs-03, REQ-rs-06). A mark steers the research loop over a REGION of the
 * graph: `expand` (raise priority), `hold` (no expansion, verification still
 * allowed), `stop` (excluded). Marks are an event log; this module is pure.
 *
 * Region = the node set a mark's scope denotes:
 *   node    -> that node only
 *   subtree -> the node plus the transitive closure of its premises
 *   goal    -> the goal's scope (its targets plus their premise closure)
 *
 * Overlap resolution (the single rule, in order): a user-authored mark beats
 * an agent-authored one; then the more specific scope (node < subtree < goal);
 * then the smaller region; then the newer mark; then the lower mark id.
 */

import type { GraphChain } from "../contracts.ts";
import { goalScope, type Goal } from "./goals.ts";

export type MarkKind = "expand" | "hold" | "stop";
export type ScopeKind = "node" | "subtree" | "goal";
export type MarkAuthor = "user" | "agent";
export interface MarkScope {
	kind: ScopeKind;
	id: string;
}

export type FrontierEvent =
	| {
			type: "set";
			markId: string;
			scope: MarkScope;
			mark: MarkKind;
			maxDepth?: number;
			budgetUsd?: number;
			note: string;
			author: MarkAuthor;
			at: string;
	  }
	| { type: "clear"; markId: string; author: MarkAuthor; at: string };

export interface Mark {
	id: string;
	scope: MarkScope;
	mark: MarkKind;
	maxDepth?: number;
	budgetUsd?: number;
	note: string;
	author: MarkAuthor;
	at: string;
}

const MARKS = new Set<string>(["expand", "hold", "stop"]);
const SCOPES = new Set<string>(["node", "subtree", "goal"]);
const AUTHORS = new Set<string>(["user", "agent"]);

export function parseFrontierEvent(raw: unknown): FrontierEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.markId !== "string" || r.markId === "" || typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
	if (typeof r.author !== "string" || !AUTHORS.has(r.author)) return null;
	const author = r.author as MarkAuthor;
	if (r.type === "clear") return { type: "clear", markId: r.markId, author, at: r.at };
	if (r.type !== "set") return null;
	const scope = r.scope as { kind?: unknown; id?: unknown } | undefined;
	if (typeof scope !== "object" || scope === null) return null;
	if (typeof scope.kind !== "string" || !SCOPES.has(scope.kind)) return null;
	if (typeof scope.id !== "string" || scope.id === "") return null;
	if (typeof r.mark !== "string" || !MARKS.has(r.mark)) return null;
	if (typeof r.note !== "string") return null;
	if (r.maxDepth !== undefined && !(typeof r.maxDepth === "number" && Number.isInteger(r.maxDepth) && r.maxDepth >= 0)) return null;
	if (r.budgetUsd !== undefined && !(typeof r.budgetUsd === "number" && Number.isFinite(r.budgetUsd) && r.budgetUsd > 0)) return null;
	return {
		type: "set",
		markId: r.markId,
		scope: { kind: scope.kind as ScopeKind, id: scope.id },
		mark: r.mark as MarkKind,
		...(r.maxDepth !== undefined ? { maxDepth: r.maxDepth as number } : {}),
		...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd as number } : {}),
		note: r.note,
		author,
		at: r.at,
	};
}

/** Replay in order. A `set` with a known id replaces it; a `clear` removes it. An agent event never touches a user-authored mark. */
export function deriveMarks(events: readonly FrontierEvent[]): Mark[] {
	const marks = new Map<string, Mark>();
	for (const e of events) {
		const prev = marks.get(e.markId);
		if (prev !== undefined && prev.author === "user" && e.author === "agent") continue;
		if (e.type === "clear") {
			marks.delete(e.markId);
			continue;
		}
		marks.set(e.markId, {
			id: e.markId,
			scope: e.scope,
			mark: e.mark,
			...(e.maxDepth !== undefined ? { maxDepth: e.maxDepth } : {}),
			...(e.budgetUsd !== undefined ? { budgetUsd: e.budgetUsd } : {}),
			note: e.note,
			author: e.author,
			at: e.at,
		});
	}
	return [...marks.values()];
}

type Chains = readonly Pick<GraphChain, "premises" | "conclusion">[];

export function regionOf(scope: MarkScope, goals: readonly Goal[], chains: Chains): Set<string> {
	if (scope.kind === "node") return new Set([scope.id]);
	if (scope.kind === "subtree") return new Set(goalScope([scope.id], chains));
	const goal = goals.find((g) => g.id === scope.id);
	return new Set(goal === undefined ? [] : goalScope(goal.targetNodeIds, chains));
}

const SPECIFICITY: Record<ScopeKind, number> = { node: 0, subtree: 1, goal: 2 };

export interface MarkResolver {
	/** The winning mark for a node, or null when no region contains it. */
	effective(nodeId: string): Mark | null;
}

export function createMarkResolver(marks: readonly Mark[], goals: readonly Goal[], chains: Chains): MarkResolver {
	const regions = marks.map((mark) => ({ mark, nodes: regionOf(mark.scope, goals, chains) }));
	return {
		effective(nodeId) {
			const hits = regions.filter((r) => r.nodes.has(nodeId));
			if (hits.length === 0) return null;
			hits.sort((a, b) => {
				const author = Number(a.mark.author !== "user") - Number(b.mark.author !== "user");
				if (author !== 0) return author;
				const spec = SPECIFICITY[a.mark.scope.kind] - SPECIFICITY[b.mark.scope.kind];
				if (spec !== 0) return spec;
				if (a.nodes.size !== b.nodes.size) return a.nodes.size - b.nodes.size;
				if (a.mark.at !== b.mark.at) return a.mark.at < b.mark.at ? 1 : -1;
				if (a.mark.id === b.mark.id) return 0;
				return a.mark.id < b.mark.id ? -1 : 1;
			});
			return hits[0]!.mark;
		},
	};
}

export type FrontierMode = "none" | "expand" | "hold" | "stop";

/** The mode a mark imposes now. A non-finite spend counts as exhausted. An exhausted budget degrades `expand` to `hold`; it never lifts a `stop`. */
export function frontierMode(mark: Mark | null, spentUsd: number): FrontierMode {
	if (mark === null) return "none";
	if (mark.mark === "stop") return "stop";
	if (mark.budgetUsd !== undefined && !(spentUsd < mark.budgetUsd)) return "hold";
	return mark.mark;
}

/** `stop` excludes everything; `hold` excludes expansion but allows verification. */
export function modeAllows(mode: FrontierMode, gapClass: "expansion" | "verification"): boolean {
	if (mode === "stop") return false;
	if (mode === "hold") return gapClass === "verification";
	return true;
}
