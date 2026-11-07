// tests/ext-study-view-ui.test.tsx
// The study view's layout rules in the DOM: the action rail beside the pages, the keyboard divider,
// the closed chat with its reopen control, and the persisted layout.
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StudyView } from "../components/ext/study-view.tsx";
import { LAYOUT_KEY } from "../components/ext/study-logic.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

// The divider's pixel rules need a width; linkedom has no layout, so every element reports this one.
const WIDTH = 1200;
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => WIDTH });

/** In-memory localStorage: the view reads and writes the layout through window.localStorage. */
let store = new Map<string, string>();
Object.defineProperty(dom.window, "localStorage", {
	configurable: true,
	get: () => ({
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	}),
});

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
	store = new Map();
	globalThis.fetch = ((url: string) => {
		if (String(url).includes("/drafts")) return Promise.resolve(Response.json({ drafts: [] }));
		return Promise.resolve(new Response(null, { status: 404 }));
	}) as typeof fetch;
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
		root!.render(
			<StudyView
				document={{ id: "doc1", title: "Analysis book", pageCount: 12 }}
				startPage={3}
				chat={{ chatId: "chat_1", title: "Chat title", initialMessages: [], initialError: undefined, initialConfigured: false, initiallyInFlight: false, initiallyCompacting: false }}
				renderChat={(p) => <p data-testid="stand-in-chat">{p.chatId}</p>}
			/>,
		);
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const divider = () => document.querySelector<HTMLElement>('[role="separator"]');

async function key(el: HTMLElement, k: string) {
	await act(async () => {
		const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
		Object.defineProperty(ev, "key", { value: k });
		el.dispatchEvent(ev);
	});
}

it("the actions sit in a rail beside the pages, never inside the page area", async () => {
	await mount();
	const rail = q('nav[aria-label="Study actions"]');
	assert.ok(rail, "rail rendered");
	for (const name of ["Card from selection", "Card from page", "Write a card", "Complete", "Goal and review"]) {
		assert.ok(rail!.querySelector(`[aria-label="${name}"]`), `rail has ${name}`);
	}
	assert.equal(rail!.closest('[data-testid="pdf-viewer"]'), null, "the rail is not inside the scrolling page area");
	assert.equal(q('[data-testid="pdf-viewer"]')?.querySelector('[aria-label="Card from page"]') ?? null, null);
});

it("the document title is not repeated in the study view (the page header shows it)", async () => {
	await mount();
	const text = q('[data-testid="study-view"]')?.textContent ?? "";
	assert.ok(!text.includes("Analysis book"), "the title is not in the study view");
});

it("the divider is a focusable separator with its value, and arrow keys resize it in steps", async () => {
	await mount();
	const sep = divider();
	assert.ok(sep, "separator rendered");
	assert.equal(sep!.getAttribute("aria-orientation"), "vertical");
	assert.equal(sep!.getAttribute("tabindex"), "0");
	assert.equal(sep!.getAttribute("aria-valuenow"), "60");
	assert.equal(sep!.getAttribute("aria-valuemin"), String(Math.round((320 / WIDTH) * 100)));
	assert.equal(sep!.getAttribute("aria-valuemax"), String(Math.round((1 - 320 / WIDTH) * 100)));
	await key(sep!, "ArrowRight");
	assert.equal(divider()!.getAttribute("aria-valuenow"), "62");
	await key(divider()!, "ArrowLeft");
	await key(divider()!, "ArrowLeft");
	assert.equal(divider()!.getAttribute("aria-valuenow"), "58");
	await key(divider()!, "End");
	assert.equal(divider()!.getAttribute("aria-valuenow"), String(Math.round((1 - 320 / WIDTH) * 100)));
	await key(divider()!, "Home");
	assert.equal(divider()!.getAttribute("aria-valuenow"), String(Math.round((320 / WIDTH) * 100)));
});

it("the keyboard resize is kept per browser", async () => {
	await mount();
	await key(divider()!, "ArrowRight");
	const saved = JSON.parse(store.get(LAYOUT_KEY) ?? "null") as { ratio: number; chatOpen: boolean };
	assert.ok(Math.abs(saved.ratio - 0.62) < 1e-9);
	assert.equal(saved.chatOpen, true);
});

it("a double click on the divider resets the ratio to the default", async () => {
	await mount();
	await key(divider()!, "ArrowRight");
	await key(divider()!, "ArrowRight");
	await act(async () => {
		divider()!.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
	});
	assert.equal(divider()!.getAttribute("aria-valuenow"), "60");
});

it("closing the chat gives the PDF the whole width, and a visible control reopens it", async () => {
	await mount();
	assert.ok(byLabel("Close the chat"), "close control is visible while the chat is open");
	await act(async () => byLabel("Close the chat")!.click());
	assert.equal(divider(), null, "no divider while the chat is closed");
	assert.ok(q('section[aria-label="Chat"].hidden'), "the chat is hidden, not removed");
	assert.ok(q('section[aria-label="Chat"]'), "the chat's section stays mounted");
	const reopen = byLabel("Open the chat");
	assert.ok(reopen, "reopen control is visible");
	assert.equal(JSON.parse(store.get(LAYOUT_KEY)!).chatOpen, false, "the closed state is kept");
	await act(async () => reopen!.click());
	assert.ok(divider(), "divider back when the chat is open");
	assert.ok(!q('section[aria-label="Chat"]')!.classList.contains("hidden"));
	assert.equal(JSON.parse(store.get(LAYOUT_KEY)!).chatOpen, true);
});

it("a closed chat is restored closed on the next visit", async () => {
	store.set(LAYOUT_KEY, JSON.stringify({ ratio: 0.45, chatOpen: false }));
	await mount();
	assert.equal(divider(), null);
	assert.ok(byLabel("Open the chat"));
});

it("unreadable saved layout renders the defaults", async () => {
	store.set(LAYOUT_KEY, "{not json");
	await mount();
	assert.equal(divider()!.getAttribute("aria-valuenow"), "60");
	assert.ok(q('section[aria-label="Chat"]:not(.hidden)'));
});

it("Goal and review opens the panel with the goal form and the review checkbox", async () => {
	await mount();
	assert.equal(document.querySelector('aside[aria-label="Goal and review"]'), null);
	await act(async () => byLabel("Goal and review")!.click());
	const panel = document.querySelector('aside[aria-label="Goal and review"]');
	assert.ok(panel, "panel open");
	assert.ok(panel!.textContent?.includes("Add to my review"));
	assert.ok(panel!.textContent?.includes("Start a goal from this document"));
});
