// src/server/ext/study-live.ts
/**
 * Composition of the assisted-study stage: the live stores, the teacher-slot
 * engine for the two drafting calls, the shared cost gate, and upstream's
 * notes import for confirmed propositions. Only wiring; the logic is in
 * study-service.ts.
 *
 * chat-handler.ts imports this module (the `study` session's agent), and the
 * notes import lives in chat-handler.ts, so the import goes through a dynamic
 * import() at call time: no static cycle.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { draftCard, proposePageDrafts } from "../../agent/ext/study/draft-writer.ts";
import { readDocumentPages } from "../../agent/ext/study/pdf-pages.ts";
import { emit } from "../../core/events.ts";
import { getGraph } from "../../core/graph.ts";
import { createGoal } from "../../core/ext/goal-service.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { approveCard, createUserCard, proposeAgentCard, setPinned } from "../../core/ext/review-service.ts";
import type { CandidateNode } from "../../core/ext/study/card-node.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";
import { createStudyService } from "./study-service.ts";

const sourceIdOf = (filePath: string): string => `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

const reviewDeps = () => ({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	reviewStore: extStores.reviewStore,
	cardsStore: extStores.cardsStore,
});

const candidates = (pick: (n: ReturnType<typeof getGraph>["nodes"][number]) => boolean): CandidateNode[] =>
	getGraph(stores.graphStore)
		.nodes.filter(pick)
		.map((n) => ({ id: n.id, name: n.name, statement: n.statement, aliases: n.aliases }));

/**
 * A card drafted on the learner's request is not blocked by the daily ceiling
 * (plan decision 4: REQ-study-13 gates only complete runs). It is spend, so it
 * is still recorded on the shared gate.
 */
const userInitiatedGate = { allowed: () => true, record: liveCostGate.record };

/**
 * One service per process, kept on globalThis like research-live.ts does, so a
 * hot reload or a second module instance cannot run a second single-flight
 * registry or a second open/complete guard.
 */
const studyHolder = globalThis as unknown as { __lhStudy?: ReturnType<typeof createStudyService> };
export const studyService = (studyHolder.__lhStudy ??= createStudyService({
	documents: extStores.documentsLedger,
	reading: extStores.readingLedger,
	links: extStores.studyLinksLedger,
	drafts: extStores.studyDraftsLedger,
	files: extStores.documentFiles,
	readFile: async (p) => new Uint8Array(await fs.readFile(p)),
	fileSize: async (p) => (await fs.stat(p)).size,
	readPages: readDocumentPages,
	library: createSourceLibrary(extStores.sourcesStore),
	gate: liveCostGate,
	createSession: (title) => stores.chatStore.createChat(title, "study"),
	writers: {
		draftCard: (input) => draftCard({ ...writerDeps(), gate: userInitiatedGate }, input),
		proposePageDrafts: (input) => proposePageDrafts(writerDeps(), input),
	},
	nodesByIds: (ids) => {
		const want = new Set(ids);
		return candidates((n) => want.has(n.id));
	},
	importProposition: async ({ filePath, text }) => {
		const { extraction } = await import("../chat-handler.ts");
		sourceDirectory.registerImport(filePath);
		try {
			await extraction.importNotes({ filePath, text });
		} finally {
			emit("sources-changed", {});
		}
	},
	nodesFromSource: (filePath) => {
		const id = sourceIdOf(filePath);
		return candidates((n) => n.provenance.some((p) => p.chatId === id));
	},
	cards: {
		createUser: (input) => createUserCard(input, reviewDeps()),
		proposeAgent: (input) => proposeAgentCard(input, reviewDeps()),
		approve: (cardId) => approveCard(cardId, reviewDeps()),
		pin: (nodeId) => setPinned(nodeId, true, reviewDeps()),
	},
	createGoal: ({ title, statement, originRef }) =>
		createGoal({ title, statement, origin: "pdf", originRef }, { graphStore: stores.graphStore, goalsStore: extStores.goalsStore }),
}));

/** The absolute path of a document's stored PDF, for the viewer to stream. Throws StudyError 404 for an unknown document. */
export function studyPdfPath(documentId: string): string {
	return studyService.pdfFile(documentId);
}
