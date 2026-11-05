// src/server/ext/panel-providers.ts
/**
 * Where the panel gets data and actions that belong to other children. Each
 * plan fills ITS entries here (one line each):
 *   - verification:   sources.trust (not wired yet: shape mapping pending), nodeHandlers.verifyNow
 *   - lectures:       sources.lecturesCiting (not yet)
 *   - personal layer: sources.cards, sources.review, nodeHandlers.pin / retire / startReview
 *     (createCard stays without a handler: it needs a question and answer,
 *     supplied by the panel's button through POST /api/ext/cards)
 */

import type { PanelSources } from "../../core/ext/node-panel-types.ts";
import type { NodeActionHandlers } from "./node-knowledge.ts";
import { personalPanel } from "./personal-panel.ts";
import { verifyNodesNow } from "./verification.ts";

export const panelSources: PanelSources = { ...personalPanel.sources };

export const nodeHandlers: NodeActionHandlers = {
	...personalPanel.handlers,
	verifyNow: (nodeId) => verifyNodesNow([nodeId]),
};
