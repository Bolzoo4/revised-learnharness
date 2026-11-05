// tests/ext-verify-stores.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCostStore } from "../src/store/ext/cost-store.ts";
import { createSnapshotStore } from "../src/store/ext/snapshot-store.ts";
import { createSourcesStore } from "../src/store/ext/sources-store.ts";
import { createVerificationStore } from "../src/store/ext/verification-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-ver-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sources store", () => {
	it("round-trips entries, creates the stamp on first write, and reads [] when absent", () => {
		const dir = tmp();
		const store = createSourcesStore(dir);
		assert.deepEqual(store.read(), []);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false, "reads never create the stamp");
		store.write([{ id: "lib_a", kind: "pdf", locator: "/a.pdf", tier: "primary", label: "A", status: "active", addedBy: "user" }]);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), true);
		assert.equal(createSourcesStore(dir).read()[0]?.id, "lib_a");
	});
	it("reads a corrupt file as empty and throws on a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "sources.json"), "{ not json");
		assert.deepEqual(createSourcesStore(dir).read(), []);
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		assert.throws(() => createSourcesStore(dir).read(), /Upgrade/);
	});
});

describe("snapshot store (REQ-src-04)", () => {
	it("stores text at snapshots/<sha256>.txt, idempotently, and returns the hash", () => {
		const dir = tmp();
		const store = createSnapshotStore(dir);
		const hash = store.put("hello snapshot");
		assert.equal(hash, createHash("sha256").update("hello snapshot", "utf8").digest("hex"));
		assert.equal(fs.readFileSync(path.join(dir, "snapshots", `${hash}.txt`), "utf-8"), "hello snapshot");
		assert.equal(store.put("hello snapshot"), hash);
		assert.notEqual(store.put("changed source"), hash, "a changed source is a different hash");
	});
	it("throws on a put of existing text when the data is stamped by a newer build", () => {
		const dir = tmp();
		const store = createSnapshotStore(dir);
		store.put("kept text");
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		assert.throws(() => store.put("kept text"), /format version 99/);
	});
});

describe("verification and cost ledgers", () => {
	it("verification events persist and invalid ones are rejected", () => {
		const dir = tmp();
		const store = createVerificationStore(dir);
		store.appendEvent({ type: "check_failed", nodeId: "n1", reason: "x", at: "t" });
		assert.equal(createVerificationStore(dir).readEvents().length, 1);
		assert.throws(() => store.appendEvent({ type: "check_failed", nodeId: "", reason: "x", at: "t" }), /rejected/);
	});
	it("cost events persist", () => {
		const dir = tmp();
		createCostStore(dir).appendEvent({ type: "spend", usd: 0.1, source: "verification", at: "2026-11-04T00:00:00.000Z" });
		assert.equal(createCostStore(dir).readEvents()[0]?.usd, 0.1);
	});
});
