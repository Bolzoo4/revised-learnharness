// tests/ext-journal-ui.test.tsx
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { JournalView } from "../components/ext/journal-view.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: Route = () => Response.json({ entries: [], open: [] });
const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
	globalThis.fetch = ((url: string, init?: RequestInit) => Promise.resolve(route(String(url), init))) as typeof fetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	globalThis.fetch = realFetch;
});

async function mount() {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<JournalView />);
	});
	// Let the mount-time sweep and refresh settle.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}
const text = () => document.body.textContent ?? "";
const endButton = () => [...document.querySelectorAll("button")].find((b) => /End and debrief|Working/.test(b.textContent ?? "")) ?? null;

const OPEN = [{ sessionId: "chat_a", kind: "review", title: "Review", lastActivityAt: "2026-11-04T10:00:00.000Z" }];

it("a failed end request shows a fixed notice and the button is usable again", async () => {
	route = (url, init) => {
		if (url.endsWith("/api/ext/debriefs/end")) {
			assert.equal(init?.method, "POST");
			return Promise.reject(new TypeError("network down"));
		}
		return Response.json({ entries: [], open: OPEN });
	};
	await mount();
	await act(async () => endButton()!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
	assert.ok(text().includes("Request failed."), "fixed notice shown");
	assert.ok(!text().includes("network down"), "the raw error is not shown");
	assert.equal(endButton()?.textContent, "End and debrief", "busy reset");
});

it("a server error body never reaches the page: only the fixed notice", async () => {
	route = (url) => {
		if (url.endsWith("/api/ext/debriefs/end")) return Response.json({ error: "SECRET internal detail" }, { status: 500 });
		return Response.json({ entries: [], open: OPEN });
	};
	await mount();
	await act(async () => endButton()!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
	assert.ok(!text().includes("SECRET"), "server text not shown");
	assert.ok(text().includes("Request failed."));
});

it("a failed list is an error, not an empty history, and a rejected sweep is survivable", async () => {
	route = (url) => {
		if (url.endsWith("/api/ext/debriefs/sweep")) return Promise.reject(new TypeError("offline"));
		return new Response("boom", { status: 500 });
	};
	await mount();
	assert.ok(text().includes("The history could not be loaded. Try again."));
	assert.ok(!text().includes("No debrief yet."), "an error is not shown as an empty history");
});

it("a list that is truncated says so", async () => {
	route = () => Response.json({ entries: [], open: [], truncated: true });
	await mount();
	assert.ok(text().includes("Showing newest 50."));
	route = () => Response.json({ entries: [], open: [], truncated: false });
});

it("an empty history that loaded fine says no debrief yet", async () => {
	route = () => Response.json({ entries: [], open: [] });
	await mount();
	assert.ok(text().includes("No debrief yet."));
	assert.ok(!text().includes("could not be loaded"));
});
