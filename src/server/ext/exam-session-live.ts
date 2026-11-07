// src/server/ext/exam-session-live.ts
/**
 * Composition of the exam session (session kind `exam`): the exam service's
 * exercises and material search, the binding ledger, and upstream's chat store
 * for the conversation. Only wiring; the logic is in exam-session.ts.
 */

import { createLedger } from "../../store/ext/ledger.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { stores } from "../stores.ts";
import { createExamSessionService, parseExamBinding, type ExamSessionService } from "./exam-session.ts";
import { examsService } from "./exams-live.ts";

const bindingsLedger = createLedger(EXT_PATHS.dir, "exam-sessions.jsonl", parseExamBinding);

// One service per process, kept on globalThis like study-live.ts does.
const examSessionHolder = globalThis as unknown as { __lhExamSession?: ExamSessionService };
export const examSessionService: ExamSessionService = (examSessionHolder.__lhExamSession ??= createExamSessionService({
	locate: (collectionId, exerciseId) => {
		const found = examsService.getCollection(collectionId);
		if (found === null) return null;
		for (const exam of found.exams) {
			const exercise = examsService.listExercises(exam.id).find((e) => e.id === exerciseId);
			if (exercise !== undefined) return { exercise, reviewed: exam.reviewed };
		}
		return null;
	},
	search: (collectionId, query, opts) => examsService.searchMaterial(collectionId, query, opts),
	bindings: bindingsLedger,
	createSession: (title) => stores.chatStore.createChat(title, "exam"),
}));
