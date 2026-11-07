// tests/ext-pdf-chooser-ui.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfChooser } from "../components/ext/pdf-chooser.tsx";
import { StudyHome } from "../components/ext/study-home.tsx";
import { LecturesPanel } from "../components/ext/lectures-panel.tsx";

describe("the PDF chooser on the study and lectures pages", () => {
	it("the study page offers a file button, a drop zone and a title field", () => {
		const html = renderToStaticMarkup(<StudyHome initial={[]} />);
		assert.match(html, /Choose a PDF/);
		assert.match(html, /Drop a PDF here/);
		assert.match(html, /type="file"/);
		assert.match(html, /accept="application\/pdf,\.pdf"/);
		assert.match(html, /Title \(optional; the file name is used when empty\)/);
	});

	it("the study page keeps the typed path as a fallback under a details element", () => {
		const html = renderToStaticMarkup(<StudyHome initial={[]} />);
		assert.match(html, /<details/);
		assert.match(html, /Or paste a path/);
		assert.match(html, /placeholder="\/Users\/you\/Books\/probability\.pdf"/);
	});

	it("the lectures page offers the same chooser and keeps the path fallback", () => {
		const html = renderToStaticMarkup(<LecturesPanel />);
		assert.match(html, /Choose a PDF/);
		assert.match(html, /Drop a PDF here/);
		assert.match(html, /<details/);
		assert.match(html, /Or paste a path/);
		assert.match(html, /placeholder="\/absolute\/path\/to\/book\.pdf"/);
	});

	it("while busy the chooser says so and disables the file input", () => {
		const busy = renderToStaticMarkup(<PdfChooser busy={true} onPick={() => {}} onError={() => {}} />);
		assert.match(busy, /Reading the PDF/);
		assert.match(busy, /disabled=""/);
		const idle = renderToStaticMarkup(<PdfChooser busy={false} onPick={() => {}} onError={() => {}} />);
		assert.match(idle, /Drop a PDF here/);
		assert.doesNotMatch(idle, /disabled=""/);
	});
});
