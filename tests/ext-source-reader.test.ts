// tests/ext-source-reader.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createSourceReader } from "../src/agent/ext/source-reader.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-reader-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pdfPath = path.join(dir, "book.pdf");
fs.writeFileSync(pdfPath, tinyPdf([{ runs: [{ text: "The orthogonal complement theorem holds in every Hilbert space.", x: 72, y: 700 }] }]));

describe("source reader", () => {
	it("reads a library PDF through upstream's pdf tools and strips page markers", async () => {
		const reader = createSourceReader({ allowedPdfPaths: () => [pdfPath] });
		const text = await reader.read(pdfPath);
		assert.match(text ?? "", /orthogonal complement theorem holds in every Hilbert space/);
		assert.ok(!(text ?? "").includes("--- Page"), "page markers are removed so quotes can span pages");
	});

	it("refuses a local path that is not a library PDF", async () => {
		const reader = createSourceReader({ allowedPdfPaths: () => [] });
		assert.equal(await reader.read(pdfPath), null);
		assert.equal(await reader.read("/etc/passwd"), null);
	});

	it("fetches a plain-text URL with the same web_fetch the verifier used", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("The sum of the angles of a triangle is 180 degrees.", { headers: { "content-type": "text/plain" } })) as typeof fetch;
		try {
			const text = await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/t");
			assert.match(text ?? "", /sum of the angles of a triangle is 180 degrees/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("returns null for a failed fetch", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch;
		try {
			assert.equal(await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/missing"), null);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("downloads and extracts a remote PDF when web_fetch points at one", async () => {
		const realFetch = globalThis.fetch;
		const bytes = tinyPdf([{ runs: [{ text: "A remote paper states the compactness lemma clearly.", x: 72, y: 700 }] }]);
		globalThis.fetch = (async () => new Response(bytes.slice().buffer as ArrayBuffer, { headers: { "content-type": "application/pdf" } })) as typeof fetch;
		try {
			const text = await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/paper.pdf");
			assert.match(text ?? "", /compactness lemma clearly/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("rejects non-http schemes", async () => {
		assert.equal(await createSourceReader({ allowedPdfPaths: () => [] }).read("ftp://example.org/x"), null);
	});
});
