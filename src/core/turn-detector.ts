// src/core/turn-detector.ts
/**
 * The turn detector of voice mode (REQ-chat-tts-15, 16): decides when the learner has finished speaking, from the
 * dictation stream. Pure: the timer is injected (the app passes setTimeout; the tests a fake clock).
 *
 * A turn ends, once, at the first of:
 *  - the stream's UtteranceEnd, after at least one word;
 *  - VOICE_SILENCE_MS after the last word (each new word restarts the countdown);
 *  - for an option question whose words so far name exactly one option, VOICE_CLEAR_MS after the last word.
 * With no word at all, the turn never ends (the listening timeout is the caller's).
 */

import { resolveOption, type ResolvableOption } from "./answer-resolver.ts";

export const VOICE_SILENCE_MS = 5000;
export const VOICE_CLEAR_MS = 1500;

/** `at` is the stream's clock in ms, kept for the caller; the countdowns are delays from the event. */
export type TurnDetectorEvent = { type: "word"; at: number } | { type: "utteranceEnd"; at: number };

export interface TurnDetectorDeps {
	/** Runs `fire` after `delayMs` and returns the cancel function. */
	schedule(delayMs: number, fire: () => void): () => void;
	/** Called once, when the turn ends. */
	onEnd(): void;
	/** Option questions only: true when the words so far resolve to exactly one option. Read at every word. */
	resolvesToOne?: () => boolean;
	silenceMs?: number;
	clearMs?: number;
}

export interface TurnDetector {
	event(event: TurnDetectorEvent): void;
	readonly ended: boolean;
}

export function createTurnDetector(deps: TurnDetectorDeps): TurnDetector {
	const silenceMs = deps.silenceMs ?? VOICE_SILENCE_MS;
	const clearMs = deps.clearMs ?? VOICE_CLEAR_MS;
	let heard = false;
	let ended = false;
	let cancelCountdown: (() => void) | null = null;

	const stopCountdown = (): void => {
		cancelCountdown?.();
		cancelCountdown = null;
	};
	const end = (): void => {
		if (ended) return;
		ended = true;
		stopCountdown();
		deps.onEnd();
	};

	return {
		get ended() {
			return ended;
		},
		event(event) {
			if (ended) return;
			if (event.type === "utteranceEnd") {
				if (heard) end();
				return;
			}
			heard = true;
			stopCountdown();
			const short = deps.resolvesToOne?.() === true;
			cancelCountdown = deps.schedule(short ? clearMs : silenceMs, end);
		},
	};
}

/**
 * The option check of an option question: true when the words so far (read from `getTranscript` each time it is
 * asked) resolve to exactly one option through resolveOption.
 */
export function clearOptionCheck(getTranscript: () => string, options: ResolvableOption[], language?: "it" | "en"): () => boolean {
	return () => resolveOption(getTranscript(), options, language).kind === "option";
}
