"use client";
// components/session-overflow-menu.tsx
/**
 * The session's overflow menu, in the chat header (REQ-chat-tts-08). Voice mode is an item here, never a control
 * in the composer. The flag is read from the session when the menu opens, saved by its own route, and followed
 * when the page changes it (a budget or unavailable speech turns it off).
 *
 * Turning voice mode on, inside the click (iOS starts audio only from a gesture): the speech element is unlocked,
 * and the shared audio context is created and resumed (primeDictationAudio). The save follows once the audio
 * can run; when it cannot, voice mode stays off and the menu says so.
 */

import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { primeDictationAudio } from "./dictation";
import { getSpeechPlayer, type SpeechPlayer } from "./use-speech-player";
import { announceVoiceMode, VOICE_EVENT } from "./use-voice-mode";

export const VOICE_MODE_SAVE_FAILED = "Voice mode could not be changed.";
export const VOICE_MIC_FAILED = "The microphone could not start, so voice mode stays off.";

export function SessionOverflowMenu({
	chatId,
	player,
	prime = primeDictationAudio,
}: {
	chatId: string;
	player?: SpeechPlayer | null;
	/** Creates and resumes the audio for listening; resolves true when it can run. Injected for tests. */
	prime?: () => Promise<boolean>;
}) {
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

	// The page turns the flag off by itself when speech is spent or unavailable: the menu follows.
	useEffect(() => {
		const onToggle = (event: Event) => {
			const detail = (event as CustomEvent<{ chatId: string; on: boolean }>).detail;
			if (detail.chatId !== chatId) return;
			setVoiceMode(detail.on);
			setNote(null);
		};
		window.addEventListener(VOICE_EVENT, onToggle);
		return () => window.removeEventListener(VOICE_EVENT, onToggle);
	}, [chatId]);

	function save(next: boolean, previous: boolean) {
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
				setVoiceMode(previous);
				setNote(VOICE_MODE_SAVE_FAILED);
			});
	}

	function toggleVoiceMode() {
		const current = voiceMode === true;
		if (current) {
			active?.stop();
			setVoiceMode(false);
			setNote(null);
			save(false, true);
			return;
		}
		// Inside the click: the audio is created and resumed, and the speech element unlocked, before any await.
		const ready = prime();
		active?.unlock();
		void ready.then((ok) => {
			if (!ok) {
				setNote(VOICE_MIC_FAILED);
				return;
			}
			setVoiceMode(true);
			setNote(null);
			save(true, false);
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
