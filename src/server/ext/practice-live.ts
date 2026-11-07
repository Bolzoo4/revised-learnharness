// src/server/ext/practice-live.ts
/**
 * Composition of the office-hours / exercises stage. Only wiring; the logic is
 * in practice-service.ts. Exercise results reach the personal layer through
 * its core applyExerciseResult (the only writer of a goal's `reached`).
 */

import { writeExerciseSet } from "../../agent/ext/practice/exercise-writer.ts";
import { getGraph } from "../../core/graph.ts";
import { extractNodeLinks } from "../../core/ext/explanation-check.ts";
import { goalScope, deriveGoals } from "../../core/ext/goals.ts";
import { applyExerciseResult } from "../../core/ext/review-service.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createPracticeService } from "./practice-service.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";
import { studyBlockFor } from "./session-notes-live.ts";
import { trustViews } from "./verification.ts";

export const practiceService = createPracticeService({
	officeHours: extStores.officeHoursLedger,
	exercises: extStores.exercisesLedger,
	snapshots: { put: (t) => extStores.snapshotStore.put(t), get: (h) => extStores.snapshotReader.get(h) },
	gate: liveCostGate,
	createSession: (title) => stores.chatStore.createChat(title, "office_hours"),
	saveMessages: (chatId, messages) => stores.chatStore.saveMessages(chatId, messages),
	goalScope: (goalId) => {
		const goal = deriveGoals(extStores.goalsStore.readEvents()).find((x) => x.id === goalId);
		if (goal === undefined) return null;
		const chains = getGraph(stores.graphStore).chains;
		return { title: goal.title, targetNodeIds: goal.targetNodeIds, scope: goalScope(goal.targetNodeIds, chains), status: goal.status };
	},
	nodes: (ids) => {
		const want = new Set(ids);
		return getGraph(stores.graphStore).nodes.filter((n) => want.has(n.id)).map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
	},
	trust: (ids) => new Map(trustViews([...ids]).map((v) => [v.nodeId, v.level] as const)),
	writeExerciseSet: (input) => writeExerciseSet(writerDeps(), { ...input, studyNotes: studyBlockFor(input.nodes.map((n) => n.id)) }),
	// Office hours on a lecture exercise: the nodes the exercise links ([[id]]) carry their study preferences.
	studyNotesFor: (focus) => studyBlockFor(extractNodeLinks(focus)),
	applyExerciseResult: (input) =>
		applyExerciseResult(input, {
			graphStore: stores.graphStore,
			goalsStore: extStores.goalsStore,
			reviewStore: extStores.reviewStore,
			cardsStore: extStores.cardsStore,
		}),
});


/** Active goals for the practice page. */
export function listActiveGoals(): Array<{ id: string; title: string }> {
	return deriveGoals(extStores.goalsStore.readEvents()).filter((g) => g.status === "active").map((g) => ({ id: g.id, title: g.title }));
}
