// src/core/ext/stage.ts
/**
 * The derived node stage (REQ-graph-agent-13/14). Never stored: computed on
 * demand from the graph, the active goals' scope and the review ledger. Pure:
 * no IO, no clock.
 *
 * "TAUGHT" (one definition, used everywhere): a node is taught when
 *   (a) it has a provenance entry whose chatId starts with "chat_" (it was
 *       created from, or mentioned in, a teaching chat), OR
 *   (b) it has any review result recorded.
 * A node whose provenance is only "src_" entries (document or agent imports)
 * and that has no review result is NOT taught.
 *
 * Rule order of nodeStage (first match wins):
 *   1. recall known and >= DERIVABLE_RECALL          -> confirmed
 *   2. outside every active goal scope, no reviews   -> confirmed
 *   3. outside every active goal scope (has reviews) -> unrevised
 *   4. not taught                                    -> staged
 *   5. otherwise                                     -> unrevised
 * So "staged" is only ever returned for nodes in an active goal scope.
 */

import { DERIVABLE_RECALL } from "./deck.ts";

export type NodeStage = "staged" | "unrevised" | "confirmed";

export interface StageInput {
	inActiveGoalScope: boolean;
	taught: boolean;
	/** Recall of the node now; null when it has no review result yet. */
	recall: number | null;
	hasReviewHistory: boolean;
}

export function nodeStage(input: StageInput): NodeStage {
	if (input.recall !== null && input.recall >= DERIVABLE_RECALL) return "confirmed";
	if (!input.inActiveGoalScope && !input.hasReviewHistory) return "confirmed";
	if (!input.inActiveGoalScope) return "unrevised";
	if (!input.taught) return "staged";
	return "unrevised";
}

/** The "taught" definition from the module header. */
export function isTaught(provenanceChatIds: readonly string[], hasReviewHistory: boolean): boolean {
	return hasReviewHistory || provenanceChatIds.some((id) => id.startsWith("chat_"));
}

export interface StageContext {
	/** Node ids in the scope of at least one ACTIVE goal. */
	activeScope: ReadonlySet<string>;
	/** Recall per node id; a node absent from the map has no recall result. */
	recall: ReadonlyMap<string, number>;
	/** Node ids with at least one review result. */
	reviewed: ReadonlySet<string>;
}

export interface StageNode {
	id: string;
	provenance: readonly { chatId: string }[];
}

/** The stage of every given node. */
export function stagesFor(nodes: readonly StageNode[], ctx: StageContext): Map<string, NodeStage> {
	const out = new Map<string, NodeStage>();
	for (const node of nodes) {
		const hasReviewHistory = ctx.reviewed.has(node.id);
		out.set(
			node.id,
			nodeStage({
				inActiveGoalScope: ctx.activeScope.has(node.id),
				taught: isTaught(
					node.provenance.map((p) => p.chatId),
					hasReviewHistory,
				),
				recall: ctx.recall.get(node.id) ?? null,
				hasReviewHistory,
			}),
		);
	}
	return out;
}

/** How many nodes are in each stage (zero for a stage with none). */
export function stageCounts(stages: Iterable<NodeStage>): Record<NodeStage, number> {
	const counts: Record<NodeStage, number> = { staged: 0, unrevised: 0, confirmed: 0 };
	for (const stage of stages) counts[stage] += 1;
	return counts;
}
