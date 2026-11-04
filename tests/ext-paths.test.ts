// tests/ext-paths.test.ts
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { extPathsFor } from "../src/store/ext/paths.ts";

describe("extension paths", () => {
	it("places everything under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		assert.equal(p.dir, path.join("/tmp/lh-data", "ext"));
		assert.equal(p.format, path.join("/tmp/lh-data", "ext", "format.json"));
		assert.equal(p.goals, path.join("/tmp/lh-data", "ext", "goals.jsonl"));
	});
});
