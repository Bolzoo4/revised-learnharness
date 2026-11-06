// components/ext/lecture-audio-client.ts
/**
 * The browser's side of the narration audio: which voice plays a block, the routes it calls, and the
 * requests themselves. The decisions are pure (tested without a DOM); the requests take the fetch function,
 * so the tests can answer them. A generation already in flight for a block is shared, not paid twice.
 */

import type { AudioBlock, AudioLanguage, AudioManifest } from "@/src/core";

/** The lecture's audio state as GET /api/ext/lectures/[id]/audio answers it. */
export interface AudioState {
	keyConfigured: boolean;
	language: AudioLanguage | "unknown";
	voice: string | null;
	ready: number;
	total: number;
	manifest: AudioManifest | null;
}

export type AudioSource = "audio" | "generate" | "speech";

/** Which voice speaks a block: its ready audio; else, when a key exists and the language has a voice, the audio generated on demand; else the browser's voice. */
export function audioSourceFor(input: { ready: boolean; canGenerate: boolean }): AudioSource {
	if (input.ready) return "audio";
	return input.canGenerate ? "generate" : "speech";
}

/** Generation on demand is possible: a key is configured and the lecture's language has a voice. */
export function canGenerate(state: Pick<AudioState, "keyConfigured" | "language">): boolean {
	return state.keyConfigured && state.language !== "unknown";
}

export function audioUrl(lectureId: string, blockId: string): string {
	return `/api/ext/lectures/${encodeURIComponent(lectureId)}/audio/${encodeURIComponent(blockId)}`;
}

/** The ready blocks of a manifest by block id (a failed or missing block is absent). */
export function readyBlocks(manifest: AudioManifest | null): Record<string, AudioBlock> {
	const out: Record<string, AudioBlock> = {};
	for (const b of manifest?.blocks ?? []) if (b.status === "ready") out[b.blockId] = b;
	return out;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The lecture's audio state, or null when it cannot be read. */
export async function fetchAudioState(lectureId: string, fetchFn: Fetch = (i, init) => fetch(i, init)): Promise<AudioState | null> {
	try {
		const res = await fetchFn(`/api/ext/lectures/${encodeURIComponent(lectureId)}/audio`);
		if (!res.ok) return null;
		return (await res.json()) as AudioState;
	} catch {
		return null;
	}
}

const inFlight = new Map<string, Promise<AudioBlock | null>>();

/**
 * One block's audio, generated on demand (POST {blockId}); resolves with the ready block, or null when it is
 * not ready. A request already running for the same block is awaited instead of sent again.
 */
export function generateBlockAudio(lectureId: string, blockId: string, fetchFn: Fetch = (i, init) => fetch(i, init)): Promise<AudioBlock | null> {
	const key = `${lectureId}/${blockId}`;
	const running = inFlight.get(key);
	if (running !== undefined) return running;
	const request = (async (): Promise<AudioBlock | null> => {
		try {
			const res = await fetchFn(`/api/ext/lectures/${encodeURIComponent(lectureId)}/audio`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blockId }),
			});
			if (!res.ok) return null;
			const body = (await res.json()) as { block?: AudioBlock };
			return body.block?.status === "ready" ? body.block : null;
		} catch {
			return null;
		}
	})();
	inFlight.set(key, request);
	void request.then(() => inFlight.delete(key));
	return request;
}

/** The lecture's missing blocks are generated in the background. Resolves with null when started, else the server's fixed sentence. */
export async function startLectureAudio(lectureId: string, fetchFn: Fetch = (i, init) => fetch(i, init)): Promise<string | null> {
	try {
		const res = await fetchFn(`/api/ext/lectures/${encodeURIComponent(lectureId)}/audio`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		if (res.ok) return null;
		const body = (await res.json().catch(() => ({}))) as { error?: unknown };
		return typeof body.error === "string" ? body.error : "The audio could not be started.";
	} catch {
		return "The audio could not be started.";
	}
}
