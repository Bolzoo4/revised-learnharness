// tests/service-install.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const darwin = process.platform === "darwin";

function fixture() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-svc-"));
	const app = path.join(home, "Apps", "LearnHarness.app");
	fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
	fs.mkdirSync(path.join(app, "Contents", "Resources", "server", "standalone"), { recursive: true });
	fs.writeFileSync(path.join(app, "Contents", "MacOS", "LearnHarness"), "#!/bin/sh\n", { mode: 0o755 });
	fs.writeFileSync(path.join(app, "Contents", "Resources", "server", "standalone", "server.js"), "");
	fs.writeFileSync(path.join(app, "Contents", "Resources", "server-title-guard.cjs"), "");
	const env = { PATH: process.env.PATH!, HOME: home, LH_APP: app, LH_SERVICE_DRY_RUN: "1", LH_PORT: "47891", LH_TAILNET_HOST: "mac.tail1234.ts.net", LH_TAILSCALE_LOGIN: "me@example.test" };
	const run = (script: string) => spawnSync("bash", [path.join(ROOT, "scripts/service", script)], { env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
	return { home, app, env, run, plist: path.join(home, "Library/LaunchAgents/org.revisedlearnharness.app.plist"), token: path.join(home, "Library/Application Support/LearnHarness/access-token") };
}

test("install writes a valid plist and a 0600 token and does not touch launchd in dry-run", { skip: !darwin }, () => {
	const f = fixture();
	const result = f.run("install.sh");
	assert.equal(result.status, 0, result.stderr);
	execFileSync("plutil", ["-lint", f.plist]);
	const xml = fs.readFileSync(f.plist, "utf8");
	for (const needle of [
		"<string>org.revisedlearnharness.app</string>",
		`<string>${f.app}/Contents/MacOS/LearnHarness</string>`,
		"<string>--require</string>", `<string>${f.app}/Contents/Resources/server-title-guard.cjs</string>`,
		`<string>${f.app}/Contents/Resources/server/standalone/server.js</string>`,
		"<key>ELECTRON_RUN_AS_NODE</key><string>1</string>", "<key>NODE_ENV</key><string>production</string>",
		"<key>PORT</key><string>47891</string>", "<key>HOSTNAME</key><string>127.0.0.1</string>",
		`<key>LH_DATA_DIR</key><string>${f.home}/Library/Application Support/LearnHarness/data</string>`,
		`<key>LH_ACCESS_TOKEN_FILE</key><string>${f.token}</string>`,
		"<string>127.0.0.1:47891,localhost:47891,mac.tail1234.ts.net</string>",
		"<key>LH_ACCESS_TAILSCALE_LOGIN</key><string>me@example.test</string>",
		"<key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/>",
	]) assert(xml.includes(needle), needle);
	const mode = fs.statSync(f.token).mode & 0o777;
	assert.equal(mode, 0o600);
	assert(fs.readFileSync(f.token, "utf8").trim().length >= 32);
	assert.equal(execFileSync("plutil", ["-extract", "EnvironmentVariables.PORT", "raw", "-o", "-", f.plist], { encoding: "utf8" }).trim(), "47891");
});

test("install is idempotent: the token and the plist do not change on a second run", { skip: !darwin }, () => {
	const f = fixture();
	assert.equal(f.run("install.sh").status, 0);
	const token = fs.readFileSync(f.token, "utf8"), plist = fs.readFileSync(f.plist, "utf8");
	assert.equal(f.run("install.sh").status, 0);
	assert.equal(fs.readFileSync(f.token, "utf8"), token);
	assert.equal(fs.readFileSync(f.plist, "utf8"), plist);
});

test("install refuses when the app or its bundled server is missing", { skip: !darwin }, () => {
	const f = fixture();
	fs.rmSync(path.join(f.app, "Contents", "Resources", "server"), { recursive: true });
	const result = f.run("install.sh");
	assert.notEqual(result.status, 0);
	assert(/server/i.test(result.stderr));
	assert(!fs.existsSync(f.plist));
});

test("a login is optional: without one the plist has no login key", { skip: !darwin }, () => {
	const f = fixture();
	delete (f.env as Record<string, string | undefined>).LH_TAILSCALE_LOGIN;
	assert.equal(f.run("install.sh").status, 0);
	assert(!fs.readFileSync(f.plist, "utf8").includes("LH_ACCESS_TAILSCALE_LOGIN"));
});

test("rotate-token replaces the token and keeps mode 0600", { skip: !darwin }, () => {
	const f = fixture();
	assert.equal(f.run("install.sh").status, 0);
	const before = fs.readFileSync(f.token, "utf8");
	const result = f.run("rotate-token.sh");
	assert.equal(result.status, 0, result.stderr);
	const after = fs.readFileSync(f.token, "utf8");
	assert.notEqual(after, before);
	assert(after.trim().length >= 32);
	assert.equal(fs.statSync(f.token).mode & 0o777, 0o600);
});

test("uninstall removes the plist and keeps the token and data", { skip: !darwin }, () => {
	const f = fixture();
	assert.equal(f.run("install.sh").status, 0);
	assert.equal(f.run("uninstall.sh").status, 0);
	assert(!fs.existsSync(f.plist));
	assert(fs.existsSync(f.token));
	assert.equal(f.run("uninstall.sh").status, 0, "uninstall is idempotent");
});
