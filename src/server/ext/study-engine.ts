// src/server/ext/study-engine.ts
/**
 * The teacher-slot engine and the writer dependencies of the study stage's
 * background model work. Kept apart from lecture-live.ts so that the chat
 * handler (which imports practice-live.ts) never imports back into itself.
 */

import type { WriterDeps } from "../../agent/ext/lecture/writers.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { ROLE_SLOT } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { stores } from "../stores.ts";
import { liveCostGate, livePriceStep } from "./cost-live.ts";
import { observedEngine } from "./provider-pause.ts";

/** The teacher slot's engine, fresh per run (a settings change lands immediately). Throws with a readable reason. */
export function teacherEngine(): PiEngine {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new Error("lectures and exercises need a model for the teacher role: configure the models in settings");
	if (!providerKeyPresent(spec.provider)) throw new Error(`no API key for provider ${spec.provider}`);
	return observedEngine(piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.teacher]?.cacheRetention));
}

export const writerDeps = (): WriterDeps => ({ engine: teacherEngine(), gate: liveCostGate, priceStep: livePriceStep });
