// src/core/ext/lecture/audio.ts
/**
 * Narration audio (Deepgram Aura-2 text-to-speech), pure part: how a block's
 * text is cut into requests, which voice speaks it, what a request costs, the
 * manifest that records the result, and the mapping from the audio's clock to
 * a character offset of the block text (so the cues of the slides keep
 * working). No I/O here; the synthesis lives in src/server/ext/lecture-audio.ts.
 *
 * Offsets are UTF-16 code units, i.e. JavaScript string indices, the same unit
 * the speech engine reports. Billing uses the same unit: it is the larger of
 * the two common counts, so it never under-estimates.
 *
 * Timing approximation: Deepgram returns audio bytes only, with no timing data.
 * The output is a constant bit rate of 48000 bits per second, so a chunk's
 * duration is estimated as bytes * 8 / 48000 seconds. The estimate ignores the
 * container overhead, which is small at this rate; the chunk boundaries inside
 * a block are therefore approximate, the block's order is exact.
 */

import { isValidLectureId, stripNodeLinks } from "./lecture.ts";

export const AUDIO_MANIFEST_VERSION = 1;

/** Deepgram's speak endpoint (POST, JSON body {text}, query model/encoding/bit_rate). */
export const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
export const AUDIO_ENCODING = "mp3";
export const AUDIO_BIT_RATE = 48000;
/** Bytes per second of the constant-bit-rate output. */
export const AUDIO_BYTES_PER_SECOND = AUDIO_BIT_RATE / 8;
/** Deepgram refuses a request above 2000 characters (413); a chunk stays well below. */
export const AUDIO_MAX_REQUEST_CHARS = 2000;
export const AUDIO_CHUNK_CHARS = 800;
/** Requests in flight for one block (Deepgram allows 15; the app uses at most 4). */
export const AUDIO_CONCURRENCY = 4;
/** Deepgram's published price, USD per 1000 characters. */
export const AUDIO_USD_PER_1000_CHARS = 0.03;

export type AudioLanguage = "it" | "en";
export type AudioStatus = "ready" | "failed";

export function audioCostUsd(chars: number): number {
	return (chars * AUDIO_USD_PER_1000_CHARS) / 1000;
}

// ── chunking ────────────────────────────────────────────────────────────────

/** A half-open range [startChar, endChar) of the block text. */
export interface CharRange {
	startChar: number;
	endChar: number;
}

/** A node link `[[n_…]]` or `[[n_…|label]]` is one unit: a chunk never cuts inside it. */
const LINK_SPAN_RE = /\[\[[^\]]*\]\]/g;
/** A sentence ends with a run of . ! ? … (then closing quotes or brackets) and whitespace, or with a line break. */
const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*\s+|\n+/g;

function linkSpans(text: string): Array<[number, number]> {
	return [...text.matchAll(LINK_SPAN_RE)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * Cuts the block text into ranges of at most `maxChars` UTF-16 units that tile it exactly: in order,
 * no gap, no overlap, nothing dropped. Cuts fall at sentence ends where possible, else after the last
 * whitespace of the window, else at any code point (never inside a surrogate pair); node links stay whole.
 */
export function chunkText(text: string, maxChars: number = AUDIO_CHUNK_CHARS): CharRange[] {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be a positive integer");
	if (text.length === 0) return [];
	const spans = linkSpans(text);
	const insideLink = (p: number): boolean => spans.some(([s, e]) => s < p && p < e);

	// 1. sentence units: contiguous, ending at each sentence end and at the text's end
	const ends: number[] = [];
	for (const m of text.matchAll(SENTENCE_END_RE)) {
		const end = m.index + m[0].length;
		if (!insideLink(end)) ends.push(end);
	}
	if (ends.length === 0 || ends[ends.length - 1] !== text.length) ends.push(text.length);

	// 2. pieces: every unit longer than maxChars is cut again, so no piece exceeds the limit
	const pieces: CharRange[] = [];
	let start = 0;
	for (const end of ends) {
		let s = start;
		while (end - s > maxChars) {
			let cut = s + maxChars;
			for (let i = cut - 1; i > s; i--) {
				if (/\s/.test(text[i]!)) {
					cut = i + 1;
					break;
				}
			}
			const high = text.charCodeAt(cut - 1);
			if (cut - 1 > s && high >= 0xd800 && high <= 0xdbff) cut--;
			const span = spans.find(([a, b]) => a < cut && cut < b);
			if (span !== undefined) {
				const [a, b] = span;
				cut = a > s ? a : Math.min(b, s + maxChars);
			}
			pieces.push({ startChar: s, endChar: cut });
			s = cut;
		}
		pieces.push({ startChar: s, endChar: end });
		start = end;
	}

	// 3. chunks: consecutive pieces joined while the total stays within the limit
	const chunks: CharRange[] = [];
	for (const piece of pieces) {
		const last = chunks[chunks.length - 1];
		if (last !== undefined && piece.endChar - last.startChar <= maxChars) last.endChar = piece.endChar;
		else chunks.push({ ...piece });
	}
	return chunks;
}

// ── language and voices ─────────────────────────────────────────────────────

const IT_STOPWORDS = new Set(["il", "lo", "la", "gli", "le", "di", "che", "e", "è", "un", "una", "per", "con", "non", "sono", "del", "della", "dei", "delle", "nel", "nella", "anche", "come", "questo", "questa", "più", "ma", "da", "alla", "dello", "degli"]);
const EN_STOPWORDS = new Set(["the", "and", "of", "to", "is", "are", "that", "with", "for", "this", "it", "as", "by", "from", "an", "be", "which", "or", "on", "was", "were", "have", "has", "not", "we", "can"]);
const MIN_STOPWORD_HITS = 5;
const MIN_SHARE = 0.7;

/**
 * The language of a text by its stopwords: "it" or "en" when one language clearly dominates,
 * "unknown" otherwise (too few function words, or a mix). Unknown texts get no Deepgram audio.
 */
export function guessLanguage(text: string): AudioLanguage | "unknown" {
	let it = 0;
	let en = 0;
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
		if (IT_STOPWORDS.has(word)) it++;
		else if (EN_STOPWORDS.has(word)) en++;
	}
	const total = it + en;
	if (total < MIN_STOPWORD_HITS) return "unknown";
	if (it > en && it / total >= MIN_SHARE) return "it";
	if (en > it && en / total >= MIN_SHARE) return "en";
	return "unknown";
}

/** The language of a lecture's narration: the stripped text of all its blocks. */
export function languageOfBlocks(blocks: ReadonlyArray<{ text: string }>): AudioLanguage | "unknown" {
	return guessLanguage(blocks.map((b) => stripNodeLinks(b.text)).join("\n"));
}

export const DEFAULT_AUDIO_VOICES: Readonly<Record<AudioLanguage, string>> = {
	it: "aura-2-livia-it",
	en: "aura-2-thalia-en",
};

const VOICE_RE = /^aura-2-[a-z]+-(it|en)$/;

export function isVoiceFor(voice: string, language: AudioLanguage): boolean {
	const m = VOICE_RE.exec(voice);
	return m !== null && m[1] === language;
}

/**
 * The voices per language: the defaults, each overridden by LH_EXT_AUDIO_VOICE_IT / LH_EXT_AUDIO_VOICE_EN
 * when it is an Aura-2 voice of that language (anything else keeps the default).
 */
export function audioVoicesFromEnv(env: Record<string, string | undefined>): Record<AudioLanguage, string> {
	const pick = (language: AudioLanguage, raw: string | undefined): string => (raw !== undefined && isVoiceFor(raw.trim(), language) ? raw.trim() : DEFAULT_AUDIO_VOICES[language]);
	return { it: pick("it", env.LH_EXT_AUDIO_VOICE_IT), en: pick("en", env.LH_EXT_AUDIO_VOICE_EN) };
}

/** The Deepgram speak URL for one voice (the body is {text}; the key goes in the Authorization header). */
export function speakUrl(voice: string): string {
	return `${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(voice)}&encoding=${AUDIO_ENCODING}&bit_rate=${AUDIO_BIT_RATE}`;
}

// ── manifest ────────────────────────────────────────────────────────────────

/** One request's piece of a block: its text range, where it starts on the audio clock, how long it plays. */
export interface AudioChunk {
	startChar: number;
	endChar: number;
	startSec: number;
	durationSec: number;
	bytes: number;
}

export interface AudioBlock {
	blockId: string;
	status: AudioStatus;
	/** The block text's length (UTF-16 units). */
	chars: number;
	durationSec: number;
	/** Tiles [0, chars) in order for a ready block; empty for a failed one. */
	chunks: AudioChunk[];
	/** A fixed text saying why the block failed (never the provider's text, never the key). */
	error?: string;
}

/** data/ext/lecture-audio/<lectureId>/audio.json: the voice, the language, and each block's outcome. */
export interface AudioManifest {
	version: typeof AUDIO_MANIFEST_VERSION;
	lectureId: string;
	language: AudioLanguage | "unknown";
	voice: string | null;
	blocks: AudioBlock[];
}

export const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Duration of a chunk of `bytes` bytes of constant-bit-rate audio (the documented approximation). */
export function chunkDurationSec(bytes: number): number {
	return (bytes * 8) / AUDIO_BIT_RATE;
}

/** The chunks of a block with their start on the audio clock: each starts where the previous one ends. */
export function timedChunks(ranges: readonly CharRange[], bytes: readonly number[]): AudioChunk[] {
	if (ranges.length !== bytes.length) throw new RangeError("one byte count per chunk range");
	let startSec = 0;
	return ranges.map((r, i) => {
		const durationSec = chunkDurationSec(bytes[i]!);
		const chunk = { startChar: r.startChar, endChar: r.endChar, startSec, durationSec, bytes: bytes[i]! };
		startSec += durationSec;
		return chunk;
	});
}

const TIME_EPSILON = 1e-6;

/** Structural check of a manifest; null when this build does not understand it. Ready blocks must tile their text. */
export function parseAudioManifest(raw: unknown): AudioManifest | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.version !== AUDIO_MANIFEST_VERSION || !isValidLectureId(r.lectureId)) return null;
	if (r.language !== "it" && r.language !== "en" && r.language !== "unknown") return null;
	if (!Array.isArray(r.blocks)) return null;
	const language = r.language;
	if (r.voice !== null && (typeof r.voice !== "string" || language === "unknown" || !isVoiceFor(r.voice, language))) return null;
	const seen = new Set<string>();
	const blocks: AudioBlock[] = [];
	for (const b of r.blocks) {
		const block = parseAudioBlock(b);
		if (block === null || seen.has(block.blockId)) return null;
		seen.add(block.blockId);
		blocks.push(block);
	}
	return { version: AUDIO_MANIFEST_VERSION, lectureId: r.lectureId, language, voice: r.voice as string | null, blocks };
}

function parseAudioBlock(raw: unknown): AudioBlock | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const b = raw as Record<string, unknown>;
	if (typeof b.blockId !== "string" || !BLOCK_ID_RE.test(b.blockId)) return null;
	if (b.status !== "ready" && b.status !== "failed") return null;
	if (!Number.isInteger(b.chars) || (b.chars as number) < 0) return null;
	if (typeof b.durationSec !== "number" || !Number.isFinite(b.durationSec) || b.durationSec < 0) return null;
	if (!Array.isArray(b.chunks)) return null;
	const chunks: AudioChunk[] = [];
	for (const c of b.chunks) {
		if (typeof c !== "object" || c === null) return null;
		const k = c as Record<string, unknown>;
		const ok =
			Number.isInteger(k.startChar) && Number.isInteger(k.endChar) && typeof k.startSec === "number" && Number.isFinite(k.startSec) && k.startSec >= 0 &&
			typeof k.durationSec === "number" && Number.isFinite(k.durationSec) && k.durationSec >= 0 && Number.isInteger(k.bytes) && (k.bytes as number) >= 0 &&
			(k.startChar as number) < (k.endChar as number);
		if (!ok) return null;
		chunks.push({ startChar: k.startChar as number, endChar: k.endChar as number, startSec: k.startSec as number, durationSec: k.durationSec as number, bytes: k.bytes as number });
	}
	if (b.status === "ready") {
		const chars = b.chars as number;
		let at = 0;
		let sec = 0;
		for (const c of chunks) {
			if (c.startChar !== at || Math.abs(c.startSec - sec) > TIME_EPSILON) return null;
			at = c.endChar;
			sec += c.durationSec;
		}
		if (at !== chars && !(chars === 0 && chunks.length === 0)) return null;
		if (Math.abs(sec - (b.durationSec as number)) > TIME_EPSILON) return null;
	} else if (chunks.length > 0) return null;
	const block: AudioBlock = { blockId: b.blockId, status: b.status, chars: b.chars as number, durationSec: b.durationSec as number, chunks };
	if (typeof b.error === "string") block.error = b.error;
	return block;
}

// ── the audio clock to the text ─────────────────────────────────────────────

/**
 * The character offset of the block text being spoken at `seconds` on the audio clock: inside a chunk,
 * linear between its start and end; past a chunk's end, the chunk's end. Before the start, the first offset.
 * Monotonic in time, so the cues of activeCue keep their order. A block without chunks is at 0.
 */
export function charIndexAtTime(block: Pick<AudioBlock, "chunks">, seconds: number): number {
	const chunks = block.chunks;
	if (chunks.length === 0) return 0;
	if (!(seconds > 0)) return chunks[0]!.startChar;
	let current = chunks[0]!;
	for (const c of chunks) if (c.startSec <= seconds) current = c;
	const end = current.startSec + current.durationSec;
	if (seconds >= end || current.durationSec === 0) return current.endChar;
	const span = current.endChar - current.startChar;
	const fraction = (seconds - current.startSec) / current.durationSec;
	return Math.min(current.endChar - 1, current.startChar + Math.floor(fraction * span));
}
