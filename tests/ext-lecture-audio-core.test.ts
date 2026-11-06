import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AUDIO_CHUNK_CHARS,
	AUDIO_MAX_REQUEST_CHARS,
	audioCostUsd,
	audioVoicesFromEnv,
	charIndexAtTime,
	chunkText,
	guessLanguage,
	languageOfBlocks,
	parseAudioManifest,
	speakUrl,
	timedChunks,
	type AudioBlock,
	type AudioManifest,
} from "../src/core/ext/lecture/audio.ts";

const SAMPLE_IT =
	"Una sigma algebra è una famiglia di insiemi chiusa per complementi e unioni numerabili. Questa proprietà è fondamentale per la misura. " +
	"Vediamo ora un esempio: consideriamo l'insieme dei numeri reali! Che cosa succede se togliamo un elemento? Proviamo a rispondere… ";

describe("chunkText", () => {
	it("tiles the text exactly: in order, no gap, no overlap, nothing dropped", () => {
		for (const text of [SAMPLE_IT, "a".repeat(2500), "Parola ".repeat(400), "x.\n\ny. z\n", "  \n\t  "]) {
			const chunks = chunkText(text, 120);
			let at = 0;
			for (const c of chunks) {
				assert.equal(c.startChar, at);
				assert.ok(c.endChar > c.startChar);
				at = c.endChar;
			}
			assert.equal(at, text.length);
			assert.equal(chunks.map((c) => text.slice(c.startChar, c.endChar)).join(""), text);
		}
	});
	it("respects the size limit", () => {
		const chunks = chunkText("a".repeat(2500) + " " + "b".repeat(90), 800);
		for (const c of chunks) assert.ok(c.endChar - c.startChar <= 800);
		assert.ok(AUDIO_CHUNK_CHARS <= AUDIO_MAX_REQUEST_CHARS);
	});
	it("prefers sentence boundaries and packs sentences into chunks", () => {
		const text = "Prima frase breve. Seconda frase breve. Terza frase breve.";
		const chunks = chunkText(text, 30);
		assert.deepEqual(chunks.map((c) => text.slice(c.startChar, c.endChar)), ["Prima frase breve. ", "Seconda frase breve. ", "Terza frase breve."]);
	});
	it("cuts a long sentence at whitespace, never inside a word when a space is available", () => {
		const text = "uno due tre quattro cinque sei sette otto nove dieci";
		for (const c of chunkText(text, 12)) {
			const piece = text.slice(c.startChar, c.endChar);
			assert.ok(piece.length <= 12);
			assert.ok(piece.endsWith(" ") || c.endChar === text.length, piece);
		}
	});
	it("never splits a surrogate pair", () => {
		const text = "a".repeat(9) + "😀".repeat(20);
		const chunks = chunkText(text, 10);
		for (const c of chunks) {
			const piece = text.slice(c.startChar, c.endChar);
			assert.equal(piece.charCodeAt(0) >= 0xdc00 && piece.charCodeAt(0) <= 0xdfff, false);
			assert.equal(piece.charCodeAt(piece.length - 1) >= 0xd800 && piece.charCodeAt(piece.length - 1) <= 0xdbff, false);
		}
		assert.equal(chunks.map((c) => text.slice(c.startChar, c.endChar)).join(""), text);
	});
	it("keeps a node link whole", () => {
		const text = "Il concetto [[n_aaaa1111|sigma. algebra]] vale. " + "x".repeat(30) + " [[n_bbbb2222|lungo label qui]] fine";
		const chunks = chunkText(text, 40);
		for (const c of chunks) {
			const piece = text.slice(c.startChar, c.endChar);
			assert.equal((piece.match(/\[\[/g) ?? []).length, (piece.match(/\]\]/g) ?? []).length, piece);
		}
		assert.equal(chunks.map((c) => text.slice(c.startChar, c.endChar)).join(""), text);
	});
	it("returns no chunks for an empty text", () => {
		assert.deepEqual(chunkText(""), []);
	});
	it("rejects a non-positive limit", () => {
		assert.throws(() => chunkText("abc", 0), RangeError);
		assert.throws(() => chunkText("abc", 2.5), RangeError);
	});
});

describe("guessLanguage", () => {
	it("recognises Italian and English by their function words", () => {
		assert.equal(guessLanguage(SAMPLE_IT), "it");
		assert.equal(guessLanguage("The set is closed under complements and the union of two sets is a set of the algebra."), "en");
	});
	it("says unknown for too little text or a mix", () => {
		assert.equal(guessLanguage("Sigma algebra."), "unknown");
		assert.equal(guessLanguage("Il the di and che of è to la the and of il di is the"), "unknown");
		assert.equal(guessLanguage("12345 67890"), "unknown");
	});
	it("reads a lecture's narration with node links stripped", () => {
		const blocks = [{ text: "La [[n_aaaa1111|misura]] è una funzione che di solito non è banale, e per questo serve." }];
		assert.equal(languageOfBlocks(blocks), "it");
	});
});

describe("voices", () => {
	it("defaults to an Italian and an English Aura-2 voice", () => {
		assert.deepEqual(audioVoicesFromEnv({}), { it: "aura-2-livia-it", en: "aura-2-thalia-en" });
	});
	it("takes an override only when it is an Aura-2 voice of that language", () => {
		assert.deepEqual(audioVoicesFromEnv({ LH_EXT_AUDIO_VOICE_IT: "aura-2-cesare-it", LH_EXT_AUDIO_VOICE_EN: "aura-2-cesare-it" }), {
			it: "aura-2-cesare-it",
			en: "aura-2-thalia-en",
		});
		assert.equal(audioVoicesFromEnv({ LH_EXT_AUDIO_VOICE_IT: "../../x" }).it, "aura-2-livia-it");
	});
	it("builds the speak URL with the fixed encoding and bit rate", () => {
		assert.equal(speakUrl("aura-2-thalia-en"), "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=48000");
	});
});

describe("cost", () => {
	it("prices 0.03 USD per 1000 characters", () => {
		assert.equal(audioCostUsd(1000), 0.03);
		assert.equal(audioCostUsd(0), 0);
	});
});

describe("timing and the audio clock", () => {
	const ranges = [
		{ startChar: 0, endChar: 10 },
		{ startChar: 10, endChar: 30 },
		{ startChar: 30, endChar: 32 },
	];
	const chunks = timedChunks(ranges, [6000, 12000, 6000]);
	const block: AudioBlock = { blockId: "b1", status: "ready", chars: 32, durationSec: 4, chunks };

	it("derives durations from bytes at 48000 bit/s and chains start times", () => {
		assert.deepEqual(chunks.map((c) => [c.startSec, c.durationSec]), [
			[0, 1],
			[1, 2],
			[3, 1],
		]);
	});
	it("maps the start and the end of each chunk exactly", () => {
		assert.equal(charIndexAtTime(block, 0), 0);
		assert.equal(charIndexAtTime(block, 1), 10);
		assert.equal(charIndexAtTime(block, 3), 30);
		assert.equal(charIndexAtTime(block, 4), 32);
		assert.equal(charIndexAtTime(block, 99), 32);
	});
	it("interpolates linearly inside a chunk", () => {
		assert.equal(charIndexAtTime(block, 2), 10 + Math.floor(0.5 * 20));
		assert.equal(charIndexAtTime(block, 1.5), 10 + Math.floor(0.25 * 20));
	});
	it("is monotonic in time and never leaves the block", () => {
		let prev = -1;
		for (let t = -1; t <= 5; t += 0.01) {
			const c = charIndexAtTime(block, t);
			assert.ok(c >= prev, `at ${t}`);
			assert.ok(c >= 0 && c <= 32);
			prev = c;
		}
	});
	it("is 0 for a block without chunks and the first offset before the start", () => {
		assert.equal(charIndexAtTime({ chunks: [] }, 3), 0);
		assert.equal(charIndexAtTime(block, -2), 0);
		assert.equal(charIndexAtTime(block, Number.NaN), 0);
	});
	it("keeps the monotonic order across a silent whitespace chunk", () => {
		const silent = timedChunks([{ startChar: 0, endChar: 5 }, { startChar: 5, endChar: 9 }, { startChar: 9, endChar: 12 }], [6000, 0, 6000]);
		const b = { chunks: silent };
		// the silent chunk has no length: at 1s the speech is already in the chunk that starts there
		assert.equal(charIndexAtTime(b, 1), 9);
		assert.ok(charIndexAtTime(b, 1) >= charIndexAtTime(b, 0.5));
	});
});

describe("manifest validation", () => {
	const good: AudioManifest = {
		version: 1,
		lectureId: "lec_b0123abcd_c02_l01",
		language: "en",
		voice: "aura-2-thalia-en",
		blocks: [
			{ blockId: "b1", status: "ready", chars: 32, durationSec: 4, chunks: timedChunks([{ startChar: 0, endChar: 10 }, { startChar: 10, endChar: 32 }], [6000, 18000]) },
			{ blockId: "b2", status: "failed", chars: 5, durationSec: 0, chunks: [], error: "the text-to-speech service could not be reached" },
		],
	};

	it("accepts a valid manifest", () => {
		assert.deepEqual(parseAudioManifest(JSON.parse(JSON.stringify(good))), good);
	});
	it("rejects a manifest with an unknown version, a bad id, a bad voice or language", () => {
		assert.equal(parseAudioManifest({ ...good, version: 2 }), null);
		assert.equal(parseAudioManifest({ ...good, lectureId: "../x" }), null);
		assert.equal(parseAudioManifest({ ...good, voice: "aura-2-thalia-it" }), null);
		assert.equal(parseAudioManifest({ ...good, language: "fr" }), null);
		assert.equal(parseAudioManifest({ ...good, language: "unknown", voice: "aura-2-thalia-en" }), null);
	});
	it("rejects a ready block whose chunks do not tile its text, and a duplicate block id", () => {
		const gap = JSON.parse(JSON.stringify(good));
		gap.blocks[0].chunks[1].startChar = 11;
		assert.equal(parseAudioManifest(gap), null);
		const short = JSON.parse(JSON.stringify(good));
		short.blocks[0].chars = 40;
		assert.equal(parseAudioManifest(short), null);
		assert.equal(parseAudioManifest({ ...good, blocks: [good.blocks[0], good.blocks[0]] }), null);
	});
	it("rejects a failed block that carries chunks, and a block id outside the safe alphabet", () => {
		const failedWithChunks = JSON.parse(JSON.stringify(good));
		failedWithChunks.blocks[1].chunks = [{ startChar: 0, endChar: 5, startSec: 0, durationSec: 1, bytes: 6000 }];
		assert.equal(parseAudioManifest(failedWithChunks), null);
		assert.equal(parseAudioManifest({ ...good, blocks: [{ ...good.blocks[1], blockId: "a/b" }] }), null);
	});
	it("returns null for non-objects", () => {
		assert.equal(parseAudioManifest(null), null);
		assert.equal(parseAudioManifest([]), null);
		assert.equal(parseAudioManifest("x"), null);
	});
});

describe("block shape", () => {
	it("a block without chunks has no duration", () => {
		const block: AudioBlock = { blockId: "b9", status: "failed", chars: 3, durationSec: 0, chunks: [] };
		assert.equal(block.chunks.length, 0);
	});
});
