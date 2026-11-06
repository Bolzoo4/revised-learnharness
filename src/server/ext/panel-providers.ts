// src/server/ext/panel-providers.ts
/**
 * Where the panel gets data and actions that belong to other children. Each
 * plan fills ITS entries here (one line each):
 *   - verification:   sources.trust (via panelTrustOf), nodeHandlers.verifyNow
 *   - lectures:       sources.lecturesCiting (read from the lectures store)
 *   - personal layer: sources.cards, sources.review, nodeHandlers.pin / retire / startReview
 *     (createCard stays without a handler: it needs a question and answer,
 *     supplied by the panel's button through POST /api/ext/cards)
 */

import { citingLectures } from "../../core/ext/lecture/lecture-graph.ts";
import { panelTrustOf } from "../../core/ext/panel-trust.ts";
import { deriveDocuments } from "../../core/ext/study/documents.ts";
import { sourcesOfNode } from "../../core/ext/study/links.ts";
import type { PanelSources } from "../../core/ext/node-panel-types.ts";
import type { NodeActionHandlers } from "./node-knowledge.ts";
import { personalPanel } from "./personal-panel.ts";
import { extStores } from "./stores.ts";
import { trustViews, verifyNodesNow } from "./verification.ts";

export const panelSources: PanelSources = {
	...personalPanel.sources,
	trust: (nodeId) => panelTrustOf(trustViews([nodeId])[0]),
	lecturesCiting: (nodeId) => citingLectures(nodeId, extStores.lecturesStore.list()).map((l) => ({ lectureId: l.id, title: l.title })),
	studySources: (nodeId) => {
		const docs = deriveDocuments(extStores.documentsLedger.readAll());
		return sourcesOfNode(extStores.studyLinksLedger.readAll(), nodeId).flatMap((s) => {
			const doc = docs.find((d) => d.id === s.documentId);
			return doc === undefined ? [] : [{ documentId: doc.id, title: doc.title, page: s.page }];
		});
	},
};

export const nodeHandlers: NodeActionHandlers = {
	...personalPanel.handlers,
	verifyNow: (nodeId) => verifyNodesNow([nodeId]),
};
