// src/server/ext/panel-providers.ts
/**
 * Where the panel gets data and actions that belong to other children. Each
 * plan fills ITS entries here (one line each):
 *   - verification:   sources.trust (via panelTrustOf), nodeHandlers.verifyNow
 *   - lectures:       sources.lecturesCiting (not yet)
 *   - personal layer: sources.cards, sources.review, nodeHandlers.pin / retire / startReview
 *     (createCard stays without a handler: it needs a question and answer,
 *     supplied by the panel's button through POST /api/ext/cards)
 */

import { panelTrustOf } from "../../core/ext/panel-trust.ts";
import type { PanelSources } from "../../core/ext/node-panel-types.ts";
import type { NodeActionHandlers } from "./node-knowledge.ts";
import { personalPanel } from "./personal-panel.ts";
import { trustViews, verifyNodesNow } from "./verification.ts";

export const panelSources: PanelSources = {
	...personalPanel.sources,
	trust: (nodeId) => panelTrustOf(trustViews([nodeId])[0]),
};

export const nodeHandlers: NodeActionHandlers = {
	...personalPanel.handlers,
	verifyNow: (nodeId) => verifyNodesNow([nodeId]),
};
