// components/use-speech-player.ts
/**
 * Playback of a teacher reply's speech (REQ-chat-tts-01, 03, 05, 06): one shared audio element, one message at a time.
 *
 * iOS (Safari) starts audio only from a user gesture. The element is unlocked inside the click itself: play()
 * is called synchronously on a short silent clip, on the SAME element. The fetch of the real audio then
 * takes time, and when it arrives the element's src is replaced and play() is called again. Safari keeps the
 * element unlocked from the gesture, so the second play() is allowed. A new Audio per message would lose that
 * unlock, which is why there is exactly one element, created once. Playing another message stops the first;
 * pressing the same message again stops it.
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
	/** `retryable` false: the server refused this message (422, 429); the reason is its own fixed text. */
	| { status: "error"; reason: string; retryable: boolean };

export interface SpeechSnapshot {
	/** Per message id: loading, playing or error. A message with no entry is idle. */
	readonly states: Readonly<Record<string, SpeechState>>;
	/** The server has no speech for this session (no key): the control is hidden for the rest of the session. */
	readonly unavailable: boolean;
}

export interface SpeechPlayer {
	snapshot(): SpeechSnapshot;
	subscribe(listener: () => void): () => void;
	/** Plays a message (or stops it when it is the one playing). Synchronous up to the unlock; resolves when the request settles. */
	play(sessionId: string, messageId: string): Promise<void>;
	stop(): void;
}

export interface SpeechPlayerDeps {
	audio: SpeechAudio;
	/** A short silent clip used to unlock the element inside the gesture. */
	silentSrc: string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
}

export const SPEECH_URL = "/api/chat/tts";
export const SPEECH_FAILED_TEXT = "this reply could not be read aloud; try again";

const NO_SNAPSHOT: SpeechSnapshot = { states: {}, unavailable: false };

export function createSpeechPlayer(deps: SpeechPlayerDeps): SpeechPlayer {
	let snap: SpeechSnapshot = NO_SNAPSHOT;
	const listeners = new Set<() => void>();
	/** The message that is loading or playing, if any. */
	let activeId: string | null = null;
	/** Bumped by every stop or new play: a request that finishes after it is ignored. */
	let generation = 0;
	let objectUrl: string | null = null;

	const publish = (next: SpeechSnapshot): void => {
		snap = next;
		for (const listener of listeners) listener();
	};
	const withState = (id: string, state: SpeechState | null): void => {
		const states = { ...snap.states };
		if (state === null) delete states[id];
		else states[id] = state;
		publish({ ...snap, states });
	};
	const releaseUrl = (): void => {
		if (objectUrl !== null) deps.revokeObjectURL(objectUrl);
		objectUrl = null;
	};
	const halt = (): void => {
		generation++;
		deps.audio.pause();
		releaseUrl();
		if (activeId !== null) {
			const id = activeId;
			activeId = null;
			withState(id, null);
		}
	};
	const fail = (id: string, token: number, reason: string, retryable: boolean): void => {
		if (token !== generation) return;
		releaseUrl();
		activeId = null;
		withState(id, { status: "error", reason, retryable });
	};

	/** The server's own fixed text for a refusal, or the generic text. */
	async function refusalReason(res: Response): Promise<string> {
		const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
		return typeof data?.error === "string" && data.error !== "" ? data.error : SPEECH_FAILED_TEXT;
	}

	async function load(sessionId: string, messageId: string, token: number): Promise<void> {
		let res: Response;
		try {
			res = await deps.fetch(SPEECH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, messageId }),
			});
		} catch {
			return fail(messageId, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		if (res.status === 503) {
			activeId = null;
			withState(messageId, null);
			publish({ ...snap, unavailable: true });
			return;
		}
		if (!res.ok) {
			const reason = await refusalReason(res);
			return fail(messageId, token, reason, res.status >= 500);
		}
		let blob: Blob;
		try {
			blob = await res.blob();
		} catch {
			return fail(messageId, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		releaseUrl();
		objectUrl = deps.createObjectURL(blob);
		deps.audio.src = objectUrl;
		try {
			await deps.audio.play();
		} catch {
			return fail(messageId, token, SPEECH_FAILED_TEXT, true);
		}
		if (token !== generation) return;
		withState(messageId, { status: "playing" });
	}

	deps.audio.addEventListener("ended", () => {
		// The silent unlock clip also ends; only the real audio finishing ends the message.
		if (activeId !== null && snap.states[activeId]?.status === "playing") halt();
	});
	deps.audio.addEventListener("error", () => {
		if (activeId !== null && snap.states[activeId]?.status === "playing") fail(activeId, generation, SPEECH_FAILED_TEXT, true);
	});

	return {
		snapshot: () => snap,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		play(sessionId, messageId) {
			if (snap.unavailable) return Promise.resolve();
			if (activeId === messageId) {
				halt();
				return Promise.resolve();
			}
			halt();
			activeId = messageId;
			const token = generation;
			withState(messageId, { status: "loading" });
			// The unlock: synchronous, inside the click that called play(). See the file header.
			deps.audio.src = deps.silentSrc;
			try {
				void Promise.resolve(deps.audio.play()).catch(() => undefined);
			} catch {
				// The unlock did not start; the real play below reports the failure.
			}
			return load(sessionId, messageId, token);
		},
		stop: halt,
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
	});
	return browserPlayer;
}
