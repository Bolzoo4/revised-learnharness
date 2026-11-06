// src/server/ext/lecture-audio.ts
/**
 * Narration audio of lectures (Deepgram Aura-2): the synthesis of a block, its
 * files and manifest, the per-chunk content cache, and the spend on the audio
 * gate. Everything impure is injected (fetch, clock, key, gate, data dir);
 * the live wiring is lecture-live.ts.
 *
 *   <dir>/cache/<sha256(voice + "\n" + text)>.mp3        one request's audio, never paid twice
 *   <dir>/<lectureId>/<blockId>.mp3                      a ready block: its chunks concatenated
 *   <dir>/<lectureId>/audio.json                         the manifest (core/ext/lecture/audio.ts)
 *
 * A failed block is recorded as failed and never touches the lecture; a block
 * that is missing or failed is generated again by the next request.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import {
	AUDIO_CONCURRENCY,
	AUDIO_MANIFEST_VERSION,
	BLOCK_ID_RE,
	audioCostUsd,
	chunkText,
	languageOfBlocks,
	parseAudioManifest,
	speakUrl,
	timedChunks,
	type AudioBlock,
	type AudioLanguage,
	type AudioManifest,
} from "../../core/ext/lecture/audio.ts";
import { isValidLectureId, stripNodeLinks, type Lecture } from "../../core/ext/lecture/lecture.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { HttpError } from "./http-error.ts";

export const NO_KEY_TEXT = "no text-to-speech key is configured (DEEPGRAM_API_KEY)";
export const NO_VOICE_TEXT = "this lecture's language has no text-to-speech voice";
export const BUDGET_TEXT = "the daily budget for narration audio is spent";
export const FAILED_TEXT = "the audio could not be generated; try again later";
const UNKNOWN_BLOCK_TEXT = "unknown block";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const RETRY_AFTER_CAP_MS = 30_000;

/** A block's failure with a fixed text; nothing of the request or the response is in it. */
class TtsError extends Error {}
/** The audio gate refused a request: the block stops, nothing is recorded as its failure. */
class BudgetRefused extends Error {}

export interface LectureAudioDeps {
	/** Root of the audio files: <data>/ext/lecture-audio. */
	dir: string;
	apiKey(): string | undefined;
	/** The audio ceiling (its own ledger; see cost-live.ts). */
	gate: CostGate;
	voices(): Record<AudioLanguage, string>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	maxAttempts?: number;
	now?: () => string;
}

export type BlockStatus = "ready" | "failed" | "missing";

export interface AudioSummary {
	keyConfigured: boolean;
	language: AudioLanguage | "unknown";
	voice: string | null;
	/** Blocks with ready audio for the current voice. */
	ready: number;
	/** All blocks of the lecture (every block is spoken). */
	total: number;
	statuses: Array<{ blockId: string; status: BlockStatus }>;
	/** The manifest restricted to the current voice and language, or null when none was written. */
	manifest: AudioManifest | null;
}

export interface SkipReport {
	generated: number;
	skipped: null | "no-key" | "language" | "ceiling";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createLectureAudio(deps: LectureAudioDeps) {
	const fetchFn: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
	const sleep = deps.sleep ?? defaultSleep;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const now = deps.now ?? (() => new Date().toISOString());
	/** Generations in flight, by lecture and block: a second request waits for the first instead of paying twice. */
	const jobs = new Map<string, Promise<AudioBlock>>();

	const lectureDir = (lectureId: string): string => path.join(deps.dir, lectureId);
	const manifestFile = (lectureId: string): string => path.join(lectureDir(lectureId), "audio.json");
	const blockFileOf = (lectureId: string, blockId: string): string => path.join(lectureDir(lectureId), `${blockId}.mp3`);
	const cacheFileOf = (voice: string, text: string): string =>
		path.join(deps.dir, "cache", `${createHash("sha256").update(voice).update("\n").update(text).digest("hex")}.mp3`);

	function readManifest(lectureId: string): AudioManifest | null {
		try {
			const manifest = parseAudioManifest(JSON.parse(fs.readFileSync(manifestFile(lectureId), "utf-8")));
			return manifest !== null && manifest.lectureId === lectureId ? manifest : null;
		} catch {
			return null;
		}
	}

	/** The manifest's blocks when they belong to the current voice and language; the others count as missing. */
	function currentBlocks(lectureId: string, language: AudioLanguage | "unknown", voice: string | null): AudioBlock[] {
		const manifest = readManifest(lectureId);
		if (manifest === null || manifest.language !== language || manifest.voice !== voice) return [];
		return manifest.blocks;
	}

	function languageOf(lecture: Lecture): AudioLanguage | "unknown" {
		return languageOfBlocks(lecture.blocks);
	}

	function voiceFor(language: AudioLanguage | "unknown"): string | null {
		return language === "unknown" ? null : deps.voices()[language];
	}

	function readyEntry(lecture: Lecture, blockId: string): AudioBlock | null {
		const language = languageOf(lecture);
		const entry = currentBlocks(lecture.id, language, voiceFor(language)).find((b) => b.blockId === blockId);
		return entry !== undefined && entry.status === "ready" ? entry : null;
	}

	/** Writes the manifest with `blockId`'s entry replaced; the manifest is rebuilt when the voice or language changed. */
	function recordBlock(lecture: Lecture, entry: AudioBlock): void {
		const language = languageOf(lecture);
		const voice = voiceFor(language);
		const kept = currentBlocks(lecture.id, language, voice).filter((b) => b.blockId !== entry.blockId);
		writeManifest(lecture.id, language, voice, [...kept, entry]);
	}

	function recordUnknownLanguage(lecture: Lecture): void {
		writeManifest(lecture.id, "unknown", null, []);
	}

	function writeManifest(lectureId: string, language: AudioLanguage | "unknown", voice: string | null, blocks: AudioBlock[]): void {
		const manifest: AudioManifest = { version: AUDIO_MANIFEST_VERSION, lectureId, language, voice, blocks };
		fs.mkdirSync(lectureDir(lectureId), { recursive: true });
		writeFileAtomicSync(manifestFile(lectureId), `${JSON.stringify(manifest, null, "\t")}\n`);
	}

	function writeBytes(file: string, bytes: Buffer): void {
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

	function requestSignal(signal: AbortSignal | undefined): AbortSignal {
		const timeout = AbortSignal.timeout(timeoutMs);
		return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	}

	function retryDelayMs(res: Response, attempt: number): number {
		const raw = res.headers.get("retry-after");
		const seconds = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
		return BACKOFF_BASE_MS * 2 ** (attempt - 1);
	}

	/** One request, with retries on 429, 5xx and network errors. The gate is consulted and the spend recorded before every attempt. */
	async function speakWithRetry(text: string, voice: string, key: string, signal: AbortSignal | undefined): Promise<Buffer> {
		const url = speakUrl(voice);
		for (let attempt = 1; ; attempt++) {
			if (!deps.gate.allowed()) throw new BudgetRefused(BUDGET_TEXT);
			deps.gate.record(audioCostUsd(text.length), "audio");
			let res: Response;
			try {
				res = await fetchFn(url, {
					method: "POST",
					headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify({ text }),
					signal: requestSignal(signal),
				});
			} catch (err) {
				if (signal?.aborted) throw err;
				if (attempt >= maxAttempts) throw new TtsError("the text-to-speech service could not be reached");
				await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
				continue;
			}
			if (res.ok) {
				const bytes = Buffer.from(await res.arrayBuffer());
				if (bytes.length === 0) throw new TtsError("the text-to-speech service returned no audio");
				return bytes;
			}
			void res.body?.cancel().catch(() => undefined);
			if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
				await sleep(retryDelayMs(res, attempt));
				continue;
			}
			if (res.status === 401 || res.status === 403) throw new TtsError("the text-to-speech key was refused");
			throw new TtsError(`the text-to-speech service answered ${res.status}`);
		}
	}

	/** The audio of one request's text: from the cache when present (free), else synthesised and cached. */
	async function bytesFor(text: string, voice: string, key: string, signal: AbortSignal | undefined): Promise<Buffer> {
		const file = cacheFileOf(voice, text);
		const cached = readCache(file);
		if (cached !== null) return cached;
		const bytes = await speakWithRetry(text, voice, key, signal);
		writeBytes(file, bytes);
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

	function failedEntry(block: { id: string; text: string }, error: string): AudioBlock {
		return { blockId: block.id, status: "failed", chars: block.text.length, durationSec: 0, chunks: [], error };
	}

	/** One block, from its chunks. A fixed-text failure becomes a failed entry; a refused budget or a cancel throws. */
	async function synthesize(lecture: Lecture, block: { id: string; text: string }, voice: string, key: string, signal: AbortSignal | undefined): Promise<AudioBlock> {
		const ranges = chunkText(block.text);
		const inputs = ranges.map((r) => stripNodeLinks(block.text.slice(r.startChar, r.endChar)));
		const ctl = new AbortController();
		const cancel = (): void => ctl.abort();
		if (signal?.aborted) cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const parts = await mapPool(
				inputs,
				AUDIO_CONCURRENCY,
				(text) => (text.trim() === "" ? Promise.resolve(Buffer.alloc(0)) : bytesFor(text, voice, key, ctl.signal)),
				cancel,
			);
			const audio = Buffer.concat(parts);
			if (audio.length === 0) return failedEntry(block, "the block has no speakable text");
			const chunks = timedChunks(ranges, parts.map((p) => p.length));
			const entry: AudioBlock = {
				blockId: block.id,
				status: "ready",
				chars: block.text.length,
				durationSec: chunks.reduce((sum, c) => sum + c.durationSec, 0),
				chunks,
			};
			writeBytes(blockFileOf(lecture.id, block.id), audio);
			return entry;
		} catch (err) {
			if (signal?.aborted) throw err;
			if (err instanceof BudgetRefused) throw new HttpError(429, BUDGET_TEXT);
			if (err instanceof TtsError) return failedEntry(block, err.message);
			console.error("[ext] narration audio: unexpected error:", err);
			return failedEntry(block, FAILED_TEXT);
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}

	/** The key and language checks every generation starts with. */
	function synthesisContext(lecture: Lecture): { voice: string; key: string; language: AudioLanguage } {
		const key = deps.apiKey();
		if (!key) throw new HttpError(503, NO_KEY_TEXT);
		const language = languageOf(lecture);
		if (language === "unknown") {
			recordUnknownLanguage(lecture);
			throw new HttpError(422, NO_VOICE_TEXT);
		}
		return { voice: deps.voices()[language], key, language };
	}

	/**
	 * One block's audio, waiting until it is ready (the on-demand path). A ready block is returned without cost.
	 * Resolves with a failed entry when synthesis failed (the failure is recorded); throws an HttpError for an
	 * unknown block, a missing key, an unknown language or a spent budget; rejects with an AbortError on a cancel.
	 */
	async function generateBlock(lecture: Lecture, blockId: string, opts: { signal?: AbortSignal } = {}): Promise<AudioBlock> {
		const block = lecture.blocks.find((b) => b.id === blockId);
		if (block === undefined || !BLOCK_ID_RE.test(blockId)) throw new HttpError(404, UNKNOWN_BLOCK_TEXT);
		const { voice, key } = synthesisContext(lecture);
		const ready = readyEntry(lecture, blockId);
		if (ready !== null) return ready;
		const jobKey = `${lecture.id}/${blockId}`;
		const running = jobs.get(jobKey);
		if (running !== undefined) return running;
		const job = (async (): Promise<AudioBlock> => {
			const entry = await synthesize(lecture, block, voice, key, opts.signal);
			recordBlock(lecture, entry);
			return entry;
		})();
		jobs.set(jobKey, job);
		job.then(
			() => jobs.delete(jobKey),
			() => jobs.delete(jobKey),
		);
		return job;
	}

	/** Every block that is not ready, in order, one at a time (the blocks' requests run four at a time). */
	async function generateMissing(lecture: Lecture, opts: { signal?: AbortSignal } = {}): Promise<SkipReport> {
		if (!deps.apiKey()) return { generated: 0, skipped: "no-key" };
		if (languageOf(lecture) === "unknown") {
			recordUnknownLanguage(lecture);
			return { generated: 0, skipped: "language" };
		}
		let generated = 0;
		for (const block of lecture.blocks) {
			if (opts.signal?.aborted) break;
			if (readyEntry(lecture, block.id) !== null) continue;
			try {
				const entry = await generateBlock(lecture, block.id, opts);
				if (entry.status === "ready") generated++;
			} catch (err) {
				if (err instanceof HttpError && err.status === 429) return { generated, skipped: "ceiling" };
				if (opts.signal?.aborted) break;
				console.error("[ext] narration audio: a block was not generated:", err);
			}
		}
		return { generated, skipped: null };
	}

	return {
		/** The state for the lecture page and the lectures list: what is ready, for which voice, and the manifest. */
		summary(lecture: Lecture): AudioSummary {
			const language = languageOf(lecture);
			const voice = voiceFor(language);
			const ids = new Set(lecture.blocks.map((b) => b.id));
			const blocks = currentBlocks(lecture.id, language, voice).filter((b) => ids.has(b.blockId));
			const statuses = lecture.blocks.map((b) => {
				const entry = blocks.find((e) => e.blockId === b.id);
				return { blockId: b.id, status: (entry === undefined ? "missing" : entry.status) as BlockStatus };
			});
			const manifest = readManifest(lecture.id);
			return {
				keyConfigured: Boolean(deps.apiKey()),
				language,
				voice,
				ready: statuses.filter((s) => s.status === "ready").length,
				total: lecture.blocks.length,
				statuses,
				manifest: manifest === null ? null : { ...manifest, blocks: blocks.filter((b) => ids.has(b.blockId)) },
			};
		},
		/** Refuses (HttpError) when a generation could not start: no key, or a language with no voice. */
		requireSynthesis(lecture: Lecture): void {
			synthesisContext(lecture);
		},
		generateBlock,
		generateMissing,
		/** Starts every missing block in the background: never awaited, never throws. */
		prefetch(lecture: Lecture): void {
			void generateMissing(lecture).catch((err: unknown) => console.error("[ext] narration audio failed:", err));
		},
		/** The ready file of a block of this lecture, or null (unknown block, not ready, or the file is gone). */
		blockFile(lecture: Lecture, blockId: string): { path: string; size: number } | null {
			if (!BLOCK_ID_RE.test(blockId) || !lecture.blocks.some((b) => b.id === blockId)) return null;
			if (readyEntry(lecture, blockId) === null) return null;
			const file = blockFileOf(lecture.id, blockId);
			try {
				return { path: file, size: fs.statSync(file).size };
			} catch {
				return null;
			}
		},
		/** Drops a lecture's audio (the lecture was removed). */
		removeLecture(lectureId: string): void {
			if (!isValidLectureId(lectureId)) return;
			fs.rmSync(lectureDir(lectureId), { recursive: true, force: true });
		},
	};
}

export type LectureAudio = ReturnType<typeof createLectureAudio>;

/** The byte range an HTTP Range header asks for, over a file of `size` bytes. Unparseable or multi-range headers are ignored (whole file). */
export function audioRange(header: string | null, size: number): { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" } {
	if (header === null) return { kind: "full" };
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (m === null || (m[1] === "" && m[2] === "")) return { kind: "full" };
	if (m[1] === "") {
		const suffix = Number(m[2]);
		if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
		return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(m[1]);
	const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (start >= size || end < start) return { kind: "unsatisfiable" };
	return { kind: "partial", start, end };
}

