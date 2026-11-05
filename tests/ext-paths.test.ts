// tests/ext-paths.test.ts
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { extPathsFor } from "../src/store/ext/paths.ts";

describe("extension paths", () => {
	it("places everything under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		const dir = path.join("/tmp/lh-data", "ext");
		assert.equal(p.dir, dir);
		assert.equal(p.format, path.join(dir, "format.json"));
		assert.equal(p.goals, path.join(dir, "goals.jsonl"));
		assert.equal(p.review, path.join("/tmp/lh-data", "ext", "review.jsonl"));
		assert.equal(p.cards, path.join("/tmp/lh-data", "ext", "cards.jsonl"));
		assert.equal(p.sources, path.join(dir, "sources.json"));
		assert.equal(p.snapshots, path.join(dir, "snapshots"));
		assert.equal(p.verification, path.join(dir, "verification.jsonl"));
		assert.equal(p.cost, path.join(dir, "cost.jsonl"));
	});
});
