// src/core/ext/node-panel.ts
/**
 * buildNodePanel: assembles the panel's data for one node from the graph,
 * the explanation and goal events and the optional PanelSources. Pure given
 * its inputs (core/graph.ts getGraph is the shared reader). SERVER-SIDE
 * module: it is deliberately not in the browser barrel because core/graph.ts
 * imports node:crypto; the browser uses node-panel-types.ts instead.
 */

import { getGraph } from "../graph.ts";
import type { GraphStore } from "../ports.ts";
import { extractNodeLinks, mentionedBy } from "./explanation-check.ts";
import { explanationForm, isStale } from "./explanation-rules.ts";
import { deriveExplanations, type ExplanationEvent } from "./explanations.ts";
import { deriveGoals, goalScope, type GoalEvent } from "./goals.ts";
import { neighbourhood } from "./neighbourhood.ts";
import type {
	ExplanationView,
	NodeAction,
	NodePanelData,
	NodeRef,
	PanelSources,
} from "./node-panel-types.ts";

export interface PanelInput {
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	explanationEvents: readonly ExplanationEvent[];
	goalEvents: readonly GoalEvent[];
	sources: PanelSources;
	/** False when the daily cost ceiling is reached (REQ-node-05). */
	costAllowed: boolean;
	availableActions: readonly NodeAction[];
}

export function buildNodePanel(nodeId: string, input: PanelInput): NodePanelData | null {
	const { nodes, chains } = getGraph(input.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const node = byId.get(nodeId);
	if (node === undefined) return null;
	const ref = (id: string): NodeRef => ({ id, name: byId.get(id)?.name ?? id });

	const derived = deriveExplanations(input.explanationEvents);
	const entry = derived.get(nodeId);
	const current = entry?.current ?? null;
	const proposal = entry?.proposal ?? null;
	const state = current === null ? "missing" : isStale(current, nodeId, chains) ? "stale" : "current";

	const linkNames: Record<string, string> = {};
	for (const body of [current?.body, proposal?.body]) {
		if (body === undefined) continue;
		for (const id of extractNodeLinks(body)) {
			const linked = byId.get(id);
			if (linked !== undefined) linkNames[id] = linked.name;
		}
	}
	const explanation: ExplanationView = {
		state,
		ceiling: state !== "current" && !input.costAllowed,
		form: explanationForm(nodeId, chains),
		current: current && { version: current.version, body: current.body, author: current.author, noSource: current.noSource },
		proposal: proposal && { version: proposal.version, body: proposal.body },
		linkNames,
	};

	const currentBodies = new Map<string, string>();
	for (const [id, e] of derived) if (e.current !== null && byId.has(id)) currentBodies.set(id, e.current.body);

	const goals = deriveGoals(input.goalEvents).flatMap((g) =>
		goalScope(g.targetNodeIds, chains).includes(nodeId)
			? [{ id: g.id, title: g.title, status: g.status, isTarget: g.targetNodeIds.includes(nodeId) }]
			: [],
	);

	const hood = neighbourhood(nodeId, chains, 2);
	return {
		node: { id: node.id, name: node.name, statement: node.statement, aliases: [...node.aliases] },
		explanation,
		trust: input.sources.trust?.(nodeId) ?? { level: "unverified", evidence: [] },
		concluding: chains.filter((c) => c.conclusion === nodeId).map((c) => ({ chainId: c.id, premises: c.premises.map(ref) })),
		usedAsPremise: chains
			.filter((c) => c.premises.includes(nodeId))
			.map((c) => ({
				chainId: c.id,
				coPremises: c.premises.filter((p) => p !== nodeId).map(ref),
				conclusion: ref(c.conclusion),
			})),
		citingLectures: input.sources.lecturesCiting?.(nodeId) ?? [],
		studySources: input.sources.studySources?.(nodeId) ?? [],
		studyNotes: input.sources.studyNotes?.(nodeId) ?? [],
		mentionedBy: mentionedBy(nodeId, currentBodies).map(ref),
		cards: input.sources.cards?.(nodeId) ?? [],
		review: input.sources.review?.(nodeId) ?? null,
		goals,
		neighbourhood: { nodes: hood.nodes.map((n) => ({ ...ref(n.id), depth: n.depth })), edges: hood.edges },
		availableActions: [...input.availableActions],
	};
}
