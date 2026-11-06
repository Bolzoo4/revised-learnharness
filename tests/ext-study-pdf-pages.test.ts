// tests/ext-study-pdf-pages.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readDocumentPages, splitExtractedPages } from "../src/agent/ext/study/pdf-pages.ts";
import { buildOutlinePdf } from "./helpers/outline-pdf.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-pdf-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, bytes: Uint8Array): string => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, bytes);
	return p;
};

describe("splitExtractedPages", () => {
	it("splits on the page headers and keeps empty pages", () => {
		assert.deepEqual(splitExtractedPages("--- Page 1 ---\nalpha\nbeta\n--- Page 2 ---\n--- Page 3 ---\ngamma"), ["alpha\nbeta", "", "gamma"]);
	});
	it("refuses out-of-order numbering", () => {
		assert.throws(() => splitExtractedPages("--- Page 1 ---\na\n--- Page 3 ---\nb"), /expected page 2, found page 3/);
	});
	it("gives no pages for text without headers", () => {
		assert.deepEqual(splitExtractedPages("No pages selected — page spec matched nothing."), []);
	});
});

describe("readDocumentPages", () => {
	it("returns one text per page and the page count", async () => {
		const pdf = write("a.pdf", buildOutlinePdf(["alpha page", "beta page", "gamma page"]));
		const { pageCount, pages } = await readDocumentPages(pdf);
		assert.equal(pageCount, 3);
		assert.match(pages[0]!, /alpha page/);
		assert.match(pages[2]!, /gamma page/);
	});
	it("gives an empty string for a page without text", async () => {
		const pdf = write("b.pdf", tinyPdf([{ runs: [{ text: "only text page", x: 72, y: 700 }] }, { image: true }]));
		const { pages } = await readDocumentPages(pdf);
		assert.equal(pages.length, 2);
		assert.match(pages[0]!, /only text page/);
		assert.equal(pages[1]!.trim(), "");
	});
	it("throws for a file that is not a PDF", async () => {
		await assert.rejects(readDocumentPages(write("c.pdf", new TextEncoder().encode("not a pdf"))), /Invalid PDF structure/);
	});
});
