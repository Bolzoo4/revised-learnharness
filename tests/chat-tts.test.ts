// tests/chat-tts.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCostGate, type CostEvent, type CostGate } from "../src/core/ext/cost-gate.ts";
import { createChatTts, type ChatTtsDeps, type ChatTtsMessage } from "../src/server/chat-tts.ts";
import { BUDGET_TEXT, NO_KEY_TEXT } from "../src/server/ext/lecture-audio.ts";
import { HttpError } from "../src/server/ext/http-error.ts";

const KEY = "dg_test_key_0123456789";
const VOICES = { it: "aura-2-livia-it", en: "aura-2-thalia-en" } as const;
const EN_TEXT = "The set is closed under complements. This is the first step of the proof.";
const IT_TEXT = "Il insieme è chiuso per il complemento e questo è il primo passo della dimostrazione.";
const UNKNOWN_TEXT = "Das ist ein Satz in einer Sprache ohne Stoppwörter fuer den Test.";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-tts-"));
	dirs.push(d);
	return d;
}

/** A gate that records every spend; `open` controls whether a request is allowed. */
function fakeGate(open = true) {
	const events: CostEvent[] = [];
	const gate: CostGate = {
		allowed: () => open,
		record: (usd, source) => void events.push({ usd, source } as CostEvent),
	};
	return { gate, events };
}

/** A fake Deepgram: one call per request; answers with the requested text's length in bytes. */
function fakeDeepgram(opts: { status?: number } = {}) {
	const sent: Array<{ url: string; auth: string | null; text: string }> = [];
	const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = init?.headers as Record<string, string>;
		const body = JSON.parse(String(init?.body)) as { text: string };
		sent.push({ url: String(input), auth: headers.Authorization ?? null, text: body.text });
		if (opts.status !== undefined && opts.status !== 200) return new Response("provider detail that must never leak", { status: opts.status });
		return new Response(Buffer.alloc(body.text.length, 7), { status: 200 });
	};
	return { fetchFn: fetchFn as typeof fetch, sent };
}

const assistant = (content: unknown[]): ChatTtsMessage => ({ role: "assistant", content });
const SESSION = "chat_1";
const MESSAGE = "msg_1";

/** Messages by "session/message"; a session that is not in the map is unknown, as is a message that is not in it. */
function reader(messages: Record<string, ChatTtsMessage>, sessions: string[] = [SESSION]) {
	return (sessionId: string, messageId: string): ChatTtsMessage | null => {
		if (!sessions.includes(sessionId)) return null;
		return messages[`${sessionId}/${messageId}`] ?? null;
	};
}

function service(opts: {
	messages?: Record<string, ChatTtsMessage>;
	key?: string | undefined;
	gate?: CostGate;
	status?: number;
	dir?: string;
}) {
	const dgram = fakeDeepgram({ status: opts.status });
	const gateFake = opts.gate === undefined ? fakeGate() : { gate: opts.gate, events: [] as CostEvent[] };
	const dir = opts.dir ?? tmpDir();
	const deps: ChatTtsDeps = {
		readMessage: reader(opts.messages ?? { [`${SESSION}/${MESSAGE}`]: assistant([{ type: "text", text: EN_TEXT }]) }),
		apiKey: () => ("key" in opts ? opts.key : KEY),
		voices: () => VOICES,
		synthesis: { dir, gate: gateFake.gate, fetch: dgram.fetchFn, sleep: async () => undefined, timeoutMs: 5000, maxAttempts: 3 },
	};
	return { tts: createChatTts(deps), sent: dgram.sent, dir, events: gateFake.events };
}

const body = (extra: Record<string, unknown> = {}) => ({ sessionId: SESSION, messageId: MESSAGE, ...extra });

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
		return { status: err.status, message: err.message };
	}
	assert.fail("expected the call to be refused");
}

describe("chat TTS request body", () => {
	it("accepts {sessionId, messageId} and returns audio bytes", async () => {
		const { tts } = service({});
		const audio = await tts.speak(body());
		assert.ok(Buffer.isBuffer(audio));
		assert.ok(audio.length > 0);
	});

	it("rejects a raw text field with 400 and synthesizes nothing", async () => {
		const { tts, sent } = service({});
		const res = await statusOf(tts.speak(body({ text: "anything the caller wants spoken" })));
		assert.equal(res.status, 400);
		assert.equal(sent.length, 0);
	});

	it("rejects any other extra field with 400", async () => {
		const { tts, sent } = service({});
		assert.equal((await statusOf(tts.speak(body({ voice: "aura-2-thalia-en" })))).status, 400);
		assert.equal(sent.length, 0);
	});

	it("rejects a missing or non-string id with 400", async () => {
		const { tts } = service({});
		assert.equal((await statusOf(tts.speak({ sessionId: SESSION }))).status, 400);
		assert.equal((await statusOf(tts.speak({ sessionId: 7, messageId: MESSAGE }))).status, 400);
		assert.equal((await statusOf(tts.speak({ sessionId: SESSION, messageId: "" }))).status, 400);
	});
});

describe("chat TTS message checks", () => {
	it("answers 404 for an unknown session", async () => {
		const { tts } = service({});
		assert.equal((await statusOf(tts.speak({ sessionId: "chat_ghost", messageId: MESSAGE }))).status, 404);
	});

	it("answers 404 for an unknown message", async () => {
		const { tts } = service({});
		assert.equal((await statusOf(tts.speak(body({ messageId: "msg_ghost" })))).status, 404);
	});

	it("answers 422 for a message that is not an assistant message", async () => {
		const { tts, sent } = service({ messages: { [`${SESSION}/${MESSAGE}`]: { role: "user", content: [{ type: "text", text: EN_TEXT }] } } });
		assert.equal((await statusOf(tts.speak(body()))).status, 422);
		assert.equal(sent.length, 0);
	});

	it("answers 422 when the message has no speakable text (tool parts and code only)", async () => {
		const { tts, sent } = service({
			messages: {
				[`${SESSION}/${MESSAGE}`]: assistant([
					{ type: "toolCall", id: "t1", name: "ask", arguments: {} },
					{ type: "text", text: "```\nx = 1\n```" },
				]),
			},
		});
		assert.equal((await statusOf(tts.speak(body()))).status, 422);
		assert.equal(sent.length, 0);
	});

	it("answers 422 with the language reason for a message in a language without a voice", async () => {
		const { tts, sent } = service({ messages: { [`${SESSION}/${MESSAGE}`]: assistant([{ type: "text", text: UNKNOWN_TEXT }]) } });
		const res = await statusOf(tts.speak(body()));
		assert.equal(res.status, 422);
		assert.equal(res.message, "this message's language has no text-to-speech voice");
		assert.equal(sent.length, 0);
	});

	it("speaks Italian with the Italian voice", async () => {
		const { tts, sent } = service({ messages: { [`${SESSION}/${MESSAGE}`]: assistant([{ type: "text", text: IT_TEXT }]) } });
		await tts.speak(body());
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.url, /model=aura-2-livia-it/);
	});
});

describe("chat TTS what is sent", () => {
	it("sends the speech text of the message: no code, no thinking, no markup", async () => {
		const { tts, sent } = service({
			messages: {
				[`${SESSION}/${MESSAGE}`]: assistant([
					{ type: "thinking", thinking: "secret plan" },
					{ type: "text", text: "The set is closed for the union.\n```js\nconst a = 1;\n```\nThis is **proved** for the set and it is the first step of the proof." },
				]),
			},
		});
		await tts.speak(body());
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.text, "The set is closed for the union. This is proved for the set and it is the first step of the proof.");
		assert.equal(sent[0]!.url.includes("aura-2-thalia-en"), true);
		assert.equal(sent[0]!.auth, `Token ${KEY}`);
	});
});

describe("chat TTS key, budget and cache", () => {
	it("answers 503 with the fixed text when there is no key, and calls nothing", async () => {
		const { tts, sent } = service({ key: undefined });
		const res = await statusOf(tts.speak(body()));
		assert.equal(res.status, 503);
		assert.equal(res.message, NO_KEY_TEXT);
		assert.equal(sent.length, 0);
	});

	it("answers 429 with the fixed text when the daily audio budget is spent, and calls nothing", async () => {
		const { tts, sent } = service({ gate: fakeGate(false).gate });
		const res = await statusOf(tts.speak(body()));
		assert.equal(res.status, 429);
		assert.equal(res.message, BUDGET_TEXT);
		assert.equal(sent.length, 0);
	});

	it("answers the upstream failure with 502 and a fixed text that carries no provider detail", async () => {
		const { tts } = service({ status: 500 });
		const res = await statusOf(tts.speak(body()));
		assert.equal(res.status, 502);
		assert.ok(!res.message.includes("provider detail"));
	});

	it("records the spend on the audio gate", async () => {
		const { tts, events } = service({});
		await tts.speak(body());
		assert.equal(events.length, 1);
		assert.equal(events[0]!.source, "audio");
	});

	it("stores the audio in the lecture narration cache, keyed as the lecture path keys it", async () => {
		const { tts, dir } = service({});
		await tts.speak(body());
		const key = createHash("sha256").update(VOICES.en).update("\n").update(EN_TEXT).digest("hex");
		assert.ok(fs.existsSync(path.join(dir, "cache", `${key}.mp3`)));
	});

	it("serves identical text from the cache without a second network call", async () => {
		const dir = tmpDir();
		const first = service({ dir });
		const a = await first.tts.speak(body());
		const second = service({ dir });
		const b = await second.tts.speak(body());
		assert.equal(second.sent.length, 0);
		assert.deepEqual(a, b);
	});

	it("plays cached text even when the budget is now spent (a cache hit costs nothing)", async () => {
		const dir = tmpDir();
		await service({ dir }).tts.speak(body());
		const closed = service({ dir, gate: fakeGate(false).gate });
		const audio = await closed.tts.speak(body());
		assert.ok(audio.length > 0);
		assert.equal(closed.sent.length, 0);
	});
});
