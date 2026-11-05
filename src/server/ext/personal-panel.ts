// src/server/ext/personal-panel.ts
/**
 * What the personal layer contributes to the node panel (node-knowledge
 * plan: PanelSources.cards / .review and the pin / retire / startReview
 * action handlers). Structurally typed on purpose, so this file does not
 * depend on the node-knowledge types; the shapes match its PanelCard,
 * PanelReview and NodeActionHandlers. "Create card" has no handler here: a
 * card needs a question and an answer, which the panel's button supplies
 * through POST /api/ext/cards.
 */

import { personalLayer, type PersonalLayer } from "./personal-layer.ts";

export function createPersonalPanel(layer: PersonalLayer) {
	return {
		sources: {
			cards: (nodeId: string) =>
				layer.listCards(nodeId).map((c) => ({ cardId: c.id, question: c.question, status: c.status })),
			review: (nodeId: string) => layer.nodeReview(nodeId),
		},
		handlers: {
			pin: (nodeId: string) => layer.mark({ nodeId, pinned: true }),
			retire: (nodeId: string) => layer.mark({ nodeId, retired: true }),
			startReview: (_nodeId: string) => layer.startReviewSession(),
		},
	};
}

export const personalPanel = createPersonalPanel(personalLayer);
