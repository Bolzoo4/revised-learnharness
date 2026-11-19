// tests/access-config.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readAccessSettings, MIN_TOKEN_LENGTH } from "../src/server/access/config.ts";

const long = "t".repeat(64);
const reader = (map: Record<string, string | undefined>) => (path: string): string => {
	const text = map[path];
	if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	return text;
};

test("production without a token file is enforced with no token (fail closed)", () => {
	const s = readAccessSettings({ NODE_ENV: "production" }, reader({}));
	assert.equal(s.mode, "enforced");
	assert.equal(s.token, null);
});

test("outside production, no token file means the gate is open (development convenience)", () => {
	assert.equal(readAccessSettings({ NODE_ENV: "development" }, reader({})).mode, "open");
	assert.equal(readAccessSettings({ NODE_ENV: "test" }, reader({})).mode, "open");
	assert.equal(readAccessSettings({}, reader({})).mode, "open");
});

test("a token file turns enforcement on in every environment", () => {
	for (const NODE_ENV of ["production", "development", "test"]) {
		const s = readAccessSettings({ NODE_ENV, LH_ACCESS_TOKEN_FILE: "/t" }, reader({ "/t": `${long}\n` }));
		assert.equal(s.mode, "enforced");
		assert.equal(s.token, long);
	}
});

test("a missing, unreadable, empty or short token file leaves token null while enforced", () => {
	for (const files of [{}, { "/t": "" }, { "/t": "short" }, { "/t": "x".repeat(MIN_TOKEN_LENGTH - 1) }]) {
		const s = readAccessSettings({ NODE_ENV: "production", LH_ACCESS_TOKEN_FILE: "/t" }, reader(files));
		assert.equal(s.mode, "enforced");
		assert.equal(s.token, null);
	}
});

test("a token of exactly the minimum length is accepted", () => {
	const t = "y".repeat(MIN_TOKEN_LENGTH);
	assert.equal(readAccessSettings({ LH_ACCESS_TOKEN_FILE: "/t" }, reader({ "/t": t })).token, t);
});

test("hosts are split, trimmed, lower-cased; empty entries dropped; tailscale login trimmed", () => {
	const s = readAccessSettings({
		LH_ACCESS_TOKEN_FILE: "/t",
		LH_ACCESS_ALLOWED_HOSTS: " 127.0.0.1:1 , LOCALHOST:1,, Mac.TS.net ",
		LH_ACCESS_TAILSCALE_LOGIN: "  me@example.test ",
	}, reader({ "/t": long }));
	assert.deepEqual(s.allowedHosts, ["127.0.0.1:1", "localhost:1", "mac.ts.net"]);
	assert.equal(s.tailscaleLogin, "me@example.test");
});

test("an empty login variable means no login is configured", () => {
	assert.equal(readAccessSettings({ LH_ACCESS_TAILSCALE_LOGIN: "  " }, reader({})).tailscaleLogin, null);
});

test("the length rule applies after trimming, so padding cannot make a short token valid", () => {
	for (const text of ["x".repeat(31) + "\n", "   \n", " ".repeat(40)]) {
		const s = readAccessSettings({ LH_ACCESS_TOKEN_FILE: "/t" }, reader({ "/t": text }));
		assert.equal(s.token, null, JSON.stringify(text));
	}
});
