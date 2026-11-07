// src/server/ext/exam-session.ts
/**
 * The exam session service (session kind `exam`, REQ-ex-07, REQ-ex-11, REQ-ex-12).
 * Pure with respect to its inputs: the exercises, the material search, the
 * binding ledger and the chat creation come in through ports (the live wiring is
 * exam-session-live.ts). One conversation is bound to one exercise of one
 * collection; the binding is an append-only ledger line written at start.
 *
 * Errors: an ExamSessionError (HttpError) carries a fixed message written here.
 * A session starts only for an exercise of a REVIEWED exam (REQ-ex-03): the learner
 * has seen the split before anything reads it.
 */

import type { Exercise, SearchHit } from "../../core/ext/exams/types.ts";
import type { ExamAgentContext } from "../../agent/ext/exams/exam-agent.ts";
import { HttpError } from "./http-error.ts";

export class ExamSessionError extends HttpError {}

/** The longest id the start request may carry (characters). */
export const MAX_ID_CHARS = 200;

export interface ExamBinding {
	chatId: string;
	collectionId: string;
	exerciseId: string;
	examId: string;
	at: string;
}

/** The ledger's parser: a valid binding, or null (the ledger never writes what this rejects). */
export function parseExamBinding(raw: unknown): ExamBinding | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const fields = ["chatId", "collectionId", "exerciseId", "examId", "at"] as const;
	for (const f of fields) if (typeof r[f] !== "string" || (r[f] as string) === "") return null;
	return { chatId: r.chatId as string, collectionId: r.collectionId as string, exerciseId: r.exerciseId as string, examId: r.examId as string, at: r.at as string };
}

export interface ExamSessionDeps {
	/** The exercise and whether its exam is reviewed, or null when the collection or the exercise is unknown. */
	locate(collectionId: string, exerciseId: string): { exercise: Exercise; reviewed: boolean } | null;
	/** The collection's material search (the service's searchMaterial). */
	search(collectionId: string, query: string, opts: { k: number; maxTokens: number }): SearchHit[];
	bindings: { append(binding: ExamBinding): void; readAll(): ExamBinding[] };
	/** Creates a conversation of kind `exam` and returns its id. */
	createSession(title: string): { id: string };
	now?: () => string;
}

export interface ExamSessionService {
	/** Starts a session on one exercise: validates the ids, checks the exam is reviewed, creates the chat and binds it. */
	start(input: unknown): { chatId: string };
	/** The agent's view of a session: its exercise and the material search, bound to its collection. */
	toolContext(chatId: string, chatStore: ExamAgentContext["chatStore"]): ExamAgentContext;
}

function requiredId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim();
	return v === "" || v.length > MAX_ID_CHARS ? null : v;
}

/** The newest binding of a chat (a chat is bound once; the newest line wins if a ledger ever holds more). */
function boundTo(bindings: ExamSessionDeps["bindings"], chatId: string): ExamBinding | null {
	let found: ExamBinding | null = null;
	for (const b of bindings.readAll()) if (b.chatId === chatId) found = b;
	return found;
}

export function createExamSessionService(deps: ExamSessionDeps): ExamSessionService {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		start(input: unknown) {
			const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
			const collectionId = requiredId(body.collectionId);
			const exerciseId = requiredId(body.exerciseId);
			if (collectionId === null || exerciseId === null) throw new ExamSessionError(400, "collectionId and exerciseId are required");
			const found = deps.locate(collectionId, exerciseId);
			if (found === null) throw new ExamSessionError(404, "the exercise was not found");
			if (!found.reviewed) throw new ExamSessionError(409, "review the exercises of this exam before practising them");
			const session = deps.createSession(`Exam, exercise ${found.exercise.order}`);
			deps.bindings.append({ chatId: session.id, collectionId, exerciseId, examId: found.exercise.examId, at: now() });
			return { chatId: session.id };
		},
		toolContext(chatId, chatStore) {
			const binding = boundTo(deps.bindings, chatId);
			const exercise = binding === null ? null : (deps.locate(binding.collectionId, binding.exerciseId)?.exercise ?? null);
			return {
				chatId,
				chatStore,
				collectionId: binding?.collectionId ?? "",
				exercise,
				search: (query, opts) => (binding === null ? [] : deps.search(binding.collectionId, query, opts)),
			};
		},
	};
}
