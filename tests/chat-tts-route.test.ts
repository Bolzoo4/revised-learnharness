// tests/chat-tts-route.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

// The seam, BEFORE any config-loading import (access settings are cached on first read).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-tts-route-"));
const TOKEN = "q".repeat(64);
const origin = "http://127.0.0.1:47891";
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
fs.writeFileSync(path.join(TMP_DATA, "token"), TOKEN, { mode: 0o600 });
process.env.LH_ACCESS_TOKEN_FILE = path.join(TMP_DATA, "token");
process.env.LH_ACCESS_ALLOWED_HOSTS = "127.0.0.1:47891";
delete process.env.DEEPGRAM_API_KEY;

const { proxy } = await import("../proxy.ts");
const { issueSession } = await import("../src/server/access/session.ts");
const tts = await import("../app/api/chat/tts/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const cookie = `lh_session=${issueSession(TOKEN, Date.now()).value}`;

/** The gate as the app runs it, for a request that carries (or lacks) the session cookie. */
function gateFor(withCookie: boolean) {
	return proxy(
		new NextRequest(`${origin}/api/chat/tts`, {
			method: "POST",
			headers: { host: "127.0.0.1:47891", origin, "content-type": "application/json", ...(withCookie ? { cookie } : {}) },
			body: JSON.stringify({ sessionId: "chat_x", messageId: "msg_x" }),
		}),
	);
}

const post = (body: unknown) =>
	new Request(`${origin}/api/chat/tts`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, host: "127.0.0.1:47891" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("chat TTS route is behind the access gate", () => {
	it("refuses a call without a session with 401 JSON", () => {
		assert.equal(gateFor(false).status, 401);
	});

	it("passes the gate with a valid session cookie", () => {
		assert.equal(gateFor(true).headers.get("x-middleware-next"), "1");
	});
});

describe("chat TTS route", () => {
	it("answers 404 for a session that does not exist", async () => {
		const res = await tts.POST(post({ sessionId: "chat_ghost", messageId: "msg_ghost" }));
		assert.equal(res.status, 404);
		assert.equal(((await res.json()) as { error: string }).error, "unknown session or message");
	});

	it("answers 400 when the body carries a text field", async () => {
		const res = await tts.POST(post({ sessionId: "chat_ghost", messageId: "msg_ghost", text: "spend on this" }));
		assert.equal(res.status, 400);
	});

	it("answers 400 for a body that is not a JSON object", async () => {
		const res = await tts.POST(post("[1,2]"));
		assert.equal(res.status, 400);
	});
});
