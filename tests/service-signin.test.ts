import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { signInToService } = require("../electron/service-signin.cjs");

const origin = "http://127.0.0.1:47890";
const cookieHeader = "lh_session=1800000000000.abcDEF-_123; Path=/; Expires=Fri, 19 Feb 2027 10:00:00 GMT; HttpOnly; SameSite=Strict";
const ok = () => new Response("{}", { status: 200, headers: { "set-cookie": cookieHeader } });

test("it posts the token once with a same-origin Origin and stores the cookie scoped to the service", async () => {
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const stored: unknown[] = [];
	await signInToService({
		origin, token: "tok",
		fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return ok(); },
		setCookie: async (cookie: unknown) => { stored.push(cookie); },
	});
	assert.equal(requests.length, 1);
	const request = requests[0];
	assert.ok(request);
	assert.equal(request.url, `${origin}/api/access/signin`);
	assert.equal(request.init.method, "POST");
	assert.equal((request.init.headers as Record<string, string>).origin, origin);
	assert.equal(request.init.body, JSON.stringify({ token: "tok" }));
	assert.deepEqual(stored, [{
		url: origin, name: "lh_session", value: "1800000000000.abcDEF-_123",
		httpOnly: true, sameSite: "strict", expirationDate: Date.parse("Fri, 19 Feb 2027 10:00:00 GMT") / 1000,
	}]);
});

test("a rejected token throws and stores nothing", async () => {
	let stored = 0;
	await assert.rejects(signInToService({
		origin, token: "bad",
		fetch: async () => new Response("{}", { status: 401 }),
		setCookie: async () => { stored++; },
	}), /sign-in failed \(401\)/);
	assert.equal(stored, 0);
});

test("a success without a session cookie throws and stores nothing", async () => {
	let stored = 0;
	for (const response of [new Response("{}", { status: 200 }), new Response("{}", { status: 200, headers: { "set-cookie": "other=1; Path=/" } })]) {
		await assert.rejects(signInToService({ origin, token: "t", fetch: async () => response, setCookie: async () => { stored++; } }), /no session/);
	}
	assert.equal(stored, 0);
});

test("the token never appears in the error message", async () => {
	await assert.rejects(signInToService({ origin, token: "super-secret-token", fetch: async () => new Response("{}", { status: 500 }), setCookie: async () => {} }), (error: Error) => !error.message.includes("super-secret-token"));
});
