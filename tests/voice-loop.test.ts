// tests/voice-loop.test.ts
// The voice loop (REQ-chat-tts-11..15) with fakes: playback, microphone, submit and a fake clock. The rules are in
// the machine (tests/voice-machine.test.ts); these tests check the wiring to the page's effects.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceController, type VoiceEnv } from "../components/voice-controller.ts";
import type { Answer, PendingQuestion } from "../src/core/voice-machine.ts";
import type { SpeechOutcome, SpeechRequest } from "../components/use-speech-player.ts";

const CHOICE: PendingQuestion = {
	kind: "option",
	options: [{ label: "Mercury", value: "a" }, { label: "Venus", value: "b" }, { label: "Mars", value: "c" }],
};
const OPEN: PendingQuestion = { kind: "open" };

/** A fake page: a clock that runs only when advanced, a speaker and a microphone that record their state. */
function fakeEnv() {
	let now = 0;
	const timers: Array<{ due: number; fire: () => void; cancelled: boolean }> = [];
	const log: string[] = [];
	const submits: Answer[] = [];
	const disabled: string[] = [];
	const plays: Array<{ messageId: string; request?: SpeechRequest }> = [];
	let speaker = false;
	let mic = false;
	const violations: string[] = [];
	const env: VoiceEnv = {
		play(messageId, request) {
			if (mic) violations.push("played while listening");
			speaker = true;
			plays.push({ messageId, request });
			log.push(`play ${messageId}${request ? ` ${request.part}` : ""}`);
		},
		stopPlaying() {
			speaker = false;
			log.push("stopPlaying");
		},
		startListening() {
			if (speaker) violations.push("listened while speaking");
			mic = true;
			log.push("startListening");
		},
		stopListening() {
			mic = false;
			log.push("stopListening");
		},
		schedule(delayMs, fire) {
			const timer = { due: now + delayMs, fire, cancelled: false };
			timers.push(timer);
			return () => void (timer.cancelled = true);
		},
		submit(answer) {
			submits.push(answer);
			log.push(`submit ${JSON.stringify(answer)}`);
		},
		disable(reason) {
			disabled.push(reason);
			log.push(`disable ${reason}`);
		},
		notice(reason) {
			log.push(`notice ${reason}`);
		},
		now: () => now,
	};
	return {
		env,
		log,
		submits,
		disabled,
		plays,
		violations,
		speaker: () => speaker,
		/** The page's audio finished (or failed): the speaker is silent. */
		endSpeech: () => void (speaker = false),
		mic: () => mic,
		/** Runs timers that are due, up to `ms` from now. */
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

/** A clip settles on the page: a finished or failed clip silences the speaker, then the controller hears it. */
function settle(fake: ReturnType<typeof fakeEnv>, voice: VoiceController, key: string, outcome: SpeechOutcome) {
	if (outcome.type !== "stopped") fake.endSpeech();
	voice.settled(key, outcome);
}

/** Voice mode on, a reply with a pending question; the prose and the question have been heard: listening. */
function listeningOn(question: PendingQuestion, fake: ReturnType<typeof fakeEnv>) {
	const voice = new VoiceController(fake.env);
	voice.dispatch({ type: "modeOn" });
	voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question, language: "en" });
	settle(fake, voice, "m1", { type: "ended" });
	settle(fake, voice, "m1#question", { type: "ended" });
	return voice;
}

describe("voice loop: replies and questions", () => {
	it("a new reply plays on its own when voice mode is on", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: null, language: "en" });
		assert.deepEqual(fake.plays, [{ messageId: "m1", request: undefined }]);
	});

	it("a pending question is spoken after the prose, then listening starts", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: CHOICE, language: "en" });
		settle(fake, voice, "m1", { type: "ended" });
		assert.deepEqual(fake.plays.at(-1), { messageId: "m1", request: { part: "question" } });
		assert.equal(fake.mic(), false);
		settle(fake, voice, "m1#question", { type: "ended" });
		assert.equal(fake.mic(), true);
		assert.equal(fake.log.at(-1), "startListening");
	});
});

describe("voice loop: answers by voice", () => {
	it("a dictated 'la B' submits option 2 through the submit path", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		voice.onWords("la B", true);
		voice.onUtteranceEnd();
		assert.deepEqual(fake.submits, [{ kind: "option", index: 1, value: "b" }]);
		assert.equal(fake.mic(), false);
	});

	it("a turn with no end from the stream ends after the silence", () => {
		const fake = fakeEnv();
		const voice = listeningOn(OPEN, fake);
		voice.onWords("because the axiom holds", true);
		fake.advance(4999);
		assert.equal(fake.submits.length, 0);
		fake.advance(1);
		assert.deepEqual(fake.submits, [{ kind: "text", text: "because the axiom holds" }]);
	});

	it("an option named as soon as it is said ends after the short silence", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		voice.onWords("Venus", false);
		fake.advance(1499);
		assert.equal(fake.submits.length, 0);
		fake.advance(1);
		assert.deepEqual(fake.submits, [{ kind: "option", index: 1, value: "b" }]);
	});

	it("interim words replace each other; a final is kept", () => {
		const fake = fakeEnv();
		const voice = listeningOn(OPEN, fake);
		voice.onWords("Mer", false);
		voice.onWords("Mercury", true);
		voice.onWords("and", false);
		voice.onUtteranceEnd();
		assert.deepEqual(fake.submits, [{ kind: "text", text: "Mercury and" }]);
	});

	it("an unresolved answer speaks the retry and listens again", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		voice.onWords("boh", true);
		voice.onUtteranceEnd();
		assert.deepEqual(fake.plays.at(-1), { messageId: "m1", request: { part: "retry", language: "en" } });
		assert.equal(fake.mic(), false, "the microphone is off while the retry is spoken");
		assert.equal(fake.submits.length, 0);
		settle(fake, voice, "m1#retry", { type: "ended" });
		assert.equal(fake.mic(), true);
	});

	it("allows three retries; the fourth failure stops listening and leaves the card for tapping", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		for (let attempt = 1; attempt <= 3; attempt++) {
			voice.onWords("boh", true);
			voice.onUtteranceEnd();
			assert.equal(fake.plays.at(-1)?.request?.part, "retry", `retry ${attempt}`);
			settle(fake, voice, "m1#retry", { type: "ended" });
			assert.equal(fake.mic(), true);
		}
		voice.onWords("boh", true);
		voice.onUtteranceEnd();
		assert.equal(fake.mic(), false, "the fourth failure stops listening");
		assert.equal(fake.plays.filter((p) => p.request?.part === "retry").length, 3);
		assert.equal(fake.submits.length, 0);
	});

	it("a tap during listening stops the microphone and submits by the card, once", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		voice.noteTap();
		assert.equal(fake.mic(), false);
		assert.equal(fake.submits.length, 0, "the machine does not submit: the card's own submit is the answer");
		fake.advance(60_000);
		assert.equal(fake.submits.length, 0, "the cancelled countdown never submits");
	});

	it("turning voice mode off stops everything and leaves the question pending: nothing is submitted", () => {
		const fake = fakeEnv();
		const voice = listeningOn(CHOICE, fake);
		voice.dispatch({ type: "modeOff" });
		assert.equal(fake.mic(), false);
		assert.equal(fake.speaker(), false);
		fake.advance(60_000);
		assert.equal(fake.submits.length, 0);
	});
});

describe("voice loop: failures", () => {
	it("a budget refusal turns voice mode off with its message", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: null, language: "en" });
		settle(fake, voice, "m1", { type: "failed", kind: "budget" });
		assert.deepEqual(fake.disabled, ["budget"]);
		assert.equal(fake.speaker(), false);
	});

	it("an unavailable service turns voice mode off with its message", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: null, language: "en" });
		settle(fake, voice, "m1", { type: "failed", kind: "unavailable" });
		assert.deepEqual(fake.disabled, ["unavailable"]);
	});

	it("a stopped clip is not reported as an event", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: OPEN, language: "en" });
		settle(fake, voice, "m1", { type: "stopped" });
		assert.equal(fake.plays.length, 1, "the question is not started by a stop");
	});
});

describe("voice loop: the speaker and the microphone are never active together", () => {
	it("holds through a full scenario of replies, retries, answers, taps and switching off", () => {
		const fake = fakeEnv();
		const voice = new VoiceController(fake.env);
		voice.dispatch({ type: "modeOn" });
		voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question: CHOICE, language: "en" });
		settle(fake, voice, "m1", { type: "ended" });
		settle(fake, voice, "m1#question", { type: "ended" });
		voice.onWords("boh", true);
		voice.onUtteranceEnd();
		settle(fake, voice, "m1#retry", { type: "ended" });
		voice.onWords("la C", true);
		voice.onUtteranceEnd();
		voice.replyArrived({ type: "replyArrived", messageId: "m2", speakable: true, question: OPEN, language: "it" });
		settle(fake, voice, "m2", { type: "ended" });
		settle(fake, voice, "m2#question", { type: "ended" });
		voice.onWords("sì", true);
		voice.noteTap();
		voice.dispatch({ type: "modeOff" });
		assert.deepEqual(fake.violations, []);
		assert.equal(fake.speaker() && fake.mic(), false);
	});
});

describe("voice loop: the pending question of a reply", () => {
	it("reads an option question from a pending quiz or ask call, with its option labels and values", async () => {
		const { pendingQuestionOf } = await import("../components/use-voice-mode.ts");
		const quiz = pendingQuestionOf([{ type: "text", text: "Check." }, { type: "tool-quiz", state: "input-available", input: { options: [{ label: "Mercury", value: "a" }, { label: "Venus" }] } }]);
		assert.deepEqual(quiz, { kind: "option", options: [{ label: "Mercury", value: "a" }, { label: "Venus", value: "Venus" }] });
		const ask = pendingQuestionOf([{ type: "tool-ask_user_question", state: "input-available", input: { options: [{ label: "Yes" }] } }]);
		assert.equal(ask?.kind, "option");
	});

	it("reads an open question from a pending ask with no options, and nothing once answered", async () => {
		const { pendingQuestionOf } = await import("../components/use-voice-mode.ts");
		assert.deepEqual(pendingQuestionOf([{ type: "tool-ask_user_question", state: "input-available", input: { question: "Why?" } }]), { kind: "open" });
		assert.equal(pendingQuestionOf([{ type: "tool-quiz", state: "output-available", input: {} }]), null);
		assert.equal(pendingQuestionOf([{ type: "text", text: "just prose" }]), null);
	});
});
