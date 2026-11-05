import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readBookmarks, readChapterText, readPageTexts } from "../src/agent/ext/lecture/pdf-facts.ts";
import { buildOutlinePdf } from "./helpers/outline-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, bytes: Uint8Array): string => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, bytes);
	return p;
};

describe("pdf facts", () => {
	it("reads chapter bookmarks with their pages", async () => {
		const pdf = write("a.pdf", buildOutlinePdf(["intro", "one", "two", "three", "four"], [
			{ title: "Chapter One", page: 2 }, { title: "Chapter Two", page: 4 }, { title: "Chapter Three", page: 5 },
		]));
		const { pageCount, bookmarks } = await readBookmarks(pdf);
		assert.equal(pageCount, 5);
		assert.deepEqual(bookmarks, [{ title: "Chapter One", page: 2 }, { title: "Chapter Two", page: 4 }, { title: "Chapter Three", page: 5 }]);
	});
	it("returns no bookmarks for a PDF without an outline", async () => {
		const pdf = write("b.pdf", buildOutlinePdf(["x", "y"]));
		assert.deepEqual((await readBookmarks(pdf)).bookmarks, []);
	});
	it("reads page texts", async () => {
		const pdf = write("c.pdf", buildOutlinePdf(["alpha page", "beta page"]));
		const pages = await readPageTexts(pdf);
		assert.equal(pages.length, 2);
		assert.match(pages[0]!, /alpha page/);
		assert.match(pages[1]!, /beta page/);
	});
	it("extracts a chapter's plain text without page headers", async () => {
		const pdf = write("d.pdf", buildOutlinePdf(["alpha page", "beta page", "gamma page"]));
		const text = await readChapterText(pdf, { index: 1, title: "t", pageStart: 1, pageEnd: 2 });
		assert.match(text, /alpha page/);
		assert.match(text, /beta page/);
		assert.doesNotMatch(text, /gamma/);
		assert.doesNotMatch(text, /--- Page/);
	});
});
