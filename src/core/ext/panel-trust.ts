/**
 * Maps the verification layer's TrustView into the node panel's PanelTrust
 * (REQ-node-12). Pure. An unvetted item has no library entry id, so the cited
 * reference stands in as the source label.
 */

import type { PanelTrust } from "./node-panel-types.ts";
import type { TrustView } from "./verification-service.ts";

export function panelTrustOf(view: TrustView | undefined): PanelTrust {
	if (view === undefined) return { level: "unverified", evidence: [] };
	return {
		level: view.level,
		evidence: view.evidence.map((e) => ({
			sourceId: e.sourceId ?? e.sourceRef,
			locator: e.locator,
			quote: e.quote,
			stance: e.stance,
			tier: e.tier,
			snapshotHash: e.snapshot,
		})),
	};
}
