// tests/ext-nav.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { EXT_NAV_ITEMS, ExtNavList, isExtNavActive } from "../components/ext/ext-nav.tsx";

/** Server-render the list for a pathname and parse it, so the assertions read the real markup. */
function render(pathname: string | null): Document {
	const html = renderToStaticMarkup(<ExtNavList pathname={pathname} />);
	return parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}
const anchors = (doc: Document) => [...doc.querySelectorAll("nav[data-testid='ext-nav'] a")] as HTMLAnchorElement[];
const link = (doc: Document, label: string) => anchors(doc).find((a) => a.textContent === label);

it("renders the five learning pages as real links with the right hrefs", () => {
	const doc = render("/");
	assert.deepEqual(
		anchors(doc).map((a) => [a.textContent, a.getAttribute("href")]),
		[["Review", "/review"], ["Lectures", "/lectures"], ["Study", "/study"], ["Research", "/research"], ["Journal", "/journal"]],
	);
});

it("every row carries one decorative svg icon, hidden from assistive tech, beside the label", () => {
	const doc = render("/");
	for (const a of anchors(doc)) {
		const svgs = a.querySelectorAll("svg");
		assert.equal(svgs.length, 1, `${a.textContent} has one icon`);
		assert.equal(svgs[0]!.getAttribute("aria-hidden"), "true", `${a.textContent} icon is decorative`);
		assert.equal(svgs[0]!.previousElementSibling, null, "the icon comes before the label");
	}
	assert.ok(EXT_NAV_ITEMS.every((i) => i.icon !== undefined), "every entry names its icon");
});

it("no entry duplicates another: one row per page and one label per row", () => {
	const hrefs = EXT_NAV_ITEMS.map((i) => i.href);
	assert.equal(new Set(hrefs).size, hrefs.length);
	assert.equal(new Set(EXT_NAV_ITEMS.map((i) => i.label)).size, EXT_NAV_ITEMS.length);
});

it("highlights only the entry of the current page, with aria-current", () => {
	const doc = render("/study");
	assert.equal(link(doc, "Study")?.getAttribute("aria-current"), "page");
	assert.equal(link(doc, "Journal")?.hasAttribute("aria-current"), false);
	assert.equal(link(doc, "Review")?.hasAttribute("aria-current"), false);
	// Exact class tokens: "hover:bg-accent" is on every row and must not count as the active look.
	const tokens = (doc2: HTMLAnchorElement | undefined) => (doc2?.getAttribute("class") ?? "").split(/\s+/);
	assert.ok(tokens(link(doc, "Study")).includes("bg-accent"), "active row carries the active background");
	assert.ok(tokens(link(doc, "Study")).includes("text-foreground"));
	assert.ok(!tokens(link(doc, "Journal")).includes("bg-accent"), "inactive row does not");
	assert.ok(tokens(link(doc, "Journal")).includes("text-muted-foreground"));
});

it("a sub-page keeps its parent entry active (/lectures/[id], /study/[documentId])", () => {
	const doc = render("/lectures/abc");
	assert.equal(link(doc, "Lectures")?.getAttribute("aria-current"), "page");
	assert.equal(isExtNavActive("/study/doc-1", "/study"), true);
	assert.equal(isExtNavActive("/studyguide", "/study"), false, "a prefix of a word is not the page");
});

it("the Review entry points at the flashcard page and is active there", () => {
	assert.equal(EXT_NAV_ITEMS.find((i) => i.label === "Review")?.href, "/review");
	assert.equal(link(render("/review"), "Review")?.getAttribute("aria-current"), "page");
	assert.equal(link(render("/practice"), "Review")?.hasAttribute("aria-current"), false, "office hours is not the Review page");
});

it("no entry is active on the home page or on an unknown pathname", () => {
	assert.equal(render("/").querySelectorAll("[aria-current]").length, 0);
	assert.equal(render(null).querySelectorAll("[aria-current]").length, 0);
	assert.equal(isExtNavActive(null, "/research"), false);
});
