// components/use-speech-player.ts
/**
 * Playback of a teacher reply's speech (REQ-chat-tts-01, 03, 05, 06): one shared audio element, one clip at a time.
 *
 * iOS (Safari) starts audio only from a user gesture. The element is unlocked inside the click itself: play()
 * is called synchronously on a short silent clip, on the SAME element. The fetch of the real audio then
 * takes time, and when it arrives the element's src is replaced and play() is called again. Safari keeps the
 * element unlocked from the gesture, so the second play() is allowed. A new Audio per clip would lose that
 * unlock, which is why there is exactly one element, created once. Playing another clip stops the first;
 * pressing the same clip again stops it.
 *
 * A clip is a message's prose (the default), its pending question (part "question"), or the retry phrase
 * (part "retry", with a language). Each has its own state key. onSettle reports how a clip ended, for voice mode.
 *
 * Everything impure is injected (the element, fetch, object URLs); getSpeechPlayer() wires the browser's.
 */

/** The part of HTMLAudioElement the player uses. */
export interface SpeechAudio {
	src: string;
	play(): Promise<void> | void;
	pause(): void;
	addEventListener(type: "ended" | "error", listener: () => void): void;
}

export type SpeechState =
	| { status: "loading" }
	| { status: "playing" }
	/** `retryable` false: the server refused this clip (422, 429); the reason is its own fixed text. */
	| { status: "error"; reason: string; retryable: boolean };

export interface SpeechSnapshot {
	/** Per clip key: loading, playing or error. A key with no entry is idle. */
	readonly states: Readonly<Record<string, SpeechState>>;
	/** The server has no speech for this session (no key): the control is hidden for the rest of the session. */
	readonly unavailable: boolean;
}

/** Which clip of a message: the prose by default, the question, or the retry phrase in a language. */
export type SpeechRequest = { part: "question"; language?: "it" | "en" } | { part: "retry"; language: "it" | "en" };

/** How a clip settled: it ended on its own, it was stopped, or it failed (budget, unavailable, other). */
export type SpeechOutcome = { type: "ended" } | { type: "stopped" } | { type: "failed"; kind: "budget" | "unavailable" | "other" };

export interface SpeechPlayer {
	snapshot(): SpeechSnapshot;
	subscribe(listener: () => void): () => void;
	/** Plays a message's prose, question or retry phrase (or stops it when it is the one playing). Synchronous up to the unlock; resolves when the request settles. */
	play(sessionId: string, messageId: string, request?: SpeechRequest): Promise<void>;
	stop(): void;
	/** Unlocks the shared element for later playback, without fetching anything. Call it inside a click (iOS). Stops what plays. */
	unlock(): void;
}

export interface SpeechPlayerDeps {
	audio: SpeechAudio;
	/** A short silent clip used to unlock the element inside the gesture. */
	silentSrc: string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
	/** Told how each clip settled. Optional: the control needs none. */
	onSettle?: (key: string, outcome: SpeechOutcome) => void;
}

export const SPEECH_URL = "/api/chat/tts";
export const SPEECH_FAILED_TEXT = "this reply could not be read aloud; try again";
/** The server's text when the daily audio budget is spent (lecture-audio.ts BUDGET_TEXT; a test keeps them equal). */
export const SPEECH_BUDGET_TEXT = "the daily budget for narration audio is spent";

const NO_SNAPSHOT: SpeechSnapshot = { states: {}, unavailable: false };

/** The state key of a clip. */
export function clipKey(messageId: string, request?: SpeechRequest): string {
	return request === undefined ? messageId : `${messageId}#${request.part}`;
}

export function createSpeechPlayer(deps: SpeechPlayerDeps): SpeechPlayer {
	let snap: SpeechSnapshot = NO_SNAPSHOT;
	const listeners = new Set<() => void>();
	/** The clip that is loading or playing, if any (its state key). */
	let activeKey: string | null = null;
	/** Bumped by every stop or new play: a request that finishes after it is ignored. */
	let generation = 0;
	let objectUrl: string | null = null;

	const publish = (next: SpeechSnapshot): void => {
		snap = next;
		for (const listener of listeners) listener();
	};
	const withState = (key: string, state: SpeechState | null): void => {
		const states = { ...snap.states };
		if (state === null) delete states[key];
		else states[key] = state;
		publish({ ...snap, states });
	};
	const releaseUrl = (): void => {
		if (objectUrl !== null) deps.revokeObjectURL(objectUrl);
		objectUrl = null;
	};
	/** The request of the clip that is loading: a stop aborts it, so the server stops synthesizing. */
	let currentAbort: AbortController | null = null;
	/** Stops whatever plays or loads; the clip that was active settles as stopped. */
	const halt = (): void => {
		generation++;
		currentAbort?.abort();
		currentAbort = null;
		deps.audio.pause();
		releaseUrl();
		if (activeKey !== null) {
			const key = activeKey;
			activeKey = null;
			withState(key, null);
			deps.onSettle?.(key, { type: "stopped" });
		}
	};
	const fail = (key: string, token: number, reason: string, retryable: boolean, kind: "budget" | "unavailable" | "other" = "other"): void => {
		if (token !== generation) return;
		releaseUrl();
		activeKey = null;
		withState(key, { status: "error", reason, retryable });
		deps.onSettle?.(key, { type: "failed", kind });
	};

	/** The server's own fixed text for a refusal, or the generic text. */
	async function refusalReason(res: Response): Promise<string> {
		const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
		return typeof data?.error === "string" && data.error !== "" ? data.error : SPEECH_FAILED_TEXT;
	}

	async function load(key: string, sessionId: string, messageId: string, request: SpeechRequest | undefined, token: number, abort: AbortController): Promise<void> {
		let res: Response;
		try {
			res = await deps.fetch(SPEECH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, messageId, ...(request ?? {}) }),
				signal: abort.signal,
			});
		} catch {
			return fail(key, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		if (res.status === 503) {
			activeKey = null;
			withState(key, null);
			publish({ ...snap, unavailable: true });
			deps.onSettle?.(key, { type: "failed", kind: "unavailable" });
			return;
		}
		if (!res.ok) {
			const reason = await refusalReason(res);
			return fail(key, token, reason, res.status >= 500, reason === SPEECH_BUDGET_TEXT ? "budget" : "other");
		}
		let blob: Blob;
		try {
			blob = await res.blob();
		} catch {
			return fail(key, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		releaseUrl();
		objectUrl = deps.createObjectURL(blob);
		deps.audio.src = objectUrl;
		try {
			await deps.audio.play();
		} catch {
			return fail(key, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		withState(key, { status: "playing" });
	}

	deps.audio.addEventListener("ended", () => {
		// The silent unlock clip also ends; only the real audio finishing ends the clip.
		if (activeKey === null || snap.states[activeKey]?.status !== "playing") return;
		const key = activeKey;
		generation++;
		releaseUrl();
		activeKey = null;
		withState(key, null);
		deps.onSettle?.(key, { type: "ended" });
	});
	deps.audio.addEventListener("error", () => {
		if (activeKey !== null && snap.states[activeKey]?.status === "playing") fail(activeKey, generation, SPEECH_FAILED_TEXT, true);
	});

	return {
		snapshot: () => snap,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		play(sessionId, messageId, request) {
			const key = clipKey(messageId, request);
			if (snap.unavailable) return Promise.resolve();
			if (activeKey === key) {
				halt();
				return Promise.resolve();
			}
			halt();
			activeKey = key;
			const token = generation;
			withState(key, { status: "loading" });
			// The unlock: synchronous, inside the click that called play(). See the file header.
			deps.audio.src = deps.silentSrc;
			try {
				void Promise.resolve(deps.audio.play()).catch(() => undefined);
			} catch {
				// The unlock did not start; the real play below reports the failure.
			}
			const abort = new AbortController();
			currentAbort = abort;
			return load(key, sessionId, messageId, request, token, abort);
		},
		stop: halt,
		unlock() {
			halt();
			deps.audio.src = deps.silentSrc;
			try {
				void Promise.resolve(deps.audio.play()).catch(() => undefined);
			} catch {
				// Nothing to unlock on this platform; the real play reports its own failure.
			}
		},
	};
}

/** A silent WAV (8 kHz, 8-bit mono, 0.1 s) as a data URI: the unlock clip. */
export function silentWavDataUri(): string {
	const samples = 800;
	const bytes = new Uint8Array(44 + samples);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => [...text].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 8000, true);
	view.setUint32(28, 8000, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	ascii(36, "data");
	view.setUint32(40, samples, true);
	bytes.fill(0x80, 44);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return `data:audio/wav;base64,${btoa(binary)}`;
}

let browserPlayer: SpeechPlayer | null = null;
/** Set by the voice layer before the first clip, so the one player reports settlements to it. */
let browserSettle: ((key: string, outcome: SpeechOutcome) => void) | undefined;

/** Registers the settlement listener of the page's player (voice mode). */
export function setSpeechSettleListener(listener: ((key: string, outcome: SpeechOutcome) => void) | undefined): void {
	browserSettle = listener;
}

/** The one player of the page (one audio element). Null where there is no browser (server render). */
export function getSpeechPlayer(): SpeechPlayer | null {
	if (browserPlayer !== null) return browserPlayer;
	if (typeof window === "undefined" || typeof Audio === "undefined") return null;
	browserPlayer = createSpeechPlayer({
		audio: new Audio() as unknown as SpeechAudio,
		silentSrc: silentWavDataUri(),
		fetch: (url, init) => fetch(url, init),
		createObjectURL: (blob) => URL.createObjectURL(blob),
		revokeObjectURL: (url) => URL.revokeObjectURL(url),
		onSettle: (key, outcome) => browserSettle?.(key, outcome),
	});
	return browserPlayer;
}
