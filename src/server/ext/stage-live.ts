// src/server/ext/stage-live.ts
/**
 * The live derived node stage: assembles the inputs of core/ext/stage.ts
 * from the real stores (graph nodes, active goals and their scope, review
 * results). Thin on purpose: the rules live in core.
 */

import { activeScope } from "../../core/ext/goals.ts";
import { nowOf, snapshot, type ReviewDeps } from "../../core/ext/review-service.ts";
import { stagesFor, type NodeStage } from "../../core/ext/stage.ts";
import { stores } from "../stores.ts";
import { extStores } from "./stores.ts";

/** Stage of every node, given the ledgers behind `deps` at `now`. */
export function stagesOf(deps: ReviewDeps, now: string): Map<string, NodeStage> {
	const snap = snapshot(deps, now);
	const reviewed = new Set<string>();
	for (const e of deps.reviewStore.readEvents()) if (e.type === "review") reviewed.add(e.nodeId);
	const recall = new Map<string, number>();
	for (const id of snap.states.keys()) recall.set(id, snap.recall(id));
	return stagesFor(snap.nodes, {
		activeScope: new Set(activeScope(snap.goals, snap.chains)),
		recall,
		reviewed,
	});
}

/** Stage of every node in the live store. */
export function liveStages(): Map<string, NodeStage> {
	const deps: ReviewDeps = {
		graphStore: stores.graphStore,
		goalsStore: extStores.goalsStore,
		reviewStore: extStores.reviewStore,
		cardsStore: extStores.cardsStore,
	};
	return stagesOf(deps, nowOf(deps));
}
