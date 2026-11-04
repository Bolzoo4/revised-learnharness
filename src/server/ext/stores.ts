// src/server/ext/stores.ts
/**
 * THE COMPOSITION ROOT for the extension layer's stores — a separate file
 * from upstream's src/server/stores.ts on purpose (no upstream edit). Later
 * plans add their adapters here.
 */

import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
