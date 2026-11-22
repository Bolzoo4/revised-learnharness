// tests/chat-voice-mode.test.ts
// Voice mode (REQ-chat-tts-08, 09): a per-session flag, off by default, persisted with the session; while on,
// the teacher's turn carries a standing instruction to speak. Runs under an isolated LH_DATA_DIR.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-voice-mode-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { voiceModeInstruction } = await import("../src/core/native-messages.ts");
const voiceRoute = await import("../app/api/chats/[id]/voice-mode/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** A faux engine so no provider is touched (the same seam as prompt-overrides.test.ts). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const put = (id: string, body: unknown) =>
	new Request(`http://127.0.0.1/api/chats/${id}/voice-mode`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("voice mode flag", () => {
	it("is off by default", () => {
		const chat = chatStore.createChat("Voice default");
		assert.notEqual(chatStore.getChat(chat.id)?.voiceMode, true);
	});

	it("persists with the session across reads", () => {
		const chat = chatStore.createChat("Voice persist");
		chatStore.setVoiceMode(chat.id, true);
		assert.equal(chatStore.getChat(chat.id)?.voiceMode, true);
		chatStore.setVoiceMode(chat.id, false);
		assert.equal(chatStore.getChat(chat.id)?.voiceMode, false);
	});

	it("does not touch the model settings or the conversation's activity", () => {
		const chat = chatStore.createChat("Voice settings");
		chatStore.saveSettings(chat.id, { thinkingLevel: "high" });
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.setVoiceMode(chat.id, true);
		const after = chatStore.getChat(chat.id)!;
		assert.deepEqual(after.settings, { thinkingLevel: "high" });
		assert.equal(after.updatedAt, before, "a flag change is not conversation activity");
	});
});

describe("voice mode standing instruction", () => {
	it("is composed into the teacher's system prompt only while voice mode is on", () => {
		const engine = fauxEngine();
		const off = createTeacherAgent(undefined, { engine });
		const on = createTeacherAgent(undefined, { engine, voiceMode: true });
		assert.ok(on.state.systemPrompt.includes(voiceModeInstruction()));
		assert.ok(!off.state.systemPrompt.includes(voiceModeInstruction()));
	});

	it("leaves the prompt byte-identical when voice mode is off", () => {
		const engine = fauxEngine();
		const plain = createTeacherAgent(undefined, { engine });
		const explicitOff = createTeacherAgent(undefined, { engine, voiceMode: false });
		assert.equal(explicitOff.state.systemPrompt, plain.state.systemPrompt);
	});

	it("asks for conversational speech, no markup, and only the two question tools", () => {
		const text = voiceModeInstruction();
		for (const phrase of ["conversationally", "tables", "code blocks", "ask_user_question", "quiz", "in words"]) {
			assert.ok(text.includes(phrase), `missing: ${phrase}`);
		}
	});
});

describe("voice mode route", () => {
	it("PUT sets the flag and answers with it", async () => {
		const chat = chatStore.createChat("Voice route");
		const res = await voiceRoute.PUT(put(chat.id, { voiceMode: true }), params(chat.id));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { voiceMode: true });
		assert.equal(chatStore.getChat(chat.id)?.voiceMode, true);
	});

	it("PUT refuses a body that is not exactly a boolean flag (400)", async () => {
		const chat = chatStore.createChat("Voice bad body");
		for (const body of [{}, { voiceMode: "yes" }, "not json"]) {
			const res = await voiceRoute.PUT(put(chat.id, body), params(chat.id));
			assert.equal(res.status, 400, JSON.stringify(body));
		}
	});

	it("PUT on an unknown session is 404", async () => {
		const res = await voiceRoute.PUT(put("chat_ghost", { voiceMode: true }), params("chat_ghost"));
		assert.equal(res.status, 404);
	});
});
