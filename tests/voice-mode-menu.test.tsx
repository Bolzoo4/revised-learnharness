// tests/voice-mode-menu.test.tsx
// The session's overflow menu (REQ-chat-tts-08): voice mode is a menu item inside it, never a control in the composer.
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { SpeechPlayer } from "../components/use-speech-player.ts";

const CHAT = "chat_1";
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

/** A player stand-in that records the unlock and its order against the request. */
function fakePlayer(log: string[]): SpeechPlayer {
	return {
		snapshot: () => ({ states: {}, unavailable: false }),
		subscribe: () => () => undefined,
		play: async () => undefined,
		stop: () => undefined,
		unlock: () => void log.push("unlock"),
	};
}

async function mount(opts: { voiceMode: boolean; putOk?: boolean; log: string[] }) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const requests: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetchFn = async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		opts.log.push(`${method} ${url}`);
		if (method === "PUT") return opts.putOk === false ? new Response("{}", { status: 500 }) : Response.json({ voiceMode: true });
		return Response.json({ id: CHAT, voiceMode: opts.voiceMode, messages: [] });
	};
	const globals: Record<string, unknown> = {
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchFn,
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0), cancelAnimationFrame: clearTimeout,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(globals)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const { SessionOverflowMenu } = await import("../components/session-overflow-menu.tsx");
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => {
		root.render(<SessionOverflowMenu chatId={CHAT} player={fakePlayer(opts.log)} />);
	});
	dispose = () => {
		act(() => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const q = <T extends Element = HTMLElement>(sel: string) => doc.querySelector<T>(sel);
	const open = async () => {
		await act(async () => q<HTMLButtonElement>('[aria-label="More session options"]')!.click());
	};
	return { q, open, requests, doc };
}

describe("session overflow menu", () => {
	it("is a button in the header; voice mode is not in the menu until it is opened", async () => {
		const { q } = await mount({ voiceMode: false, log: [] });
		assert.ok(q('[aria-label="More session options"]'));
		assert.equal(q('[role="menuitemcheckbox"]'), null);
		assert.equal(q('[role="menu"]'), null);
	});

	it("opened, it offers Voice mode as the one checkbox item, reflecting the session's flag", async () => {
		const { q, open } = await mount({ voiceMode: false, log: [] });
		await open();
		const item = q('[role="menu"] [role="menuitemcheckbox"]');
		assert.ok(item, "the voice mode item is inside the menu");
		assert.equal(item!.textContent?.trim(), "Voice mode");
		assert.equal(item!.getAttribute("aria-checked"), "false");
	});

	it("turning it on unlocks the audio inside the click, then saves the flag", async () => {
		const log: string[] = [];
		const { q, open, requests } = await mount({ voiceMode: false, log });
		await open();
		await act(async () => q<HTMLButtonElement>('[role="menuitemcheckbox"]')!.click());
		assert.equal(log[0], `GET /api/chats/${CHAT}`, "the state is read when the menu opens");
		assert.equal(log.includes("unlock"), true);
		assert.ok(log.indexOf("unlock") < log.indexOf(`PUT /api/chats/${CHAT}/voice-mode`), "unlock comes before the save");
		assert.deepEqual(requests.at(-1), { method: "PUT", url: `/api/chats/${CHAT}/voice-mode`, body: { voiceMode: true } });
		assert.equal(q('[role="menuitemcheckbox"]')!.getAttribute("aria-checked"), "true");
	});

	it("a failed save puts the item back and says so", async () => {
		const { q, open } = await mount({ voiceMode: false, putOk: false, log: [] });
		await open();
		await act(async () => q<HTMLButtonElement>('[role="menuitemcheckbox"]')!.click());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(q('[role="menuitemcheckbox"]')!.getAttribute("aria-checked"), "false");
		assert.match(q('[role="status"]')?.textContent ?? "", /could not be changed/);
	});
});
