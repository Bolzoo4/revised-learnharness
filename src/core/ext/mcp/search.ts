// src/core/ext/mcp/search.ts
/** search_nodes (REQ-mcp-04): upstream's fuzzy scoring over name, statement and aliases. */

import { fuzzyScore } from "../../fuzzy.ts";
import { getGraph } from "../../graph.ts";
import { deriveGoals, goalScope } from "../goals.ts";
import { guardReplay, type Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { compareCodeUnits, optionalEnum, requireId, requireQuery } from "./input.ts";
import { capText, clampLimit, LIMITS, page } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { TRUST_LEVELS, trustLevels } from "./trust-view.ts";

const nfc = (s: string): string => s.normalize("NFC");

export function searchNodes(call: Call, input: Record<string, unknown>, opts: RunOptions) {
	const query = requireQuery(input.query);
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const trust = optionalEnum(input.trust, TRUST_LEVELS, "trust");
	const goalId = input.goalId === undefined ? undefined : requireId(input.goalId, "goalId");
	if (goalId !== undefined && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by goal needs study state, which is disabled (--knowledge-only).");
	}

	const { nodes, chains } = getGraph(call.graph);
	let scope: Set<string> | null = null;
	if (goalId !== undefined) {
		const goal = guardReplay(() => deriveGoals(call.review.goalsStore.readEvents())).find((g) => g.id === goalId);
		if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(goalId, 60)}".`);
		scope = new Set(goalScope(goal.targetNodeIds, chains));
	}

	const levels = trustLevels(call.deps.verification.readAll());
	const hits: Array<{ id: string; name: string; statement: string; score: number; level: string }> = [];
	for (const node of nodes) {
		if (scope !== null && !scope.has(node.id)) continue;
		const level = levels.get(node.id)?.level ?? "unverified";
		if (trust !== undefined && level !== trust) continue;
		// Stored text is compared in NFC too, so composed and decomposed accents match alike.
		const score = fuzzyScore(query, nfc(node.name), nfc(node.statement), ...node.aliases.map(nfc));
		if (score === null) continue;
		hits.push({ id: node.id, name: node.name, statement: node.statement, score, level });
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
		})),
	};
}
