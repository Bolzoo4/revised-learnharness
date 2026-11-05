// src/core/ext/explanation-service.ts
/**
 * Explanation generation, user edits and proposal decisions. Core only: the
 * model call, the clock-free storage and the cost ceiling arrive as ports.
 * The graph is READ-ONLY here (REQ-int-02: extension code never writes the
 * content ledgers) and an explanation never touches trust (REQ-node-09):
 * the only thing this module ever appends is explanation events.
 *
 * Flow of generateExplanations:
 *   1. pick the nodes that need text: no explanation, or a stale one, and no
 *      pending proposal for the current chains;
 *   2. cut them into batches of neighbours (explanation-batches.ts);
 *   3. per batch: ceiling check, one writer call, deterministic checks, and
 *      up to MAX_REGENERATIONS re-asks for the failed nodes only;
 *   4. append one version event per accepted text. Over a user-authored
 *      current version the agent text is stored as `proposed`.
 */

import { getGraph } from "../graph.ts";
import type { GraphStore } from "../ports.ts";
import { planBatches } from "./explanation-batches.ts";
import { checkExplanation } from "./explanation-check.ts";
import { concludingFingerprint, explanationForm, isStale } from "./explanation-rules.ts";
import { deriveExplanations } from "./explanations.ts";
import type {
	CostGate,
	ExplanationsStore,
	ExplanationWriter,
	SourceContext,
	WriterNode,
} from "./node-knowledge-ports.ts";

/** Regenerations after the first attempt (REQ-node-08: at most twice). */
export const MAX_REGENERATIONS = 2;

export interface ExplanationDeps {
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	explanations: ExplanationsStore;
	writer: ExplanationWriter;
	cost: CostGate;
	now?: () => string;
	batchSize?: number;
}

export interface GenerateRequest {
	nodeIds: readonly string[];
	/** Chapter text for a chapter run; null when there is none ("no source context"). */
	source: SourceContext | null;
}

export interface GenerateResult {
	/** Nodes whose new text became current. */
	written: string[];
	/** Nodes whose new text awaits the user's approval. */
	proposed: string[];
	skipped: Array<{ nodeId: string; reason: "unknown_node" | "current" | "pending_proposal" }>;
	rejected: Array<{ nodeId: string; errors: string[] }>;
	ceilingReached: boolean;
}

export async function generateExplanations(request: GenerateRequest, deps: ExplanationDeps): Promise<GenerateResult> {
	const now = deps.now ?? (() => new Date().toISOString());
	const { nodes, chains } = getGraph(deps.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const validIds = new Set(byId.keys());
	const derived = deriveExplanations(deps.explanations.readEvents());
	const result: GenerateResult = { written: [], proposed: [], skipped: [], rejected: [], ceilingReached: false };

	const todo: string[] = [];
	for (const nodeId of new Set(request.nodeIds)) {
		if (!byId.has(nodeId)) {
			result.skipped.push({ nodeId, reason: "unknown_node" });
			continue;
		}
		const entry = derived.get(nodeId);
		if (entry?.current !== null && entry?.current !== undefined && !isStale(entry.current, nodeId, chains)) {
			result.skipped.push({ nodeId, reason: "current" });
			continue;
		}
		if (entry?.proposal !== null && entry?.proposal !== undefined && entry.proposal.fingerprint === concludingFingerprint(nodeId, chains)) {
			result.skipped.push({ nodeId, reason: "pending_proposal" });
			continue;
		}
		todo.push(nodeId);
	}

	const describeNode = (nodeId: string): WriterNode => {
		const n = byId.get(nodeId);
		if (n === undefined) throw new Error(`generateExplanations: unknown node ${nodeId}`);
		const ref = (id: string) => ({ id, name: byId.get(id)?.name ?? id, statement: byId.get(id)?.statement ?? "" });
		const usedIn = new Map<string, string>();
		for (const c of chains) {
			if (c.premises.includes(nodeId)) usedIn.set(c.conclusion, byId.get(c.conclusion)?.name ?? c.conclusion);
		}
		return {
			id: n.id,
			name: n.name,
			statement: n.statement,
			aliases: [...n.aliases],
			form: explanationForm(nodeId, chains),
			arguments: chains.filter((c) => c.conclusion === nodeId).map((c) => c.premises.map(ref)),
			usedIn: [...usedIn].map(([id, name]) => ({ id, name })),
		};
	};

	for (const batch of planBatches(todo, chains, deps.batchSize)) {
		let pending = batch;
		let feedback: Record<string, string[]> = {};
		for (let attempt = 0; attempt <= MAX_REGENERATIONS && pending.length > 0; attempt++) {
			if (!deps.cost.allowed()) {
				result.ceilingReached = true;
				return result;
			}
			const out = await deps.writer.write({ nodes: pending.map(describeNode), source: request.source, feedback });
			deps.cost.record(out.costUsd);
			const failed: string[] = [];
			feedback = {};
			for (const nodeId of pending) {
				const body = Object.hasOwn(out.bodies, nodeId) ? out.bodies[nodeId] : undefined;
				const problems = body === undefined ? ["the writer returned no text for this node"] : checkExplanation(body, validIds).errors;
				if (body === undefined || problems.length > 0) {
					failed.push(nodeId);
					feedback[nodeId] = problems;
					continue;
				}
				const entry = derived.get(nodeId);
				const proposed = entry?.current?.author === "user";
				deps.explanations.appendEvent({
					type: "version",
					nodeId,
					version: (entry?.latestVersion ?? 0) + 1,
					body,
					author: "agent",
					sourceRefs: request.source?.refs ?? [],
					styleVersion: out.styleVersion,
					fingerprint: concludingFingerprint(nodeId, chains),
					noSource: request.source === null,
					proposed,
					at: now(),
				});
				(proposed ? result.proposed : result.written).push(nodeId);
			}
			pending = failed;
		}
		for (const nodeId of pending) result.rejected.push({ nodeId, errors: feedback[nodeId] ?? [] });
	}
	return result;
}

export function saveUserExplanation(
	nodeId: string,
	body: string,
	deps: Pick<ExplanationDeps, "graph" | "explanations" | "now">,
): { version: number } {
	const { nodes, chains } = getGraph(deps.graph);
	if (!nodes.some((n) => n.id === nodeId)) throw new Error(`unknown node ${nodeId}`);
	const check = checkExplanation(body, new Set(nodes.map((n) => n.id)));
	if (check.errors.length > 0) throw new Error(`explanation refused: ${check.errors.join("; ")}`);
	const latest = deriveExplanations(deps.explanations.readEvents()).get(nodeId)?.latestVersion ?? 0;
	const version = latest + 1;
	deps.explanations.appendEvent({
		type: "version",
		nodeId,
		version,
		body,
		author: "user",
		sourceRefs: [],
		styleVersion: "user",
		fingerprint: concludingFingerprint(nodeId, chains),
		noSource: false,
		proposed: false,
		at: (deps.now ?? (() => new Date().toISOString()))(),
	});
	return { version };
}

export function decideProposal(
	nodeId: string,
	decision: "approved" | "rejected",
	deps: Pick<ExplanationDeps, "explanations" | "now">,
): { version: number } {
	const proposal = deriveExplanations(deps.explanations.readEvents()).get(nodeId)?.proposal;
	if (proposal === null || proposal === undefined) throw new Error(`no pending proposal for ${nodeId}`);
	deps.explanations.appendEvent({
		type: "decision",
		nodeId,
		version: proposal.version,
		decision,
		at: (deps.now ?? (() => new Date().toISOString()))(),
	});
	return { version: proposal.version };
}
