import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDocumentFiles } from "../src/store/ext/documents-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { extStores } from "../src/server/ext/stores.ts";
import { createLedger } from "../src/store/ext/ledger.ts";
import { parseDocumentEvent, type DocumentEvent } from "../src/core/ext/study/documents.ts";
import { parseReadingEvent, type ReadingEvent } from "../src/core/ext/study/reading.ts";
import { parseStudyLinkEvent, type StudyLinkEvent } from "../src/core/ext/study/links.ts";
import { parseDraftEvent, type DraftEvent } from "../src/core/ext/study/drafts.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-docs-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("document files store", () => {
	it("putPdf computes sha256 id, writes documents/<id>.pdf and is idempotent", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const bytes = new TextEncoder().encode("%PDF-1.4 test content");
		const expectedId = createHash("sha256").update(bytes).digest("hex");

		const result1 = files.putPdf(bytes);
		assert.equal(result1.id, expectedId);
		assert.equal(result1.path, path.join(dir, "documents", `${expectedId}.pdf`));
		assert.ok(fs.existsSync(result1.path));
		assert.deepEqual(fs.readFileSync(result1.path), Buffer.from(bytes));

		// Idempotent: repeated call returns identical result without error
		const result2 = files.putPdf(bytes);
		assert.deepEqual(result2, result1);
	});

	it("creates the format stamp on first write and never on read", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const sampleId = "a".repeat(64);

		assert.equal(files.pdfPath(sampleId), null);
		assert.equal(files.getPages(sampleId), null);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false);

		files.putPages(sampleId, ["Page 1 text"]);
		assert.ok(fs.existsSync(path.join(dir, "format.json")));
		const stamp = JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8"));
		assert.equal(stamp.version, CURRENT_EXT_FORMAT_VERSION);
	});

	it("pdfPath validates document id and returns path only if exists", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const bytes = new TextEncoder().encode("another test pdf");
		const { id, path: storedPath } = files.putPdf(bytes);

		assert.equal(files.pdfPath(id), storedPath);

		// Non-existent but valid sha256
		const nonExistentId = "b".repeat(64);
		assert.equal(files.pdfPath(nonExistentId), null);

		// Invalid document ids
		assert.equal(files.pdfPath("../../evil"), null);
		assert.equal(files.pdfPath("not-a-hash"), null);
		assert.equal(files.pdfPath(""), null);
		assert.equal(files.pdfPath("a".repeat(63)), null);
		assert.equal(files.pdfPath("a".repeat(65)), null);
	});

	it("putPages and getPages round-trip page contents atomically", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const id = "c".repeat(64);
		const pages = ["First page content", "Second page content", "Third page"];

		files.putPages(id, pages);
		assert.deepEqual(files.getPages(id), pages);
	});

	it("putPages throws on invalid document id", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);

		assert.throws(() => files.putPages("../../bad-id", ["text"]), /invalid document id/);
		assert.throws(() => files.putPages("short", ["text"]), /invalid document id/);
	});

	it("getPages returns null on missing, invalid id, or corrupt/invalid data", () => {
		const dir = tmp();
		const files = createDocumentFiles(dir);
		const id = "d".repeat(64);

		// Missing file
		assert.equal(files.getPages(id), null);

		// Invalid id
		assert.equal(files.getPages("../passwd"), null);

		// Corrupt JSON
		const docsDir = path.join(dir, "documents");
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(path.join(docsDir, `${id}.pages.json`), "{broken json");
		assert.equal(files.getPages(id), null);

		// Invalid JSON shape (not an array of strings)
		fs.writeFileSync(path.join(docsDir, `${id}.pages.json`), JSON.stringify({ not: "an array" }));
		assert.equal(files.getPages(id), null);

		fs.writeFileSync(path.join(docsDir, `${id}.pages.json`), JSON.stringify([1, 2, 3]));
		assert.equal(files.getPages(id), null);
	});

	it("throws when stamped with a format version newer than this build", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		const files = createDocumentFiles(dir);
		const id = "e".repeat(64);

		assert.throws(() => files.putPdf(new Uint8Array([1, 2, 3])), /format version/);
		assert.throws(() => files.pdfPath(id), /format version/);
		assert.throws(() => files.putPages(id, ["text"]), /format version/);
		assert.throws(() => files.getPages(id), /format version/);
	});
});

describe("study ledgers wiring in extStores", () => {
	it("extStores exports the four study ledgers and documentFiles", () => {
		assert.ok(extStores.documentsLedger);
		assert.ok(extStores.readingLedger);
		assert.ok(extStores.studyLinksLedger);
		assert.ok(extStores.studyDraftsLedger);
		assert.ok(extStores.documentFiles);
	});

	it("documentsLedger validates and records document events", () => {
		const dir = tmp();
		const ledger = createLedger<DocumentEvent>(dir, "documents.jsonl", parseDocumentEvent);
		const id = "f".repeat(64);
		const at = "2026-11-05T00:00:00.000Z";

		ledger.append({ type: "registered", documentId: id, title: "Test Doc", pageCount: 10, at });
		ledger.append({ type: "chat", documentId: id, chatId: "chat_1", at });

		assert.deepEqual(ledger.readAll(), [
			{ type: "registered", documentId: id, title: "Test Doc", pageCount: 10, at },
			{ type: "chat", documentId: id, chatId: "chat_1", at },
		]);

		assert.throws(() => ledger.append({ type: "registered", documentId: "bad", title: "", pageCount: 0, at } as any), /rejected/);
	});

	it("readingLedger validates and records reading events", () => {
		const dir = tmp();
		const ledger = createLedger<ReadingEvent>(dir, "reading.jsonl", parseReadingEvent);
		const id = "1".repeat(64);
		const at = "2026-11-05T00:00:00.000Z";

		ledger.append({ type: "visit", documentId: id, page: 1, at });
		ledger.append({ type: "close", documentId: id, at });

		assert.deepEqual(ledger.readAll(), [
			{ type: "visit", documentId: id, page: 1, at },
			{ type: "close", documentId: id, at },
		]);

		assert.throws(() => ledger.append({ type: "visit", documentId: id, page: -1, at } as any), /rejected/);
	});

	it("studyLinksLedger validates and records link events", () => {
		const dir = tmp();
		const ledger = createLedger<StudyLinkEvent>(dir, "study-links.jsonl", parseStudyLinkEvent);
		const docId = "2".repeat(64);
		const at = "2026-11-05T00:00:00.000Z";

		ledger.append({ type: "link", nodeId: "node_1", documentId: docId, page: 2, at });

		assert.deepEqual(ledger.readAll(), [{ type: "link", nodeId: "node_1", documentId: docId, page: 2, at }]);

		assert.throws(() => ledger.append({ type: "link", nodeId: "", documentId: docId, page: 0, at } as any), /rejected/);
	});

	it("studyDraftsLedger validates and records draft events", () => {
		const dir = tmp();
		const ledger = createLedger<DraftEvent>(dir, "study-drafts.jsonl", parseDraftEvent);
		const docId = "3".repeat(64);
		const at = "2026-11-05T00:00:00.000Z";

		ledger.append({
			type: "proposed",
			draftId: "draft_1",
			documentId: docId,
			page: 1,
			proposition: "Fact 1",
			question: "Q1?",
			answer: "A1",
			at,
		});
		ledger.append({ type: "decided", draftId: "draft_1", decision: "approved", at });
		ledger.append({ type: "pages_processed", documentId: docId, pages: [1, 2], at });

		assert.deepEqual(ledger.readAll(), [
			{
				type: "proposed",
				draftId: "draft_1",
				documentId: docId,
				page: 1,
				proposition: "Fact 1",
				question: "Q1?",
				answer: "A1",
				at,
			},
			{ type: "decided", draftId: "draft_1", decision: "approved", at },
			{ type: "pages_processed", documentId: docId, pages: [1, 2], at },
		]);

		assert.throws(() => ledger.append({ type: "decided", draftId: "draft_1", decision: "maybe" as any, at }), /rejected/);
	});
});
