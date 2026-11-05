// src/server/ext/verification.ts
/**
 * Composition of the verification stage: real stores, the settings-resolved
 * researcher engine, the live search provider, and the daily cost ceiling.
 * Everything testable lives in src/core/ext and src/agent/ext; this file
 * only wires.
 */

import { createSourceReader } from "../../agent/ext/source-reader.ts";
import { createVerifier } from "../../agent/ext/verifier.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { createCostGate } from "../../core/ext/cost-gate.ts";
import type { SourceEntry, SourceTier } from "../../core/ext/sources.ts";
import { trustTag } from "../../core/ext/trust.ts";
import { createVerificationService, type TrustView } from "../../core/ext/verification-service.ts";
import type { VerifyReport } from "../../core/ext/verify.ts";
import { ROLE_SLOT } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { searchProvider } from "../search.ts";
import { stores } from "../stores.ts";
import { extStores } from "./stores.ts";

/** One daily ceiling for verification and research (REQ-cost-01). Override with LH_EXT_DAILY_CEILING_USD. */
const DEFAULT_DAILY_CEILING_USD = 2;
function ceilingUsd(): number {
	const raw = Number(process.env.LH_EXT_DAILY_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING_USD;
}

/** The researcher slot's engine, fresh per run (a settings change lands immediately). Throws with a readable reason. */
function researcherEngine(): PiEngine {
	const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
	if (!spec) throw new Error("verification needs a model for the researcher role: configure the models in settings");
	if (!providerKeyPresent(spec.provider)) throw new Error(`verification: no API key for provider ${spec.provider}`);
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.researcher]?.cacheRetention);
}

const service = createVerificationService({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	sourcesStore: extStores.sourcesStore,
	snapshotStore: extStores.snapshotStore,
	verificationStore: extStores.verificationStore,
	verifier: createVerifier({ engine: researcherEngine, search: searchProvider }),
	reader: createSourceReader({
		allowedPdfPaths: () => extStores.sourcesStore.read().filter((e) => e.kind === "pdf" && e.status === "active").map((e) => e.locator),
	}),
	costGate: {
		// Fresh per call so a LH_EXT_DAILY_CEILING_USD change lands without a restart.
		allowed: () => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).allowed(),
		record: (usd, source) => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).record(usd, source),
	},
});

/** On-demand verification of any nodes. */
export function verifyNodesNow(nodeIds: string[]): Promise<VerifyReport> {
	return service.verify(nodeIds);
}

/** The post-merge trigger (REQ-src-13). */
export function verifyAfterMerge(): Promise<VerifyReport> {
	return service.afterMerge();
}

export function trustViews(nodeIds: string[]): TrustView[] {
	return service.trust(nodeIds);
}

export function listLibrarySources(): SourceEntry[] {
	return service.library.list();
}

export function addLibrarySource(input: { kind: SourceEntry["kind"]; locator: string; tier: SourceTier; label: string; author?: string }): SourceEntry {
	return service.library.add({ ...input, addedBy: "user" });
}

/**
 * Only the USER activates an entry (REQ-src-02). Activation triggers the
 * background re-verification of in-scope unverified/contested nodes (REQ-src-13).
 */
export function setLibrarySourceStatus(id: string, status: SourceEntry["status"], tier?: SourceTier): SourceEntry {
	if (status === "active") {
		const { entry, verification } = service.activateSource(id, tier);
		void verification.catch((err) => console.error("[ext] activation verification failed:", err));
		return entry;
	}
	return service.library.setStatus(id, status, tier);
}

/** Tags picked propositions with their trust level for the teacher and practice context (REQ-src-15). Never throws. */
export function withTrustTags<T extends { id: string; statement: string }>(picks: readonly T[]): T[] {
	try {
		const level = new Map(service.trust(picks.map((p) => p.id)).map((v) => [v.nodeId, v.level]));
		return picks.map((p) => ({ ...p, statement: `${p.statement} ${trustTag(level.get(p.id) ?? "unverified")}` }));
	} catch (err) {
		console.error("[ext] trust tags unavailable:", err);
		return [...picks];
	}
}
