import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = "p".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pair-"));
const tokenFile = path.join(dir, "access-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
process.env.LH_ACCESS_TOKEN_FILE = tokenFile;

const { POST: create } = await import("../app/api/access/pairing/route.ts");
const { POST: redeem } = await import("../app/api/access/pair/route.ts");
const { GET: page } = await import("../app/pair/route.ts");
const { signinLimiter } = await import("../src/server/access/signin.ts");
const { pairingStore } = await import("../src/server/access/pairing.ts");
const { verifySession } = await import("../src/server/access/session.ts");

const HOST = "mac.tail1234.ts.net:8444";
const call = (handler: (r: Request) => Promise<Response>, body: unknown, host = HOST) =>
	handler(new Request(`https://${host}/x`, {
		method: "POST", headers: { host, origin: `https://${host}`, "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	}));

beforeEach(() => { signinLimiter().reset(); pairingStore().create(0); });

test("creating a code returns it once, with its expiry, and never the token", async () => {
	const response = await call(create, {});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const text = await response.text();
	assert(!text.includes(token));
	const body = JSON.parse(text);
	assert(/^[A-Za-z0-9_-]{22}$/.test(body.code));
	assert(body.expiresAt > Date.now());
});

test("a created code is exchanged for a 14-day Secure session cookie that verifies under the token", async () => {
	const { code } = await (await call(create, {})).json();
	const response = await call(redeem, { code });
	assert.equal(response.status, 200);
	const set = response.headers.get("set-cookie") ?? "";
	assert(set.startsWith("lh_session="), set);
	assert(/HttpOnly/i.test(set) && /SameSite=lax/i.test(set) && /;\s*Secure/i.test(set) && /Path=\//i.test(set), set);
	const value = decodeURIComponent(/^lh_session=([^;]+)/.exec(set)?.[1] ?? "");
	assert(verifySession(value, token, Date.now()));
	const days = Math.round((Date.parse(/expires=([^;]+)/i.exec(set)?.[1] ?? "") - Date.now()) / 86_400_000);
	assert.equal(days, 14);
	assert(!set.includes(token) && !set.includes(code));
});

test("a code cannot be used twice", async () => {
	const { code } = await (await call(create, {})).json();
	assert.equal((await call(redeem, { code })).status, 200);
	const again = await call(redeem, { code });
	assert.equal(again.status, 401);
	assert.equal(again.headers.get("set-cookie"), null);
});

test("wrong, missing and malformed codes get 401 and no cookie", async () => {
	await call(create, {});
	for (const body of [{ code: "nope" }, {}, { code: 7 }, { code: "" }, { code: ["x"] }, "not json", "null", "[]"]) {
		signinLimiter().reset();
		const response = await call(redeem, body);
		assert.equal(response.status, 401, JSON.stringify(body));
		assert.equal(response.headers.get("set-cookie"), null);
	}
});

test("five wrong codes lock redemption with 429, even for the right code", async () => {
	const { code } = await (await call(create, {})).json();
	for (let i = 0; i < 5; i++) assert.equal((await call(redeem, { code: "wrong" })).status, 401);
	const locked = await call(redeem, { code });
	assert.equal(locked.status, 429);
	assert.equal(locked.headers.get("set-cookie"), null);
});

test("sign-in failures and pairing failures share one lock", async () => {
	const { POST: signin } = await import("../app/api/access/signin/route.ts");
	const { code } = await (await call(create, {})).json();
	for (let i = 0; i < 5; i++) await call(signin, { token: "wrong" });
	assert.equal((await call(redeem, { code })).status, 429);
});

test("oversized bodies are refused and never redeem", async () => {
	const { code } = await (await call(create, {})).json();
	const response = await call(redeem, { code, padding: "x".repeat(2000) });
	assert.equal(response.status, 401);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal((await call(redeem, { code })).status, 200, "the real code was not burned");
});

test("the pairing page is HTML, not cacheable, carries no code, and reads the fragment", async () => {
	const response = await page();
	assert.equal(response.status, 200);
	assert(response.headers.get("content-type")?.startsWith("text/html"));
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	const html = await response.text();
	assert(html.includes("location.hash") && html.includes("/api/access/pair"));
	assert(!html.includes(token));
});
