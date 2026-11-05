// src/server/ext/stores.ts
/**
 * THE COMPOSITION ROOT for the extension layer's stores — a separate file
 * from upstream's src/server/stores.ts on purpose (no upstream edit). Later
 * plans add their adapters here.
 */

import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createCostStore } from "../../store/ext/cost-store.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";
import { createSnapshotStore } from "../../store/ext/snapshot-store.ts";
import { createSourcesStore } from "../../store/ext/sources-store.ts";
import { createVerificationStore } from "../../store/ext/verification-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
	sourcesStore: createSourcesStore(EXT_PATHS.dir),
	snapshotStore: createSnapshotStore(EXT_PATHS.dir),
	verificationStore: createVerificationStore(EXT_PATHS.dir),
	costStore: createCostStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
