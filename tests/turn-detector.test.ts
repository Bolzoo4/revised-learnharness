// tests/turn-detector.test.ts
// The turn detector of voice mode (REQ-chat-tts-15, 16): a pure state machine fed by the dictation stream, with
// an injected timer. The tests drive a fake clock; no real timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearOptionCheck, createTurnDetector, VOICE_CLEAR_MS, VOICE_SILENCE_MS, type TurnDetectorEvent } from "../src/core/turn-detector.ts";

/** A fake clock: timers fire only when advance() moves time past their due time. */
function fakeClock() {
	let now = 0;
	const timers: Array<{ due: number; fire: () => void; cancelled: boolean }> = [];
	return {
		schedule(delayMs: number, fire: () => void): () => void {
			const timer = { due: now + delayMs, fire, cancelled: false };
			timers.push(timer);
			return () => void (timer.cancelled = true);
		},
		advance(ms: number): void {
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
		now: () => now,
		pending: () => timers.filter((t) => !t.cancelled).length,
	};
}

function harness(opts: { clear?: () => boolean } = {}) {
	const clock = fakeClock();
	let ends = 0;
	const detector = createTurnDetector({
		schedule: clock.schedule,
		onEnd: () => void (ends += 1),
		resolvesToOne: opts.clear,
	});
	const send = (event: TurnDetectorEvent) => detector.event(event);
	return { clock, detector, send, ends: () => ends };
}

describe("turn detector: the constants", () => {
	it("are the spec's defaults", () => {
		assert.equal(VOICE_SILENCE_MS, 5000);
		assert.equal(VOICE_CLEAR_MS, 1500);
	});
});

describe("turn detector: ending the turn", () => {
	it("ends at the stream's UtteranceEnd, after words", () => {
		const h = harness();
		h.send({ type: "word", at: 0 });
		h.send({ type: "utteranceEnd", at: 300 });
		assert.equal(h.ends(), 1);
		assert.equal(h.detector.ended, true);
	});

	it("ends VOICE_SILENCE_MS after the last word when no UtteranceEnd comes", () => {
		const h = harness();
		h.send({ type: "word", at: 0 });
		h.clock.advance(VOICE_SILENCE_MS - 1);
		assert.equal(h.ends(), 0);
		h.clock.advance(1);
		assert.equal(h.ends(), 1);
	});

	it("each new word restarts the silence countdown", () => {
		const h = harness();
		h.send({ type: "word", at: 0 });
		h.clock.advance(4000);
		h.send({ type: "word", at: 4000 });
		h.clock.advance(VOICE_SILENCE_MS - 1);
		assert.equal(h.ends(), 0, "still inside the silence after the second word");
		h.clock.advance(1);
		assert.equal(h.ends(), 1);
	});

	it("an UtteranceEnd cancels the pending countdown: the turn is reported once", () => {
		const h = harness();
		h.send({ type: "word", at: 0 });
		h.send({ type: "utteranceEnd", at: 300 });
		h.clock.advance(60_000);
		assert.equal(h.ends(), 1);
		assert.equal(h.clock.pending(), 0);
	});

	it("events after the end are ignored and start nothing", () => {
		const h = harness();
		h.send({ type: "word", at: 0 });
		h.send({ type: "utteranceEnd", at: 300 });
		h.send({ type: "word", at: 400 });
		h.send({ type: "utteranceEnd", at: 500 });
		assert.equal(h.ends(), 1);
		assert.equal(h.clock.pending(), 0);
	});

	it("never ends without words: silence alone, or an UtteranceEnd before any word, keeps the turn open", () => {
		const h = harness();
		h.clock.advance(60_000);
		h.send({ type: "utteranceEnd", at: 60_100 });
		h.clock.advance(60_000);
		assert.equal(h.ends(), 0);
		assert.equal(h.detector.ended, false);
	});
});

describe("turn detector: option questions", () => {
	it("ends VOICE_CLEAR_MS after the last word when the words so far name exactly one option", () => {
		const h = harness({ clear: () => true });
		h.send({ type: "word", at: 0 });
		h.clock.advance(VOICE_CLEAR_MS - 1);
		assert.equal(h.ends(), 0);
		h.clock.advance(1);
		assert.equal(h.ends(), 1);
	});

	it("keeps the full silence when the words do not resolve to one option", () => {
		const h = harness({ clear: () => false });
		h.send({ type: "word", at: 0 });
		h.clock.advance(VOICE_CLEAR_MS);
		assert.equal(h.ends(), 0);
		h.clock.advance(VOICE_SILENCE_MS - VOICE_CLEAR_MS);
		assert.equal(h.ends(), 1);
	});

	it("more words that make the answer ambiguous return the countdown to the full silence", () => {
		let clear = true;
		const h = harness({ clear: () => clear });
		h.send({ type: "word", at: 0 });
		h.clock.advance(1000);
		clear = false;
		h.send({ type: "word", at: 1000 });
		h.clock.advance(VOICE_CLEAR_MS);
		assert.equal(h.ends(), 0, "the short countdown was cancelled by the new word");
		h.clock.advance(VOICE_SILENCE_MS - VOICE_CLEAR_MS - 1);
		assert.equal(h.ends(), 0);
		h.clock.advance(1);
		assert.equal(h.ends(), 1);
	});

	it("a word that makes the answer resolve starts the short countdown", () => {
		let clear = false;
		const h = harness({ clear: () => clear });
		h.send({ type: "word", at: 0 });
		clear = true;
		h.send({ type: "word", at: 2000 });
		h.clock.advance(VOICE_CLEAR_MS);
		assert.equal(h.ends(), 1);
	});
});

describe("clearOptionCheck: when the words so far name exactly one option", () => {
	const options = [{ label: "Mercury" }, { label: "Venus" }];

	it("is true for a letter or a label of one option", () => {
		assert.equal(clearOptionCheck(() => "B", options)(), true);
		assert.equal(clearOptionCheck(() => "Mercury", options)(), true);
	});

	it("is false for nothing said yet and for an unknown answer", () => {
		assert.equal(clearOptionCheck(() => "", options)(), false);
		assert.equal(clearOptionCheck(() => "Z", options)(), false);
	});

	it("reads the transcript when it is asked, so it follows the words", () => {
		let transcript = "";
		const check = clearOptionCheck(() => transcript, options);
		assert.equal(check(), false);
		transcript = "Venus";
		assert.equal(check(), true);
	});
});
