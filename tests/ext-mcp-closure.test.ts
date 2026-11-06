// tests/ext-mcp-closure.test.ts
/**
 * REQ-mcp-01, -02, -11: the server cannot reach a model, a key or a write path
 * through its import closure. Filesystem use is an ALLOWLIST: only the read
 * functions below may be reached from the closure; anything else (a write API
 * under any name, a named import, a bare alias such as `const { x } = fs`, or
 * fs/promises) fails the test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { importClosure } from "./helpers/mcp-closure.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const closure = importClosure("scripts/ext-mcp.ts", ROOT);

const FORBIDDEN_FILES = [
	/^src\/agent\//,
	/^src\/store\/graph\.ts$/,
	/^src\/store\/(settings|keys|chats)/,
	/^src\/server\/(stores|verification|settings|keys)/,
	/^src\/server\/ext\/(?!mcp\/)/,
	/^config\.ts$/,
	/^src\/store\/ext\/(?!readonly\.ts$)/,
];
const FORBIDDEN_NODE = /^node:(child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|vm|dns|inspector)$/;

/** The only fs members the closure may reach. */
const FS_ALLOWED = new Set(["statSync", "readFileSync", "readdirSync", "lstatSync"]);

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
const IMPORT_STATEMENT = /^[ \t]*import\s[^;]*?from\s*["'][^"']+["'];?/gm;
const FS_MODULE = /^(node:)?fs$/;

/**
 * Every use of node:fs in one source file that is NOT on the allowlist, as
 * human-readable problems. Comments are ignored. Covers: named imports, the
 * default or namespace binding (member access and bare references), and
 * fs/promises under any spelling.
 */
export function fsProblems(source: string): string[] {
	const src = stripComments(source);
	const problems: string[] = [];
	if (/["'](node:)?fs\/promises["']/.test(src)) problems.push("imports fs/promises");
	const aliases = new Set<string>();
	for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
		if (!FS_MODULE.test(m[2]!)) continue;
		for (const raw of m[1]!.split(",")) {
			const name = raw.trim().split(/\s+as\s+/)[0]!.trim();
			if (name !== "" && !FS_ALLOWED.has(name)) problems.push(`named import ${name}`);
		}
	}
	for (const m of src.matchAll(/import\s+(?:(\w+)|\*\s+as\s+(\w+))(?:\s*,\s*\{[^}]*\})?\s+from\s*["']([^"']+)["']/g)) {
		if (FS_MODULE.test(m[3]!)) aliases.add((m[1] ?? m[2])!);
	}
	const bare = src.replace(IMPORT_STATEMENT, "");
	for (const alias of aliases) {
		for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${alias}\\s*\\.\\s*(\\w+)`, "g"))) {
			if (!FS_ALLOWED.has(m[1]!)) problems.push(`${alias}.${m[1]}`);
		}
		// A bare reference (const { x } = fs, passing fs on, an alias) is not a member access: refuse it.
		const bareRef = new RegExp(`(?<![\\w$.])${alias}(?!\\s*\\.)(?![\\w$])`, "g");
		if (bareRef.test(bare)) problems.push(`bare reference to ${alias}`);
	}
	return problems;
}

describe("the server's import closure (REQ-mcp-01, -02, -11)", () => {
	it("contains the entry, the read-only layer, and no agent, settings, key or chat module (the shared review functions are reachable, but their stores refuse writes in deps.ts)", () => {
		assert.ok(closure.files.includes("scripts/ext-mcp.ts"));
		assert.ok(closure.files.includes("src/store/ext/readonly.ts"));
		for (const f of closure.files) for (const re of FORBIDDEN_FILES) assert.ok(!re.test(f), `${f} must not be imported by the server`);
	});

	it("imports only node builtins without network, process or thread access, the MCP SDK, zod and ts-fsrs (the app's pure scheduler)", () => {
		for (const p of closure.packages) {
			const ok = p.startsWith("node:") ? !FORBIDDEN_NODE.test(p) : p.startsWith("@modelcontextprotocol/sdk/") || p === "zod" || p === "ts-fsrs";
			assert.ok(ok, `package ${p} is not allowed in the server closure`);
		}
	});

	it("every use of node:fs in the closure is on the read allowlist", () => {
		for (const f of closure.files) {
			const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
			assert.deepEqual(fsProblems(src), [], `${f} reaches a filesystem function outside the read allowlist`);
		}
	});

	it("the fs scanner is not blind: each planted write form is reported", () => {
		const planted: Array<[string, string]> = [
			["member write", 'import fs from "node:fs";\nfs.writeFile("x", "y", () => {});'],
			["named write import", 'import { mkdirSync } from "node:fs";\nmkdirSync("d");'],
			["aliased named import", 'import { writeFileSync as w } from "fs";\nw("a", "b");'],
			["destructured bare alias", 'import fs from "node:fs";\nconst { rmSync } = fs;\nrmSync("x");'],
			["promises member", 'import fs from "node:fs";\nawait fs.promises.writeFile("x", "y");'],
			["namespace member", 'import * as f from "fs";\nf.rmSync("x");'],
			["fs/promises import", 'import { writeFile } from "node:fs/promises";\nawait writeFile("x", "y");'],
			["passed on bare", 'import fs from "node:fs";\nhelper(fs);'],
		];
		for (const [label, src] of planted) assert.ok(fsProblems(src).length > 0, `${label} was not reported`);
		assert.deepEqual(fsProblems('import fs from "node:fs";\nconst s = fs.statSync("x");\nfs.readFileSync("y");\n'), []);
	});

	it("the scanner follows real files: a planted write and a planted forbidden import inside the closure are both reported", () => {
		const dir = fs.mkdtempSync(path.join(ROOT, "tests", ".closure-"));
		try {
			fs.writeFileSync(path.join(dir, "a.ts"), 'import "./b.ts";\nexport * from "../../src/agent/background-capture.ts";\n');
			fs.writeFileSync(path.join(dir, "b.ts"), 'import fs from "node:fs";\nimport("node:child_process");\nfs.writeFileSync("x", "y");\n');
			const c = importClosure(path.relative(ROOT, path.join(dir, "a.ts")), ROOT);
			assert.ok(c.packages.includes("node:child_process"), "the planted package is seen");
			assert.ok(c.files.some((f) => f.startsWith("src/agent/")), "the planted agent module is seen");
			const planted = path.relative(ROOT, path.join(dir, "b.ts"));
			assert.ok(fsProblems(fs.readFileSync(path.join(dir, "b.ts"), "utf-8")).includes("fs.writeFileSync"), `${planted} write reported`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no file of the closure reads process.env except the entry arguments, or touches fetch/WebSocket/listen", () => {
		for (const f of closure.files) {
			const src = stripComments(fs.readFileSync(path.join(ROOT, f), "utf-8"));
			assert.ok(!/\b(fetch|WebSocket|XMLHttpRequest)\s*\(|\.listen\s*\(/.test(src), `${f} uses the network`);
			if (f !== "scripts/ext-mcp.ts" && f !== "src/server/ext/mcp/args.ts") assert.ok(!/process\.env/.test(src), `${f} reads process.env`);
		}
	});
});
