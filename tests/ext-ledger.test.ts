// tests/ext-ledger.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { createLedger } from "../src/store/ext/ledger.ts";

interface Ping {
	n: number;
}
function parsePing(raw: unknown): Ping | null {
	if (typeof raw !== "object" || raw === null) return null;
	const n = (raw as { n?: unknown }).n;
	return typeof n === "number" ? { n } : null;
}

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension ledger", () => {
	it("round-trips appended events in order", () => {
		const dir = tmp();
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		ledger.append({ n: 1 });
		ledger.append({ n: 2 });
		assert.deepEqual(ledger.readAll(), [{ n: 1 }, { n: 2 }]);
	});

	it("reading a missing ledger returns [] and writes nothing", () => {
		const dir = path.join(tmp(), "ext");
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.deepEqual(ledger.readAll(), []);
		assert.equal(fs.existsSync(dir), false);
	});

	it("the first append creates the stamp", () => {
		const dir = path.join(tmp(), "ext");
		createLedger(dir, "pings.jsonl", parsePing).append({ n: 1 });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8")), {
			version: CURRENT_EXT_FORMAT_VERSION,
		});
	});

	it("skips corrupt lines and lines the parser rejects", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "pings.jsonl"), `{"n":1}\n{broken\n{"x":true}\n\n{"n":3}\n`);
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.deepEqual(ledger.readAll(), [{ n: 1 }, { n: 3 }]);
	});

	it("append rejects an event the parser refuses and writes nothing", () => {
		const dir = tmp();
		const ledger = createLedger(dir, "pings.jsonl", (raw) => parsePing(raw));
		assert.throws(() => ledger.append({ n: "x" } as unknown as Ping), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "pings.jsonl")), false);
	});

	it("both read and append refuse a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.throws(() => ledger.readAll(), /format version/);
		assert.throws(() => ledger.append({ n: 1 }), /format version/);
	});
});
