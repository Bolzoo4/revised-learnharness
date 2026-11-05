import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const created: string[] = [];
after(() => {
	for (const id of created) {
		try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch { /* gone */ }
	}
});

/** Runs one turn WITHOUT the buildAgent test seam, so the handler's own kind branch builds the agent;
 *  the model call is intercepted at fetch and its request body (system prompt + tool names) returned. */
async function requestBodyFor(kind: "office_hours" | "practice" | undefined): Promise<string> {
	const chat = chatStore.createChat(`Test: ${kind ?? "teach"} routing`, kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	created.push(chat.id);
	const realFetch = globalThis.fetch;
	const bodies: string[] = [];
	globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
		if (typeof init?.body === "string") bodies.push(init.body);
		return new Response("{}", { status: 400 });
	}) as typeof fetch;
	try {
		const req = new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "here is my proof" } }),
		});
		const ack = await handleChatRequest(req);
		assert.equal(ack.status, 200, await ack.clone().text());
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
	} finally {
		globalThis.fetch = realFetch;
	}
	return bodies.join("\n");
}

describe("chat sessions of kind office_hours", () => {
	it("run the office-hours agent (its prompt and tools), not the practice or teach path", async () => {
		const oh = await requestBodyFor("office_hours");
		assert.ok(oh.length > 0, "the turn reached the model");
		assert.match(oh, /hold office hours/);
		for (const other of [await requestBodyFor("practice"), await requestBodyFor(undefined)]) {
			assert.doesNotMatch(other, /hold office hours/);
		}
	});
});
