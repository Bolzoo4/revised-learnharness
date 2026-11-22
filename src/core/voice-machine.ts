// src/core/voice-machine.ts
/**
 * The voice-mode state machine (REQ-chat-tts-11..14): a pure reducer, step(state, event) -> {state, effects}.
 * No I/O: the caller runs the effects (playback, the microphone, the answer submit) and feeds back the events
 * (speechEnded, speechFailed, turnEnded, resolved). The rules, not the wiring, live here.
 *
 * Invariant (tested as a property): the speaker and the microphone are never active together. Every effect that
 * starts the speaker comes after a stopListening when listening; startListening only follows the end of speech.
 */

import { resolveOption, type OptionResolution, type ResolvableOption } from "./answer-resolver.ts";

export type VoiceLanguage = "it" | "en";
/** Notices the learner sees: the listening stopped; the reply's prose could not be read (the question follows). */
export type VoiceNotice = "listenStopped" | "proseFailed";
export type VoiceMode = "off" | "idle" | "speaking" | "listening" | "resolving";
/** What the teacher asked: an open question, or an option question (ask_user_question or quiz) with its options. */
export type PendingQuestion = { kind: "open" } | { kind: "option"; options: ResolvableOption[] };
/** The learner's answer, as the question card submits it: an option by index and value, or free text. */
export type Answer = { kind: "option"; index: number; value: string } | { kind: "text"; text: string };
/** A retry is spoken at most this many times for one question; the next failure stops listening. */
export const MAX_RETRIES = 3;

export interface VoiceState {
	mode: VoiceMode;
	/** The question of the latest reply, until it is answered. */
	pending: { messageId: string; toolCallId: string | null; question: PendingQuestion } | null;
	/** What is being spoken: the prose, the question's spoken form, the retry phrase, or a manual Listen. */
	phase: "prose" | "question" | "retry" | "manual" | null;
	language: VoiceLanguage;
	/** Failed answers to the pending question. */
	failures: number;
}

export type VoiceEvent =
	| { type: "modeOn" }
	| { type: "modeOff" }
	| { type: "replyArrived"; messageId: string; speakable: boolean; question: PendingQuestion | null; toolCallId: string | null; language: VoiceLanguage }
	| { type: "speechEnded" }
	| { type: "speechFailed"; kind: "budget" | "unavailable" | "other" }
	| { type: "turnEnded"; transcript: string }
	| { type: "resolved"; result: OptionResolution }
	| { type: "tap"; answer: Answer }
	/** The listening ended outside the machine (a stream or microphone error, or ⌘D / Esc). */
	| { type: "listenFailed" }
	/** The learner pressed Listen on a reply: the clip plays; a listening turn stops first. */
	| { type: "manualPlay"; messageId: string };

export type VoiceEffect =
	| { type: "play"; messageId: string }
	| { type: "playQuestion"; messageId: string }
	| { type: "speakRetry"; language: VoiceLanguage }
	| { type: "startListening" }
	| { type: "stopListening" }
	| { type: "stopPlaying" }
	| { type: "resolve"; transcript: string; options: ResolvableOption[]; language: VoiceLanguage }
	| { type: "submitAnswer"; answer: Answer; toolCallId: string | null }
	| { type: "disableModeWithMessage"; reason: "budget" | "unavailable" }
	| { type: "notice"; reason: VoiceNotice };

export interface VoiceStep {
	state: VoiceState;
	effects: VoiceEffect[];
}

export function initialVoiceState(): VoiceState {
	return { mode: "off", pending: null, phase: null, language: "en", failures: 0 };
}

const IDLE = (s: VoiceState): VoiceState => ({ ...s, mode: "idle", phase: null });

export function step(s: VoiceState, event: VoiceEvent): VoiceStep {
	switch (event.type) {
		case "modeOn":
			if (s.mode !== "off") return { state: s, effects: [] };
			return { state: { ...initialVoiceState(), mode: "idle" }, effects: [] };

		case "modeOff":
			if (s.mode === "off") return { state: s, effects: [] };
			return { state: initialVoiceState(), effects: [{ type: "stopPlaying" }, { type: "stopListening" }] };

		case "replyArrived": {
			if (s.mode === "off") return { state: s, effects: [] };
			const effects: VoiceEffect[] = [];
			if (s.mode === "listening") effects.push({ type: "stopListening" });
			if (s.mode === "speaking") effects.push({ type: "stopPlaying" });
			const pending = event.question === null ? null : { messageId: event.messageId, toolCallId: event.toolCallId, question: event.question };
			const base = { ...s, pending, failures: 0, language: event.language };
			if (event.speakable) {
				effects.push({ type: "play", messageId: event.messageId });
				return { state: { ...base, mode: "speaking", phase: "prose" }, effects };
			}
			if (pending !== null) {
				effects.push({ type: "playQuestion", messageId: event.messageId });
				return { state: { ...base, mode: "speaking", phase: "question" }, effects };
			}
			return { state: { ...base, mode: "idle", phase: null }, effects };
		}

		case "speechEnded": {
			if (s.mode !== "speaking") return { state: s, effects: [] };
			// A manual Listen is not part of the question: when it ends, the machine rests.
			if (s.phase === "manual") return { state: IDLE(s), effects: [] };
			if (s.phase === "prose") {
				if (s.pending === null) return { state: IDLE(s), effects: [] };
				return {
					state: { ...s, phase: "question" },
					effects: [{ type: "playQuestion", messageId: s.pending.messageId }],
				};
			}
			// The question's spoken form or the retry phrase has been heard: listen.
			if (s.pending === null) return { state: IDLE(s), effects: [] };
			return { state: { ...s, mode: "listening", phase: null }, effects: [{ type: "startListening" }] };
		}

		case "speechFailed": {
			if (event.kind === "other") {
				// A failed prose: the learner is told, and a pending question is still asked.
				if (s.mode === "speaking" && s.phase === "prose") {
					const notice: VoiceEffect = { type: "notice", reason: "proseFailed" };
					if (s.pending === null) return { state: IDLE(s), effects: [notice] };
					return {
						state: { ...s, phase: "question" },
						effects: [notice, { type: "playQuestion", messageId: s.pending.messageId }],
					};
				}
				// Any other failed speech goes idle; the microphone is released if it was on.
				return { state: IDLE(s), effects: s.mode === "listening" ? [{ type: "stopListening" }] : [] };
			}
			return {
				state: initialVoiceState(),
				effects: [{ type: "stopPlaying" }, { type: "stopListening" }, { type: "disableModeWithMessage", reason: event.kind }],
			};
		}

		case "turnEnded": {
			if (s.mode !== "listening" || s.pending === null) return { state: s, effects: [] };
			const question = s.pending.question;
			const transcript = event.transcript.trim();
			if (question.kind === "open") {
				// Nothing said: a failed turn. The microphone stops before the retry is spoken.
				if (transcript === "") {
					const retry = failed(s);
					return { state: retry.state, effects: [{ type: "stopListening" }, ...retry.effects] };
				}
				return {
					state: { ...s, mode: "idle", pending: null, phase: null, failures: 0 },
					effects: [{ type: "stopListening" }, { type: "submitAnswer", answer: { kind: "text", text: transcript }, toolCallId: s.pending.toolCallId }],
				};
			}
			return {
				state: { ...s, mode: "resolving", phase: null },
				effects: [{ type: "stopListening" }, { type: "resolve", transcript, options: question.options, language: s.language }],
			};
		}

		case "resolved": {
			if (s.mode !== "resolving" || s.pending === null) return { state: s, effects: [] };
			if (event.result.kind === "option") {
				const { index, value } = event.result;
				return {
					state: { ...s, mode: "idle", pending: null, phase: null, failures: 0 },
					effects: [{ type: "submitAnswer", answer: { kind: "option", index, value }, toolCallId: s.pending.toolCallId }],
				};
			}
			return failed(s);
		}

		case "listenFailed": {
			if (s.mode !== "listening" && s.mode !== "resolving") return { state: s, effects: [] };
			return {
				state: { ...s, mode: "idle", phase: null },
				effects: [{ type: "stopListening" }, { type: "notice", reason: "listenStopped" }],
			};
		}

		case "manualPlay": {
			if (s.mode === "off") return { state: s, effects: [] };
			const effects: VoiceEffect[] = [];
			if (s.mode === "listening") effects.push({ type: "stopListening" });
			if (s.mode === "speaking") effects.push({ type: "stopPlaying" });
			effects.push({ type: "play", messageId: event.messageId });
			return { state: { ...s, mode: "speaking", phase: "manual" }, effects };
		}

		case "tap": {
			if (s.pending === null) return { state: s, effects: [] };
			return {
				state: { ...s, mode: "idle", pending: null, phase: null, failures: 0 },
				effects: [{ type: "stopPlaying" }, { type: "stopListening" }, { type: "submitAnswer", answer: event.answer, toolCallId: s.pending.toolCallId }],
			};
		}
	}
}

/** A failed answer: the retry is spoken while the retries last; the failure after the last one stops listening. */
function failed(s: VoiceState): VoiceStep {
	const failures = s.failures + 1;
	if (failures <= MAX_RETRIES) {
		return { state: { ...s, mode: "speaking", phase: "retry", failures }, effects: [{ type: "speakRetry", language: s.language }] };
	}
	return { state: { ...s, mode: "idle", phase: null, failures }, effects: [] };
}

/** Resolves a turn's words against the options (the effect runner calls it; pure). */
export function resolveTurn(transcript: string, options: ResolvableOption[], language: VoiceLanguage): OptionResolution {
	return resolveOption(transcript, options, language);
}
