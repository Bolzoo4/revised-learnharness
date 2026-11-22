// tests/speech-player.test.tsx
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createSpeechPlayer, SPEECH_FAILED_TEXT, type SpeechAudio, type SpeechPlayer } from "../components/use-speech-player.ts";

const SILENT = "data:audio/wav;base64,SILENT";
const SESSION = "chat_1";
const BUDGET = "the daily budget for narration audio is spent";
const REFUSED = "this message's language has no text-to-speech voice";

class FakeAudio implements SpeechAudio {
	src = "";
	/** The src of every play() call, in order. */
	plays: string[] = [];
	pauses = 0;
	private listeners = new Map<string, Set<() => void>>();
	play(): Promise<void> {
		this.plays.push(this.src);
		return Promise.resolve();
	}
	pause(): void {
		this.pauses++;
	}
	addEventListener(type: "ended" | "error", listener: () => void): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	emit(type: "ended" | "error"): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

const AUDIO_BYTES = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
const jsonError = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

/** A fake /api/chat/tts: each call takes the next scripted answer (a Response, or a promise of one). */
function fakeFetch(answers: Array<() => Promise<Response> | Response>) {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, body: JSON.parse(String(init.body)) });
		const next = answers.shift() ?? AUDIO_BYTES;
		return next();
	};
	return { fetch, calls };
}

function setup(answers: Array<() => Promise<Response> | Response> = []) {
	const audio = new FakeAudio();
	const { fetch, calls } = fakeFetch(answers);
	const revoked: string[] = [];
	let n = 0;
	const player: SpeechPlayer = createSpeechPlayer({
		audio,
		silentSrc: SILENT,
		fetch,
		createObjectURL: () => `blob:${++n}`,
		revokeObjectURL: (url) => void revoked.push(url),
	});
	return { player, audio, calls, revoked };
}

/** A promise that the test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe("speech player: playing", () => {
	it("fetches the message's audio by id and plays it", async () => {
		const { player, audio, calls } = setup();
		await player.play(SESSION, "msg_1");
		assert.deepEqual(calls, [{ url: "/api/chat/tts", body: { sessionId: SESSION, messageId: "msg_1" } }]);
		assert.equal(audio.plays.at(-1), "blob:1");
		assert.deepEqual(player.snapshot().states, { msg_1: { status: "playing" } });
	});

	it("starts the unlock on the shared element synchronously, before any awaited work", () => {
		const { player, audio } = setup([() => new Promise(() => {})]);
		void player.play(SESSION, "msg_1");
		assert.equal(audio.plays.length, 1, "play() on the element is called before play() returns");
		assert.equal(audio.plays[0], SILENT);
	});

	it("playing another message stops the first and releases its audio", async () => {
		const { player, audio, revoked } = setup();
		await player.play(SESSION, "msg_1");
		await player.play(SESSION, "msg_2");
		assert.ok(audio.pauses >= 1);
		assert.deepEqual(revoked, ["blob:1"]);
		assert.deepEqual(player.snapshot().states, { msg_2: { status: "playing" } });
	});

	it("pressing the message that is playing stops it", async () => {
		const { player, audio, revoked } = setup();
		await player.play(SESSION, "msg_1");
		const pausesBefore = audio.pauses;
		await player.play(SESSION, "msg_1");
		assert.ok(audio.pauses > pausesBefore);
		assert.deepEqual(revoked, ["blob:1"]);
		assert.deepEqual(player.snapshot().states, {});
	});

	it("stop during loading drops the answer when it arrives", async () => {
		const gate = deferred<Response>();
		const { player, audio } = setup([() => gate.promise]);
		const pending = player.play(SESSION, "msg_1");
		player.stop();
		gate.resolve(AUDIO_BYTES());
		await pending;
		assert.deepEqual(audio.plays, [SILENT], "the real audio is never assigned");
		assert.deepEqual(player.snapshot().states, {});
	});

	it("the end of the real audio clears the message's state", async () => {
		const { player, audio } = setup();
		await player.play(SESSION, "msg_1");
		audio.emit("ended");
		assert.deepEqual(player.snapshot().states, {});
	});

	it("the end of the silent unlock clip does not clear a loading message", async () => {
		const gate = deferred<Response>();
		const { player, audio } = setup([() => gate.promise]);
		const pending = player.play(SESSION, "msg_1");
		audio.emit("ended");
		assert.deepEqual(player.snapshot().states, { msg_1: { status: "loading" } });
		gate.resolve(AUDIO_BYTES());
		await pending;
		assert.deepEqual(player.snapshot().states, { msg_1: { status: "playing" } });
	});
});

describe("speech player: refusals", () => {
	it("a 503 hides the control for the session and sends nothing more", async () => {
		const { player, calls } = setup([() => new Response("{}", { status: 503 })]);
		await player.play(SESSION, "msg_1");
		assert.equal(player.snapshot().unavailable, true);
		await player.play(SESSION, "msg_2");
		assert.equal(calls.length, 1);
	});

	it("a 422 is a refusal with the server's reason, not retryable", async () => {
		const { player } = setup([() => jsonError(422, REFUSED)]);
		await player.play(SESSION, "msg_1");
		assert.deepEqual(player.snapshot().states.msg_1, { status: "error", reason: REFUSED, retryable: false });
	});

	it("a 429 shows the budget message, not retryable", async () => {
		const { player } = setup([() => jsonError(429, BUDGET)]);
		await player.play(SESSION, "msg_1");
		assert.deepEqual(player.snapshot().states.msg_1, { status: "error", reason: BUDGET, retryable: false });
	});

	it("a server failure is retryable and carries no provider text", async () => {
		const { player } = setup([() => new Response("provider detail", { status: 502 })]);
		await player.play(SESSION, "msg_1");
		assert.deepEqual(player.snapshot().states.msg_1, { status: "error", reason: SPEECH_FAILED_TEXT, retryable: true });
	});

	it("a network error is retryable with the generic text", async () => {
		const { player } = setup([() => Promise.reject(new TypeError("network down"))]);
		await player.play(SESSION, "msg_1");
		assert.deepEqual(player.snapshot().states.msg_1, { status: "error", reason: SPEECH_FAILED_TEXT, retryable: true });
	});
});

// ── the button, mounted in a DOM (linkedom) ─────────────────────────────────

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

async function mountButton(opts: { player: SpeechPlayer; parts: unknown[] }) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals: Record<string, unknown> = {
		React,
		window: win,
		document: doc,
		Element: win.Element,
		HTMLElement: win.HTMLElement,
		Node: win.Node,
		Event: win.Event,
		CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
		cancelAnimationFrame: clearTimeout,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(globals)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const { ListenButton } = await import("../components/listen-button.tsx");
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => {
		root.render(<ListenButton sessionId={SESSION} messageId="msg_1" parts={opts.parts as never} player={opts.player} />);
	});
	dispose = () => {
		act(() => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	return { button: () => doc.querySelector<HTMLButtonElement>('[data-testid="listen-button"]') };
}

const SPEAKABLE = [{ type: "text", text: "The set is closed under complements and this is the first step of the proof." }];

describe("listen button", () => {
	it("is labelled Listen and starts playing on click, the unlock happening inside the click", async () => {
		const { player, audio } = setup();
		const { button } = await mountButton({ player, parts: SPEAKABLE });
		assert.equal(button()!.getAttribute("aria-label"), "Listen");
		button()!.click();
		assert.equal(audio.plays[0], SILENT, "the element is unlocked before the click handler returns");
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(audio.plays.at(-1), "blob:1");
	});

	it("is disabled with the server's reason as its title after a 422", async () => {
		const { player } = setup([() => jsonError(422, REFUSED)]);
		const { button } = await mountButton({ player, parts: SPEAKABLE });
		button()!.click();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(button()!.disabled, true);
		assert.equal(button()!.getAttribute("title"), REFUSED);
	});

	it("is hidden for the session after a 503", async () => {
		const { player } = setup([() => new Response("{}", { status: 503 })]);
		const { button } = await mountButton({ player, parts: SPEAKABLE });
		button()!.click();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(button(), null);
	});

	it("is not rendered for a message with nothing speakable", async () => {
		const { player } = setup();
		const { button } = await mountButton({ player, parts: [{ type: "tool-ask", state: "output-available" }] });
		assert.equal(button(), null);
	});
});
