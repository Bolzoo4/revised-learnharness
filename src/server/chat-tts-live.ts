// src/server/chat-tts-live.ts
/**
 * Live wiring of chat speech: the chat store, the Deepgram key (DEEPGRAM_API_KEY), and the shared audio
 * cache and gate of lecture narration. Only wiring; the behaviour is in chat-tts.ts.
 */

import { audioVoicesFromEnv } from "../core/ext/lecture/audio.ts";
import { liveAudioGate } from "./ext/cost-live.ts";
import { lectureAudioDir } from "./ext/lecture-live.ts";
import { getChat } from "./chats.ts";
import { createChatTts } from "./chat-tts.ts";
import { keyValue } from "./keys.ts";

export const chatTts = createChatTts({
	readSession(sessionId) {
		return getChat(sessionId)?.messages ?? null;
	},
	apiKey: () => keyValue("DEEPGRAM_API_KEY") || undefined,
	voices: () => audioVoicesFromEnv(process.env),
	synthesis: { dir: lectureAudioDir, gate: liveAudioGate },
});
