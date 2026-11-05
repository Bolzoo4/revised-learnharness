// src/server/ext/stores.ts
/**
 * THE COMPOSITION ROOT for the extension layer's stores — a separate file
 * from upstream's src/server/stores.ts on purpose (no upstream edit). Later
 * plans add their adapters here.
 */

import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createCardsStore } from "../../store/ext/cards-store.ts";
import { createCostStore } from "../../store/ext/cost-store.ts";
import { createExplanationsStore } from "../../store/ext/explanations-store.ts";
import { parseExerciseEvent } from "../../core/ext/practice/exercises.ts";
import { parseOfficeHoursEvent } from "../../core/ext/practice/office-hours.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";
import { createLecturesStore } from "../../store/ext/lectures-store.ts";
import { createLedger } from "../../store/ext/ledger.ts";
import { createResearchStore } from "../../store/ext/research-store.ts";
import { createReviewStore } from "../../store/ext/review-store.ts";
import { createSnapshotReader } from "../../store/ext/snapshot-reader.ts";
import { createSnapshotStore } from "../../store/ext/snapshot-store.ts";
import { createSourcesStore } from "../../store/ext/sources-store.ts";
import { createVerificationStore } from "../../store/ext/verification-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
	reviewStore: createReviewStore(EXT_PATHS.dir),
	cardsStore: createCardsStore(EXT_PATHS.dir),
	sourcesStore: createSourcesStore(EXT_PATHS.dir),
	snapshotStore: createSnapshotStore(EXT_PATHS.dir),
	verificationStore: createVerificationStore(EXT_PATHS.dir),
	costStore: createCostStore(EXT_PATHS.dir),
	lecturesStore: createLecturesStore(EXT_PATHS.dir),
	snapshotReader: createSnapshotReader(EXT_PATHS.dir),
	officeHoursLedger: createLedger(EXT_PATHS.dir, "office-hours.jsonl", parseOfficeHoursEvent),
	exercisesLedger: createLedger(EXT_PATHS.dir, "exercises.jsonl", parseExerciseEvent),
	explanationsStore: createExplanationsStore(EXT_PATHS.dir),
	/** ONE store per data dir: the cycle's busy guard is keyed on its `log` object (and `lockKey`). */
	researchStore: createResearchStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
