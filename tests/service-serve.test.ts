// tests/service-serve.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const darwin = process.platform === "darwin";
const DNS = "mac.tail1234.ts.net";

/** A stand-in `tailscale` that records its calls and answers status queries from files in `bin/`. */
function fixture(serveStatus = "No serve config\n") {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-serve-"));
	const app = path.join(home, "Apps", "LearnHarness.app");
	fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
	fs.mkdirSync(path.join(app, "Contents", "Resources", "server", "standalone"), { recursive: true });
	fs.writeFileSync(path.join(app, "Contents", "MacOS", "LearnHarness"), "#!/bin/sh\n", { mode: 0o755 });
	fs.writeFileSync(path.join(app, "Contents", "Resources", "server", "standalone", "server.js"), "");
	fs.writeFileSync(path.join(app, "Contents", "Resources", "server-title-guard.cjs"), "");
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin);
	const calls = path.join(home, "calls.log");
	fs.writeFileSync(path.join(bin, "serve-status.txt"), serveStatus);
	fs.writeFileSync(path.join(bin, "status.json"), JSON.stringify({ Self: { DNSName: `${DNS}.` } }));
	const stub = path.join(bin, "tailscale");
	fs.writeFileSync(stub, `#!/bin/sh
echo "$@" >> "${calls}"
case "$1 $2" in
  "status --json") cat "${bin}/status.json" ;;
  "serve status") cat "${bin}/serve-status.txt" ;;
esac
exit 0
`, { mode: 0o755 });
	const env = { PATH: process.env.PATH!, HOME: home, LH_APP: app, LH_SERVICE_DRY_RUN: "1", LH_PORT: "47891", LH_TAILSCALE_BIN: stub };
	const run = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync("bash", [path.join(ROOT, "scripts/service/serve.sh"), ...args], { env: { ...env, ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
	const read = (name: string) => (fs.existsSync(name) ? fs.readFileSync(name, "utf8") : "");
	return { home, run, calls: () => read(calls), plist: path.join(home, "Library/LaunchAgents/org.revisedlearnharness.app.plist"), hostFile: path.join(home, "Library/Application Support/LearnHarness/tailnet-host") };
}

test("on publishes TLS-terminated TCP on the chosen port, saves the host and puts it in the plist", { skip: !darwin }, () => {
	const f = fixture();
	const result = f.run(["on"]);
	assert.equal(result.status, 0, result.stderr);
	assert(f.calls().includes("serve --bg --tls-terminated-tcp=8444 tcp://127.0.0.1:47891"), f.calls());
	assert.equal(fs.readFileSync(f.hostFile, "utf8").trim(), `${DNS}:8444`);
	assert(fs.readFileSync(f.plist, "utf8").includes(`127.0.0.1:47891,localhost:47891,${DNS}:8444`));
	assert(result.stdout.includes(`https://${DNS}:8444`));
});

test("on never resets or edits other mappings", { skip: !darwin }, () => {
	const f = fixture();
	f.run(["on"]);
	assert(!/\breset\b/.test(f.calls()), f.calls());
	assert(!/--https=/.test(f.calls()), f.calls());
});

test("on refuses a port another service already uses", { skip: !darwin }, () => {
	const f = fixture(`https://${DNS}:8444 (tailnet only)\n|-- / proxy http://localhost:9000\n`);
	const result = f.run(["on"]);
	assert.notEqual(result.status, 0);
	assert(/already/i.test(result.stderr), result.stderr);
	assert(!/--tls-terminated-tcp/.test(f.calls()), f.calls());
});

test("on is idempotent when the port already points at this service", { skip: !darwin }, () => {
	const f = fixture(`|-- tcp://${DNS}:8444 (TLS terminated) tcp://127.0.0.1:47891\n`);
	assert.equal(f.run(["on"]).status, 0);
});

test("on refuses the ports Funnel can publish, and bad ports", { skip: !darwin }, () => {
	for (const port of ["443", "8443", "10000", "0", "70000", "abc", "8444; reboot"]) {
		const f = fixture();
		const result = f.run(["on"], { LH_SERVE_PORT: port });
		assert.notEqual(result.status, 0, port);
		assert(!/--tls-terminated-tcp/.test(f.calls()), port);
	}
});

test("off removes only this port's mapping and the saved host", { skip: !darwin }, () => {
	const f = fixture();
	f.run(["on"]);
	const result = f.run(["off"]);
	assert.equal(result.status, 0, result.stderr);
	assert(/--tls-terminated-tcp=8444 off/.test(f.calls()), f.calls());
	assert(!fs.existsSync(f.hostFile));
	assert(!fs.readFileSync(f.plist, "utf8").includes(DNS));
});

test("status reports the URL when published and says so when not", { skip: !darwin }, () => {
	const f = fixture();
	assert(/not published/i.test(f.run(["status"]).stdout));
	f.run(["on"]);
	assert(f.run(["status"]).stdout.includes(`https://${DNS}:8444`));
});
