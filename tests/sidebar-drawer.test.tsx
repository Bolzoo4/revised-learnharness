import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DrawerBackdrop, SidebarToggle } from "../components/sidebar.tsx";

describe("DrawerBackdrop", () => {
	it("is a full-screen button that names its action", () => {
		const html = renderToStaticMarkup(<DrawerBackdrop onClose={() => {}} />);
		assert.ok(html.includes("<button"), html);
		assert.ok(html.includes('aria-label="Close menu"'), html);
		assert.ok(html.includes("fixed") && html.includes("inset-0"), html);
	});
});

describe("SidebarToggle", () => {
	it("is rendered with the default (closed) sidebar, so a phone page header shows the menu button", () => {
		const html = renderToStaticMarkup(<SidebarToggle />);
		assert.ok(html.includes("Open sidebar"), html);
		assert.ok(!html.includes("w-0 -mr-3"), "closed: the toggle owns a visible slot");
	});
});
