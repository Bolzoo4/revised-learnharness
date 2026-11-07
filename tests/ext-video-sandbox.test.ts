/**
 * The sandbox profile on THIS Mac, with the real sandbox-exec (REQ-vid-06).
 *
 * Each case runs a real program under sandboxProfile() and checks the kernel's
 * answer: a write inside the work directory succeeds, a write outside it is
 * refused, a connection to a local listener is refused (the control run
 * without the sandbox proves the listener works), and the home folder cannot
 * be read. The file is skipped only where /usr/bin/sandbox-exec is missing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { sandboxProfile } from "../src/core/ext/video/sandbox-profile.ts";

const SANDBOX = "/usr/bin/sandbox-exec";
const HAS_SANDBOX = fs.existsSync(SANDBOX);

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lh-sbx-test-"));
const workDir = path.join(root, "work");
const sibling = path.join(root, "sibling");
const runtimeRoot = path.join(root, "runtime");
fs.mkdirSync(workDir);
fs.mkdirSync(sibling);
fs.mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
fs.writeFileSync(path.join(runtimeRoot, "bin", "marker.txt"), "runtime-file");

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const profile = () => sandboxProfile({ workDir: fs.realpathSync(workDir), runtimeRoot: fs.realpathSync(runtimeRoot) });

function sandboxed(argv: string[]) {
	return spawnSync(SANDBOX, ["-p", profile(), ...argv], { encoding: "utf-8", timeout: 20_000 });
}

describe("sandbox-exec with sandboxProfile (REQ-vid-06)", { skip: !HAS_SANDBOX && "sandbox-exec is not on this machine" }, () => {
	it("allows a write inside the work directory", () => {
		const target = path.join(fs.realpathSync(workDir), "inside.txt");
		const r = sandboxed(["/bin/sh", "-c", `echo hello > '${target}' && cat '${target}'`]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(fs.readFileSync(target, "utf-8").trim(), "hello");
	});

	it("refuses a write outside the work directory and leaves no file behind", () => {
		const target = path.join(fs.realpathSync(sibling), "escape.txt");
		const r = sandboxed(["/bin/sh", "-c", `echo nope > '${target}'`]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /Operation not permitted/);
		assert.equal(fs.existsSync(target), false);
	});

	it("refuses a connection to a local listener; the same connection works without the sandbox", async () => {
		const server = net.createServer((socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as net.AddressInfo).port;
		try {
			const control = spawnSync("/usr/bin/nc", ["-z", "-w", "3", "127.0.0.1", String(port)], { encoding: "utf-8", timeout: 20_000 });
			assert.equal(control.status, 0, "control connection must succeed without the sandbox");
			const r = sandboxed(["/usr/bin/nc", "-z", "-w", "3", "127.0.0.1", String(port)]);
			assert.notEqual(r.status, 0, "the sandboxed connection must be refused");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("refuses to read the home folder", () => {
		const r = sandboxed(["/bin/ls", os.homedir()]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /Operation not permitted/);
	});

	it("reads files inside the runtime root", () => {
		const r = sandboxed(["/bin/cat", path.join(fs.realpathSync(runtimeRoot), "bin", "marker.txt")]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout.trim(), "runtime-file");
	});
});
