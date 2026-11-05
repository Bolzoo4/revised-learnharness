// src/server/ext/personal-trust.ts
/**
 * ASSUMED INTERFACE (source-verification plan): the live trust level of a
 * node, shown to the review agent. Until verification is wired in, every
 * node reads "unverified". The verification integration task replaces the
 * body of this one function.
 */

import type { TrustLevel } from "../../core/ext/review-queries.ts";

export function trustOfNode(_nodeId: string): TrustLevel {
	return "unverified";
}
