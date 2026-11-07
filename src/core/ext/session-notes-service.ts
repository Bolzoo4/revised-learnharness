// src/core/ext/session-notes-service.ts
/**
 * The session-notes stage (REQ-sn-02 to REQ-sn-04, REQ-sn-06): after an extraction batch
 * merges, one model proposal may update the chat's note. Pure orchestration over ports:
 * the store, the proposer (the agent layer's writer) and the daily cost gate. It never throws
 * to its caller, and it never writes the graph.
 *
 * Per chat the calls run one after another, so two batches of one chat never race. The
 * stored note is re-read after the model call: a learner's edit made while the model was
 * thinking wins (REQ-sn-04).
 */

import type { CostGate } from "./cost-gate.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../settings.ts";
import {
	applyStageProposal,
	parseLearnerNote,
	type SessionNote,
	type SessionNotes,
	type SessionNotesStore,
} from "./session-notes.ts";

export type SessionNotesStoreLike = SessionNotesStore;

/** The model side of the stage: one proposal from the learner's words (null = no change). */
export interface SessionNoteProposer {
	propose(
		input: { currentText: string | null; learnerTexts: readonly string[] },
		hooks: { costGate: CostGate },
	): Promise<{ text: string | null; costUsd: number }>;
}

export interface SessionNotesServiceDeps {
	store: SessionNotesStoreLike;
	proposer: SessionNoteProposer;
	costGate: CostGate;
	now(): string;
	log(message: string, err?: unknown): void;
}

export type AfterBatchOutcome = "skipped-no-learner-text" | "skipped-gate" | "skipped-unavailable" | "unchanged" | "updated" | "failed";

export function createSessionNotesService(deps: SessionNotesServiceDeps) {
	const queues = new Map<string, Promise<unknown>>();

	/** Runs `job` after the chat's earlier jobs; a failed earlier job does not block it. */
	function serial<T>(chatId: string, job: () => Promise<T>): Promise<T> {
		const previous = queues.get(chatId) ?? Promise.resolve();
		const next = previous.then(job, job);
		const settled = next.catch(() => undefined);
		queues.set(chatId, settled);
		void settled.then(() => {
			if (queues.get(chatId) === settled) queues.delete(chatId);
		});
		return next;
	}

	function gateOpen(): boolean {
		try {
			return deps.costGate.allowed();
		} catch {
			return false; // a gate that cannot answer is closed
		}
	}

	return {
		/** The note of one chat, or null. */
		noteOf(chatId: string): SessionNote | null {
			return deps.store.read()[chatId] ?? null;
		},

		/** The stage for one merged batch: `learnerTexts` are the learner's own messages of that batch. */
		afterBatch(chatId: string, learnerTexts: readonly string[]): Promise<AfterBatchOutcome> {
			return serial(chatId, async (): Promise<AfterBatchOutcome> => {
				const texts = learnerTexts.map((t) => t.trim()).filter((t) => t !== "");
				if (texts.length === 0) return "skipped-no-learner-text";
				if (deps.store.read()[chatId]?.edited === true) return "unchanged";
				if (!gateOpen()) return "skipped-gate";

				const current = deps.store.read()[chatId];
				let proposal: { text: string | null; costUsd: number };
				try {
					proposal = await deps.proposer.propose({ currentText: current?.text ?? null, learnerTexts: texts }, { costGate: deps.costGate });
				} catch (err) {
					if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) return "skipped-unavailable";
					deps.log(`[session-notes ${chatId}] stage failed:`, err);
					return "failed";
				}

				// Re-read: the learner may have saved their own note during the model call.
				const fresh: SessionNotes = deps.store.read();
				const next = applyStageProposal(fresh[chatId], proposal.text, deps.now());
				if (next === null) return "unchanged";
				deps.store.write({ ...fresh, [chatId]: next });
				return "updated";
			});
		},

		/** The learner's own save (text) or clear (""). Returns the stored note, or null when cleared. */
		setLearnerNote(chatId: string, raw: unknown): SessionNote | null {
			const text = parseLearnerNote(raw);
			const all = deps.store.read();
			if (text === "") {
				const rest: SessionNotes = { ...all };
				delete rest[chatId];
				deps.store.write(rest);
				return null;
			}
			const note: SessionNote = { text, updatedAt: deps.now(), edited: true };
			deps.store.write({ ...all, [chatId]: note });
			return note;
		},
	};
}
