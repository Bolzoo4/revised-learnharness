// src/core/ext/mcp/search.ts
/**
 * search_nodes (REQ-mcp-04, REQ-search-08). Three modes over the same graph nodes:
 *   keyword:  upstream's fuzzy scoring over name, statement and aliases;
 *   semantic: cosine similarity between the query vector and each node's vector;
 *   hybrid:   both rankings merged by reciprocal rank fusion (k = 60). The default.
 * The trust filter and the goal scope apply before ranking; the stage filter applies
 * before the limit in every mode. When the semantic index or model is missing, the
 * answer is the keyword answer with a note saying why.
 */

import { fuzzyScore } from "../../fuzzy.ts";
import { getGraph } from "../../graph.ts";
import type { GraphNode } from "../../contracts.ts";
import { cosine } from "../embedder.ts";
import { deriveGoals, weightedScopeIds } from "../goals.ts";
import type { VectorIndex } from "../vector-index.ts";
import { guardReplay, stagesOfCall, type Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { compareCodeUnits, optionalEnum, requireId, requireQuery } from "./input.ts";
import { capText, clampLimit, LIMITS, page } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { TRUST_LEVELS, trustLevels } from "./trust-view.ts";
import type { NodeStage } from "../stage.ts";

const nfc = (s: string): string => s.normalize("NFC");

export const STAGE_FILTERS = ["staged", "unrevised", "confirmed", "all"] as const;
export const SEARCH_MODES = ["semantic", "keyword", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
/** The reciprocal-rank-fusion constant (the usual k = 60). */
export const RRF_K = 60;

/** A node that passed the trust and goal filters, with its keyword and semantic scores (null when it has none). */
interface Row {
	node: GraphNode;
	level: string;
	nodeStage: NodeStage | null;
	kw: number | null;
	sem: number | null;
}

export interface SearchOutput {
	query: string;
	mode: SearchMode;
	note?: string;
	hiddenByStage: number;
	count: number;
	truncated: boolean;
	items: Array<{ id: string; name: string; statement: string; trust: string; stage: NodeStage | null }>;
}

/**
 * The stage filter defaults to "confirmed": a learner's search shows what is
 * settled. Under --knowledge-only a stage needs study state, so the default is
 * "all" (no filter) and an explicit stage other than "all" is refused.
 *
 * Returns the answer, or a promise of it when the semantic index is consulted.
 */
export function searchNodes(call: Call, input: Record<string, unknown>, opts: RunOptions): SearchOutput | Promise<SearchOutput> {
	const query = requireQuery(input.query);
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const trust = optionalEnum(input.trust, TRUST_LEVELS, "trust");
	const mode = optionalEnum(input.mode, SEARCH_MODES, "mode") ?? "hybrid";
	const goalId = input.goalId === undefined ? undefined : requireId(input.goalId, "goalId");
	if (goalId !== undefined && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by goal needs study state, which is disabled (--knowledge-only).");
	}
	const stageArg = optionalEnum(input.stage, STAGE_FILTERS, "stage");
	if (stageArg !== undefined && stageArg !== "all" && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by stage needs study state, which is disabled (--knowledge-only).");
	}
	const stage = stageArg ?? (opts.knowledgeOnly ? "all" : "confirmed");

	// The graph is read first, so a graph read failure keeps its own (internal) path. Stages are computed only when a
	// stage filter other than "all" needs them (they replay the review history); "all" computes none.
	const { nodes, chains } = getGraph(call.graph);
	const stages: Map<string, NodeStage> | null = opts.knowledgeOnly || stage === "all" ? null : stagesOfCall(call);
	const links = call.review.linksStore?.readLinks() ?? [];
	let scope: Set<string> | null = null;
	if (goalId !== undefined) {
		const goal = guardReplay(() => deriveGoals(call.review.goalsStore.readEvents())).find((g) => g.id === goalId);
		if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(goalId, 60)}".`);
		scope = new Set(weightedScopeIds(goal, chains, links));
	}

	const levels = trustLevels(call.deps.verification.readAll());
	const rows: Row[] = [];
	for (const node of nodes) {
		if (scope !== null && !scope.has(node.id)) continue;
		const level = levels.get(node.id)?.level ?? "unverified";
		if (trust !== undefined && level !== trust) continue;
		// Stored text is compared in NFC too, so composed and decomposed accents match alike.
		const kw = fuzzyScore(query, nfc(node.name), nfc(node.statement), ...node.aliases.map(nfc));
		rows.push({ node, level, nodeStage: stages?.get(node.id) ?? null, kw, sem: null });
	}

	const keywordAnswer = (note?: string): SearchOutput => answer(rows, "keyword", stage, limit, query, note);
	if (mode === "keyword") return keywordAnswer();

	const port = call.deps.semantic;
	if (port === undefined) return keywordAnswer("semantic search unavailable: the semantic index is not configured");
	// A reason the file alone decides answers now, synchronously; otherwise the index and the model load asynchronously.
	const known = port.unavailable?.();
	if (known) return keywordAnswer(`semantic search unavailable: ${known}`);
	return port.load().then(async (state): Promise<SearchOutput> => {
		if (!state.ok) return keywordAnswer(`semantic search unavailable: ${state.reason}`);
		let vector: Float32Array;
		try {
			vector = await state.embedQuery(query);
		} catch (error) {
			// The app's own reason (no model, not running, stale) is the note; any other failure is generic.
			if (error instanceof ToolError) return keywordAnswer(`semantic search unavailable: ${error.message}`);
			return keywordAnswer("semantic search unavailable: query embedding failed");
		}
		if (vector.length !== state.index.dim) return keywordAnswer("semantic search unavailable: the query vector does not match the index");
		scoreSemantic(rows, state.index, vector);
		return answer(rows, mode, stage, limit, query);
	});
}

/** Sets each row's cosine score against the query vector. A row the index does not hold keeps null. */
function scoreSemantic(rows: Row[], index: VectorIndex, query: Float32Array): void {
	const position = new Map<string, number>();
	index.ids.forEach((id, i) => position.set(id, i));
	for (const row of rows) {
		const i = position.get(row.node.id);
		if (i === undefined) continue;
		row.sem = cosine(query, index.vectors.subarray(i * index.dim, (i + 1) * index.dim));
	}
}

/**
 * The ranked, staged, limited answer. The pool is the rows the mode can rank. The stage filter runs on the pool
 * (the hidden ones are counted), the ranking runs on what is visible, and the page is taken last.
 */
function answer(rows: Row[], mode: SearchMode, stage: string, limit: number, query: string, note?: string): SearchOutput {
	const usable = (r: Row): boolean => (mode === "keyword" ? r.kw !== null : mode === "semantic" ? r.sem !== null : r.kw !== null || r.sem !== null);
	const pool = rows.filter(usable);
	const visible = pool.filter((r) => stage === "all" || r.nodeStage === stage);
	const hiddenByStage = pool.length - visible.length;

	const byId = (a: Row, b: Row): number => compareCodeUnits(a.node.id, b.node.id);
	let ranked: Array<{ row: Row; score: number }>;
	if (mode === "keyword") {
		ranked = visible
			.filter((r) => r.kw !== null)
			.sort((a, b) => b.kw! - a.kw! || byId(a, b))
			.map((row) => ({ row, score: row.kw! }));
	} else if (mode === "semantic") {
		ranked = visible
			.filter((r) => r.sem !== null)
			.sort((a, b) => b.sem! - a.sem! || byId(a, b))
			.map((row) => ({ row, score: row.sem! }));
	} else {
		const kwOrder = visible.filter((r) => r.kw !== null).sort((a, b) => b.kw! - a.kw! || byId(a, b));
		const semOrder = visible.filter((r) => r.sem !== null).sort((a, b) => b.sem! - a.sem! || byId(a, b));
		const fused = new Map<string, number>();
		for (const order of [kwOrder, semOrder]) {
			order.forEach((row, i) => fused.set(row.node.id, (fused.get(row.node.id) ?? 0) + 1 / (RRF_K + i + 1)));
		}
		ranked = visible
			.filter((r) => fused.has(r.node.id))
			.map((row) => ({ row, score: fused.get(row.node.id)! }))
			.sort((a, b) => b.score - a.score || byId(a.row, b.row));
	}

	const p = page(ranked, limit);
	return {
		query,
		mode,
		...(note !== undefined ? { note } : {}),
		hiddenByStage,
		...p,
		items: p.items.map(({ row }) => ({
			id: row.node.id,
			name: capText(row.node.name, LIMITS.nameChars),
			statement: capText(row.node.statement, LIMITS.listStatementChars),
			trust: row.level,
			stage: row.nodeStage,
		})),
	};
}
