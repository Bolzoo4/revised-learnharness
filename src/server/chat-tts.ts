// src/server/chat-tts.ts
/**
 * Speech for a chat message (REQ-chat-tts-02..05, 07): the teacher's reply read aloud on the shared
 * synthesis (ext/speech-synthesis.ts), with the same content cache and audio gate as lecture narration.
 * The request names a message by its session and id, never a text, so a caller cannot spend the audio
 * budget on arbitrary text. Everything impure is injected; the live wiring is chat-tts-live.ts.
 */

import { speechText, type SpeechPart } from "../core/chat-speech.ts";
import { guessLanguage, type AudioLanguage } from "../core/ext/lecture/audio.ts";
import { BUDGET_TEXT, FAILED_TEXT, NO_KEY_TEXT } from "./ext/lecture-audio.ts";
import { HttpError } from "./ext/http-error.ts";
import { BudgetRefused, TtsError, synthesizeText, type SynthesisDeps } from "./ext/speech-synthesis.ts";

export const CHAT_NO_VOICE_TEXT = "this message's language has no text-to-speech voice";
const UNKNOWN_MESSAGE_TEXT = "unknown session or message";
const NOT_ASSISTANT_TEXT = "only an assistant message can be read aloud";
const NO_TEXT = "this message has no text to read aloud";
const BODY_FIELDS: readonly string[] = ["sessionId", "messageId"];

/** The part of a stored message this service reads: its role and its content parts. */
export interface ChatTtsMessage {
	role: string;
	content?: unknown;
}

export interface ChatTtsDeps {
	/** The message of a session, or null when the session or the message is unknown. */
	readMessage(sessionId: string, messageId: string): ChatTtsMessage | null;
	apiKey(): string | undefined;
	voices(): Record<AudioLanguage, string>;
	/** The shared synthesis: the cache directory, the audio gate, and the injected network. */
	synthesis: SynthesisDeps;
}

/** The body must be exactly {sessionId, messageId}: any other field is refused before anything is read or sent. */
function requestIds(body: unknown): { sessionId: string; messageId: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
	const record = body as Record<string, unknown>;
	if (Object.keys(record).some((key) => !BODY_FIELDS.includes(key))) throw new HttpError(400, "the body takes only sessionId and messageId");
	const { sessionId, messageId } = record;
	if (typeof sessionId !== "string" || sessionId === "") throw new HttpError(400, "sessionId must be a non-empty string");
	if (typeof messageId !== "string" || messageId === "") throw new HttpError(400, "messageId must be a non-empty string");
	return { sessionId, messageId };
}

export function createChatTts(deps: ChatTtsDeps) {
	return {
		/**
		 * The audio (audio/mpeg bytes) of a message's speech text. Every refusal is an HttpError: 400 a bad body,
		 * 404 an unknown session or message, 422 a message that is not speakable, 503 no key, 429 budget spent,
		 * 502 an upstream failure (fixed text).
		 */
		async speak(body: unknown): Promise<Buffer> {
			const { sessionId, messageId } = requestIds(body);
			const message = deps.readMessage(sessionId, messageId);
			if (message === null) throw new HttpError(404, UNKNOWN_MESSAGE_TEXT);
			if (message.role !== "assistant") throw new HttpError(422, NOT_ASSISTANT_TEXT);
			const text = speechText(Array.isArray(message.content) ? (message.content as SpeechPart[]) : []);
			if (text === "") throw new HttpError(422, NO_TEXT);
			const language = guessLanguage(text);
			if (language === "unknown") throw new HttpError(422, CHAT_NO_VOICE_TEXT);
			const key = deps.apiKey();
			if (!key) throw new HttpError(503, NO_KEY_TEXT);
			try {
				const { parts } = await synthesizeText({ text, voice: deps.voices()[language], key }, deps.synthesis);
				return Buffer.concat(parts);
			} catch (err) {
				if (err instanceof BudgetRefused) throw new HttpError(429, BUDGET_TEXT);
				if (err instanceof TtsError) throw new HttpError(502, err.message);
				console.error("[ext] chat speech: unexpected error:", err);
				throw new HttpError(502, FAILED_TEXT);
			}
		},
	};
}
