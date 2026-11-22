"use client";
// components/use-voice-mode.ts
/**
 * Voice mode in the chat (REQ-chat-tts-08..15): binds the voice controller to the page. Replies play on their own
 * when the session's flag is on; a pending question is spoken after the prose; the learner's words come from the
 * dictation stream (the voice URL, with the controller's turn detector); a spoken answer is submitted through the
 * question card's own submit (buildAnswer, the same grading), and only for the call that is still pending. A
 * budget or unavailable speech turns the flag off with a visible notice; the lesson continues in text. Leaving the
 * chat (unmount, or another session) ends the loop: nothing is submitted for the old chat afterwards.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useDictation } from "@/components/dictation";
import { useDictationLanguage } from "@/components/dictation-preference";
import { questionDataOf } from "@/components/question-dock";
import { getSpeechPlayer, setSpeechSettleListener } from "@/components/use-speech-player";
import { VoiceController } from "@/components/voice-controller";
import {
	buildAnswer,
	guessLanguage,
	speechText,
	type LhViewMessage,
	type PendingQuestion,
	type QuestionAnswerData,
	type ResolvableOption,
	type VoiceLanguage,
} from "@/src/core";

export const VOICE_BUDGET_NOTICE = "Voice mode is off: today's audio budget is spent. The lesson continues in text.";
export const VOICE_UNAVAILABLE_NOTICE = "Voice mode is off: speech is not available here. The lesson continues in text.";
export const VOICE_LISTEN_STOPPED_NOTICE = "Listening stopped. Tap the card to answer.";
export const VOICE_PROSE_FAILED_NOTICE = "This reply could not be read aloud. The question follows.";
export const VOICE_EVENT = "lh:voice-mode";
const QUESTION_TOOLS = ["tool-ask_user_question", "tool-quiz", "tool-probe"];

/**
 * The pending question of a reply, as the machine reads it: an option question (a quiz or probe, or an ask with
 * options) with its options, or an open one. Null when nothing is pending. `toolCallId` names the call it answers.
 */
export function pendingQuestionOf(
	parts: readonly { type: string; text?: unknown; state?: unknown; input?: unknown; toolCallId?: unknown }[],
): { question: PendingQuestion; toolCallId?: string } | null {
	const call = [...parts].reverse().find((p) => QUESTION_TOOLS.includes(p.type) && p.state === "input-available");
	if (call === undefined) return null;
	const input = (call.input ?? {}) as { options?: Array<{ label?: unknown; value?: unknown }> };
	const options: ResolvableOption[] = (input.options ?? [])
		.filter((o) => typeof o.label === "string" && o.label !== "")
		.map((o) => ({ label: o.label as string, value: typeof o.value === "string" ? o.value : (o.label as string) }));
	const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
	const question: PendingQuestion = call.type === "tool-quiz" || call.type === "tool-probe" || options.length > 0 ? { kind: "option", options } : { kind: "open" };
	return { question, toolCallId };
}

/**
 * The language of a reply: its own words when they name one; else the chat's language (the last reply's); else the
 * dictation preference. Never a hard English.
 */
export function replyLanguage(text: string, chat: VoiceLanguage | null, dictation: VoiceLanguage): VoiceLanguage {
	const own = guessLanguage(text);
	if (own !== "unknown") return own;
	return chat ?? dictation;
}

export interface VoicePending {
	tool: string;
	toolCallId: string;
	input: unknown;
}

/** A spoken answer may be submitted only for the question call that is still pending. */
export function canSubmitTo(pending: VoicePending | null, toolCallId: string): boolean {
	return pending !== null && pending.toolCallId === toolCallId;
}

export function useVoiceMode({
	chatId,
	messages,
	busy,
	pending,
	submitPending,
}: {
	chatId: string;
	messages: readonly LhViewMessage[];
	busy: boolean;
	/** The question card's pending call (the chat's own), or null. */
	pending: VoicePending | null;
	/** The card's submit path: the same function the question card's tap uses. */
	submitPending: (output: QuestionAnswerData) => void;
}) {
	const [on, setOn] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const chatRef = useRef(chatId);
	chatRef.current = chatId;
	const pendingRef = useRef(pending);
	pendingRef.current = pending;
	const submitRef = useRef(submitPending);
	submitRef.current = submitPending;
	const dictationRef = useRef<{ start: () => Promise<void>; stop: () => void } | null>(null);
	/** The chat's language: the language of its last reply that named one. */
	const chatLanguageRef = useRef<VoiceLanguage | null>(null);
	const dictationLanguageRef = useRef<VoiceLanguage>("en");
	const { getLanguage } = useDictationLanguage();

	useEffect(() => {
		let alive = true;
		getLanguage()
			.then((code) => {
				if (alive) dictationLanguageRef.current = code.startsWith("it") ? "it" : "en";
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [getLanguage]);

	// One controller per chat: leaving the chat disposes the old one (see the cleanup below).
	const controller = useMemo(
		() =>
			new VoiceController({
				play: (messageId, request) => void getSpeechPlayer()?.play(chatRef.current, messageId, request),
				stopPlaying: () => getSpeechPlayer()?.stop(),
				startListening: () => void dictationRef.current?.start(),
				stopListening: () => dictationRef.current?.stop(),
				schedule: (ms, fire) => {
					const timer = setTimeout(fire, ms);
					return () => clearTimeout(timer);
				},
				submit: (answer, toolCallId) => {
					// Only the call that is still pending is answered; a stale call is never submitted.
					const p = pendingRef.current;
					if (!canSubmitTo(p, toolCallId) || p === null) return;
					const qd = questionDataOf(p.tool, p.input as never, p.toolCallId);
					const req = answer.kind === "option" ? { values: [answer.value] } : { text: answer.text };
					submitRef.current(buildAnswer(qd, req, p.tool));
				},
				notice: (reason) => setNotice(reason === "listenStopped" ? VOICE_LISTEN_STOPPED_NOTICE : VOICE_PROSE_FAILED_NOTICE),
				disable: (reason) => {
					setOn(false);
					announceVoiceMode(chatRef.current, false);
					setNotice(reason === "budget" ? VOICE_BUDGET_NOTICE : VOICE_UNAVAILABLE_NOTICE);
					void fetch(`/api/chats/${chatRef.current}/voice-mode`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ voiceMode: false }),
					}).catch(() => undefined);
				},
				now: () => Date.now(),
			}),
		[chatId],
	);
	useEffect(() => () => controller.dispose(), [controller]);

	const listener = useMemo(
		() => ({
			onWords: (text: string, final: boolean) => controller.onWords(text, final),
			onUtteranceEnd: () => controller.onUtteranceEnd(),
			onStop: () => controller.onStopped(),
		}),
		[controller],
	);
	// A voice dictation: its words go to the controller, never to the composer, and it takes no keyboard seam.
	const dictation = useDictation({ append: () => undefined, voice: listener });
	dictationRef.current = { start: dictation.start, stop: dictation.stop };

	// The flag: read from the session, and kept current by the overflow menu's toggle and the page's own turn-off.
	useEffect(() => {
		let alive = true;
		setOn(false);
		fetch(`/api/chats/${chatId}`)
			.then((res) => (res.ok ? (res.json() as Promise<{ voiceMode?: unknown }>) : null))
			.then((data) => {
				if (alive) setOn(data?.voiceMode === true);
			})
			.catch(() => undefined);
		const onToggle = (event: Event) => {
			const detail = (event as CustomEvent<{ chatId: string; on: boolean }>).detail;
			if (detail.chatId === chatRef.current) setOn(detail.on);
		};
		window.addEventListener(VOICE_EVENT, onToggle);
		return () => {
			alive = false;
			window.removeEventListener(VOICE_EVENT, onToggle);
		};
	}, [chatId]);

	useEffect(() => {
		controller.dispatch(on ? { type: "modeOn" } : { type: "modeOff" });
	}, [on, controller]);

	useEffect(() => {
		setSpeechSettleListener((key, outcome) => controller.settled(key, outcome));
		return () => setSpeechSettleListener(undefined);
	}, [controller]);

	// New replies play once the turn is over. The replies already present when the page opens are not replayed.
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		if (seen.current === null) {
			seen.current = new Set(messages.map((m) => m.id));
			return;
		}
		if (busy) return;
		for (const m of messages) {
			if (m.role !== "assistant" || seen.current.has(m.id)) continue;
			seen.current.add(m.id);
			const parts = m.parts as Array<{ type: string; text?: string; state?: unknown; input?: unknown; toolCallId?: unknown }>;
			const text = speechText(parts as never);
			const language = replyLanguage(text, chatLanguageRef.current, dictationLanguageRef.current);
			if (guessLanguage(text) !== "unknown") chatLanguageRef.current = language;
			const found = pendingQuestionOf(parts);
			controller.replyArrived({
				type: "replyArrived",
				messageId: m.id,
				speakable: text !== "",
				question: found?.question ?? null,
				toolCallId: found?.toolCallId ?? null,
				language,
			});
		}
	}, [messages, busy, controller]);

	return {
		notice,
		on,
		/** A tap on the question card: the voice layer stops speaking and listening; the card submits. */
		noteTap: () => controller.noteTap(),
		/** Manual Listen on a reply while voice mode is on. */
		manual: (messageId: string) => controller.manual(messageId),
	};
}

/** The menu's toggle, and the page's own turn-off, tell the other side about the flag. */
export function announceVoiceMode(chatId: string, on: boolean): void {
	window.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail: { chatId, on } }));
}
