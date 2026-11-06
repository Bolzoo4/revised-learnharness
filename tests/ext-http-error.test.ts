// tests/ext-http-error.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_JSON_BODY_BYTES, HttpError, readJsonObject } from "../src/server/ext/http-error.ts";

const CAP = 64 * 1024;
const isTooLarge = (e: unknown) => e instanceof HttpError && e.status === 413 && e.message === "the request body is too large";

/** A POST whose body arrives as a stream: no content-length is set, so only the streamed count can enforce the cap. */
function streamed(chunks: Uint8Array[], declared?: string): Request {
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(c) {
			if (i < chunks.length) c.enqueue(chunks[i++]!);
			else c.close();
		},
	});
	const headers: Record<string, string> = declared === undefined ? {} : { "content-length": declared };
	return new Request("http://localhost/api/ext/test", { method: "POST", body, duplex: "half", headers } as RequestInit & { duplex: "half" });
}

const text = (s: string) => new TextEncoder().encode(s);

describe("readJsonObject byte cap (REQ-http-cap)", () => {
	it("accepts a valid small object", async () => {
		const body = await readJsonObject(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ a: 1 }) }));
		assert.deepEqual(body, { a: 1 });
	});

	it("rejects a declared content-length over the cap with 413 before reading the stream", async () => {
		const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(text("{}")); c.close(); } });
		const req = new Request("http://localhost/x", { method: "POST", body, duplex: "half", headers: { "content-length": String(CAP + 1) } } as RequestInit & { duplex: "half" });
		await assert.rejects(readJsonObject(req), isTooLarge);
		assert.equal(req.bodyUsed, false, "the body was never read");
	});

	it("rejects a lying content-length: small declared, huge streamed (no content-length at all too)", async () => {
		const huge = new Uint8Array(CAP + 10).fill(0x20);
		await assert.rejects(readJsonObject(streamed([huge], "10")), isTooLarge);
		await assert.rejects(readJsonObject(streamed([huge])), isTooLarge);
	});

	it("rejects an oversize body split into many small chunks, and stops reading once over the cap", async () => {
		const chunk = new Uint8Array(4096).fill(0x20);
		const chunks = Array.from({ length: 1000 }, () => chunk);
		let pulls = 0;
		let i = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				pulls += 1;
				if (i < chunks.length) c.enqueue(chunks[i++]!);
				else c.close();
			},
		});
		const req = new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
		await assert.rejects(readJsonObject(req), isTooLarge);
		assert.ok(pulls < 40, `stops early (pulled ${pulls} chunks of 1000)`);
	});

	it("counts bytes, not characters: a multi-byte body over the cap in bytes is rejected", async () => {
		const half = "é".repeat(Math.floor(CAP / 2) + 10); // 2 bytes each, so over CAP bytes but under CAP characters
		const json = JSON.stringify({ s: half });
		assert.ok(json.length < CAP && new TextEncoder().encode(json).length > CAP);
		await assert.rejects(readJsonObject(streamed([text(json)])), isTooLarge);
	});

	it("accepts a body of exactly the cap, and an explicit larger cap accepts a larger body", async () => {
		const pad = " ".repeat(CAP - '{"s":""}'.length);
		const exact = `{"s":"${pad}"}`;
		assert.equal(new TextEncoder().encode(exact).length, CAP);
		const ok = await readJsonObject(streamed([text(exact)]));
		assert.equal(typeof ok.s, "string");
		const bigger = `{"s":"${" ".repeat(CAP + 100)}"}`;
		await assert.rejects(readJsonObject(streamed([text(bigger)])), isTooLarge);
		const allowed = await readJsonObject(streamed([text(bigger)]), CAP * 2);
		assert.equal(typeof allowed.s, "string");
	});

	it("keeps the 400 for malformed JSON, arrays and null, and a missing body", async () => {
		const bad = (body: string) => readJsonObject(new Request("http://localhost/x", { method: "POST", body }));
		await assert.rejects(bad("{not json"), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(bad("[1,2]"), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(bad("null"), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(readJsonObject(new Request("http://localhost/x", { method: "POST" })), (e: unknown) => e instanceof HttpError && e.status === 400);
	});

	it("the default cap is 64 KiB", () => {
		assert.equal(DEFAULT_JSON_BODY_BYTES, 64 * 1024);
	});
});
