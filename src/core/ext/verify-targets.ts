// src/core/ext/verify-targets.ts
/**
 * Which nodes the automatic triggers verify (REQ-src-13, REQ-ver-03). Pure.
 * Automatic runs are limited to the scope of ACTIVE goals; on-demand runs
 * (any node) bypass these selectors.
 */

import type { GraphChain, GraphNode } from "../contracts.ts";
import { activeScope, type Goal } from "./goals.ts";
import { deriveTrustMap, type VerificationEvent } from "./trust.ts";

export interface TargetInputs {
	goals: readonly Goal[];
	nodes: readonly Pick<GraphNode, "id">[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	events: readonly VerificationEvent[];
}

function scopeNodeIds(i: TargetInputs): string[] {
	const exists = new Set(i.nodes.map((n) => n.id));
	return activeScope(i.goals, i.chains).filter((id) => exists.has(id));
}

/** After a merge: in-scope nodes with no verification event at all (so a node that came back unverified is not re-spent on every merge). */
export function postMergeTargets(i: TargetInputs): string[] {
	const attempted = new Set(i.events.map((e) => e.nodeId));
	return scopeNodeIds(i).filter((id) => !attempted.has(id));
}

/** After a library entry is activated: in-scope nodes that are unverified or contested. */
export function activationTargets(i: TargetInputs): string[] {
	const trust = deriveTrustMap(i.events);
	return scopeNodeIds(i).filter((id) => {
		const level = trust.get(id)?.level ?? "unverified";
		return level === "unverified" || level === "contested";
	});
}
