// tests/ext-session-notes-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { createSessionNotesService, type SessionNoteProposer, type SessionNotesStoreLike } from "../src/core/ext/session-notes-service.ts";
import type { SessionNotes } from "../src/core/ext/session-notes.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";

const NOW = "2026-11-07T10:00:00.000Z";

function memStore(initial: SessionNotes = {}): SessionNotesStoreLike & { value: SessionNotes; writes: number } {
	const s = {
		value: initial,
		writes: 0,
		read: () => ({ ...s.value }),
		write(next: SessionNotes) {
			s.writes++;
			s.value = { ...next };
		},
	};
	return s;
}

const openGate = (): CostGate => ({ allowed: () => true, record: () => undefined });

function proposer(answer: string | null | (() => never), calls: Array<{ currentText: string | null; learnerTexts: readonly string[] }> = []): SessionNoteProposer {
	return {
		async propose(input) {
			calls.push({ currentText: input.currentText, learnerTexts: input.learnerTexts });
			if (typeof answer === "function") answer();
			return { text: answer as string | null, costUsd: 0.01 };
		},
	};
}

function service(over: { store?: ReturnType<typeof memStore>; proposer?: SessionNoteProposer; costGate?: CostGate; logs?: string[] } = {}) {
	const store = over.store ?? memStore();
	const logs = over.logs ?? [];
	const svc = createSessionNotesService({
		store,
		proposer: over.proposer ?? proposer(null),
		costGate: over.costGate ?? openGate(),
		now: () => NOW,
		log: (message) => logs.push(message),
	});
	return { svc, store, logs };
}

describe("session notes service: after an extraction batch (REQ-sn-02)", () => {
	it("writes a new note from the learner's messages of the batch", async () => {
		const { svc, store } = service({ proposer: proposer("Intuition before formulas.") });
		assert.equal(await svc.afterBatch("chat_1", ["explain it without formulas"]), "updated");
		assert.deepEqual(store.value.chat_1, { text: "Intuition before formulas.", updatedAt: NOW, edited: false });
	});

	it("asks the model only with the learner's words, and the note so far", async () => {
		const calls: Array<{ currentText: string | null; learnerTexts: readonly string[] }> = [];
		const { svc } = service({ store: memStore({ chat_1: { text: "old", updatedAt: NOW, edited: false } }), proposer: proposer(null, calls) });
		await svc.afterBatch("chat_1", ["  just the intuition  ", "   "]);
		assert.deepEqual(calls, [{ currentText: "old", learnerTexts: ["just the intuition"] }]);
	});

	it("calls no model when the batch holds no learner words", async () => {
		const calls: Array<{ currentText: string | null; learnerTexts: readonly string[] }> = [];
		const { svc, store } = service({ proposer: proposer("never", calls) });
		assert.equal(await svc.afterBatch("chat_1", ["", "  "]), "skipped-no-learner-text");
		assert.equal(calls.length, 0);
		assert.equal(store.writes, 0);
	});

	it("makes no change when the model proposes none", async () => {
		const { svc, store } = service({ proposer: proposer(null) });
		assert.equal(await svc.afterBatch("chat_1", ["what is a limit?"]), "unchanged");
		assert.equal(store.writes, 0);
	});
});

describe("session notes service: the learner's edits win (REQ-sn-04)", () => {
	it("calls no model for a note the learner edited, and writes nothing", async () => {
		const calls: Array<{ currentText: string | null; learnerTexts: readonly string[] }> = [];
		const { svc, store } = service({
			store: memStore({ chat_1: { text: "mine", updatedAt: NOW, edited: true } }),
			proposer: proposer("Formulas please.", calls),
		});
		assert.equal(await svc.afterBatch("chat_1", ["give me formulas"]), "unchanged");
		assert.equal(calls.length, 0);
		assert.equal(store.value.chat_1?.text, "mine");
	});

	it("re-reads the store after the model call, so an edit made meanwhile is not overwritten", async () => {
		const store = memStore({ chat_1: { text: "auto", updatedAt: NOW, edited: false } });
		const slow: SessionNoteProposer = {
			async propose() {
				// The learner saves their own note while the model is still thinking.
				store.value = { chat_1: { text: "my own words", updatedAt: NOW, edited: true } };
				return { text: "Formulas please.", costUsd: 0.01 };
			},
		};
		const { svc } = service({ store, proposer: slow });
		assert.equal(await svc.afterBatch("chat_1", ["formulas"]), "unchanged");
		assert.equal(store.value.chat_1?.text, "my own words");
	});
});

describe("session notes service: spend and availability (REQ-sn-03)", () => {
	it("does nothing when the daily ceiling is closed", async () => {
		const calls: Array<{ currentText: string | null; learnerTexts: readonly string[] }> = [];
		const closed: CostGate = { allowed: () => false, record: () => undefined };
		const { svc, store } = service({ proposer: proposer("x", calls), costGate: closed });
		assert.equal(await svc.afterBatch("chat_1", ["hi"]), "skipped-gate");
		assert.equal(calls.length, 0);
		assert.equal(store.writes, 0);
	});

	it("does nothing when no model is configured or its key is missing", async () => {
		const missingModel = service({ proposer: proposer(() => { throw new ModelsNotConfiguredError(["cheap"]); }) });
		assert.equal(await missingModel.svc.afterBatch("chat_1", ["hi"]), "skipped-unavailable");
		const missingKey = service({ proposer: proposer(() => { throw new ProviderKeyMissingError("anthropic", ["cheap"]); }) });
		assert.equal(await missingKey.svc.afterBatch("chat_1", ["hi"]), "skipped-unavailable");
		assert.equal(missingModel.store.writes + missingKey.store.writes, 0);
	});

	it("a model failure is logged and never thrown to the pipeline", async () => {
		const { svc, store, logs } = service({ proposer: proposer(() => { throw new Error("provider 500"); }) });
		assert.equal(await svc.afterBatch("chat_1", ["hi"]), "failed");
		assert.equal(store.writes, 0);
		assert.equal(logs.length, 1);
	});
});

describe("session notes service: the learner's own note (REQ-sn-06)", () => {
	it("saves the learner's text as edited and clears it on an empty text", () => {
		const { svc, store } = service();
		svc.setLearnerNote("chat_1", "Examples first.");
		assert.deepEqual(store.value.chat_1, { text: "Examples first.", updatedAt: NOW, edited: true });
		svc.setLearnerNote("chat_1", "  ");
		assert.equal(store.value.chat_1, undefined);
	});

	it("reads one chat's note, or null", () => {
		const { svc } = service({ store: memStore({ chat_1: { text: "t", updatedAt: NOW, edited: true } }) });
		assert.equal(svc.noteOf("chat_1")?.text, "t");
		assert.equal(svc.noteOf("chat_2"), null);
	});
});
