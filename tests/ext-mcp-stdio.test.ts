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
import { cleanupAllFixtures, makeFixture, N, seedStandard, GOAL_ID } from "./helpers/mcp-fixture.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { treeDigest } from "./helpers/mcp-dir-hash.ts";

const sessions: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const c of sessions.splice(0)) c.kill("SIGKILL");
	cleanupAllFixtures();
});

/** A valid input for every tool, so each call must succeed (isError false). */
const VALID_INPUTS: Record<string, unknown> = {
	search_nodes: { query: "set" },
	get_node: { id: N.a },
	get_neighbors: { id: N.a, depth: 2 },
	list_lectures: {},
	get_lecture: { id: makeLecture().id },
	list_goals: {},
	get_goal: { id: GOAL_ID },
	get_daily_plan: {},
	research_status: {},
	get_recent_debriefs: {},
	list_documents: {},
};

const ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "ext-mcp.ts");
const SECRET = "sk-ant-api03-HIDDEN_ENV_SECRET_77";
const HANG_MS = 15_000;

interface Session {
	child: ChildProcessWithoutNullStreams;
	stdoutLines: string[];
	stderr(): string;
	/** Resolves with the exit code once the process has exited, however it exited. */
	exited: Promise<number | null>;
	request(method: string, params?: unknown): Promise<{ result?: any; error?: any }>;
	/** Ends stdin (the client going away) and waits for the exit. */
	exit(): Promise<number | null>;
}

interface StartOptions {
	args?: string[];
	env?: Record<string, string>;
	/** Launch command: the default starts `node` with the tsx loader, so the pid IS the server. */
	launch?: "node" | "npx" | string;
}

function start(dataDir: string, options: StartOptions = {}): Session {
	const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LH_DATA_DIR: dataDir, NODE_ENV: "test", ANTHROPIC_API_KEY: SECRET, ...options.env } as NodeJS.ProcessEnv;
	const entry = options.launch ?? ENTRY;
	const args = options.launch === "npx" ? ["tsx", ENTRY, ...(options.args ?? [])] : ["--import", "tsx", entry, ...(options.args ?? [])];
	const command = options.launch === "npx" ? "npx" : process.execPath;
	const child = spawn(command, args, { cwd: ROOT, env, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
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
				/* recorded in stdoutLines; the hygiene assertions inspect it */
			}
		}
	});
	let id = 0;
	const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
	return {
		child,
		stdoutLines,
		stderr: () => err,
		exited,
		request: (method, params) =>
			new Promise((resolve, reject) => {
				const n = ++id;
				const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${err}`)), 20_000);
				waiting.set(n, (m) => {
					clearTimeout(t);
					resolve(m);
				});
				child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
			}),
		exit: async () => {
			child.stdin.end();
			return exited;
		},
	};
}

/** The exit code, or "hung" when the process is still alive after HANG_MS. */
async function exitWithin(s: Session): Promise<number | "hung" | null> {
	return Promise.race([s.exited, new Promise<"hung">((res) => setTimeout(() => res("hung"), HANG_MS))]);
}

async function handshake(s: Session): Promise<void> {
	const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	assert.ok(init.result, JSON.stringify(init));
	s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

function hasLsof(): boolean {
	return spawnSync("lsof", ["-v"], { encoding: "utf-8" }).error === undefined;
}

/** Every stdout line must be a JSON-RPC 2.0 message. */
function assertProtocolOnly(lines: string[]): void {
	for (const line of lines) {
		let m: any;
		try {
			m = JSON.parse(line);
		} catch {
			assert.fail(`non-JSON stdout line: ${line.slice(0, 80)}`);
		}
		assert.equal(m.jsonrpc, "2.0", `non-protocol stdout line: ${line.slice(0, 80)}`);
	}
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
			assert.equal(r.result.isError, false, `${name} with a valid input: ${JSON.stringify(r.result).slice(0, 200)}`);
		}
		const code = await s.exit();
		assert.equal(code, 0, s.stderr());
		assertProtocolOnly(s.stdoutLines);
		const everything = s.stdoutLines.join("\n") + all.join("\n");
		assert.ok(!everything.includes(SECRET), "the key must never be served");
		assert.ok(!everything.includes(f.root), "the data path must never be served");
		assert.equal(treeDigest(f.root), before);
	});

	it("opens no listening socket: lsof on the server's own pid (the process started directly, not through a wrapper)", { skip: !hasLsof() }, async () => {
		const f = makeFixture();
		const s = start(f.root);
		await handshake(s);
		const lsof = (args: string[]): string => {
			const r = spawnSync("lsof", ["-nP", "-p", String(s.child.pid), ...args], { encoding: "utf-8", timeout: 20_000 });
			return r.stdout ?? "";
		};
		assert.match(lsof([]), /\bcwd\b/, "the probe must see the server process");
		assert.equal(lsof(["-a", "-i"]).trim(), "", "the server must hold no network socket");
		await s.exit();
	});

	it("launched as `npx tsx scripts/ext-mcp.ts` (the documented command) its stdout is protocol only", async () => {
		const f = makeFixture();
		seedStandard(f);
		const s = start(f.root, { launch: "npx" });
		await handshake(s);
		const list = await s.request("tools/list");
		assert.equal(list.result.tools.length, TOOL_NAMES.length);
		assert.equal((await s.request("tools/call", { name: "get_node", arguments: { id: N.a } })).result.isError, false);
		assert.equal(await s.exit(), 0, s.stderr());
		assertProtocolOnly(s.stdoutLines);
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
		const badArg = start(makeFixture().root, { args: ["--write"] });
		assert.equal(await badArg.exit(), 1);
		assert.match(badArg.stderr(), /unknown argument/);
		assert.deepEqual(badArg.stdoutLines, []);
	});

	it("an oversized request ends the process by itself (exit 0, no stdin end needed): no hang, no data change, no payload echoed", async () => {
		const f = makeFixture();
		seedStandard(f);
		const before = treeDigest(f.root);
		const s = start(f.root);
		await handshake(s);
		const big = JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "search_nodes", arguments: { query: "x".repeat(300_000) } } });
		s.child.stdin.write(big + "\n");
		const code = await exitWithin(s);
		assert.notEqual(code, "hung", "the server must exit on an oversized request");
		assert.equal(code, 0, s.stderr());
		assertProtocolOnly(s.stdoutLines);
		assert.ok(!s.stderr().includes("xxxxxxxxxxxxxxxx"), "the payload is never echoed");
		assert.equal(treeDigest(f.root), before);
	});

	it("a closed stdout (the client went away) ends the process quietly: exit 0, no unhandled error event, no stack on stderr", async () => {
		const f = makeFixture();
		seedStandard(f);
		const s = start(f.root);
		await handshake(s);
		s.child.stdout.destroy(); // the reader side is gone: the next reply hits EPIPE
		s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "list_lectures", arguments: {} } }) + "\n");
		const code = await exitWithin(s);
		assert.notEqual(code, "hung", "the server must not hang on a closed stdout");
		assert.equal(code, 0, s.stderr());
		assert.ok(!/Unhandled|EPIPE|\bat \w|Error:/.test(s.stderr()), `stderr must be quiet: ${s.stderr().slice(0, 300)}`);
	});

	it("stray module-level output in the import chain stays off stdout (the guard is installed first); the unguarded control leaks", async () => {
		const f = makeFixture();
		seedStandard(f);
		const guarded = start(f.root, { launch: path.join(ROOT, "tests", "helpers", "mcp-noisy-entry.ts") });
		await handshake(guarded);
		assert.equal((await guarded.request("tools/call", { name: "get_node", arguments: { id: N.a } })).result.isError, false);
		await guarded.exit();
		assertProtocolOnly(guarded.stdoutLines);
		assert.match(guarded.stderr(), /planted: console\.log at module level/, "the planted print is redirected to stderr");

		const unguarded = start(f.root, { launch: path.join(ROOT, "tests", "helpers", "mcp-unguarded-entry.ts") });
		await handshake(unguarded);
		await unguarded.exit();
		assert.ok(unguarded.stdoutLines.some((l) => l.includes("planted")), "control: without the guard first, the planted print reaches stdout");
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

	it("a failed protocol write ends quietly: onClosed runs once, and no error event is emitted on the protocol stream", async () => {
		const out = new PassThrough();
		const err = new PassThrough();
		out.write = ((_chunk: unknown, cb?: unknown) => {
			if (typeof cb === "function") (cb as (e: Error) => void)(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }));
			return false;
		}) as typeof out.write;
		const stderr: string[] = [];
		err.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof err.write;
		const proc = { stdout: out, stderr: err } as unknown as NodeJS.Process;
		let closed = 0;
		const guard = installStdioGuard(proc, () => { closed += 1; });
		const errors: unknown[] = [];
		guard.protocolOut.on("error", (e) => errors.push(e));
		try {
			await new Promise<void>((resolve) => guard.protocolOut.write('{"jsonrpc":"2.0"}\n', () => resolve()));
			assert.equal(closed, 1, "onClosed ran once");
			assert.deepEqual(errors, [], "no error event reaches the protocol stream");
			assert.deepEqual(stderr, [], "nothing is printed");
		} finally {
			guard.restore();
		}
	});
});
