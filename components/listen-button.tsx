"use client";
// components/listen-button.tsx
/**
 * The "listen" control of an assistant reply (REQ-chat-tts-01, 03, 05): small and icon-only. Hidden when the
 * reply has nothing speakable or the server has no speech (no key, 503); disabled with the server's reason as
 * its title when the server refuses this message (422 language, 429 budget). Pressing it plays the reply, or
 * stops it when it is the one playing.
 */

import { useSyncExternalStore } from "react";
import { LoaderCircleIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { speechText, type SpeechPart } from "@/src/core";
import { getSpeechPlayer, type SpeechPlayer, type SpeechSnapshot } from "./use-speech-player";

const EMPTY: SpeechSnapshot = { states: {}, unavailable: false };
const subscribeNothing = (): (() => void) => () => undefined;
const snapshotNothing = (): SpeechSnapshot => EMPTY;

export function ListenButton({
	sessionId,
	messageId,
	parts,
	player,
	onPress,
}: {
	sessionId: string;
	messageId: string;
	parts: readonly SpeechPart[];
	/** The player to use; defaults to the page's one (see getSpeechPlayer). */
	player?: SpeechPlayer | null;
	/** Voice mode: a press is handed to the voice layer (which stops listening first) instead of playing directly. */
	onPress?: (messageId: string) => void;
}) {
	const active = player === undefined ? getSpeechPlayer() : player;
	const snap = useSyncExternalStore(
		active ? active.subscribe : subscribeNothing,
		active ? active.snapshot : snapshotNothing,
		snapshotNothing,
	);
	if (speechText(parts) === "" || snap.unavailable) return null;
	const state = snap.states[messageId];
	const playing = state?.status === "playing";
	const loading = state?.status === "loading";
	const error = state?.status === "error" ? state : null;
	return (
		<button
			type="button"
			aria-label="Listen"
			aria-pressed={playing}
			aria-busy={loading || undefined}
			title={error?.reason}
			disabled={error !== null && !error.retryable}
			data-testid="listen-button"
			data-state={state?.status ?? "idle"}
			className="lh-touch inline-flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
			onClick={() => {
				if (onPress) onPress(messageId);
				else void active?.play(sessionId, messageId);
			}}
		>
			{loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : playing ? <SquareIcon className="size-4" /> : <Volume2Icon className="size-4" />}
		</button>
	);
}
