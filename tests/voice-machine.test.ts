// tests/voice-machine.test.ts
// The voice-mode state machine (REQ-chat-tts-11..14): a pure reducer. Table tests per transition, the retry
// limit, and a property check that the speaker and the microphone are never active together.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialVoiceState, step, type PendingQuestion, type VoiceEvent, type VoiceState } from "../src/core/voice-machine.ts";
import type { ResolvableOption } from "../src/core/answer-resolver.ts";

const OPTIONS: ResolvableOption[] = [{ label: "Mercury", value: "a" }, { label: "Venus", value: "b" }, { label: "Mars", value: "c" }];
const OPEN: PendingQuestion = { kind: "open" };
const CHOICE: PendingQuestion = { kind: "option", options: OPTIONS };
const B = { kind: "option" as const, index: 1, value: "b" };

const reply = (question: PendingQuestion | null, speakable = true, messageId = "m1"): VoiceEvent => ({
	type: "replyArrived",
	messageId,
	speakable,
	question,
	toolCallId: question === null ? null : "t1",
	language: "en",
});

/** Runs events from a state; returns the final state and every effect in order. */
function run(events: VoiceEvent[], from: VoiceState = initialVoiceState()) {
	let state = from;
	const effects: unknown[] = [];
	for (const event of events) {
		const out = step(state, event);
		state = out.state;
		effects.push(...out.effects);
	}
	return { state, effects };
}

/** The machine's state after one event, from a given state. */
const after = (from: VoiceState, event: VoiceEvent) => step(from, event);

describe("voice machine: mode", () => {
	it("starts off, with nothing pending", () => {
		const s = initialVoiceState();
		assert.equal(s.mode, "off");
		assert.equal(s.pending, null);
	});

	it("modeOn goes idle without effects", () => {
		const out = after(initialVoiceState(), { type: "modeOn" });
		assert.equal(out.state.mode, "idle");
		assert.deepEqual(out.effects, []);
	});

	it("while off, a reply does nothing at all (the text lesson is untouched)", () => {
		const out = after(initialVoiceState(), reply(OPEN));
		assert.equal(out.state.mode, "off");
		assert.deepEqual(out.effects, []);
	});

	it("modeOff stops playback and listening, submits nothing, and leaves no pending question in the machine", () => {
		const { state, effects } = run([{ type: "modeOn" }, reply(CHOICE)]);
		const out = step(state, { type: "modeOff" });
		assert.equal(out.state.mode, "off");
		assert.equal(out.state.pending, null);
		assert.deepEqual(out.effects, [{ type: "stopPlaying" }, { type: "stopListening" }]);
		assert.ok(!effects.some((e) => (e as { type: string }).type === "submitAnswer"));
	});
});

describe("voice machine: replies", () => {
	it("a speakable reply plays", () => {
		const { state, effects } = run([{ type: "modeOn" }, reply(null)]);
		assert.equal(state.mode, "speaking");
		assert.deepEqual(effects, [{ type: "play", messageId: "m1" }]);
	});

	it("a reply with no speakable text and no question goes idle", () => {
		const { state, effects } = run([{ type: "modeOn" }, reply(null, false)]);
		assert.equal(state.mode, "idle");
		assert.deepEqual(effects, []);
	});

	it("a pending question is spoken after the prose, then listening starts", () => {
		let { state, effects } = run([{ type: "modeOn" }, reply(OPEN)]);
		assert.deepEqual(effects, [{ type: "play", messageId: "m1" }]);
		const next = step(state, { type: "speechEnded" });
		assert.deepEqual(next.effects, [{ type: "playQuestion", messageId: "m1" }]);
		state = next.state;
		const last = step(state, { type: "speechEnded" });
		assert.equal(last.state.mode, "listening");
		assert.deepEqual(last.effects, [{ type: "startListening" }]);
	});

	it("with no speakable prose, a pending question is spoken straight away", () => {
		const { state, effects } = run([{ type: "modeOn" }, reply(OPEN, false)]);
		assert.equal(state.mode, "speaking");
		assert.deepEqual(effects, [{ type: "playQuestion", messageId: "m1" }]);
	});

	it("a new reply stops the previous speech and any listening first", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN)]);
		const out = step(state, reply(null, true, "m2"));
		assert.deepEqual(out.effects, [{ type: "stopPlaying" }, { type: "play", messageId: "m2" }]);
	});

	it("a new reply while listening stops the microphone before it speaks", () => {
		let { state } = run([{ type: "modeOn" }, reply(OPEN), { type: "speechEnded" }, { type: "speechEnded" }]);
		assert.equal(state.mode, "listening");
		const out = step(state, reply(null, true, "m2"));
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "play", messageId: "m2" }]);
	});

	it("when the speech ends with no question pending, the machine goes idle", () => {
		const { state } = run([{ type: "modeOn" }, reply(null), { type: "speechEnded" }]);
		assert.equal(state.mode, "idle");
	});
});

describe("voice machine: answers by voice", () => {
	const listening = () => run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }]).state;

	it("an option turn ends in a resolve effect, with the stream's options and language", () => {
		const out = step(listening(), { type: "turnEnded", transcript: "la B" });
		assert.equal(out.state.mode, "resolving");
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "resolve", transcript: "la B", options: OPTIONS, language: "en" }]);
	});

	it("a resolved option submits it through submitAnswer and clears the pending question", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }, { type: "turnEnded", transcript: "la B" }]);
		const out = step(state, { type: "resolved", result: { kind: "option", index: 1, value: "b" } });
		assert.equal(out.state.mode, "idle");
		assert.equal(out.state.pending, null);
		assert.deepEqual(out.effects, [{ type: "submitAnswer", answer: B, toolCallId: "t1" }]);
	});

	it("an open question submits the transcript as text", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN), { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "turnEnded", transcript: "  Because of the axiom.  " });
		assert.equal(out.state.mode, "idle");
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "submitAnswer", answer: { kind: "text", text: "Because of the axiom." }, toolCallId: "t1" }]);
	});

	it("an empty open answer is a failed turn: the microphone stops, the retry is spoken, nothing is submitted", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN), { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "turnEnded", transcript: "   " });
		assert.equal(out.state.mode, "speaking");
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "speakRetry", language: "en" }]);
	});

	it("a turn that ends while not listening is ignored", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE)]);
		const out = step(state, { type: "turnEnded", transcript: "la B" });
		assert.equal(out.state.mode, "speaking");
		assert.deepEqual(out.effects, []);
	});

	it("an unresolved answer speaks the retry in the session's language and listens again", () => {
		let { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }, { type: "turnEnded", transcript: "boh" }]);
		const out = step(state, { type: "resolved", result: { kind: "none" } });
		assert.equal(out.state.mode, "speaking");
		assert.deepEqual(out.effects, [{ type: "speakRetry", language: "en" }]);
		const next = step(out.state, { type: "speechEnded" });
		assert.equal(next.state.mode, "listening");
		assert.deepEqual(next.effects, [{ type: "startListening" }]);
		state = next.state;
		assert.ok(state.pending, "the question stays pending while we retry");
	});

	it("an ambiguous answer retries the same way", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }, { type: "turnEnded", transcript: "a b" }]);
		const out = step(state, { type: "resolved", result: { kind: "ambiguous" } });
		assert.deepEqual(out.effects, [{ type: "speakRetry", language: "en" }]);
	});

	it("allows three retries; the fourth failure stops listening and leaves the card for tapping", () => {
		let state = listening();
		let failures = 0;
		for (let i = 0; i < 4; i++) {
			const turn = step(state, { type: "turnEnded", transcript: "boh" });
			const res = step(turn.state, { type: "resolved", result: { kind: "none" } });
			failures++;
			if (failures <= 3) {
				assert.deepEqual(res.effects, [{ type: "speakRetry", language: "en" }], `failure ${failures} speaks the retry`);
				const heard = step(res.state, { type: "speechEnded" });
				assert.deepEqual(heard.effects, [{ type: "startListening" }]);
				state = heard.state;
			} else {
				assert.deepEqual(res.effects, [], "the fourth failure says nothing more");
				assert.equal(res.state.mode, "idle", "listening has stopped");
				assert.ok(res.state.pending, "the card stays pending for tapping");
				state = res.state;
			}
		}
		assert.equal(state.mode, "idle");
	});

	it("a retry counts from the current question only: a new reply resets it", () => {
		let state = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }, { type: "turnEnded", transcript: "x" }, { type: "resolved", result: { kind: "none" } }, { type: "speechEnded" }, { type: "turnEnded", transcript: "y" }, { type: "resolved", result: { kind: "none" } }, { type: "speechEnded" }, { type: "turnEnded", transcript: "z" }, { type: "resolved", result: { kind: "none" } }, { type: "speechEnded" }]).state;
		state = step(state, reply(CHOICE, true, "m2")).state;
		state = run([{ type: "speechEnded" }, { type: "speechEnded" }], state).state;
		const out = step(run([{ type: "turnEnded", transcript: "x" }], state).state, { type: "resolved", result: { kind: "none" } });
		assert.deepEqual(out.effects, [{ type: "speakRetry", language: "en" }], "a fresh question has its full retries");
	});
});

describe("voice machine: taps and failures", () => {
	it("a tap during listening stops the microphone and submits the tapped answer", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "tap", answer: B });
		assert.equal(out.state.mode, "idle");
		assert.equal(out.state.pending, null);
		assert.deepEqual(out.effects, [{ type: "stopPlaying" }, { type: "stopListening" }, { type: "submitAnswer", answer: B, toolCallId: "t1" }]);
	});

	it("a tap during speech stops the speech and submits", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE)]);
		const out = step(state, { type: "tap", answer: B });
		assert.deepEqual(out.effects, [{ type: "stopPlaying" }, { type: "stopListening" }, { type: "submitAnswer", answer: B, toolCallId: "t1" }]);
	});

	it("a tap with no pending question does nothing", () => {
		const { state } = run([{ type: "modeOn" }, reply(null)]);
		const out = step(state, { type: "tap", answer: B });
		assert.deepEqual(out.effects, []);
	});

	it("a budget failure turns the mode off with its message and stops everything", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN)]);
		const out = step(state, { type: "speechFailed", kind: "budget" });
		assert.equal(out.state.mode, "off");
		assert.equal(out.state.pending, null);
		assert.deepEqual(out.effects, [{ type: "stopPlaying" }, { type: "stopListening" }, { type: "disableModeWithMessage", reason: "budget" }]);
	});

	it("an unavailable service turns the mode off with its message", () => {
		const { state } = run([{ type: "modeOn" }, reply(null)]);
		const out = step(state, { type: "speechFailed", kind: "unavailable" });
		assert.equal(out.state.mode, "off");
		assert.deepEqual(out.effects.at(-1), { type: "disableModeWithMessage", reason: "unavailable" });
	});

	it("another failure of the prose with no question goes idle, with a notice", () => {
		const { state } = run([{ type: "modeOn" }, reply(null)]);
		const out = step(state, { type: "speechFailed", kind: "other" });
		assert.equal(out.state.mode, "idle");
		assert.deepEqual(out.effects, [{ type: "notice", reason: "proseFailed" }]);
	});

	it("a failed prose with a pending question goes on to the question, with a notice (not silently idle)", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN)]);
		const out = step(state, { type: "speechFailed", kind: "other" });
		assert.equal(out.state.mode, "speaking");
		assert.equal(out.state.phase, "question");
		assert.deepEqual(out.effects, [{ type: "notice", reason: "proseFailed" }, { type: "playQuestion", messageId: "m1" }]);
	});

	it("a reply's question carries its call id into the submit", () => {
		const { state } = run([{ type: "modeOn" }, { type: "replyArrived", messageId: "m1", speakable: true, question: OPEN, toolCallId: "call-42", language: "en" }, { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "turnEnded", transcript: "an answer" });
		assert.deepEqual(out.effects.at(-1), { type: "submitAnswer", answer: { kind: "text", text: "an answer" }, toolCallId: "call-42" });
	});

	it("a failed speech while listening releases the microphone", () => {
		const { state } = run([{ type: "modeOn" }, reply(OPEN), { type: "speechEnded" }, { type: "speechEnded" }]);
		assert.equal(state.mode, "listening");
		const out = step(state, { type: "speechFailed", kind: "other" });
		assert.equal(out.state.mode, "idle");
		assert.deepEqual(out.effects, [{ type: "stopListening" }]);
	});
});

describe("voice machine: the speaker and the microphone never run together", () => {
	/** A small seeded generator, so a failure is reproducible. */
	function rng(seed: number) {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
	}

	function randomEvent(next: () => number): VoiceEvent {
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
		const question = pick<PendingQuestion | null>([null, OPEN, CHOICE]);
		switch (Math.floor(next() * 13)) {
			case 11: return { type: "listenFailed" };
			case 12: return { type: "manualPlay", messageId: pick(["m1", "m2"]) };
			case 0: return { type: "modeOn" };
			case 1: return { type: "modeOff" };
			case 2: return { type: "replyArrived", messageId: pick(["m1", "m2"]), speakable: next() < 0.7, question, toolCallId: question === null ? null : "t1", language: pick(["it", "en"] as const) };
			case 3: return { type: "speechEnded" };
			case 4: return { type: "speechFailed", kind: pick(["budget", "unavailable", "other"] as const) };
			case 5: return { type: "turnEnded", transcript: pick(["la B", "boh", "", "Venus"]) };
			case 6: return { type: "resolved", result: pick([{ kind: "option", index: 0, value: "a" }, { kind: "none" }, { kind: "ambiguous" }] as const) };
			case 7: return { type: "tap", answer: pick([B, { kind: "text", text: "tapped" }] as const) };
			default: return { type: "speechEnded" };
		}
	}

	it("holds over 400 seeded event sequences: the environment never hears and speaks at once", () => {
		for (let seed = 1; seed <= 400; seed++) {
			const next = rng(seed);
			let state = initialVoiceState();
			let speaker = false;
			let mic = false;
			for (let i = 0; i < 60; i++) {
				const event = randomEvent(next);
				// The environment: playback ends on its own and reports it as an event.
				if (event.type === "speechEnded" || event.type === "speechFailed") speaker = false;
				const out = step(state, event);
				for (const effect of out.effects as Array<{ type: string }>) {
					switch (effect.type) {
						case "play": case "playQuestion": case "speakRetry":
							assert.equal(mic, false, `seed ${seed} step ${i}: ${effect.type} while listening`);
							speaker = true;
							break;
						case "stopPlaying": speaker = false; break;
						case "startListening":
							assert.equal(speaker, false, `seed ${seed} step ${i}: listening while speaking`);
							mic = true;
							break;
						case "stopListening": mic = false; break;
						default: break;
					}
				}
				assert.ok(!(speaker && mic), `seed ${seed} step ${i}: both active`);
				state = out.state;
			}
		}
	});
});

describe("voice machine: an external stop of the listening (review)", () => {
	it("listenFailed while listening releases the mic, shows a notice, goes idle and keeps the question pending", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "listenFailed" });
		assert.equal(out.state.mode, "idle");
		assert.ok(out.state.pending, "the card stays pending for tapping");
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "notice", reason: "listenStopped" }]);
	});

	it("listenFailed while resolving does the same", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }, { type: "turnEnded", transcript: "la B" }]);
		assert.equal(step(state, { type: "listenFailed" }).state.mode, "idle");
	});

	it("listenFailed when not listening is ignored", () => {
		const { state } = run([{ type: "modeOn" }, reply(null)]);
		assert.deepEqual(step(state, { type: "listenFailed" }).effects, []);
	});
});

describe("voice machine: a manual Listen is a clip the machine knows about (review)", () => {
	it("from listening: stops the mic, then plays the clip; nothing listens after it", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE), { type: "speechEnded" }, { type: "speechEnded" }]);
		const out = step(state, { type: "manualPlay", messageId: "m2" });
		assert.equal(out.state.mode, "speaking");
		assert.deepEqual(out.effects, [{ type: "stopListening" }, { type: "play", messageId: "m2" }]);
		const done = step(out.state, { type: "speechEnded" });
		assert.equal(done.state.mode, "idle");
		assert.deepEqual(done.effects, []);
	});

	it("from speaking: stops the speech, then plays the clip", () => {
		const { state } = run([{ type: "modeOn" }, reply(null)]);
		assert.deepEqual(step(state, { type: "manualPlay", messageId: "m2" }).effects, [{ type: "stopPlaying" }, { type: "play", messageId: "m2" }]);
	});

	it("keeps the pending question for later", () => {
		const { state } = run([{ type: "modeOn" }, reply(CHOICE)]);
		assert.ok(step(state, { type: "manualPlay", messageId: "m2" }).state.pending);
	});

	it("is ignored while voice mode is off", () => {
		assert.deepEqual(step(initialVoiceState(), { type: "manualPlay", messageId: "m2" }).effects, []);
	});
});
