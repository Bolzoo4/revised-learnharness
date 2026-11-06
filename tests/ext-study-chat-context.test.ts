// tests/ext-study-chat-context.test.ts
/**
 * A study conversation is an ordinary upstream-compacted chat: over the compaction threshold it
 * is compacted, not refused (the one-per-document conversation cannot be replaced). Research is
 * the only kind kept out of compaction, so an over-threshold research turn is still refused with
 * the fixed 409 before any model call or write.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-context-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const RESEARCH_FULL = "this research session is full, start a new one";

/** One turn over a chat of `kind` holding `text` as the learner's earlier message; returns the status, the body and the model requests seen. */
async function turn(kind: "study" | "research", text: string): Promise<{ status: number; body: string; modelRequests: number }> {
	const chat = chatStore.createChat(kind === "study" ? "Study: test" : "Research", kind);
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
		return { status: res.status, body, modelRequests };
	} finally {
		globalThis.fetch = realFetch;
	}
}

describe("study conversation is compacted like a teach chat, not refused", () => {
	it("a study turn over the compaction threshold is not refused: it runs and reaches the model", async () => {
		// Far above the 150k-token default threshold under the chars/4 estimate.
		const out = await turn("study", "x".repeat(800_000));
		assert.notEqual(out.status, 409, out.body);
		assert.ok(out.modelRequests > 0, "the turn reached the model (compaction is not a refusal)");
	});
});

describe("research session context is still bounded", () => {
	it("a research turn over the compaction threshold is refused with the fixed 409, before any model call", async () => {
		const out = await turn("research", "x".repeat(800_000));
		assert.equal(out.status, 409);
		assert.deepEqual(JSON.parse(out.body), { error: RESEARCH_FULL });
		assert.equal(out.modelRequests, 0, "the model is not called");
	});
});
