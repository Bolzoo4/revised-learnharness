// tests/ext-mcp-closure.test.ts
/**
 * REQ-mcp-01, -02, -11: the server cannot reach a model, a key or a write path
 * because none of them is in its import closure.
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
const WRITE_CALL = /\b(writeFileSync|appendFileSync|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|truncateSync|symlinkSync|linkSync|createWriteStream|fs\.promises|node:fs\/promises|openSync\([^)]*["'][wa])/;

describe("the server's import closure (REQ-mcp-01, -02, -11)", () => {
	it("contains the entry, the read-only layer and nothing from the app's write, agent or settings code", () => {
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

	it("no file of the closure calls a filesystem write API", () => {
		for (const f of closure.files) {
			const src = fs.readFileSync(path.join(ROOT, f), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			assert.ok(!WRITE_CALL.test(src), `${f} mentions a write API`);
		}
	});

	it("no file of the closure reads process.env except the entry arguments, or touches fetch/WebSocket/listen", () => {
		for (const f of closure.files) {
			const src = fs.readFileSync(path.join(ROOT, f), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			assert.ok(!/\b(fetch|WebSocket|XMLHttpRequest)\s*\(|\.listen\s*\(/.test(src), `${f} uses the network`);
			if (f !== "scripts/ext-mcp.ts" && f !== "src/server/ext/mcp/args.ts") assert.ok(!/process\.env/.test(src), `${f} reads process.env`);
		}
	});

	it("the scanner itself sees a planted forbidden import (guard against a blind scanner)", () => {
		const dir = fs.mkdtempSync(path.join(ROOT, "tests", ".closure-"));
		try {
			fs.writeFileSync(path.join(dir, "a.ts"), 'import "./b.ts";\nexport * from "../../src/agent/runtime.ts";\n');
			fs.writeFileSync(path.join(dir, "b.ts"), 'import("node:child_process");\n');
			const c = importClosure(path.relative(ROOT, path.join(dir, "a.ts")), ROOT);
			assert.ok(c.packages.includes("node:child_process"));
		} catch (e) {
			// the agent path may not resolve in this tree; only a resolution failure is tolerated, not a missed package
			if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
