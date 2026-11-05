// src/server/ext/personal-trust.ts
/** The live trust level of a node, shown to the review agent (source-verification plan). */

import type { TrustLevel } from "../../core/ext/review-queries.ts";
import { trustViews } from "./verification.ts";

export function trustOfNode(nodeId: string): TrustLevel {
	return trustViews([nodeId])[0]?.level ?? "unverified";
}
