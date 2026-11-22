// components/voice-controller.ts
/**
 * The voice-mode loop (REQ-chat-tts-11..15): runs the pure machine (src/core/voice-machine.ts) against the
 * page's effects. The page supplies the environment (playback, the microphone, the answer submit, the timers);
 * this file owns no DOM and no React, so every rule is testable with fakes.
 *
 * Speech arrives as settlements of the shared player's clips (see settled); the microphone's words and
 * utterance ends feed the turn detector (src/core/turn-detector.ts), whose end is the machine's turnEnded.
 * A turn that hears no word for VOICE_LISTEN_TIMEOUT_MS ends empty (one retry). A turn's countdowns are
 * cancelled when it stops, so a stale timer can never end a later turn.
 */

import {
	clearOptionCheck,
	createTurnDetector,
	initialVoiceState,
	resolveOption,
	voiceStep as step,
	type TurnDetector,
	type VoiceAnswer as Answer,
	type PendingQuestion,
	type VoiceEffect,
	type VoiceEvent,
	type VoiceNotice,
	type VoiceState,
} from "@/src/core";
import { clipKey, type SpeechOutcome, type SpeechRequest } from "./use-speech-player";

/** The silence that ends a listening turn with no word at all (counts as one retry). */
export const VOICE_LISTEN_TIMEOUT_MS = 25_000;

export interface VoiceEnv {
	/** Plays a message's prose (no request), its question, or its retry phrase. */
	play(messageId: string, request?: SpeechRequest): void;
	stopPlaying(): void;
	startListening(): void;
	stopListening(): void;
	/** A countdown, in ms. Returns the cancel function. */
	schedule(delayMs: number, fire: () => void): () => void;
	/** Submits the learner's answer, for the question call it answers (toolCallId), through the card's submit path. */
	submit(answer: Answer, toolCallId: string): void;
	/** Voice mode turned itself off: the reason is shown to the learner. */
	disable(reason: "budget" | "unavailable"): void;
	/** A short notice for the learner (the reason is the machine's). */
	notice(reason: VoiceNotice): void;
	now(): number;
}

interface Turn {
	detector: TurnDetector;
	cancels: Array<() => void>;
	/** Words of the turn: committed finals, and the current interim. */
	committed: string;
	interim: string;
}

export class VoiceController {
	private state: VoiceState = initialVoiceState();
	private turn: Turn | null = null;
	/** The clip the machine is waiting for (its clip key): settlements of any other clip are not the machine's. */
	private awaiting: string | null = null;
	/** Set when the controller itself stops the listening, so the stop it causes is not reported as a failure. */
	private expectingStop = false;
	/** Set while the card's own submit runs (a tap): the machine's submit is then the card's, not a second one. */
	private cardSubmitting = false;
	private disposed = false;

	constructor(private readonly env: VoiceEnv) {}

	/** The machine's state (for the page and the tests). */
	snapshot(): VoiceState {
		return this.state;
	}

	dispatch(event: VoiceEvent): void {
		if (this.disposed) return;
		const out = step(this.state, event);
		this.state = out.state;
		for (const effect of out.effects) this.run(effect);
	}

	/** A reply arrived (the page's replyArrived event). */
	replyArrived(event: Extract<VoiceEvent, { type: "replyArrived" }>): void {
		this.dispatch(event);
	}

	/**
	 * A clip of the shared player settled. Only the clip the machine is waiting for counts: a manual Listen or a
	 * stale clip is not the machine's, so its end moves nothing. Stopped clips are the controller's own doing.
	 */
	settled(key: string, outcome: SpeechOutcome): void {
		if (this.disposed) return;
		if (outcome.type === "stopped" || key !== this.awaiting) return;
		this.awaiting = null;
		if (outcome.type === "ended") this.dispatch({ type: "speechEnded" });
		else this.dispatch({ type: "speechFailed", kind: outcome.kind });
	}

	/** A word of the stream: a final (kept) or an interim (replaced until the next). */
	onWords(text: string, final: boolean): void {
		if (this.disposed) return;
		const turn = this.turn;
		if (turn === null) return;
		if (final) {
			turn.committed = [turn.committed, text].filter((p) => p !== "").join(" ");
			turn.interim = "";
		} else {
			turn.interim = text;
		}
		turn.detector.event({ type: "word", at: this.env.now() });
	}

	onUtteranceEnd(): void {
		if (this.disposed) return;
		this.turn?.detector.event({ type: "utteranceEnd", at: this.env.now() });
	}

	/** The dictation stopped (the listener's onStop). A stop the controller asked for is expected; any other is a failure. */
	onStopped(): void {
		if (this.disposed) return;
		if (this.expectingStop) {
			this.expectingStop = false;
			return;
		}
		this.dispatch({ type: "listenFailed" });
	}

	/**
	 * The page is done with this loop (unmount, or the session changed): the machine is turned off (speech and mic
	 * stop), every countdown is cancelled, and nothing is submitted or played afterwards.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.dispatch({ type: "modeOff" });
		this.endTurn();
		this.disposed = true;
	}

	/** The learner pressed Listen on a reply while voice mode is on: the machine stops the mic, then plays the clip. */
	manual(messageId: string): void {
		if (this.disposed) return;
		this.dispatch({ type: "manualPlay", messageId });
	}

	/**
	 * The learner answered by hand on the question card. The card's own submit is the answer: the machine
	 * only stops the speech and the microphone, and does not submit a second time.
	 */
	noteTap(): void {
		if (this.disposed) return;
		this.cardSubmitting = true;
		try {
			this.dispatch({ type: "tap", answer: { kind: "text", text: "" } });
		} finally {
			this.cardSubmitting = false;
		}
	}

	private transcript(): string {
		const turn = this.turn;
		if (turn === null) return "";
		return [turn.committed, turn.interim].filter((p) => p !== "").join(" ");
	}

	private run(effect: VoiceEffect): void {
		switch (effect.type) {
			case "play":
				this.awaiting = clipKey(effect.messageId);
				this.env.play(effect.messageId);
				return;
			case "playQuestion": {
				// The language rides the request: the server's spoken form uses it when the question names none.
				const request = { part: "question", language: this.state.language } as const;
				this.awaiting = clipKey(effect.messageId, request);
				this.env.play(effect.messageId, request);
				return;
			}
			case "speakRetry": {
				const pending = this.state.pending;
				if (pending === null) return;
				const request = { part: "retry", language: effect.language } as const;
				this.awaiting = clipKey(pending.messageId, request);
				this.env.play(pending.messageId, request);
				return;
			}
			case "stopPlaying":
				this.awaiting = null;
				this.env.stopPlaying();
				return;
			case "startListening":
				this.beginTurn();
				this.env.startListening();
				return;
			case "stopListening":
				this.endTurn();
				this.expectingStop = true;
				this.env.stopListening();
				return;
			case "resolve": {
				const result = resolveOption(effect.transcript, effect.options, effect.language);
				this.dispatch({ type: "resolved", result });
				return;
			}
			case "submitAnswer":
				if (!this.cardSubmitting) this.env.submit(effect.answer, effect.toolCallId ?? "");
				return;
			case "disableModeWithMessage":
				this.env.disable(effect.reason);
				return;
			case "notice":
				this.env.notice(effect.reason);
				return;
		}
	}

	private beginTurn(): void {
		this.endTurn();
		this.expectingStop = false;
		const pending: PendingQuestion | null = this.state.pending?.question ?? null;
		const cancels: Array<() => void> = [];
		const schedule = (ms: number, fire: () => void) => {
			const cancel = this.env.schedule(ms, fire);
			cancels.push(cancel);
			return cancel;
		};
		const turn: Turn = {
			cancels,
			committed: "",
			interim: "",
			detector: createTurnDetector({
				schedule,
				onEnd: () => {
					// Only the live turn ends the machine's turn.
					if (this.turn === turn) this.dispatch({ type: "turnEnded", transcript: this.transcript() });
				},
				resolvesToOne: pending?.kind === "option" ? clearOptionCheck(() => this.transcript(), pending.options, this.state.language) : undefined,
			}),
		};
		this.turn = turn;
		// Nothing heard for the whole timeout: the turn ends empty (one retry).
		schedule(VOICE_LISTEN_TIMEOUT_MS, () => {
			if (this.turn === turn && turn.committed === "" && turn.interim === "") this.dispatch({ type: "turnEnded", transcript: "" });
		});
	}

	private endTurn(): void {
		const turn = this.turn;
		this.turn = null;
		for (const cancel of turn?.cancels ?? []) cancel();
	}
}
