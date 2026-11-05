// src/server/ext/node-knowledge.ts
/**
 * The node-knowledge service factory: panel data, single-flight explanation
 * generation, user edits, proposal decisions and node actions, over injected
 * ports (graph, explanations, goals, writer, cost gate, panel sources,
 * action handlers). The live wiring is node-knowledge-live.ts; keeping the
 * factory free of the real stores makes it testable with memory fakes.
 */

import { createGoal } from "../../core/ext/goal-service.ts";
import {
	decideProposal,
	generateExplanations,
	saveUserExplanation,
	type GenerateRequest,
	type GenerateResult,
} from "../../core/ext/explanation-service.ts";
import { buildNodePanel } from "../../core/ext/node-panel.ts";
import { NODE_ACTIONS, type NodeAction, type NodePanelData, type PanelSources } from "../../core/ext/node-panel-types.ts";
import type { CostGate, ExplanationsStore, ExplanationWriter, SourceContext } from "../../core/ext/node-knowledge-ports.ts";
import type { GoalsStore } from "../../core/ext/ports.ts";
import type { GraphStore } from "../../core/ports.ts";

/** An expected failure with the HTTP status the route should return. */
export class NodeKnowledgeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "NodeKnowledgeError";
		this.status = status;
	}
}

/** Actions other children implement; absent handler = button disabled, route answers 501. */
export type NodeActionHandlers = Partial<Record<Exclude<NodeAction, "askInChat" | "useAsGoalTarget">, (nodeId: string) => Promise<unknown> | unknown>>;

export interface NodeKnowledgeDeps {
	graphStore: GraphStore;
	explanations: ExplanationsStore;
	goalsStore: GoalsStore;
	writer: ExplanationWriter;
	cost: CostGate;
	sources: PanelSources;
	handlers: NodeActionHandlers;
	now?: () => string;
	batchSize?: number;
}

export function createNodeKnowledge(deps: NodeKnowledgeDeps) {
	const inFlight = new Map<string, Promise<GenerateResult>>();

	const requireNode = (nodeId: string) => {
		if (!deps.graphStore.readNodes().some((n) => n.id === nodeId)) {
			throw new NodeKnowledgeError(404, `unknown node ${nodeId}`);
		}
	};
	const availableActions = (): NodeAction[] =>
		NODE_ACTIONS.filter((a) => a === "askInChat" || a === "useAsGoalTarget" || deps.handlers[a] !== undefined);
	const explanationDeps = () => ({
		graph: deps.graphStore,
		explanations: deps.explanations,
		writer: deps.writer,
		cost: deps.cost,
		now: deps.now,
		batchSize: deps.batchSize,
	});
	/** Outside a chapter run the node's verification quotes are the source text (REQ-node-09). */
	const sourceContextFor = (nodeId: string): SourceContext | null => {
		const evidence = deps.sources.trust?.(nodeId).evidence ?? [];
		if (evidence.length === 0) return null;
		return { text: evidence.map((e) => e.quote).join("\n\n"), refs: [...new Set(evidence.map((e) => e.snapshotHash))] };
	};

	return {
		panel(nodeId: string): NodePanelData {
			const data = buildNodePanel(nodeId, {
				graph: deps.graphStore,
				explanationEvents: deps.explanations.readEvents(),
				goalEvents: deps.goalsStore.readEvents(),
				sources: deps.sources,
				costAllowed: deps.cost.allowed(),
				availableActions: availableActions(),
			});
			if (data === null) throw new NodeKnowledgeError(404, `unknown node ${nodeId}`);
			return data;
		},

		/** First-opening generation (REQ-node-05): one shared run per node at a time. */
		ensureExplanation(nodeId: string): Promise<GenerateResult> {
			requireNode(nodeId);
			const running = inFlight.get(nodeId);
			if (running !== undefined) return running;
			const run = generateExplanations({ nodeIds: [nodeId], source: sourceContextFor(nodeId) }, explanationDeps()).finally(() =>
				inFlight.delete(nodeId),
			);
			inFlight.set(nodeId, run);
			return run;
		},

		/** The chapter-run entry (REQ-node-04): the lecture pipeline passes the chapter text. */
		generateForNodes(request: GenerateRequest): Promise<GenerateResult> {
			return generateExplanations(request, explanationDeps());
		},

		saveExplanation(nodeId: string, body: string): { version: number } {
			requireNode(nodeId);
			try {
				return saveUserExplanation(nodeId, body, explanationDeps());
			} catch (e) {
				throw new NodeKnowledgeError(400, e instanceof Error ? e.message : String(e));
			}
		},

		decide(nodeId: string, decision: "approved" | "rejected"): { version: number } {
			requireNode(nodeId);
			try {
				return decideProposal(nodeId, decision, explanationDeps());
			} catch (e) {
				throw new NodeKnowledgeError(409, e instanceof Error ? e.message : String(e));
			}
		},

		async runAction(nodeId: string, action: NodeAction): Promise<unknown> {
			requireNode(nodeId);
			if (action === "askInChat") throw new NodeKnowledgeError(400, "askInChat runs in the browser");
			if (action === "useAsGoalTarget") {
				const name = deps.graphStore.readNodes().find((n) => n.id === nodeId)?.name ?? nodeId;
				return createGoal(
					{ title: name, existingNodeId: nodeId, origin: "user", originRef: "" },
					{ graphStore: deps.graphStore, goalsStore: deps.goalsStore, now: deps.now },
				);
			}
			const handler = deps.handlers[action];
			if (handler === undefined) throw new NodeKnowledgeError(501, `action ${action} is not available yet`);
			return (await handler(nodeId)) ?? { ok: true };
		},
	};
}

export type NodeKnowledge = ReturnType<typeof createNodeKnowledge>;
