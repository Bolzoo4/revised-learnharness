// tests/access-env.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { externalCliEnv, withoutAccessEnv } from "../src/core/auth-env.ts";
import { browserServiceSpawnEnv } from "../src/agent/subagents/headless.ts";

const env = {
	PATH: "/usr/bin", HOME: "/h",
	LH_ACCESS_TOKEN_FILE: "/secret/token", LH_ACCESS_ALLOWED_HOSTS: "a", LH_ACCESS_TAILSCALE_LOGIN: "me@example.test", LH_ACCESS_ANYTHING: "x",
	LH_DATA_DIR: "/d",
} as unknown as NodeJS.ProcessEnv;

test("withoutAccessEnv drops every LH_ACCESS_* name and keeps the rest", () => {
	const out = withoutAccessEnv(env);
	assert.deepEqual(Object.keys(out).sort(), ["HOME", "LH_DATA_DIR", "PATH"]);
	assert(Object.keys(env).includes("LH_ACCESS_TOKEN_FILE"), "the input is not mutated");
});

test("the claude CLI environment never carries access settings", () => {
	const out = externalCliEnv(env);
	for (const name of Object.keys(out)) assert(!name.startsWith("LH_ACCESS_"), name);
	assert.equal(out.PATH, "/usr/bin");
});

test("the browser-service helper environment never carries access settings", () => {
	const out = browserServiceSpawnEnv(env);
	for (const name of Object.keys(out)) assert(!name.startsWith("LH_ACCESS_"), name);
	assert.equal(out.LH_DATA_DIR, "/d");
});
