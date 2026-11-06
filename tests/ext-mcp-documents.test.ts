// tests/ext-mcp-documents.test.ts
/** list_documents (REQ-mcp-14). Needs src/core/ext/study/documents.ts and reading.ts from the assisted-study plan. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { cleanupAllFixtures, makeFixture } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("list_documents (REQ-mcp-14)", () => {
	const A = "a".repeat(64);
	const B = "b".repeat(64);

	it("lists title, page count and reading progress, newest registration first, without chat ids", () => {
		const f = makeFixture();
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "Probability", pageCount: 10, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: B, title: "Algebra", pageCount: 4, at: "2026-11-02T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "chat", documentId: A, chatId: "chat_secret_1", at: "2026-11-01T10:05:00.000Z" });
		for (const [page, at] of [[1, "10:00:00"], [2, "10:00:10"], [3, "10:00:12"], [2, "10:00:14"]] as const) {
			f.ext("reading.jsonl", { type: "visit", documentId: A, page, at: `2026-11-03T${at}.000Z` });
		}
		f.ext("reading.jsonl", { type: "close", documentId: A, at: "2026-11-03T10:02:00.000Z" });
		const r = call(f, "list_documents");
		assert.deepEqual(r.items.map((d: { title: string }) => d.title), ["Algebra", "Probability"]);
		const prob = r.items[1];
		assert.equal(prob.pageCount, 10);
		assert.equal(prob.lastPage, 2);
		assert.equal(prob.readPages, 2, "pages 1 and 2 dwelt long enough; page 3 only 2 seconds");
		assert.equal(prob.readShare, 0.2);
		assert.equal(r.items[0].lastPage, null);
		assert.equal(r.items[0].readShare, 0);
		const text = JSON.stringify(r);
		assert.ok(!text.includes("chat_secret_1") && !text.includes("chatId"));
	});

	it("empty, corrupt and duplicate registrations", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "list_documents"), { items: [], count: 0, truncated: false });
		f.ext("documents.jsonl", "garbage");
		f.ext("documents.jsonl", { type: "registered", documentId: "short", title: "x", pageCount: 3, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "First", pageCount: 3, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "Second", pageCount: 99, at: "2026-11-02T10:00:00.000Z" });
		f.ext("reading.jsonl", { type: "visit", documentId: A, page: 99, at: "2026-11-03T10:00:00.000Z" });
		const r = call(f, "list_documents");
		assert.equal(r.count, 1);
		assert.equal(r.items[0].title, "First");
		assert.equal(r.items[0].lastPage, null, "a page beyond the page count is ignored");
	});

	it("is bounded and disabled by --knowledge-only", () => {
		const f = makeFixture();
		for (let i = 0; i < 130; i++) {
			f.ext("documents.jsonl", { type: "registered", documentId: i.toString(16).padStart(64, "0"), title: `Doc ${i}`, pageCount: 5, at: `2026-11-01T10:${String(i % 60).padStart(2, "0")}:00.000Z` });
		}
		const r = call(f, "list_documents");
		assert.equal(r.count, LIMITS.documentsMax);
		assert.equal(r.truncated, true);
		expectError(f, "list_documents", {}, "disabled", true);
	});
});
