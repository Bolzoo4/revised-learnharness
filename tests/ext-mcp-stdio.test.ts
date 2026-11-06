// tests/ext-mcp-stdio.test.ts
/** The real process over stdio (REQ-mcp-01, -03, -11) and the stdout guard. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { installStdioGuard } from "../src/server/ext/mcp/stdio-guard.ts";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, makeFixture, N, seedStandard } from "./helpers/mcp-fixture.ts";
import { treeDigest } from "./helpers/mcp-dir-hash.ts";

const sessions: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const c of sessions.splice(0)) c.kill("SIGKILL");
	cleanupAllFixtures();
});

const VALID_INPUTS: Record<string, unknown> = {
	search_nodes: { query: "set" },
	get_node: { id: "n_aaaa1111" },
	get_neighbors: { id: "n_aaaa1111", depth: 2 },
	get_lecture: { id: "lec_x" },
	get_goal: { id: "goal_aaaaaaaaaaaa" },
};

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SECRET = "sk-ant-api03-HIDDEN_ENV_SECRET_77";

interface Session {
	child: ChildProcessWithoutNullStreams;
	stdoutLines: string[];
	stderr(): string;
	request(method: string, params?: unknown): Promise<{ result?: any; error?: any }>;
	exit(): Promise<number | null>;
}

function start(dataDir: string, args: string[] = [], env: Record<string, string> = {}): Session {
	const child = spawn(TSX, [path.join(ROOT, "scripts", "ext-mcp.ts"), ...args], {
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LH_DATA_DIR: dataDir, NODE_ENV: "test", ANTHROPIC_API_KEY: SECRET, ...env },
	});
	sessions.push(child);
	let err = "";
	child.stderr.on("data", (d: Buffer) => (err += d.toString()));
	const stdoutLines: string[] = [];
	const waiting = new Map<number, (m: any) => void>();
	let buf = "";
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString();
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line === "") continue;
			stdoutLines.push(line);
			try {
				const m = JSON.parse(line);
				if (typeof m.id === "number") waiting.get(m.id)?.(m);
			} catch {
				/* recorded in stdoutLines; the hygiene test inspects it */
			}
		}
	});
	let id = 0;
	const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
	return {
		child,
		stdoutLines,
		stderr: () => err,
		request: (method, params) =>
			new Promise((resolve, reject) => {
				const n = ++id;
				const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${err}`)), 20_000);
				waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
				child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
			}),
		exit: async () => { child.stdin.end(); return exited; },
	};
}

async function handshake(s: Session): Promise<void> {
	const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	assert.ok(init.result, JSON.stringify(init));
	s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

function hasLsof(): boolean {
	return spawnSync("lsof", ["-v"], { encoding: "utf-8" }).error === undefined;
}

describe("the server process", () => {
	it("speaks only JSON-RPC on stdout, answers every tool, never leaks an env or file secret, and leaves the data untouched", async () => {
		const f = makeFixture();
		seedStandard(f);
		fs.writeFileSync(path.join(f.root, "settings.json"), JSON.stringify({ apiKeys: { anthropic: SECRET } }));
		fs.mkdirSync(path.join(f.root, "chats"));
		fs.writeFileSync(path.join(f.root, "chats", "c1.json"), `{"note":"${SECRET}"}`);
		const before = treeDigest(f.root);
		const s = start(f.root);
		await handshake(s);
		const list = await s.request("tools/list");
		assert.equal(list.result.tools.length, TOOL_NAMES.length);
		const all: string[] = [JSON.stringify(list)];
		for (const name of TOOL_NAMES) {
			const r = await s.request("tools/call", { name, arguments: VALID_INPUTS[name] ?? {} });
			all.push(JSON.stringify(r));
			assert.ok(r.result, `${name}: ${JSON.stringify(r)}`);
		}
		const code = await s.exit();
		assert.equal(code, 0, s.stderr());
		for (const line of s.stdoutLines) {
			const m = JSON.parse(line);
			assert.equal(m.jsonrpc, "2.0", `non-protocol stdout line: ${line.slice(0, 80)}`);
		}
		const everything = s.stdoutLines.join("\n") + all.join("\n");
		assert.ok(!everything.includes(SECRET), "the key must never be served");
		assert.ok(!everything.includes(f.root), "the data path must never be served");
		assert.equal(treeDigest(f.root), before);
	});

	it("opens no listening socket (lsof proves the probe sees the process before it reports no sockets)", { skip: !hasLsof() }, async () => {
		const f = makeFixture();
		const s = start(f.root);
		await handshake(s);
		const lsof = (args: string[]): string => {
			const r = spawnSync("lsof", ["-nP", "-p", String(s.child.pid), ...args], { encoding: "utf-8", timeout: 20_000 });
			return r.stdout ?? "";
		};
		assert.match(lsof([]), /cwd/, "the probe must be able to see the process");
		assert.equal(lsof(["-a", "-i"]).trim(), "", "the server must hold no network socket");
		await s.exit();
	});

	it("a newer stamp makes every tool answer with the same clear error over the wire", async () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("ext", 99);
		const s = start(f.root);
		await handshake(s);
		for (const name of TOOL_NAMES) {
			const r = await s.request("tools/call", { name, arguments: VALID_INPUTS[name] ?? {} });
			assert.equal(r.result.isError, true, name);
			assert.equal(r.result.structuredContent?.error?.code, "data_newer_than_build", name);
		}
		await s.exit();
	});

	it("fails to start with a message on stderr and an empty stdout for a missing data directory or an unknown argument", async () => {
		const missing = start(path.join(makeFixture().root, "does-not-exist"));
		assert.equal(await missing.exit(), 1);
		assert.match(missing.stderr(), /data directory not found/);
		assert.deepEqual(missing.stdoutLines, []);
		const badArg = start(makeFixture().root, ["--write"]);
		assert.equal(await badArg.exit(), 1);
		assert.match(badArg.stderr(), /unknown argument/);
		assert.deepEqual(badArg.stdoutLines, []);
	});

	it("an oversized request ends the session cleanly (the transport fails closed): no hang, no data change, no payload echoed", async () => {
		const f = makeFixture();
		seedStandard(f);
		const before = treeDigest(f.root);
		const s = start(f.root);
		await handshake(s);
		const big = JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "search_nodes", arguments: { query: "x".repeat(300_000) } } });
		s.child.stdin.write(big + "\n", () => undefined);
		const code = await Promise.race([s.exit(), new Promise<string>((res) => setTimeout(() => res("hung"), 15_000))]);
		assert.notEqual(code, "hung", "the server must not hang on an oversized request");
		for (const line of s.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
		assert.ok(!s.stderr().includes("xxxxxxxxxxxxxxxx"), "the payload is never echoed");
		assert.equal(treeDigest(f.root), before);
	});
});

describe("stdio guard", () => {
	it("moves stray stdout writes and console.log to stderr; only the protocol stream reaches real stdout", () => {
		const out = new PassThrough();
		const err = new PassThrough();
		const real: string[] = [];
		out.write = ((chunk: string | Uint8Array, cb?: unknown) => { real.push(String(chunk)); if (typeof cb === "function") (cb as () => void)(); return true; }) as typeof out.write;
		const stderr: string[] = [];
		err.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof err.write;
		const proc = { stdout: out, stderr: err, exit: () => undefined } as unknown as NodeJS.Process;
		const originalLog = console.log;
		const guard = installStdioGuard(proc, () => undefined);
		try {
			proc.stdout.write("stray\n");
			console.log("hello", { a: 1 });
			console.info("info");
			console.debug("dbg");
			assert.deepEqual(real, [], "nothing but the protocol may reach stdout");
			assert.ok(stderr.join("").includes("stray") && stderr.join("").includes("hello"));
			guard.protocolOut.write('{"jsonrpc":"2.0"}\n');
			assert.deepEqual(real, ['{"jsonrpc":"2.0"}\n']);
		} finally {
			guard.restore();
		}
		assert.equal(console.log, originalLog);
	});
});
