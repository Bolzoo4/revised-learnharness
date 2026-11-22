// tests/voice-review.test.ts
// Review fixes (commit 2): disposal on unmount or session change; the submit names its question call; the
// language of a reply falls back to the chat and then the dictation preference; a stale answer is never submitted.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceController, type VoiceEnv } from "../components/voice-controller.ts";
import { canSubmitTo, pendingQuestionOf, replyLanguage } from "../components/use-voice-mode.ts";
import type { PendingQuestion } from "../src/core/voice-machine.ts";

const CHOICE: PendingQuestion = { kind: "option", options: [{ label: "Mercury", value: "a" }, { label: "Venus", value: "b" }] };

function fake() {
	let now = 0;
	const timers: Array<{ due: number; fire: () => void; cancelled: boolean }> = [];
	const log: string[] = [];
	const submits: Array<{ answer: unknown; toolCallId: string }> = [];
	const env: VoiceEnv = {
		play: (id, r) => log.push(`play ${id}${r ? `#${r.part}` : ""}`),
		stopPlaying: () => log.push("stopPlaying"),
		startListening: () => log.push("startListening"),
		stopListening: () => log.push("stopListening"),
		schedule: (ms, fire) => {
			const t = { due: now + ms, fire, cancelled: false };
			timers.push(t);
			return () => void (t.cancelled = true);
		},
		submit: (answer, toolCallId) => submits.push({ answer, toolCallId }),
		disable: () => undefined,
		notice: () => undefined,
		now: () => now,
	};
	return {
		env, log, submits,
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = timers.filter((t) => !t.cancelled && t.due <= target).sort((a, b) => a.due - b.due)[0];
				if (due === undefined) break;
				now = due.due;
				due.cancelled = true;
				due.fire();
			}
			now = target;
		},
	};
}

function listening(f: ReturnType<typeof fake>, toolCallId = "call-7") {
	const voice = new VoiceController(f.env);
	voice.dispatch({ type: "modeOn" });
	voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: CHOICE, toolCallId, language: "en" });
	voice.settled("m1", { type: "ended" });
	voice.settled("m1#question", { type: "ended" });
	return voice;
}

describe("the submit names the question call it answers (review)", () => {
	it("a spoken answer is submitted with the toolCallId of the question that was asked", () => {
		const f = fake();
		const voice = listening(f, "call-7");
		voice.onWords("Venus", true);
		voice.onUtteranceEnd();
		assert.deepEqual(f.submits, [{ answer: { kind: "option", index: 1, value: "b" }, toolCallId: "call-7" }]);
	});

	it("canSubmitTo: only the call that is still pending may be answered", () => {
		const pending = { tool: "quiz", toolCallId: "call-7", input: {} };
		assert.equal(canSubmitTo(pending, "call-7"), true);
		assert.equal(canSubmitTo(pending, "call-8"), false, "a stale answer for another call is refused");
		assert.equal(canSubmitTo(null, "call-7"), false);
	});
});

describe("disposal: unmount or a session change ends the loop for good (review)", () => {
	it("releases the mic and the speaker, cancels every countdown, and submits nothing afterwards", () => {
		const f = fake();
		const voice = listening(f);
		voice.onWords("Venus", false);
		voice.dispose();
		assert.ok(f.log.includes("stopListening"), "the mic is released");
		assert.ok(f.log.includes("stopPlaying"));
		f.advance(60_000);
		voice.onWords("Venus", true);
		voice.onUtteranceEnd();
		voice.settled("m1#question", { type: "ended" });
		voice.manual("m9");
		assert.equal(f.submits.length, 0, "nothing is submitted for the old chat");
		assert.ok(!f.log.slice(f.log.lastIndexOf("stopPlaying") + 1).some((l) => l.startsWith("play")), "nothing plays after disposal");
	});
});

describe("the language of a reply (review)", () => {
	it("a reply with its own language wins", () => {
		assert.equal(replyLanguage("Il insieme è chiuso per il complemento e questo è il primo passo della dimostrazione.", "en", "en"), "it");
	});

	it("an unclear reply takes the chat's language, then the dictation preference, never a hard English", () => {
		assert.equal(replyLanguage("Sì.", "it", "en"), "it", "the chat's language first");
		assert.equal(replyLanguage("Sì.", null, "it"), "it", "then the dictation preference");
		assert.equal(replyLanguage("Ok.", null, "en"), "en");
	});
});

describe("probe is a pending question too (review)", () => {
	it("a pending probe quiz is read and answered like a quiz", () => {
		const found = pendingQuestionOf([{ type: "tool-probe", state: "input-available", input: { options: [{ label: "Mercury", value: "a" }] } }]);
		assert.deepEqual(found, { question: { kind: "option", options: [{ label: "Mercury", value: "a" }] }, toolCallId: undefined });
	});
});
