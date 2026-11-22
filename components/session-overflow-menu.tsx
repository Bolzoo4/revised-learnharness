"use client";
// components/session-overflow-menu.tsx
/**
 * The session's overflow menu, in the chat header (REQ-chat-tts-08). Voice mode is an item here, never a control
 * in the composer. The flag is read from the session when the menu opens, and saved by its own route.
 * Turning voice mode on unlocks the audio element inside the click (iOS needs the gesture), before the save.
 */

import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { getSpeechPlayer, type SpeechPlayer } from "./use-speech-player";
import { announceVoiceMode } from "./use-voice-mode";

export const VOICE_MODE_SAVE_FAILED = "Voice mode could not be changed.";

export function SessionOverflowMenu({ chatId, player }: { chatId: string; player?: SpeechPlayer | null }) {
	const [open, setOpen] = useState(false);
	/** null until the session's flag has been read. */
	const [voiceMode, setVoiceMode] = useState<boolean | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const active = player === undefined ? getSpeechPlayer() : player;

	useEffect(() => {
		if (!open || voiceMode !== null) return;
		let alive = true;
		fetch(`/api/chats/${chatId}`)
			.then((res) => (res.ok ? (res.json() as Promise<{ voiceMode?: unknown }>) : null))
			.then((data) => {
				if (alive) setVoiceMode(data?.voiceMode === true);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [open, voiceMode, chatId]);

	function toggleVoiceMode() {
		const next = voiceMode !== true;
		// The unlock: synchronous, inside this click, before the save (see use-speech-player.ts).
		if (next) active?.unlock();
		else active?.stop();
		setVoiceMode(next);
		setNote(null);
		fetch(`/api/chats/${chatId}/voice-mode`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ voiceMode: next }),
		})
			.then((res) => {
				if (!res.ok) throw new Error(`voice mode ${res.status}`);
				announceVoiceMode(chatId, next);
			})
			.catch(() => {
				setVoiceMode(!next);
				setNote(VOICE_MODE_SAVE_FAILED);
			});
	}

	return (
		<div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
			<button
				type="button"
				aria-label="More session options"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="lh-touch lh-no-drag inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<EllipsisIcon className="size-4" aria-hidden />
			</button>
			{open && (
				<div role="menu" aria-label="Session options" className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-popover p-1 text-sm shadow-md">
					<button
						type="button"
						role="menuitemcheckbox"
						aria-checked={voiceMode === true}
						onClick={toggleVoiceMode}
						className="lh-touch flex w-full items-center rounded-sm px-2 text-left hover:bg-accent"
					>
						Voice mode
					</button>
					{note !== null && (
						<p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
							{note}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
