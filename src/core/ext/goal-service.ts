// src/core/ext/goal-service.ts
/**
 * createGoal (umbrella spec REQ-goal-01): a goal always has a target node.
 * With `statement` the node is created through upstream's merger
 * (core/graph.ts mergeFindings) — the ONLY writer of the content ledgers —
 * using the goal id as the source id, so its provenance is
 * {chatId: goalId, messageId: ""} (the same idea as the `src_…` ids of
 * imported notes). With `existingNodeId` no node is created. All validation
 * happens before the first write.
 */

import { randomBytes } from "node:crypto";
import type { AuditVerdicts, SessionFindings } from "../contracts.ts";
import { mergeFindings } from "../graph.ts";
import type { ChatStore, GraphStore } from "../ports.ts";
import {
	DEFAULT_GOAL_PRIORITY,
	deriveGoals,
	isValidGoalPriority,
	validateWeights,
	validateWeightsPatch,
	type Goal,
	type GoalOrigin,
	type GoalWeights,
} from "./goals.ts";
import type { GoalsStore } from "./ports.ts";

export interface GoalServiceDeps {
	graphStore: GraphStore;
	goalsStore: GoalsStore;
	now?: () => string;
	newGoalId?: () => string;
}

interface GoalInputBase {
	title: string;
	origin: GoalOrigin;
	originRef: string;
	priority?: number;
	/** Optional partial weights (missing keys are 1). Validated before any write. */
	weights?: unknown;
}
export type CreateGoalInput =
	| (GoalInputBase & { statement: string })
	| (GoalInputBase & { existingNodeId: string });

function newGoalId(): string {
	return `goal_${randomBytes(6).toString("hex")}`;
}

/** The merger is chat-store-free; if it ever reaches for one, fail loudly. */
const noChatStore = new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(`goal service: chatStore.${String(prop)} is not available to the merger`);
		},
	},
) as ChatStore;

export function createGoal(input: CreateGoalInput, deps: GoalServiceDeps): Goal {
	const now = (deps.now ?? (() => new Date().toISOString()))();
	const goalId = (deps.newGoalId ?? newGoalId)();
	const priority = input.priority ?? DEFAULT_GOAL_PRIORITY;

	if (input.title.trim() === "") throw new Error("createGoal: title must not be empty");
	if (!isValidGoalPriority(priority)) throw new Error(`createGoal: priority must be an integer 1 to 5, got ${priority}`);
	let weights: GoalWeights | undefined;
	if (input.weights !== undefined) {
		const w = validateWeights(input.weights);
		if (!w.ok) throw new Error(`createGoal: ${w.problems.join("; ")}`);
		weights = w.weights;
	}

	let targetNodeId: string;
	if ("existingNodeId" in input) {
		if (!deps.graphStore.readNodes().some((n) => n.id === input.existingNodeId)) {
			throw new Error(`createGoal: unknown node ${input.existingNodeId}`);
		}
		targetNodeId = input.existingNodeId;
	} else {
		if (input.statement.trim() === "") throw new Error("createGoal: statement must not be empty");
		const findings: SessionFindings = {
			propositions: [{ id: "p1", name: input.title, statement: input.statement, aliases: [] }],
			chains: [],
		};
		const verdicts: AuditVerdicts = { links: [] };
		mergeFindings(goalId, findings, verdicts, { chatStore: noChatStore, graphStore: deps.graphStore }, { foldedAt: now });
		const node = deps.graphStore.readNodes().find((n) => n.provenance.some((p) => p.chatId === goalId));
		if (node === undefined) throw new Error("createGoal: the merger did not create the target node");
		targetNodeId = node.id;
	}

	deps.goalsStore.appendEvent({
		type: "created",
		goalId,
		title: input.title,
		origin: input.origin,
		originRef: input.originRef,
		targetNodeIds: [targetNodeId],
		priority,
		...(weights ? { weights } : {}),
		at: now,
	});
	const goal = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === goalId);
	if (goal === undefined) throw new Error("createGoal: the created event did not derive a goal");
	return goal;
}

/**
 * Changes some weights of a goal (REQ-graph-agent-17). The given keys are merged onto
 * the goal's current weights and the full result is appended as one event. Unknown
 * keys and out-of-range values are rejected before any write.
 */
export function setWeights(goalId: string, raw: unknown, deps: GoalServiceDeps): Goal {
	const now = (deps.now ?? (() => new Date().toISOString()))();
	const current = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === goalId);
	if (current === undefined) throw new Error(`setWeights: unknown goal ${goalId}`);
	const patch = validateWeightsPatch(raw);
	if (!patch.ok) throw new Error(`setWeights: ${patch.problems.join("; ")}`);
	const weights: GoalWeights = { ...current.weights, ...patch.patch };
	deps.goalsStore.appendEvent({ type: "weights", goalId, weights, at: now });
	const goal = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === goalId);
	if (goal === undefined) throw new Error("setWeights: the weights event did not derive a goal");
	return goal;
}
