// src/server/chat-tts.ts
/**
 * Speech for a chat message (REQ-chat-tts-02..05, 07): the teacher's reply read aloud on the shared
 * synthesis (ext/speech-synthesis.ts), with the same content cache and audio gate as lecture narration.
 * The request names a message by its session and id, never a text, so a caller cannot spend the audio
 * budget on arbitrary text. Three parts of one message can be read: its prose (the default), its pending
 * question (part "question": the spoken form of its ask or quiz call), and the fixed retry phrase (part
 * "retry" with a language). Everything impure is injected; the live wiring is chat-tts-live.ts.
 */

import { speechText, type SpeechPart } from "../core/chat-speech.ts";
import { guessLanguage, type AudioLanguage } from "../core/ext/lecture/audio.ts";
import { spokenForm } from "../core/question-speech.ts";
import { BUDGET_TEXT, FAILED_TEXT, NO_KEY_TEXT } from "./ext/lecture-audio.ts";
import { HttpError } from "./ext/http-error.ts";
import { BudgetRefused, TtsError, synthesizeText, type SynthesisDeps } from "./ext/speech-synthesis.ts";

export const CHAT_NO_VOICE_TEXT = "this message's language has no text-to-speech voice";
const UNKNOWN_MESSAGE_TEXT = "unknown session or message";
const NOT_ASSISTANT_TEXT = "only an assistant message can be read aloud";
const NO_TEXT = "this message has no text to read aloud";
const NO_QUESTION_TEXT = "this message has no question to read aloud";
const BODY_FIELDS: readonly string[] = ["sessionId", "messageId", "part", "language"];
/** The fixed phrase of the retry part, per language. */
export const RETRY_PHRASES: Readonly<Record<AudioLanguage, string>> = {
	it: "Non ho capito.",
	en: "Sorry, I did not catch that.",
};
/** The tool calls whose input is a question the learner answers. */
const QUESTION_TOOLS: readonly string[] = ["ask_user_question", "quiz", "probe"];
/** How many of the session's most recent assistant messages decide the language of a reply with no clear language of its own. */
const LANGUAGE_CONTEXT_MESSAGES = 3;

/** The part of a stored message this service reads: its id, its role and its content parts. */
export interface ChatTtsMessage {
	id?: string;
	role: string;
	content?: unknown;
}

type Part = "prose" | "question" | "retry";

function partsOf(message: ChatTtsMessage): SpeechPart[] {
	return Array.isArray(message.content) ? (message.content as SpeechPart[]) : [];
}

/** The speech text of the session's last assistant messages, joined: the context a short reply's language is read from. */
function recentAssistantSpeech(session: readonly ChatTtsMessage[]): string {
	return session
		.filter((m) => m.role === "assistant")
		.slice(-LANGUAGE_CONTEXT_MESSAGES)
		.map((m) => speechText(partsOf(m)))
		.filter((text) => text !== "")
		.join("\n");
}

export interface ChatTtsDeps {
	/** The messages of a session in order, or null when the session is unknown. */
	readSession(sessionId: string): ChatTtsMessage[] | null;
	apiKey(): string | undefined;
	voices(): Record<AudioLanguage, string>;
	/** The shared synthesis: the cache directory, the audio gate, and the injected network. */
	synthesis: SynthesisDeps;
}

interface Request {
	sessionId: string;
	messageId: string;
	part: Part;
	language: AudioLanguage | null;
}

/** The body: {sessionId, messageId} and, optionally, part ("question" | "retry") and language (with "retry" only). */
function requestOf(body: unknown): Request {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
	const record = body as Record<string, unknown>;
	if (Object.keys(record).some((key) => !BODY_FIELDS.includes(key))) throw new HttpError(400, "the body takes only sessionId, messageId, part and language");
	const { sessionId, messageId, part, language } = record;
	if (typeof sessionId !== "string" || sessionId === "") throw new HttpError(400, "sessionId must be a non-empty string");
	if (typeof messageId !== "string" || messageId === "") throw new HttpError(400, "messageId must be a non-empty string");
	if (part !== undefined && part !== "question" && part !== "retry") throw new HttpError(400, "part must be question or retry");
	if (part !== "retry" && part !== "question" && language !== undefined) throw new HttpError(400, "language is for the retry and question parts");
	if (part === "retry" && language !== "it" && language !== "en") throw new HttpError(400, "retry needs a language: it or en");
	if (part === "question" && language !== undefined && language !== "it" && language !== "en") throw new HttpError(400, "language must be it or en");
	return {
		sessionId,
		messageId,
		part: (part as Part | undefined) ?? "prose",
		language: part === "retry" || part === "question" ? ((language as AudioLanguage | undefined) ?? null) : null,
	};
}

export function createChatTts(deps: ChatTtsDeps) {
	/** Language of a text: its own words, else the session's recent prose, else unknown. */
	const languageOf = (text: string, session: readonly ChatTtsMessage[]): AudioLanguage | "unknown" => {
		const own = guessLanguage(text);
		return own === "unknown" ? guessLanguage(recentAssistantSpeech(session)) : own;
	};

	/** The text to speak and its language for one part of a message. Refusals are HttpErrors. */
	function textFor(req: Request, session: readonly ChatTtsMessage[], message: ChatTtsMessage): { text: string; language: AudioLanguage } {
		if (req.part === "retry") return { text: RETRY_PHRASES[req.language!], language: req.language! };
		if (message.role !== "assistant") throw new HttpError(422, NOT_ASSISTANT_TEXT);
		if (req.part === "question") {
			const call = [...partsOf(message)].reverse().find((p) => p.type === "toolCall" && QUESTION_TOOLS.includes(String(p.name)));
			if (call === undefined) throw new HttpError(422, NO_QUESTION_TEXT);
			// The chat's own language first; then the language the client sends (its reply and dictation fallbacks).
			const fromChat = languageOf(speechText(partsOf(message)), session);
			const hint = fromChat !== "unknown" ? fromChat : (req.language ?? undefined);
			const form = spokenForm({ type: `tool-${String(call.name)}`, state: "input-available", input: call.arguments }, { languageHint: hint });
			if (form === null) throw new HttpError(422, NO_QUESTION_TEXT);
			// The question is cleaned like prose: node links and markdown marks go, the words stay (REQ-02).
			return { text: speechText([{ type: "text", text: form.text }]), language: form.language };
		}
		const text = speechText(partsOf(message));
		if (text === "") throw new HttpError(422, NO_TEXT);
		const language = languageOf(text, session);
		if (language === "unknown") throw new HttpError(422, CHAT_NO_VOICE_TEXT);
		return { text, language };
	}

	return {
		/**
		 * The audio (audio/mpeg bytes) of a message's speech; `signal` is the request's abort. Every refusal is an HttpError: 400 a bad body,
		 * 404 an unknown session or message, 422 a message that is not speakable, 503 no key, 429 budget spent,
		 * 502 an upstream failure (fixed text).
		 */
		async speak(body: unknown, signal?: AbortSignal): Promise<Buffer> {
			const req = requestOf(body);
			const session = deps.readSession(req.sessionId);
			const message = session?.find((m) => m.id === req.messageId) ?? null;
			if (session === null || message === null) throw new HttpError(404, UNKNOWN_MESSAGE_TEXT);
			const { text, language } = textFor(req, session, message);
			const key = deps.apiKey();
			if (!key) throw new HttpError(503, NO_KEY_TEXT);
			try {
				// The request's abort (the client stopped the clip) reaches the upstream call: a stopped clip stops paying.
				const { parts } = await synthesizeText({ text, voice: deps.voices()[language], key, signal }, deps.synthesis);
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
