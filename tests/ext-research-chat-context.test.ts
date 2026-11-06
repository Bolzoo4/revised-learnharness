// tests/ext-research-chat-context.test.ts
/**
 * A research session's context is bounded (review of 88cdf75 + dbe0234, item 3): research
 * chats are never compacted, so a turn over the compaction threshold is refused with a fixed
 * phrase before any model call and before any write. Under the threshold the turn runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-research-context-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const FULL = "this research session is full, start a new one";

/** One research turn over a chat holding `text` as the learner's earlier message; returns the status, the body and the model requests seen. */
async function research(text: string): Promise<{ status: number; body: string; modelRequests: number; messagesAfter: number }> {
	const chat = chatStore.createChat("Research", "research");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, [{ id: "u0", role: "user", content: text, timestamp: Date.now() } as never]);
	const realFetch = globalThis.fetch;
	let modelRequests = 0;
	globalThis.fetch = (async () => {
		modelRequests++;
		return new Response("{}", { status: 400 });
	}) as typeof fetch;
	try {
		const res = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "next question" } }),
			}),
		);
		const body = await res.text();
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
		return { status: res.status, body, modelRequests, messagesAfter: chatStore.getChat(chat.id)?.messages.length ?? -1 };
	} finally {
		globalThis.fetch = realFetch;
	}
}

describe("research session context is bounded", () => {
	it("a research turn over the compaction threshold is refused with a fixed phrase, before any model call or write", async () => {
		// Far above the 150k-token default threshold under the chars/4 estimate.
		const out = await research("x".repeat(800_000));
		assert.equal(out.status, 409);
		assert.deepEqual(JSON.parse(out.body), { error: FULL });
		assert.equal(out.modelRequests, 0, "the model is not called");
		assert.equal(out.messagesAfter, 1, "nothing is appended: no input, no compaction marker");
	});

	it("control: a research turn under the threshold runs and reaches the model", async () => {
		const out = await research("a short research question");
		assert.equal(out.status, 200, out.body);
		assert.ok(out.modelRequests > 0, "the turn reached the model");
	});
});
