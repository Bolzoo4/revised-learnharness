// tests/ext-page-shell.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ExtPageShell } from "../components/ext/ext-page-shell.tsx";

const ROOT = join(import.meta.dirname, "..");

function render(el: React.ReactElement): Document {
	return parseHTML(`<html><body>${renderToStaticMarkup(el)}</body></html>`).document as unknown as Document;
}

it("renders the upstream sidebar toggle and the page title in the top bar", () => {
	const doc = render(<ExtPageShell title="Research">body</ExtPageShell>);
	const header = doc.querySelector("header");
	assert.ok(header, "the TopBar header is rendered");
	assert.ok(header.querySelector("[aria-label='Open sidebar']"), "the reopen toggle is in the bar");
	assert.equal(header.querySelector("h1")?.textContent, "Research");
});

it("renders the description under the title and the children in the body", () => {
	const doc = render(
		<ExtPageShell title="Study" description="Read your own PDFs.">
			<p data-testid="child">child</p>
		</ExtPageShell>,
	);
	const main = doc.querySelector("main");
	assert.ok(main, "the body is a main landmark");
	assert.equal(main.querySelector("p")?.textContent, "Read your own PDFs.");
	assert.ok(main.querySelector("[data-testid='child']"));
	assert.ok(main.className.includes("max-w-3xl"), "default column width");
});

it("wide pages use the wider column; fill pages drop the padded main", () => {
	assert.ok(render(<ExtPageShell title="x" wide>b</ExtPageShell>).querySelector("main")!.className.includes("max-w-5xl"));
	const fill = render(<ExtPageShell title="x" fill><p data-testid="inner">b</p></ExtPageShell>);
	assert.equal(fill.querySelector("main"), null);
	assert.ok(fill.querySelector("[data-testid='inner']"));
});

it("every learning page module uses the shell with its title", () => {
	const pages: Record<string, string> = {
		"app/practice/page.tsx": "Practice",
		"app/lectures/page.tsx": "Lectures",
		"app/lectures/[id]/page.tsx": "lecture.bookTitle",
		"app/study/page.tsx": "Study",
		"app/study/[documentId]/page.tsx": "fill",
		"app/research/page.tsx": "Research",
		"app/journal/page.tsx": "Journal",
	};
	for (const [file, marker] of Object.entries(pages)) {
		const src = readFileSync(join(ROOT, file), "utf8");
		assert.ok(src.includes('from "@/components/ext/ext-page-shell"'), `${file} imports the shell`);
		assert.ok(src.includes("<ExtPageShell"), `${file} renders the shell`);
		assert.ok(!/<h1[\s>]/.test(src) || src.includes("ExtPageShell"), `${file} has no bare page header`);
		assert.ok(src.includes(marker), `${file} names its title (${marker})`);
	}
});
