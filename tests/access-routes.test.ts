import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = "r".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-access-"));
const tokenFile = path.join(dir, "access-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
process.env.LH_ACCESS_TOKEN_FILE = tokenFile;
process.env.LH_VERSION = "9.9.9";

const { POST } = await import("../app/api/access/signin/route.ts");
const { GET: health } = await import("../app/healthz/route.ts");
const { GET: page } = await import("../app/signin/route.ts");
const { signinLimiter } = await import("../src/server/access/signin.ts");
const { verifySession } = await import("../src/server/access/session.ts");

const post = (body: unknown, host = "127.0.0.1:47890") =>
	POST(new Request(`http://${host}/api/access/signin`, {
		method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	}));

beforeEach(() => signinLimiter().reset());

test("healthz reports ok and the build version, and nothing else", async () => {
	const response = await health();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), { ok: true, version: "9.9.9" });
});

test("the right token returns a session cookie that verifies under the token", async () => {
	const response = await post({ token });
	assert.equal(response.status, 200);
	const set = response.headers.get("set-cookie") ?? "";
	assert(set.startsWith("lh_session="), set);
	assert(/HttpOnly/i.test(set) && /SameSite=lax/i.test(set) && /Path=\//i.test(set), set);
	assert(!/;\s*Secure/i.test(set), "no Secure flag on loopback http");
	const value = decodeURIComponent(/^lh_session=([^;]+)/.exec(set)?.[1] ?? "");
	assert(verifySession(value, token, Date.now()));
	assert(!set.includes(token), "the token is never echoed");
});

test("off loopback the cookie is Secure", async () => {
	const set = (await post({ token }, "mac.tail1234.ts.net")).headers.get("set-cookie") ?? "";
	assert(/;\s*Secure/i.test(set), set);
});

test("wrong, missing and malformed tokens get 401 and no cookie", async () => {
	for (const body of [{ token: "nope" }, {}, { token: 7 }, { token: "" }, "not json", "null"]) {
		signinLimiter().reset(); // six bad bodies would otherwise trip the five-failure lock
		const response = await post(body);
		assert.equal(response.status, 401, JSON.stringify(body));
		assert.equal(response.headers.get("set-cookie"), null);
	}
});

test("five wrong attempts lock sign-in with 429, even for the right token", async () => {
	for (let i = 0; i < 5; i++) assert.equal((await post({ token: "wrong" })).status, 401);
	const locked = await post({ token });
	assert.equal(locked.status, 429);
	assert.equal(locked.headers.get("set-cookie"), null);
});

test("a successful sign-in clears earlier failures", async () => {
	for (let i = 0; i < 4; i++) await post({ token: "wrong" });
	assert.equal((await post({ token })).status, 200);
	for (let i = 0; i < 4; i++) assert.equal((await post({ token: "wrong" })).status, 401);
});

test("the token never reaches the console", async () => {
	const seen: string[] = [];
	const originals = { log: console.log, error: console.error, warn: console.warn };
	console.log = console.error = console.warn = (...args: unknown[]) => { seen.push(args.join(" ")); };
	try { await post({ token }); await post({ token: "wrong-" + token }); }
	finally { Object.assign(console, originals); }
	assert(!seen.join("\n").includes(token));
});

test("the sign-in page is HTML with a form, is not cacheable, and carries no token", async () => {
	const response = await page();
	assert.equal(response.status, 200);
	assert(response.headers.get("content-type")?.startsWith("text/html"));
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-frame-options"), "DENY");
	const html = await response.text();
	assert(html.includes("<form") && html.includes('type="password"'));
	assert(!html.includes(token));
});

test("a parallel burst of wrong guesses cannot outrun the limiter", async () => {
	const statuses = (await Promise.all(Array.from({ length: 30 }, () => post({ token: "wrong" })))).map((r) => r.status);
	assert.equal(statuses.filter((s) => s === 401).length, 5);
	assert.equal(statuses.filter((s) => s === 429).length, 25);
	assert.equal((await post({ token })).status, 429, "still locked for the right token");
});

test("type-confusion bodies are wrong tokens", async () => {
	for (const body of [{ token: ["x"] }, { token: { toString: "x" } }, { token: null }, "", "[]"]) {
		signinLimiter().reset();
		const response = await post(body);
		assert.equal(response.status, 401, JSON.stringify(body));
		assert.equal(response.headers.get("set-cookie"), null);
	}
});

test("oversized bodies are refused, declared or not, and never yield a cookie", async () => {
	const host = "127.0.0.1:47890";
	const declared = await POST(new Request(`http://${host}/api/access/signin`, {
		method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", "content-length": "5000" }, body: "{}",
	}));
	assert.equal(declared.status, 413);
	const big = await post({ token, padding: "x".repeat(2000) });
	assert.equal(big.status, 401);
	assert.equal(big.headers.get("set-cookie"), null);
});

test("a streamed body without content-length is cut off at the cap", async () => {
	const host = "127.0.0.1:47890";
	let pulled = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			if (pulled > 50) return controller.close();
			controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
		},
	});
	const response = await POST(new Request(`http://${host}/api/access/signin`, {
		method: "POST", headers: { host, origin: `http://${host}` }, body, duplex: "half",
	} as RequestInit));
	assert.equal(response.status, 401);
	assert(pulled < 10, `read ${pulled} chunks`);
});

test("a sign-in on a tailnet host gets a 14-day cookie, on loopback a 90-day one", async () => {
	const days = async (host: string) => {
		const set = (await post({ token }, host)).headers.get("set-cookie") ?? "";
		const expires = Date.parse(/expires=([^;]+)/i.exec(set)?.[1] ?? "");
		return Math.round((expires - Date.now()) / 86_400_000);
	};
	assert.equal(await days("mac.tail1234.ts.net:8444"), 14);
	assert.equal(await days("127.0.0.1:47890"), 90);
});

test("the sign-in page offers pairing by pasted link or code, posting only the code part to /api/access/pair", async () => {
	const html = await page().text();
	assert(html.includes('id="pair"') && html.includes("/api/access/pair"), "pairing form present");
	assert(html.includes('entered.slice(hash + 1)'), "a pasted link is reduced to its fragment");
	assert(!html.includes("lh_session"), "no cookie handling in the page");
});
