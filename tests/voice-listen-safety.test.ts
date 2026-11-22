// tests/voice-listen-safety.test.ts
// Review fixes (commit 1): a voice listener owns no keyboard seams; the listen timeout ends a silent turn; an
// external stop releases the mic and tells the machine; a manual Listen goes through the controller.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceController, VOICE_LISTEN_TIMEOUT_MS, type VoiceEnv } from "../components/voice-controller.ts";
import { ownsKeyboardSeams } from "../components/dictation.tsx";
import type { PendingQuestion } from "../src/core/voice-machine.ts";

const CHOICE: PendingQuestion = { kind: "option", options: [{ label: "Mercury", value: "a" }, { label: "Venus", value: "b" }] };

function fake() {
	let now = 0;
	const timers: Array<{ due: number; fire: () => void; cancelled: boolean }> = [];
	const log: string[] = [];
	const submits: unknown[] = [];
	const notices: string[] = [];
	const env: VoiceEnv = {
		play: (messageId, request) => log.push(`play ${messageId}${request ? `#${request.part}` : ""}`),
		stopPlaying: () => log.push("stopPlaying"),
		startListening: () => log.push("startListening"),
		stopListening: () => log.push("stopListening"),
		schedule: (ms, fire) => {
			const t = { due: now + ms, fire, cancelled: false };
			timers.push(t);
			return () => void (t.cancelled = true);
		},
		submit: (answer) => submits.push(answer),
		disable: () => undefined,
		notice: (reason) => notices.push(reason),
		now: () => now,
	};
	return {
		env, log, submits, notices,
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

function listening(f: ReturnType<typeof fake>, question: PendingQuestion = CHOICE) {
	const voice = new VoiceController(f.env);
	voice.dispatch({ type: "modeOn" });
	voice.replyArrived({ type: "replyArrived", messageId: "m1", speakable: true, question, toolCallId: "t1", language: "en" });
	voice.settled("m1", { type: "ended" });
	voice.settled("m1#question", { type: "ended" });
	return voice;
}

describe("voice listener and the keyboard seams (⌘D, Esc)", () => {
	it("a voice listener owns no keyboard shortcut or finisher; the normal dictation keeps them all", () => {
		assert.equal(ownsKeyboardSeams(undefined), true);
		assert.equal(ownsKeyboardSeams({ onWords: () => undefined, onUtteranceEnd: () => undefined, onStop: () => undefined }), false);
	});
});

describe("listen timeout", () => {
	it("a silent turn ends after VOICE_LISTEN_TIMEOUT_MS with an empty transcript, as one retry", () => {
		const f = fake();
		listening(f);
		assert.equal(VOICE_LISTEN_TIMEOUT_MS, 25_000);
		f.advance(VOICE_LISTEN_TIMEOUT_MS - 1);
		assert.equal(f.log.filter((l) => l.startsWith("play m1#retry")).length, 0);
		f.advance(1);
		assert.ok(f.log.includes("stopListening"), "the mic is closed");
		assert.ok(f.log.some((l) => l === "play m1#retry"), "the silence is one retry");
		assert.equal(f.submits.length, 0);
	});

	it("after three silent turns the listening stops and the card is left for tapping", () => {
		const f = fake();
		const voice = listening(f);
		for (let i = 0; i < 3; i++) {
			f.advance(VOICE_LISTEN_TIMEOUT_MS);
			voice.settled("m1#retry", { type: "ended" });
		}
		const before = f.log.length;
		f.advance(VOICE_LISTEN_TIMEOUT_MS);
		assert.equal(f.log.filter((l) => l === "play m1#retry").length, 3, "three retries were spoken");
		assert.ok(f.log.slice(before).includes("stopListening"), "the fourth silence stops listening");
		assert.ok(!f.log.slice(before).some((l) => l.startsWith("play")), "and says nothing more");
		assert.equal(f.submits.length, 0);
	});
});

describe("external stop of the dictation", () => {
	it("a stop the controller did not ask for releases the mic and shows a notice, and the machine goes idle", () => {
		const f = fake();
		const voice = listening(f);
		voice.onStopped();
		assert.ok(f.log.includes("stopListening"));
		assert.deepEqual(f.notices, ["listenStopped"]);
	});

	it("the stop that the controller asked for is not reported as a failure", () => {
		const f = fake();
		const voice = listening(f);
		voice.onWords("Venus", true);
		voice.onUtteranceEnd();
		voice.onStopped();
		assert.deepEqual(f.notices, [], "the end of our own listening is not a failure");
	});
});

describe("manual Listen during voice mode", () => {
	it("stops listening, plays the clip, and the clip's end does not move the machine on", () => {
		const f = fake();
		const voice = listening(f);
		voice.manual("m2");
		assert.ok(f.log.indexOf("stopListening") < f.log.indexOf("play m2"), "listening stops before the clip plays");
		voice.settled("m1#question", { type: "ended" });
		assert.ok(!f.log.slice(f.log.indexOf("play m2")).includes("startListening"), "a stale end starts nothing");
		voice.settled("m2", { type: "ended" });
		assert.ok(!f.log.slice(f.log.indexOf("play m2")).includes("startListening"), "the manual clip ends without listening");
	});

	it("a clip end for a key the machine is not waiting for is ignored", () => {
		const f = fake();
		const voice = listening(f);
		const before = f.log.length;
		voice.settled("m9", { type: "ended" });
		assert.equal(f.log.length, before);
	});
});
