// src/server/ext/speech-synthesis.ts
/**
 * Text-to-speech synthesis (Deepgram Aura-2) shared by lecture narration and chat speech: a text is cut
 * into requests, each request is answered from the content cache or synthesised (retries on 429, 5xx and
 * network errors) and paid on the audio gate, and the chunks' audio comes back in order. Everything
 * impure is injected (fetch, clock, gate, data dir); the callers own what a failure means for them.
 *
 *   <dir>/cache/<sha256(voice + "\n" + text)>.mp3   one request's audio, never paid twice
 *
 * Failures: BudgetRefused when the gate is closed (nothing is sent), TtsError for a failure whose message
 * is fixed (nothing of the request or the response is in it). Anything else is unexpected.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { AUDIO_CONCURRENCY, audioCostUsd, chunkText, speakUrl, type CharRange } from "../../core/ext/lecture/audio.ts";

export const BUDGET_TEXT = "the daily budget for narration audio is spent";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const RETRY_AFTER_CAP_MS = 30_000;

/** A request's failure with a fixed text; nothing of the request or the response is in it. */
export class TtsError extends Error {}
/** The audio gate refused a request: nothing was sent. */
export class BudgetRefused extends Error {}

export interface SynthesisDeps {
	/** Root of the audio files; the content cache is <dir>/cache. */
	dir: string;
	/** The audio ceiling: consulted and recorded before every network request (a cache hit costs nothing). */
	gate: CostGate;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	maxAttempts?: number;
}

export interface SynthesisInput {
	text: string;
	voice: string;
	key: string;
	signal?: AbortSignal;
	/** Applied to each chunk's text before it is sent (lecture narration strips its node links). */
	clean?: (text: string) => string;
}

export interface SynthesisResult {
	/** The chunks of the input text, in order (character ranges of the input). */
	ranges: CharRange[];
	/** The audio of each chunk, same order; empty for a chunk with nothing to say. */
	parts: Buffer[];
}

interface Resolved {
	deps: SynthesisDeps;
	fetchFn: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	timeoutMs: number;
	maxAttempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolved(deps: SynthesisDeps): Resolved {
	return {
		deps,
		fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
		sleep: deps.sleep ?? defaultSleep,
		timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
	};
}

export function cacheFileOf(dir: string, voice: string, text: string): string {
	return path.join(dir, "cache", `${createHash("sha256").update(voice).update("\n").update(text).digest("hex")}.mp3`);
}

/** Writes a file atomically (temp name, then rename): a reader sees the old file or the new one, never half of it. */
export function writeAudioFile(file: string, bytes: Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomUUID()}`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, file);
}

function readCache(file: string): Buffer | null {
	try {
		const bytes = fs.readFileSync(file);
		return bytes.length > 0 ? bytes : null;
	} catch {
		return null;
	}
}

function requestSignal(r: Resolved, signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(r.timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function retryDelayMs(res: Response, attempt: number): number {
	const raw = res.headers.get("retry-after");
	const seconds = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
	return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/** One request, with retries on 429, 5xx and network errors. The gate is consulted and the spend recorded before every attempt. */
async function speakWithRetry(r: Resolved, text: string, voice: string, key: string, signal: AbortSignal | undefined): Promise<Buffer> {
	const url = speakUrl(voice);
	for (let attempt = 1; ; attempt++) {
		if (!r.deps.gate.allowed()) throw new BudgetRefused(BUDGET_TEXT);
		r.deps.gate.record(audioCostUsd(text.length), "audio");
		let res: Response;
		try {
			res = await r.fetchFn(url, {
				method: "POST",
				headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
				signal: requestSignal(r, signal),
			});
		} catch (err) {
			if (signal?.aborted) throw err;
			if (attempt >= r.maxAttempts) throw new TtsError("the text-to-speech service could not be reached");
			await r.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
			continue;
		}
		if (res.ok) {
			const bytes = Buffer.from(await res.arrayBuffer());
			if (bytes.length === 0) throw new TtsError("the text-to-speech service returned no audio");
			return bytes;
		}
		void res.body?.cancel().catch(() => undefined);
		if ((res.status === 429 || res.status >= 500) && attempt < r.maxAttempts) {
			await r.sleep(retryDelayMs(res, attempt));
			continue;
		}
		if (res.status === 401 || res.status === 403) throw new TtsError("the text-to-speech key was refused");
		throw new TtsError(`the text-to-speech service answered ${res.status}`);
	}
}

/** The audio of one request's text: from the cache when present (free), else synthesised and cached. */
async function bytesFor(r: Resolved, text: string, voice: string, key: string, signal: AbortSignal | undefined): Promise<Buffer> {
	const file = cacheFileOf(r.deps.dir, voice, text);
	const cached = readCache(file);
	if (cached !== null) return cached;
	const bytes = await speakWithRetry(r, text, voice, key, signal);
	writeAudioFile(file, bytes);
	return bytes;
}

/** Runs `fn` over `items` with at most `limit` in flight; the first failure stops the rest and is thrown. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, onFail: () => void): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	let firstError: unknown;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				out[i] = await fn(items[i]!);
			} catch (err) {
				if (!failed) {
					failed = true;
					firstError = err;
					onFail();
				}
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	if (failed) throw firstError;
	return out;
}

/**
 * The audio of a text: cut into chunks, each answered from the cache or synthesised (at most AUDIO_CONCURRENCY
 * in flight), in order. The first failure stops the rest and is thrown; an aborted signal cancels the requests.
 */
export async function synthesizeText(input: SynthesisInput, deps: SynthesisDeps): Promise<SynthesisResult> {
	const r = resolved(deps);
	const ranges = chunkText(input.text);
	const clean = input.clean ?? ((text: string) => text);
	const inputs = ranges.map((range) => clean(input.text.slice(range.startChar, range.endChar)));
	const ctl = new AbortController();
	const cancel = (): void => ctl.abort();
	if (input.signal?.aborted) cancel();
	input.signal?.addEventListener("abort", cancel, { once: true });
	try {
		const parts = await mapPool(
			inputs,
			AUDIO_CONCURRENCY,
			(text) => (text.trim() === "" ? Promise.resolve(Buffer.alloc(0)) : bytesFor(r, text, input.voice, input.key, ctl.signal)),
			cancel,
		);
		return { ranges, parts };
	} finally {
		input.signal?.removeEventListener("abort", cancel);
	}
}
