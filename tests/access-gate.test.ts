// tests/access-gate.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAccess, parseCookie, type GateRequest } from "../src/server/access/gate.ts";
import { issueSession, SESSION_COOKIE } from "../src/server/access/session.ts";
import type { AccessSettings } from "../src/server/access/config.ts";

const token = "k".repeat(64);
const now = 1_700_000_000_000;
const settings: AccessSettings = {
	mode: "enforced", token,
	allowedHosts: ["127.0.0.1:47890", "localhost:47890", "mac.tail1234.ts.net"],
	tailscaleLogin: "me@example.test",
};
const cookie = `${SESSION_COOKIE}=${issueSession(token, now).value}`;
const req = (o: Partial<GateRequest> = {}): GateRequest => ({
	method: "GET", pathname: "/", host: "127.0.0.1:47890", origin: null,
	secFetchSite: null, cookie: null, tailscaleLogin: null, ...o,
});
const decide = (o: Partial<GateRequest>, s: AccessSettings = settings) => evaluateAccess(req(o), s, now);
const allow = { kind: "allow" } as const;

test("open mode allows everything; enforced without a token denies everything with 503", () => {
	assert.deepEqual(decide({ pathname: "/api/x" }, { ...settings, mode: "open", token: null }), allow);
	for (const pathname of ["/", "/healthz", "/signin", "/api/access/signin"]) {
		assert.deepEqual(decide({ pathname, cookie }, { ...settings, token: null }), { kind: "deny", status: 503 });
	}
});

test("host gate: wrong, missing or rebinding hosts get 421 even on public paths and with a valid cookie", () => {
	for (const host of [null, "", "evil.example", "evil.example:47890", "127.0.0.1:1", "127.0.0.1", "mac.tail1234.ts.net:8443", "127.0.0.1:47890.evil.example"]) {
		for (const pathname of ["/", "/healthz", "/signin", "/api/access/signin", "/api/chats"]) {
			assert.deepEqual(decide({ host, pathname, cookie }), { kind: "deny", status: 421 }, `${host} ${pathname}`);
		}
	}
});

test("host gate is case-insensitive and accepts every configured host", () => {
	for (const host of ["127.0.0.1:47890", "LOCALHOST:47890", "Mac.Tail1234.TS.net"]) assert.deepEqual(decide({ host, pathname: "/healthz" }), allow);
});

test("public paths need no cookie", () => {
	for (const pathname of ["/healthz", "/signin"]) assert.deepEqual(decide({ pathname }), allow);
	assert.deepEqual(decide({ method: "POST", pathname: "/api/access/signin", origin: "http://127.0.0.1:47890", secFetchSite: "same-origin" }), allow);
});

test("public paths are exact: lookalikes are protected", () => {
	for (const pathname of ["/healthz/", "/healthz/x", "/signin/x", "/signin.js", "/api/access/signin/x", "/api/access", "/HEALTHZ"]) {
		assert.notDeepEqual(decide({ pathname }), allow, pathname);
	}
});

test("without a valid session cookie: pages redirect to /signin, API requests get 401", () => {
	assert.deepEqual(decide({ pathname: "/chat/abc" }), { kind: "redirect", to: "/signin" });
	assert.deepEqual(decide({ method: "HEAD", pathname: "/" }), { kind: "redirect", to: "/signin" });
	assert.deepEqual(decide({ pathname: "/api/chats" }), { kind: "deny", status: 401 });
	assert.deepEqual(decide({ method: "POST", pathname: "/api/chat", origin: "http://127.0.0.1:47890" }), { kind: "deny", status: 401 });
});

test("a valid cookie allows pages and API; an expired, foreign or garbage cookie does not", () => {
	assert.deepEqual(decide({ pathname: "/chat/abc", cookie }), allow);
	assert.deepEqual(decide({ pathname: "/api/chats", cookie }), allow);
	const expired = `${SESSION_COOKIE}=${issueSession(token, now - 10_000, 1000).value}`;
	const foreign = `${SESSION_COOKIE}=${issueSession("z".repeat(64), now).value}`;
	for (const c of [expired, foreign, `${SESSION_COOKIE}=garbage`, `x${SESSION_COOKIE}=${issueSession(token, now).value}`, ""]) {
		assert.notDeepEqual(decide({ pathname: "/api/chats", cookie: c }), allow, c);
	}
});

test("the cookie is found among other cookies", () => {
	assert.deepEqual(decide({ pathname: "/api/chats", cookie: `a=1; ${cookie}; b=2` }), allow);
	assert.equal(parseCookie("a=1; b=2", "c"), null);
	assert.equal(parseCookie(null, "c"), null);
	assert.equal(parseCookie("lh_session=x=y", "lh_session"), "x=y");
});

test("state-changing requests need a same-origin Origin even with a valid cookie", () => {
	const post = { method: "POST", pathname: "/api/chat", cookie } as const;
	assert.deepEqual(decide({ ...post, origin: "http://127.0.0.1:47890", secFetchSite: "same-origin" }), allow);
	assert.deepEqual(decide({ ...post, origin: "http://127.0.0.1:47890" }), allow, "no fetch metadata (node client)");
	assert.deepEqual(decide({ ...post, origin: "http://127.0.0.1:47890", secFetchSite: "none" }), allow);
	for (const bad of [
		{ origin: null }, { origin: "null" }, { origin: "not a url" }, { origin: "http://evil.example" },
		{ origin: "http://127.0.0.1:9" }, { origin: "http://127.0.0.1:47890", secFetchSite: "cross-site" },
		{ origin: "http://127.0.0.1:47890", secFetchSite: "same-site" },
	]) {
		assert.deepEqual(decide({ ...post, ...bad }), { kind: "deny", status: 403 }, JSON.stringify(bad));
	}
	for (const method of ["PUT", "PATCH", "DELETE", "post"]) {
		assert.deepEqual(decide({ method, pathname: "/api/chat", cookie }), { kind: "deny", status: 403 }, method);
	}
});

test("the Origin check also protects the sign-in endpoint", () => {
	assert.deepEqual(decide({ method: "POST", pathname: "/api/access/signin", origin: "http://evil.example" }), { kind: "deny", status: 403 });
});

test("tailscale identity: a present header must equal the configured login, on every path", () => {
	assert.deepEqual(decide({ pathname: "/api/chats", cookie, tailscaleLogin: "me@example.test" }), allow);
	for (const pathname of ["/api/chats", "/healthz", "/signin"]) {
		assert.deepEqual(decide({ pathname, cookie, tailscaleLogin: "other@example.test" }), { kind: "deny", status: 403 }, pathname);
		assert.deepEqual(decide({ pathname, cookie, tailscaleLogin: "" }), { kind: "deny", status: 403 }, pathname);
	}
});

test("tailscale identity: a header with no configured login is refused; an absent header relies on the cookie alone", () => {
	const noLogin = { ...settings, tailscaleLogin: null };
	assert.deepEqual(decide({ pathname: "/api/chats", cookie, tailscaleLogin: "me@example.test" }, noLogin), { kind: "deny", status: 403 });
	assert.deepEqual(decide({ pathname: "/api/chats", cookie }, noLogin), allow);
	assert.deepEqual(decide({ pathname: "/api/chats" }, noLogin), { kind: "deny", status: 401 });
});
