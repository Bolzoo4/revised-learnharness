// tests/ext-explanations-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveExplanations, type ExplanationEvent } from "../src/core/ext/explanations.ts";
import { createExplanationsStore } from "../src/store/ext/explanations-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const version: ExplanationEvent = {
	type: "version",
	nodeId: "n_a",
	version: 1,
	body: "A holds.",
	author: "agent",
	sourceRefs: [],
	styleVersion: "s1",
	fingerprint: "",
	noSource: true,
	proposed: false,
	at: "2026-11-04T10:00:00.000Z",
};

describe("explanations store", () => {
	it("persists events to explanations.jsonl and derives the explanation back", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		store.appendEvent(version);
		store.appendEvent({ ...version, version: 2, body: "A holds, newer." });
		assert.equal(fs.existsSync(path.join(dir, "explanations.jsonl")), true);
		const map = deriveExplanations(createExplanationsStore(dir).readEvents());
		assert.equal(map.get("n_a")?.current?.body, "A holds, newer.");
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		assert.throws(() => store.appendEvent({ ...version, body: "" }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "explanations.jsonl")), false);
	});

	it("skips a corrupt line and keeps the rest", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		store.appendEvent(version);
		fs.appendFileSync(path.join(dir, "explanations.jsonl"), "{torn\n");
		assert.equal(store.readEvents().length, 1);
	});
});
