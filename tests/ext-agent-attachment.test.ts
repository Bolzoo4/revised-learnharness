// tests/ext-agent-attachment.test.ts
/**
 * An attached PDF reaches the notes extractor with its page markers (REQ-graph-agent-12, REQ-02): the text
 * carries one `--- Page N ---` header per page, in the format pdfExtract writes, so the extractor can anchor
 * every proposition to its page. Ports are fakes; the live wiring is agent-goals-live.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importAttachedPdf, withPageMarkers, type AttachmentPorts } from "../src/server/ext/agent-attachment.ts";
import { splitExtractedPages } from "../src/agent/ext/study/pdf-pages.ts";

function fakePorts(pages: string[], overrides: Partial<AttachmentPorts> = {}) {
	const notes: Array<{ storedPath: string; text: string }> = [];
	let released = 0;
	const ports: AttachmentPorts = {
		stageCopy: async () => ({
			path: "/staging/agent-attachment.pdf",
			release: async () => {
				released += 1;
			},
		}),
		storeDocument: async () => "/store/doc.pdf",
		readPages: async () => pages,
		importNotes: async (storedPath, text) => {
			notes.push({ storedPath, text });
		},
		sourceIdOf: () => "src_doc",
		...overrides,
	};
	return { ports, notes, released: () => released };
}

describe("withPageMarkers", () => {
	it("heads every page with `--- Page N ---`, page 1 first, in pdf_extract's format", () => {
		assert.equal(withPageMarkers(["Alpha", "Beta"]), "--- Page 1 ---\nAlpha\n--- Page 2 ---\nBeta");
	});

	it("round-trips through the splitter the study pipeline uses", () => {
		assert.deepEqual(splitExtractedPages(withPageMarkers(["Alpha", "", "Gamma"])), ["Alpha", "", "Gamma"]);
	});
});

describe("importAttachedPdf (REQ-02 page anchors)", () => {
	it("the text the notes extractor receives contains both page markers, in order, with both pages' text", async () => {
		const f = fakePorts(["First page words", "Second page words"]);
		const result = await importAttachedPdf(new Uint8Array([1]), f.ports);
		assert.equal(result.sourceId, "src_doc");
		assert.equal(f.notes.length, 1);
		const text = f.notes[0]!.text;
		const one = text.indexOf("--- Page 1 ---");
		const two = text.indexOf("--- Page 2 ---");
		assert.ok(one >= 0 && two > one, text);
		assert.ok(text.indexOf("First page words") > one && text.indexOf("First page words") < two, text);
		assert.ok(text.indexOf("Second page words") > two, text);
		assert.equal(f.notes[0]!.storedPath, "/store/doc.pdf");
	});

	it("the staged copy is released after success and after a failing extraction", async () => {
		const ok = fakePorts(["one"]);
		await importAttachedPdf(new Uint8Array([1]), ok.ports);
		assert.equal(ok.released(), 1);
		const failing = fakePorts(["one"], {
			importNotes: async () => {
				throw new Error("extraction failed");
			},
		});
		await assert.rejects(importAttachedPdf(new Uint8Array([1]), failing.ports), /extraction failed/);
		assert.equal(failing.released(), 1);
	});
});
