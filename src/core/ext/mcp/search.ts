// src/core/ext/mcp/search.ts
/** search_nodes (REQ-mcp-04): upstream's fuzzy scoring over name, statement and aliases. */

import { fuzzyScore } from "../../fuzzy.ts";
import { getGraph } from "../../graph.ts";
import { deriveGoals, goalScope } from "../goals.ts";
import { guardReplay, stagesOfCall, type Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { compareCodeUnits, optionalEnum, requireId, requireQuery } from "./input.ts";
import { capText, clampLimit, LIMITS, page } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { TRUST_LEVELS, trustLevels } from "./trust-view.ts";
import type { NodeStage } from "../stage.ts";

const nfc = (s: string): string => s.normalize("NFC");

export const STAGE_FILTERS = ["staged", "unrevised", "confirmed", "all"] as const;

/**
 * The stage filter defaults to "confirmed": a learner's search shows what is
 * settled. Under --knowledge-only a stage needs study state, so the default is
 * "all" (no filter) and an explicit stage other than "all" is refused.
 */
export function searchNodes(call: Call, input: Record<string, unknown>, opts: RunOptions) {
	const query = requireQuery(input.query);
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const trust = optionalEnum(input.trust, TRUST_LEVELS, "trust");
	const goalId = input.goalId === undefined ? undefined : requireId(input.goalId, "goalId");
	if (goalId !== undefined && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by goal needs study state, which is disabled (--knowledge-only).");
	}
	const stageArg = optionalEnum(input.stage, STAGE_FILTERS, "stage");
	if (stageArg !== undefined && stageArg !== "all" && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by stage needs study state, which is disabled (--knowledge-only).");
	}
	const stage = stageArg ?? (opts.knowledgeOnly ? "all" : "confirmed");

	// The graph is read first, so a graph read failure keeps its own (internal) path; the stages replay the review history.
	const { nodes, chains } = getGraph(call.graph);
	const stages: Map<string, NodeStage> | null = opts.knowledgeOnly ? null : stagesOfCall(call);
	let scope: Set<string> | null = null;
	if (goalId !== undefined) {
		const goal = guardReplay(() => deriveGoals(call.review.goalsStore.readEvents())).find((g) => g.id === goalId);
		if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(goalId, 60)}".`);
		scope = new Set(goalScope(goal.targetNodeIds, chains));
	}

	const levels = trustLevels(call.deps.verification.readAll());
	const hits: Array<{ id: string; name: string; statement: string; score: number; level: string; stage: NodeStage | null }> = [];
	for (const node of nodes) {
		if (scope !== null && !scope.has(node.id)) continue;
		const level = levels.get(node.id)?.level ?? "unverified";
		if (trust !== undefined && level !== trust) continue;
		const nodeStage = stages?.get(node.id) ?? null;
		// The stage filter runs here, before the limit: a page then holds matching nodes only.
		if (stage !== "all" && nodeStage !== stage) continue;
		// Stored text is compared in NFC too, so composed and decomposed accents match alike.
		const score = fuzzyScore(query, nfc(node.name), nfc(node.statement), ...node.aliases.map(nfc));
		if (score === null) continue;
		hits.push({ id: node.id, name: node.name, statement: node.statement, score, level, stage: nodeStage });
	}
	hits.sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));

	const p = page(hits, limit);
	return {
		query,
		...p,
		items: p.items.map((h) => ({
			id: h.id,
			name: capText(h.name, LIMITS.nameChars),
			statement: capText(h.statement, LIMITS.listStatementChars),
			trust: h.level,
			stage: h.stage,
		})),
	};
}
