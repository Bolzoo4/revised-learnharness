// tests/ext-post-merge.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { withPostMerge } from "../src/server/ext/post-merge.ts";

function fakePipeline(stats: { nodes: number; chains?: number }, fail = false): ExtractionPipeline {
	return {
		runExtraction: async () => { if (fail) throw new Error("extraction failed"); return stats; },
		importNotes: async () => { if (fail) throw new Error("import failed"); return stats; },
	};
}
const tick = () => new Promise((r) => setImmediate(r));

describe("withPostMerge", () => {
	it("fires the hook after a merge that added nodes, for chat runs and notes imports", async () => {
		let calls = 0;
		const p = withPostMerge(fakePipeline({ nodes: 2 }), async () => void calls++, { enabled: true });
		assert.deepEqual(await p.runExtraction("c1"), { nodes: 2 });
		await p.importNotes({ filePath: "/a.md", text: "x" });
		await tick();
		assert.equal(calls, 2);
	});
	it("does not fire when nothing new was merged or the run failed", async () => {
		let calls = 0;
		const none = withPostMerge(fakePipeline({ nodes: 0, chains: 3 }), async () => void calls++, { enabled: true });
		await none.runExtraction("c1");
		const failing = withPostMerge(fakePipeline({ nodes: 1 }, true), async () => void calls++, { enabled: true });
		await assert.rejects(failing.runExtraction("c1"));
		await tick();
		assert.equal(calls, 0);
	});
	it("a failing hook never fails the extraction", async () => {
		const p = withPostMerge(fakePipeline({ nodes: 1 }), async () => { throw new Error("hook boom"); }, { enabled: true, log: () => {} });
		assert.deepEqual(await p.runExtraction("c1"), { nodes: 1 });
		await tick();
	});
	it("is inert when disabled (tests and the master switch)", async () => {
		let calls = 0;
		const p = withPostMerge(fakePipeline({ nodes: 5 }), async () => void calls++, { enabled: false });
		await p.runExtraction("c1");
		await tick();
		assert.equal(calls, 0);
	});
});
