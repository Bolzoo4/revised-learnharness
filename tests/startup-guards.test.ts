// tests/startup-guards.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-guards-"));
const dataDir = path.join(root, "data");
process.env.LH_DATA_DIR = dataDir;
const { enforceStartupGuards } = await import("../src/server/startup-guards.ts");

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const exit = (code: number): never => { throw new Exit(code); };
const env = process.env as Record<string, string | undefined>;
function withEnv(patch: Record<string, string | undefined>, run: () => void) {
	const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]));
	Object.assign(env, patch);
	for (const [k, v] of Object.entries(patch)) if (v === undefined) delete env[k];
	try { run(); } finally {
		for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
	}
}
const tokenFile = path.join(root, "token");
fs.writeFileSync(tokenFile, "g".repeat(64), { mode: 0o600 });

test("production without a token file exits 1 and never touches the data lock", () => {
	withEnv({ NODE_ENV: "production", LH_ACCESS_TOKEN_FILE: undefined }, () => {
		assert.throws(() => enforceStartupGuards(exit), (e: unknown) => e instanceof Exit && e.code === 1);
	});
	assert(!fs.existsSync(path.join(dataDir, ".lh-server.lock")));
});

test("a short token file exits 1", () => {
	const short = path.join(root, "short");
	fs.writeFileSync(short, "tiny");
	withEnv({ NODE_ENV: "production", LH_ACCESS_TOKEN_FILE: short }, () => {
		assert.throws(() => enforceStartupGuards(exit), (e: unknown) => e instanceof Exit && e.code === 1);
	});
});

test("a data folder held by another live process exits 1", () => {
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, ".lh-server.lock"), String(process.ppid));
	withEnv({ NODE_ENV: "production", LH_ACCESS_TOKEN_FILE: tokenFile }, () => {
		assert.throws(() => enforceStartupGuards(exit), (e: unknown) => e instanceof Exit && e.code === 1);
	});
	fs.rmSync(path.join(dataDir, ".lh-server.lock"));
});

test("a valid token and a free data folder pass and write our pid", () => {
	withEnv({ NODE_ENV: "production", LH_ACCESS_TOKEN_FILE: tokenFile }, () => enforceStartupGuards(exit));
	assert.equal(fs.readFileSync(path.join(dataDir, ".lh-server.lock"), "utf8"), String(process.pid));
});

test("development without a token file passes the access check", () => {
	withEnv({ NODE_ENV: "development", LH_ACCESS_TOKEN_FILE: undefined }, () => enforceStartupGuards(exit));
});
