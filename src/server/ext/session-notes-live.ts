// src/server/ext/session-notes-live.ts
/**
 * Composition of the session-notes stage and its readers (session-notes spec). Only wiring:
 * the stage is in core/ext/session-notes-service.ts, the model call in agent/ext/session-notes-writer.ts.
 * The stage runs after a chat's extraction batch merges (extraction.ts onBatchMerged, wired in
 * chat-handler.ts); the readers serve the node panel, the sessions that work on a node, and the
 * exercise writer.
 */

import { createSessionNoteWriter } from "../../agent/ext/session-notes-writer.ts";
import { getGraph } from "../../core/graph.ts";
import type { PanelStudyNote } from "../../core/ext/node-panel-types.ts";
import { createSessionNotesService } from "../../core/ext/session-notes-service.ts";
import {
	chatIdsOfNodes,
	notesForChats,
	SessionNoteError,
	studyBlockForNodes,
	withStudyBlock,
	learnerTextsOf,
	type SessionNote,
} from "../../core/ext/session-notes.ts";
import type { LhMarkerMessage, LhMessage } from "../../core/native-messages.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../../core/settings.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { extractionModelDeps } from "./extraction-deps.ts";
import { HttpError } from "./http-error.ts";
import { extStores } from "./stores.ts";

const modelDeps = extractionModelDeps();

/** The cheap-tier engine for the notes stage, read fresh per call; a missing model or key refuses the call. */
const writer = createSessionNoteWriter({
	engine: () => {
		const engine = modelDeps.engineFor("extractor");
		if (engine === undefined) throw new ModelsNotConfiguredError(["cheap"]);
		const provider = engine.model.provider;
		if (modelDeps.providerKeyMissing(provider, "cheap") !== null) throw new ProviderKeyMissingError(provider, ["cheap"]);
		return engine;
	},
});

const service = createSessionNotesService({
	store: extStores.sessionNotesStore,
	proposer: writer,
	costGate: liveCostGate,
	now: () => new Date().toISOString(),
	log: (message, err) => console.error(message, err),
});

function titleOf(chatId: string): string {
	return stores.chatStore.getChat(chatId)?.title || chatId;
}

/** The extraction hook (REQ-sn-02): after a chat batch merges, its learner messages feed the stage. Never throws, never waits. Inert under NODE_ENV=test. */
export function sessionNotesAfterBatch(chatId: string, messages: readonly LhMessage[]): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		void service.afterBatch(chatId, learnerTextsOf(messages)).catch((err) => console.error(`[session-notes ${chatId}] stage failed:`, err));
	} catch (err) {
		console.error(`[session-notes ${chatId}] stage not started:`, err);
	}
}

function nodesOf(nodeIds: readonly string[]) {
	const want = new Set(nodeIds);
	return getGraph(stores.graphStore).nodes.filter((n) => want.has(n.id));
}

/** The study-preferences block for the given nodes (REQ-sn-05): "" when none of their chats has a note. */
export function studyBlockFor(nodeIds: readonly string[]): string {
	return studyBlockForNodes(nodesOf(nodeIds), extStores.sessionNotesStore.read(), titleOf);
}

/** A graph-context marker with the study preferences of its picked nodes ahead of the session context (REQ-sn-05). */
export function withStudyNotes(message: LhMarkerMessage, nodeIds: readonly string[]): LhMarkerMessage {
	return withStudyBlock(message, studyBlockFor(nodeIds));
}

/** The notes of the chats a node came from, for the node panel (REQ-sn-06). */
export function studyNotesOfNode(nodeId: string): PanelStudyNote[] {
	const chatIds = chatIdsOfNodes(nodesOf([nodeId]));
	return notesForChats(extStores.sessionNotesStore.read(), chatIds).map((n) => ({
		chatId: n.chatId,
		chatTitle: titleOf(n.chatId),
		text: n.text,
		edited: n.edited,
		updatedAt: n.updatedAt,
	}));
}

/** The learner's save (text) or clear (""), from the node panel. Unknown chat is a 404; a refused text is a 400. */
export function setSessionNote(chatId: string, raw: unknown): SessionNote | null {
	if (stores.chatStore.getChat(chatId) === null) throw new HttpError(404, "unknown session");
	try {
		return service.setLearnerNote(chatId, raw);
	} catch (err) {
		if (err instanceof SessionNoteError) throw new HttpError(400, err.message);
		throw err;
	}
}
