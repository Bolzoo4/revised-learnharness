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
import { parseInboxEvent } from "../../../core/ext/inbox.ts";
import type { McpDeps, ReadLog } from "../../../core/ext/mcp/ports.ts";
import { parseExerciseEvent } from "../../../core/ext/practice/exercises.ts";
import { parseReadingEvent } from "../../../core/ext/study/reading.ts";
import { parseCycleLogEntry } from "../../../core/ext/research-log.ts";
import { parseReviewEvent } from "../../../core/ext/review.ts";
import { parseVerificationEvent } from "../../../core/ext/trust.ts";
import { createGraphReader, createLectureReader, createReadableGuard, readOnlyLedger } from "../../../store/ext/readonly.ts";

/** Every write the app's types allow is refused loudly: reaching this is a bug, never a feature. */
function refuseWrite(): never {
	throw new Error("read-only server: a write was attempted");
}

/** The app's store shape (appendEvent + readEvents) over a read-only log. */
function asStore<T>(log: ReadLog<T>): { appendEvent(event: T): void; readEvents(): T[] } {
	return { appendEvent: refuseWrite, readEvents: () => log.readAll() };
}

export function createMcpDeps(dataRoot: string, clock: () => string = () => new Date().toISOString()): McpDeps {
	const extDir = path.join(dataRoot, "ext");
	const graph = createGraphReader(path.join(dataRoot, "graph"));
	return {
		review: {
			graphStore: graph,
			goalsStore: asStore(readOnlyLedger(extDir, "goals.jsonl", parseGoalEvent)),
			reviewStore: asStore(readOnlyLedger(extDir, "review.jsonl", parseReviewEvent)),
			cardsStore: asStore(readOnlyLedger(extDir, "cards.jsonl", parseCardEvent)),
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
		now: clock,
		assertReadable: createReadableGuard(dataRoot),
	};
}
