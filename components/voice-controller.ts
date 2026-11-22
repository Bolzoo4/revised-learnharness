// components/voice-controller.ts
/**
 * The voice-mode loop (REQ-chat-tts-11..15): runs the pure machine (src/core/voice-machine.ts) against the
 * page's effects. The page supplies the environment (playback, the microphone, the answer submit, the timers);
 * this file owns no DOM and no React, so every rule is testable with fakes.
 *
 * Speech arrives as settlements of the shared player's clips (see settled); the microphone's words and
 * utterance ends feed the turn detector (src/core/turn-detector.ts), whose end is the machine's turnEnded.
 * A turn's countdowns are cancelled when it stops, so a stale timer can never end a later turn.
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
	type VoiceState,
} from "@/src/core";
import type { SpeechOutcome, SpeechRequest } from "./use-speech-player";

export interface VoiceEnv {
	/** Plays a message's prose (no request), its question, or its retry phrase. */
	play(messageId: string, request?: SpeechRequest): void;
	stopPlaying(): void;
	startListening(): void;
	stopListening(): void;
	/** The turn's countdown, in ms. Returns the cancel function. */
	schedule(delayMs: number, fire: () => void): () => void;
	/** Submits the learner's answer through the question card's own submit path. */
	submit(answer: Answer): void;
	/** Voice mode turned itself off: the reason is shown to the learner. */
	disable(reason: "budget" | "unavailable"): void;
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
	/** Set while the card's own submit runs (a tap): the machine's submit is then the card's, not a second one. */
	private cardSubmitting = false;

	constructor(private readonly env: VoiceEnv) {}

	/** The machine's state (for the page and the tests). */
	snapshot(): VoiceState {
		return this.state;
	}

	dispatch(event: VoiceEvent): void {
		const out = step(this.state, event);
		this.state = out.state;
		for (const effect of out.effects) this.run(effect);
	}

	/** A reply arrived (or the page turned voice mode on or off, via modeOn/modeOff events). */
	replyArrived(event: Extract<VoiceEvent, { type: "replyArrived" }>): void {
		this.dispatch(event);
	}

	/** A playback of this controller's clip settled. Stopped clips are the controller's own doing and are not reported. */
	settled(key: string, outcome: SpeechOutcome): void {
		if (outcome.type === "stopped") return;
		if (outcome.type === "ended") this.dispatch({ type: "speechEnded" });
		else this.dispatch({ type: "speechFailed", kind: outcome.kind });
	}

	/** A word of the stream: a final (kept) or an interim (replaced until the next). */
	onWords(text: string, final: boolean): void {
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
		this.turn?.detector.event({ type: "utteranceEnd", at: this.env.now() });
	}

	/**
	 * The learner answered by hand on the question card. The card's own submit is the answer: the machine
	 * only stops the speech and the microphone, and does not submit a second time.
	 */
	noteTap(): void {
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
				this.env.play(effect.messageId);
				return;
			case "playQuestion":
				this.env.play(effect.messageId, { part: "question" });
				return;
			case "speakRetry": {
				const pending = this.state.pending;
				if (pending !== null) this.env.play(pending.messageId, { part: "retry", language: effect.language });
				return;
			}
			case "stopPlaying":
				this.env.stopPlaying();
				return;
			case "startListening":
				this.beginTurn();
				this.env.startListening();
				return;
			case "stopListening":
				this.endTurn();
				this.env.stopListening();
				return;
			case "resolve": {
				const result = resolveOption(effect.transcript, effect.options, effect.language);
				this.dispatch({ type: "resolved", result });
				return;
			}
			case "submitAnswer":
				if (!this.cardSubmitting) this.env.submit(effect.answer);
				return;
			case "disableModeWithMessage":
				this.env.disable(effect.reason);
				return;
		}
	}

	private beginTurn(): void {
		this.endTurn();
		const pending: PendingQuestion | null = this.state.pending?.question ?? null;
		const cancels: Array<() => void> = [];
		const turn: Turn = {
			cancels,
			committed: "",
			interim: "",
			detector: createTurnDetector({
				schedule: (ms, fire) => {
					const cancel = this.env.schedule(ms, fire);
					cancels.push(cancel);
					return cancel;
				},
				onEnd: () => {
					// Only the live turn ends the machine's turn.
					if (this.turn === turn) this.dispatch({ type: "turnEnded", transcript: this.transcript() });
				},
				resolvesToOne: pending?.kind === "option" ? clearOptionCheck(() => this.transcript(), pending.options, this.state.language) : undefined,
			}),
		};
		this.turn = turn;
	}

	private endTurn(): void {
		const turn = this.turn;
		this.turn = null;
		for (const cancel of turn?.cancels ?? []) cancel();
	}
}

