// tests/ext-format.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CURRENT_EXT_FORMAT_VERSION, assertExtFormat, ensureExtFormat } from "../src/store/ext/format.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension format stamp", () => {
	it("assert never writes when there is no sidecar", () => {
		const dir = tmp();
		assertExtFormat(dir);
		assert.deepEqual(fs.readdirSync(dir), []);
	});

	it("assert never creates a missing directory", () => {
		const dir = path.join(tmp(), "not-there");
		assertExtFormat(dir);
		assert.equal(fs.existsSync(dir), false);
	});

	it("ensure writes the sidecar with the current version, once", () => {
		const dir = path.join(tmp(), "ext");
		ensureExtFormat(dir);
		const first = fs.readFileSync(path.join(dir, "format.json"), "utf-8");
		assert.deepEqual(JSON.parse(first), { version: CURRENT_EXT_FORMAT_VERSION });
		ensureExtFormat(dir);
		assert.equal(fs.readFileSync(path.join(dir, "format.json"), "utf-8"), first);
	});

	it("assert throws on a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		assert.throws(() => assertExtFormat(dir), /format version/);
	});

	it("assert accepts the current version", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION }));
		assertExtFormat(dir);
	});

	it("a corrupt sidecar reads as unstamped and is not fatal", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), "{not json");
		assertExtFormat(dir);
	});
});
