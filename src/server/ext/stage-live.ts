// src/server/ext/stage-live.ts
/**
 * The live derived node stage: assembles the stores of the app and hands them to
 * the core's stagesOf (core/ext/stage.ts), which holds the rules.
 */

import { nowOf, type ReviewDeps } from "../../core/ext/review-service.ts";
import { stagesOf, type NodeStage } from "../../core/ext/stage.ts";
import { stores } from "../stores.ts";
import { extStores } from "./stores.ts";

export { stagesOf };

/** Stage of every node in the live store. */
export function liveStages(): Map<string, NodeStage> {
	const deps: ReviewDeps = {
		graphStore: stores.graphStore,
		goalsStore: extStores.goalsStore,
		reviewStore: extStores.reviewStore,
		cardsStore: extStores.cardsStore,
		linksStore: extStores.linksStore,
	};
	return stagesOf(deps, nowOf(deps));
}
