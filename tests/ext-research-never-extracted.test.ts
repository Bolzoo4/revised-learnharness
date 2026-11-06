// tests/ext-research-never-extracted.test.ts
/**
 * A research session is never extracted (review of 88cdf75 + dbe0234, item 1):
 * the pipeline refuses to read it, and the manual coverage route answers 400.
 * Practice-like kinds share the guard (isPracticeLike), as they write nothing to the graph.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as ext-research-live.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-research-never-extracted-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
const { POST } = await import("../app/api/graph/coverage/extract/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** No engines configured and an empty ledger: any run that reads the chat refuses with ModelsNotConfiguredError. */
const pipeline = () =>
	createExtractionPipeline({ chatStore, graphStore: { readCoverage: () => [] } as never } as never);

describe("a research session is never extracted", () => {
	it("the pipeline answers a research chat with an empty run, before any model is needed", async () => {
		const research = chatStore.createChat("Research", "research");
		assert.deepEqual(await pipeline().runExtraction(research.id), { nodes: 0, chains: 0 });
	});

	it("practice-like kinds are never extracted either (same guard)", async () => {
		const practice = chatStore.createChat("Practice", "practice");
		assert.deepEqual(await pipeline().runExtraction(practice.id), { nodes: 0, chains: 0 });
	});

	it("control: a teach chat with no model configured still refuses, so the guard above is the reason", async () => {
		const teach = chatStore.createChat("Teach");
		await assert.rejects(pipeline().runExtraction(teach.id), ModelsNotConfiguredError);
	});

	it("the manual coverage route answers 400 with a fixed message for a research chat, and starts no run", async () => {
		const research = chatStore.createChat("Research", "research");
		const res = await POST(
			new Request("http://localhost/api/graph/coverage/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: research.id }),
			}),
		);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "this session is not extracted" });
	});
});
