// src/server/ext/extraction-deps.ts
/**
 * The model wiring the extraction pipeline gets in the live app, for the extension's own
 * pipeline instances (the staged chapter graphs, lecture-live.ts). It mirrors the live pipeline's
 * `engineFor` and `providerKeyMissing` in src/server/chat-handler.ts, whose helpers are not
 * exported. Keep the two in step: the same role resolution, the same cache retention per slot,
 * the same key-presence refusal. Read fresh per stage call, as the live pipeline does.
 */

import type { ModelRole } from "../../../config.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyMissing as providerKeyMissingEnvelope, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import { providerKeyPresent } from "../keys.ts";
import { stores } from "../stores.ts";

export interface ExtractionModelDeps {
	engineFor(role: ModelRole): PiEngine | undefined;
	providerKeyMissing(provider: string, tier: ModelSlotName): ProviderKeyMissing | null;
}

function retentionForSlot(slot: ModelSlotName) {
	return () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention;
}

export function extractionModelDeps(): ExtractionModelDeps {
	return {
		engineFor: (role) => {
			const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
			return spec ? piEngineForSpec(spec, true, undefined, retentionForSlot(ROLE_SLOT[role])) : undefined;
		},
		providerKeyMissing: (provider, tier) => (providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier])),
	};
}
