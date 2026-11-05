// src/core/ext/verification-service.ts
/**
 * The verification service: the one object the server wires. Single-flight
 * per node (the same node is never verified twice at once), trigger
 * selection, library activation, and trust views for the UI and the
 * teacher's context.
 */

import { deriveGoals } from "./goals.ts";
import type { GoalsStore } from "./ports.ts";
import { createSourceLibrary, type SourceEntry, type SourceLibrary, type SourceTier } from "./sources.ts";
import { deriveTrustMap, type Evidence, type TrustLevel } from "./trust.ts";
import { activationTargets, postMergeTargets, type TargetInputs } from "./verify-targets.ts";
import { verifyNodes, type VerifyDeps, type VerifyReport } from "./verify.ts";

export interface TrustView {
	nodeId: string;
	level: TrustLevel;
	/** Timestamp of the latest completed check, null when never checked. */
	at: string | null;
	evidence: Evidence[];
}

export interface VerificationServiceDeps extends VerifyDeps {
	goalsStore: GoalsStore;
}

export interface VerificationService {
	library: SourceLibrary;
	verify(nodeIds: readonly string[]): Promise<VerifyReport>;
	afterMerge(): Promise<VerifyReport>;
	afterActivation(): Promise<VerifyReport>;
	/** The user's decision: activate a library entry, then re-verify in-scope unverified/contested nodes. */
	activateSource(id: string, tier?: SourceTier): { entry: SourceEntry; verification: Promise<VerifyReport> };
	trust(nodeIds: readonly string[]): TrustView[];
}

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
	const inFlight = new Set<string>();
	const library = createSourceLibrary(deps.sourcesStore);

	async function verify(nodeIds: readonly string[]): Promise<VerifyReport> {
		const ids = [...new Set(nodeIds)].filter((id) => !inFlight.has(id));
		for (const id of ids) inFlight.add(id);
		try {
			return await verifyNodes(ids, deps);
		} finally {
			for (const id of ids) inFlight.delete(id);
		}
	}

	function targetInputs(): TargetInputs {
		return {
			goals: deriveGoals(deps.goalsStore.readEvents()),
			nodes: deps.graphStore.readNodes(),
			chains: deps.graphStore.readChains(),
			events: deps.verificationStore.readEvents(),
		};
	}

	return {
		library,
		verify,
		afterMerge: () => verify(postMergeTargets(targetInputs())),
		afterActivation: () => verify(activationTargets(targetInputs())),
		activateSource(id, tier) {
			const entry = library.setStatus(id, "active", tier);
			return { entry, verification: verify(activationTargets(targetInputs())) };
		},
		trust(nodeIds) {
			const map = deriveTrustMap(deps.verificationStore.readEvents());
			return nodeIds.map((nodeId) => {
				const state = map.get(nodeId);
				return { nodeId, level: state?.level ?? "unverified", at: state?.at ?? null, evidence: state?.evidence ?? [] };
			});
		},
	};
}
