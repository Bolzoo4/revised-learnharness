// tests/ext-debrief-purity.test.ts
// The journal format and the facts functions are language-neutral contracts that the read-only MCP process
// also imports (REQ-deb-09, REQ-deb-11): the core debrief modules must stay free of adapters, models and the filesystem.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const dir = path.join(import.meta.dirname, "..", "src", "core", "ext", "debrief");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("src/core/ext/debrief stays pure", () => {
	it("has the expected modules", () => {
		assert.deepEqual(files.sort(), ["activity.ts", "commentary.ts", "config.ts", "facts.ts", "journal.ts", "ports.ts", "sessions.ts", "weekly.ts"]);
	});
	for (const f of files) {
		it(`${f} imports no store, server, agent, filesystem, network or clock-reading code`, () => {
			const text = fs.readFileSync(path.join(dir, f), "utf-8");
			const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
			for (const spec of imports) {
				assert.ok(!/\/(store|server|agent)\//.test(spec), `${f} imports ${spec}`);
				assert.ok(!/^node:(fs|path|http|https|net|child_process|os)$/.test(spec), `${f} imports ${spec}`);
			}
			assert.ok(!/\bfetch\(|new Date\(\)|Date\.now\(\)|Math\.random\(/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} reads the clock or randomness`);
		});
	}
});
