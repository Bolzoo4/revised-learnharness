// The graph legend lists only the link types present on the canvas.
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkLegend } from "../components/link-legend.tsx";

describe("LinkLegend", () => {
	it("shows an entry for each present type and none for an absent one", () => {
		const html = renderToStaticMarkup(createElement(LinkLegend, { types: ["evolution", "contrast"] }));
		assert.ok(html.includes('data-link-type="evolution"'));
		assert.ok(html.includes('data-link-type="contrast"'));
		assert.ok(!html.includes('data-link-type="sequence"'), "an absent type must not appear");
	});

	it("renders nothing when no link type is present", () => {
		assert.equal(renderToStaticMarkup(createElement(LinkLegend, { types: [] })), "");
	});
});
