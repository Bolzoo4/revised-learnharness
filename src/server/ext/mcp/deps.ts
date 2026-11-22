// src/server/ext/mcp/deps.ts
/**
 * THE COMPOSITION ROOT of the read-only MCP server: builds McpDeps from a data
 * directory using only src/store/ext/readonly.ts. It does NOT import
 * src/server/stores.ts, src/server/ext/stores.ts, settings, keys, chats or any
 * agent code: the server cannot reach a model, a secret or a write path
 * because none of them is in its import closure (test: ext-mcp-closure).
 */

import path from "node:path";
import { parseCardEvent } from "../../../core/ext/cards.ts";
import { parseJournalEvent } from "../../../core/ext/debrief/journal.ts";
import { parseDocumentEvent } from "../../../core/ext/study/documents.ts";
import { parseExplanationEvent } from "../../../core/ext/explanations.ts";
import { parseFrontierEvent } from "../../../core/ext/frontier.ts";
import { parseGoalEvent } from "../../../core/ext/goals.ts";
import { deriveLinks, parseLinkEvent } from "../../../core/ext/links.ts";
import { parseInboxEvent } from "../../../core/ext/inbox.ts";
import type { AppApiPort, McpDeps, ReadLog } from "../../../core/ext/mcp/ports.ts";
import { parseExerciseEvent } from "../../../core/ext/practice/exercises.ts";
import { parseReadingEvent } from "../../../core/ext/study/reading.ts";
import { parseCycleLogEntry } from "../../../core/ext/research-log.ts";
import { parseReviewEvent } from "../../../core/ext/review.ts";
import { parseVerificationEvent } from "../../../core/ext/trust.ts";
import { createGraphReader, createLectureReader, createReadableGuard, createSourceLabels, readOnlyLedger } from "../../../store/ext/readonly.ts";
import { DEFAULT_EMBEDDER_SPEC, unavailableEmbedder } from "../../../core/ext/embedder.ts";
import { VECTOR_INDEX_FILE } from "../../../core/ext/vector-index.ts";
import { createSemanticReader } from "./semantic.ts";

/** Every write the app's types allow is refused loudly: reaching this is a bug, never a feature. */
function refuseWrite(): never {
	throw new Error("read-only server: a write was attempted");
}

/** The app's store shape (appendEvent + readEvents) over a read-only log. */
function asStore<T>(log: ReadLog<T>): { appendEvent(event: T): void; readEvents(): T[] } {
	return { appendEvent: refuseWrite, readEvents: () => log.readAll() };
}

/**
 * `appApi` is the only write path of the server: the running app's endpoints, used by the write tools.
 * The data stores below still refuse every write.
 */
export function createMcpDeps(dataRoot: string, clock: () => string = () => new Date().toISOString(), appApi: AppApiPort): McpDeps {
	const extDir = path.join(dataRoot, "ext");
	const graph = createGraphReader(path.join(dataRoot, "graph"));
	const linksLog = readOnlyLedger(extDir, "links.jsonl", parseLinkEvent);
	return {
		appApi,
		sources: createSourceLabels(path.join(dataRoot, "graph")),
		review: {
			graphStore: graph,
			goalsStore: asStore(readOnlyLedger(extDir, "goals.jsonl", parseGoalEvent)),
			reviewStore: asStore(readOnlyLedger(extDir, "review.jsonl", parseReviewEvent)),
			cardsStore: asStore(readOnlyLedger(extDir, "cards.jsonl", parseCardEvent)),
			linksStore: { readLinks: () => deriveLinks(linksLog.readAll()) },
		},
		verification: readOnlyLedger(extDir, "verification.jsonl", parseVerificationEvent),
		explanations: readOnlyLedger(extDir, "explanations.jsonl", parseExplanationEvent),
		exercises: readOnlyLedger(extDir, "exercises.jsonl", parseExerciseEvent),
		frontier: readOnlyLedger(extDir, "frontier.jsonl", parseFrontierEvent),
		inbox: readOnlyLedger(extDir, "inbox.jsonl", parseInboxEvent),
		researchLog: readOnlyLedger(extDir, "research-log.jsonl", parseCycleLogEntry),
		journal: readOnlyLedger(extDir, "journal.jsonl", parseJournalEvent),
		documents: readOnlyLedger(extDir, "documents.jsonl", parseDocumentEvent),
		reading: readOnlyLedger(extDir, "reading.jsonl", parseReadingEvent),
		lectures: createLectureReader(extDir),
		// Semantic search reads the app's index; the model loader is unavailable until the adapter is approved.
		semantic: createSemanticReader(path.join(extDir, VECTOR_INDEX_FILE), DEFAULT_EMBEDDER_SPEC, unavailableEmbedder),
		now: clock,
		assertReadable: createReadableGuard(dataRoot),
	};
}
