// src/core/ext/mcp/node.ts
/**
 * get_node and get_neighbors (REQ-mcp-04, REQ-mcp-09, REQ-mcp-10). get_node is
 * the app's own buildNodePanel (the panel the learner sees) mapped field by
 * field to a bounded, allow-listed shape.
 */

import { getGraph } from "../../graph.ts";
import { deriveCards } from "../cards.ts";
import { citingLectures } from "../lecture/lecture-graph.ts";
import { neighbourhood } from "../neighbourhood.ts";
import { buildNodePanel } from "../node-panel.ts";
import { snapshot } from "../review-service.ts";
import type { Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { parseDepth, requireId } from "./input.ts";
import { capText, LIMITS, page, round4, textPage } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { evidencePage, trustLevels } from "./trust-view.ts";

const notFoundNode = (id: string): ToolError => new ToolError("not_found", `No node with id "${capText(id, 60)}".`);

export function getNode(call: Call, input: Record<string, unknown>, opts: RunOptions) {
	const id = requireId(input.id, "id");
	const levels = trustLevels(call.deps.verification.readAll());
	const trust = levels.get(id);
	const lectures = call.deps.lectures.list();

	const panel = buildNodePanel(id, {
		graph: call.graph,
		explanationEvents: call.deps.explanations.readAll(),
		goalEvents: call.review.goalsStore.readEvents(),
		sources: {},
		costAllowed: true,
		availableActions: [],
	});
	if (panel === null) throw notFoundNode(id);

	const ref = (r: { id: string; name: string }) => ({ id: r.id, name: capText(r.name, LIMITS.nameChars) });
	const ex = panel.explanation;
	const conclusions = new Map<string, { id: string; name: string }>();
	for (const u of panel.usedAsPremise) if (!conclusions.has(u.conclusion.id)) conclusions.set(u.conclusion.id, u.conclusion);

	const base = {
		id: panel.node.id,
		name: capText(panel.node.name, LIMITS.nameChars),
		statement: capText(panel.node.statement, LIMITS.statementChars),
		aliases: textPage(panel.node.aliases, LIMITS.aliasesMax, LIMITS.nameChars),
		trust: { level: trust?.level ?? "unverified", checkedAt: trust?.at ?? null, evidence: evidencePage(trust?.evidence ?? []) },
		explanation: {
			state: ex.state,
			noSourceContext: ex.current?.noSource ?? false,
			form: ex.form,
			version: ex.current?.version ?? null,
			author: ex.current?.author ?? null,
			body: ex.current === null ? null : capText(ex.current.body, LIMITS.explanationChars),
			pendingProposal: ex.proposal !== null,
		},
		// One entry per chain concluding the node; more than one means alternative arguments.
		arguments: (() => {
			const p = page(panel.concluding, LIMITS.argumentsMax);
			return { ...p, items: p.items.map((c) => ({ premises: page(c.premises.map(ref), LIMITS.premisesPerArgumentMax) })) };
		})(),
		conclusions: page([...conclusions.values()].map(ref), LIMITS.conclusionsMax),
		citingLectures: (() => {
			const p = page(citingLectures(id, lectures), LIMITS.citingLecturesMax);
			return { ...p, items: p.items.map((l) => ({ lectureId: l.id, title: capText(l.title, LIMITS.titleChars) })) };
		})(),
	};
	if (opts.knowledgeOnly) return { ...base, studyState: "disabled" as const };

	const cards = deriveCards(call.review.cardsStore.readEvents()).filter((c) => c.nodeId === id && c.status === "active");
	let review: {
		dueAt: string | null;
		recallProbability: number | null;
		reps: number;
		pinned: boolean;
		retired: boolean;
	} | null = null;
	let reviewUnavailable = false;
	try {
		const snap = snapshot(call.review, call.now);
		const state = snap.states.get(id);
		const pinned = snap.marks.pinned.has(id);
		const retired = snap.marks.retired.has(id);
		if (state !== undefined || pinned || retired) {
			const due = state?.card.due.getTime();
			review = {
				dueAt: due !== undefined && Number.isFinite(due) ? new Date(due).toISOString() : null,
				recallProbability: state === undefined ? null : round4(snap.recall(id)),
				reps: state?.card.reps ?? 0,
				pinned,
				retired,
			};
		}
	} catch {
		reviewUnavailable = true; // knowledge stays readable when the review history cannot be replayed
	}
	const goals = page(panel.goals, LIMITS.goalsPerNodeMax);
	return {
		...base,
		studyState: "enabled" as const,
		cardCount: cards.length,
		review,
		reviewUnavailable,
		goals: { ...goals, items: goals.items.map((g) => ({ id: g.id, title: capText(g.title, LIMITS.titleChars), status: g.status, isTarget: g.isTarget })) },
	};
}

export function getNeighbors(call: Call, input: Record<string, unknown>) {
	const id = requireId(input.id, "id");
	const depth = parseDepth(input.depth);
	const { nodes, chains } = getGraph(call.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	if (!byId.has(id)) throw notFoundNode(id);
	const levels = trustLevels(call.deps.verification.readAll());
	const hood = neighbourhood(id, chains, depth);

	const nodePage = page(hood.nodes, LIMITS.neighbourNodesMax);
	const kept = new Set(nodePage.items.map((n) => n.id));
	const edgePage = page(
		hood.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
		LIMITS.neighbourEdgesMax,
	);
	return {
		center: { id, name: capText(byId.get(id)!.name, LIMITS.nameChars) },
		depth,
		nodes: {
			...nodePage,
			items: nodePage.items.map((n) => ({
				id: n.id,
				name: capText(byId.get(n.id)?.name ?? n.id, LIMITS.nameChars),
				depth: n.depth,
				trust: levels.get(n.id)?.level ?? "unverified",
			})),
		},
		edges: edgePage,
	};
}
