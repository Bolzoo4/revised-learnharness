// tests/access-proxy.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
// Installed Next retains the old test-helper export despite proxy.md's new name.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";

const token = "p".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proxy-"));
fs.writeFileSync(path.join(dir, "token"), token, { mode: 0o600 });
process.env.LH_ACCESS_TOKEN_FILE = path.join(dir, "token");
process.env.LH_ACCESS_ALLOWED_HOSTS = "127.0.0.1:47890,mac.tail1234.ts.net:8444";

const { proxy, config } = await import("../proxy.ts");
const { issueSession } = await import("../src/server/access/session.ts");
const origin = "http://127.0.0.1:47890";
const cookie = `lh_session=${issueSession(token, Date.now()).value}`;
const call = (pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
	proxy(new NextRequest(origin + pathname, { method: init.method, headers: { host: "127.0.0.1:47890", ...init.headers } }));

test("the matcher covers pages and API, and skips only framework static assets", () => {
	for (const p of ["/", "/chat/new", "/api/events", "/api/settings/models", "/healthz", "/signin", "/pair", "/api/access/pair", "/api/access/pairing", "/manifest.webmanifest", "/icons/icon-192.png", "/apple-touch-icon.png"]) assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + p }), p);
	for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"]) assert(!unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + p }), p);
});

test("without a cookie a page redirects to /signin and the API returns 401 JSON", async () => {
	const page = call("/chat/new");
	assert.equal(page.status, 307);
	assert.equal(new URL(page.headers.get("location") ?? "").pathname, "/signin");
	assert(/^https?:\/\//.test(page.headers.get("location") ?? ""), "Location must be absolute");
	const api = call("/api/settings");
	assert.equal(api.status, 401);
	assert.equal(api.headers.get("cache-control"), "no-store");
});

test("with a valid cookie requests continue", () => {
	assert.equal(call("/api/settings", { headers: { cookie } }).headers.get("x-middleware-next"), "1");
	assert.equal(call("/chat/new", { headers: { cookie } }).headers.get("x-middleware-next"), "1");
});

test("every method is denied without a cookie", () => {
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
		const response = call("/api/settings", { method, headers: { origin } });
		assert.equal(response.status, 401, method);
	}
});

test("a foreign Host is refused with 421 before anything else", () => {
	const response = proxy(new NextRequest("http://evil.example/api/settings", { headers: { host: "evil.example", cookie } }));
	assert.equal(response.status, 421);
});

test("the Tailscale identity header is refused when no login is configured", () => {
	assert.equal(call("/api/settings", { headers: { cookie, "tailscale-user-login": "x@example.test" } }).status, 403);
});

test("healthz and the sign-in routes stay reachable without a cookie", () => {
	assert.equal(call("/healthz").headers.get("x-middleware-next"), "1");
	assert.equal(call("/signin").headers.get("x-middleware-next"), "1");
});

test("the matcher skips only the exact static paths, not look-alikes", () => {
	for (const p of ["/_next/static-evil/x", "/_next/staticfoo", "/_next/imagefoo", "/favicon.icox", "/favicon.ico/x", "/_next/data/build/x.json"]) {
		assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + p }), p);
	}
});

test("an empty Tailscale identity header is refused", () => {
	assert.equal(call("/api/settings", { headers: { cookie, "tailscale-user-login": "" } }).status, 403);
});

test("a cross-origin POST with a valid cookie is refused, a same-origin one continues", () => {
	assert.equal(call("/api/chat", { method: "POST", headers: { cookie, origin: "http://evil.example" } }).status, 403);
	assert.equal(call("/api/chat", { method: "POST", headers: { cookie, origin } }).headers.get("x-middleware-next"), "1");
});

test("on a tailnet host the sign-in redirect is https, on loopback it keeps the connection's scheme", () => {
	const tailnet = call("/chat/new", { headers: { host: "mac.tail1234.ts.net:8444" } });
	assert.equal(tailnet.status, 307);
	assert.equal(tailnet.headers.get("location"), "https://mac.tail1234.ts.net:8444/signin");
	const loopback = call("/chat/new");
	assert.equal(loopback.headers.get("location"), "http://127.0.0.1:47890/signin");
});
