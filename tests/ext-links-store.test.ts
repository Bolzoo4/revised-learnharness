// tests/ext-links-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseLinkEvent } from "../src/core/ext/links.ts";
import { createLedger } from "../src/store/ext/ledger.ts";
import { createLinksStore } from "../src/server/ext/links-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-links-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NODES = new Set(["n_a", "n_b", "n_c"]);
const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-20T11:00:00.000Z";

// Deterministic ids and clock, injected into the store.
function deps(times: string[] = [T1, T2]) {
	let n = 0;
	let t = 0;
	return {
		newId: () => `link_${++n}`,
		now: () => times[Math.min(t++, times.length - 1)] as string,
	};
}

const openStore = (dir: string, d = deps()) =>
	createLinksStore(createLedger(dir, "links.jsonl", parseLinkEvent), d);

describe("links store", () => {
	it("persists two appended links, reopens, and derives both back", () => {
		const dir = tmp();
		const store = openStore(dir);
		const first = store.appendLink({ from: "n_a", to: "n_b", linkType: "sequence", origin: "user" }, NODES);
		const second = store.appendLink({ from: "n_a", to: "n_c", linkType: "analogy", origin: "agent" }, NODES);

		assert.equal(fs.existsSync(path.join(dir, "links.jsonl")), true);
		const reopened = openStore(dir).readLinks();
		assert.deepEqual(reopened, [first, second]);
		assert.deepEqual(reopened, [
			{ id: "link_1", from: "n_a", to: "n_b", linkType: "sequence", directed: true, origin: "user", createdAt: T1 },
			{ id: "link_2", from: "n_a", to: "n_c", linkType: "analogy", directed: false, origin: "agent", createdAt: T2 },
		]);
	});

	it("skips a corrupt line instead of failing the read", () => {
		const dir = tmp();
		const store = openStore(dir);
		store.appendLink({ from: "n_a", to: "n_b", linkType: "part-of", origin: "user" }, NODES);
		fs.appendFileSync(path.join(dir, "links.jsonl"), "{this is not json\n", "utf-8");
		store.appendLink({ from: "n_b", to: "n_c", linkType: "evolution", origin: "user" }, NODES);

		const links = openStore(dir).readLinks();
		assert.deepEqual(links.map((l) => l.id), ["link_1", "link_2"]);
	});

	it("removes a link so it no longer appears when read back", () => {
		const dir = tmp();
		const store = openStore(dir);
		const keep = store.appendLink({ from: "n_a", to: "n_b", linkType: "contrast", origin: "user" }, NODES);
		const drop = store.appendLink({ from: "n_b", to: "n_c", linkType: "sequence", origin: "user" }, NODES);
		store.appendRemoval(drop.id);

		assert.deepEqual(openStore(dir).readLinks(), [keep]);
	});

	it("refuses an invalid link without writing", () => {
		const dir = tmp();
		const store = openStore(dir);
		assert.throws(
			() => store.appendLink({ from: "n_a", to: "n_x", linkType: "sequence", origin: "user" }, NODES),
			/n_x/,
		);
		assert.equal(fs.existsSync(path.join(dir, "links.jsonl")), false);
	});

	it("refuses a duplicate of an existing undirected link, reversed or not", () => {
		const dir = tmp();
		const store = openStore(dir);
		store.appendLink({ from: "n_a", to: "n_b", linkType: "analogy", origin: "user" }, NODES);
		assert.throws(() => store.appendLink({ from: "n_b", to: "n_a", linkType: "analogy", origin: "user" }, NODES));
		assert.equal(openStore(dir).readLinks().length, 1);
	});

	it("refuses to remove an id that is not a live link", () => {
		const dir = tmp();
		const store = openStore(dir);
		assert.throws(() => store.appendRemoval("link_404"), /link_404/);
	});
});
