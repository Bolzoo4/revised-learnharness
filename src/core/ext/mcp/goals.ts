// src/core/ext/mcp/goals.ts
/** list_goals and get_goal (REQ-mcp-05). Scope, readiness and deck rules are the app's own functions. */

import { getGraph } from "../../graph.ts";
import { goalReadiness } from "../deck.ts";
import { DEFAULT_RETENTION } from "../fsrs.ts";
import { deriveGoals, goalScope, type Goal } from "../goals.ts";
import { deriveExerciseSets, setComplete, type ExerciseSetState } from "../practice/exercises.ts";
import type { Call } from "./call.ts";
import { guardReplay, snapshotOf } from "./call.ts";
import { ToolError } from "./errors.ts";
import { instantMs, optionalEnum, requireId } from "./input.ts";
import { capText, fitToBudget, LIMITS, page, round4 } from "./limits.ts";
import { trustLevels } from "./trust-view.ts";

export const GOAL_STATUSES = ["active", "paused", "reached"] as const;

export function listGoals(call: Call, input: Record<string, unknown>) {
	const status = optionalEnum(input.status, GOAL_STATUSES, "status");
	const snap = snapshotOf(call);
	const rows = snap.goals
		.filter((g) => status === undefined || g.status === status)
		.map((g) => {
			// Same scope and readiness as the app's goalReadinessReport.
			const r = goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall);
			return {
				id: g.id,
				title: capText(g.title, LIMITS.titleChars),
				status: g.status,
				priority: g.priority,
				origin: g.origin,
				createdAt: g.createdAt,
				targetCount: g.targetNodeIds.length,
				scopeSize: r.total,
				solidNodes: r.solid,
				solidShare: r.total === 0 ? 0 : round4(r.solid / r.total),
				ready: r.ready,
			};
		});
	// No caller limit: the list is bounded by the goal maximum and the list byte budget, and says so when it cuts.
	return fitToBudget(page(rows, LIMITS.listMax), LIMITS.listBudgetBytes);
}

/** The newest exercise set of a goal (a tie goes to the later one in the ledger), or null. */
export function latestExerciseSet(call: Call, goalId: string): ExerciseSetState | null {
	let latest: ExerciseSetState | null = null;
	for (const s of guardReplay(() => deriveExerciseSets(call.deps.exercises.readAll()))) {
		if (s.goalId === goalId && (latest === null || instantMs(s.createdAt) >= instantMs(latest.createdAt))) latest = s;
	}
	return latest;
}

type ExerciseSetView =
	| { state: "none" }
	| { state: "in_progress" | "complete" | "applied"; exercises: number; graded: number };

function exerciseSetOf(call: Call, goalId: string): ExerciseSetView {
	const latest = latestExerciseSet(call, goalId);
	if (latest === null) return { state: "none" };
	const state = latest.applied !== null ? "applied" : setComplete(latest) ? "complete" : "in_progress";
	return { state, exercises: latest.exercises.length, graded: latest.graded.size };
}

export function getGoal(call: Call, input: Record<string, unknown>) {
	const id = requireId(input.id, "id");
	const snap = snapshotOf(call);
	const goal: Goal | undefined = snap.goals.find((g) => g.id === id);
	if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(id, 60)}".`);

	const scope = goalScope(goal.targetNodeIds, snap.chains);
	const r = goalReadiness(scope, snap.recall);
	const levels = trustLevels(call.deps.verification.readAll());
	const names = new Map(getGraph(call.graph).nodes.map((n) => [n.id, n.name]));
	const nowMs = Date.parse(snap.now);

	let dueNow = 0;
	let unseen = 0;
	let scheduled = 0;
	const byTrust = { unverified: 0, sourced: 0, contested: 0, refuted: 0 };
	for (const nodeId of scope) {
		if (!snap.nodeIds.has(nodeId)) continue;
		byTrust[levels.get(nodeId)?.level ?? "unverified"] += 1;
		if (snap.marks.retired.has(nodeId) && !snap.marks.pinned.has(nodeId)) continue;
		const state = snap.states.get(nodeId);
		if (state === undefined) unseen += 1;
		else if (state.card.due.getTime() <= nowMs) dueNow += 1;
		else scheduled += 1;
	}
	const targets = page(goal.targetNodeIds, LIMITS.targetsMax);
	return {
		id: goal.id,
		title: capText(goal.title, LIMITS.titleChars),
		status: goal.status,
		priority: goal.priority,
		origin: goal.origin,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		desiredRetention: snap.marks.retention.get(goal.id) ?? DEFAULT_RETENTION,
		targets: {
			...targets,
			items: targets.items.map((t) => ({ id: t, name: capText(names.get(t) ?? t, LIMITS.nameChars), trust: levels.get(t)?.level ?? "unverified" })),
		},
		scope: { size: r.total, solid: r.solid, solidShare: r.total === 0 ? 0 : round4(r.solid / r.total), ready: r.ready, byTrust },
		due: { dueNow, unseen, scheduled },
		exerciseSet: exerciseSetOf(call, goal.id),
	};
}
