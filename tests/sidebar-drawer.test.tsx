import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DrawerBackdrop, SessionRow, SidebarToggle } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

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

const chat: ChatListItem = {
	id: "c1", title: "Test session", kind: "teach", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
	messageCount: 4, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
};

describe("touch targets", () => {
	it("the menu button, the close button and a session row carry the touch class", () => {
		assert.ok(renderToStaticMarkup(<SidebarToggle />).includes("lh-touch"));
		assert.ok(renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />).includes("lh-touch"));
	});
});
