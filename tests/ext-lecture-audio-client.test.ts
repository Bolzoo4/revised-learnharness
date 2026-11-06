import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	audioSourceFor,
	audioUrl,
	canGenerate,
	fetchAudioState,
	generateBlockAudio,
	readyBlocks,
	startLectureAudio,
} from "../components/ext/lecture-audio-client.ts";
import { audioLineText, buildLectureTree, canGenerateAudioLine } from "../components/ext/lectures-tree.ts";

const LEC = "lec_b0123abcd_c02_l01";
const READY = { blockId: "b1", status: "ready" as const, chars: 5, durationSec: 1, chunks: [{ startChar: 0, endChar: 5, startSec: 0, durationSec: 1, bytes: 6000 }] };

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("which voice speaks a block", () => {
	it("uses ready audio first, then the on-demand audio when a key exists, else the browser voice", () => {
		assert.equal(audioSourceFor({ ready: true, canGenerate: true }), "audio");
		assert.equal(audioSourceFor({ ready: true, canGenerate: false }), "audio");
		assert.equal(audioSourceFor({ ready: false, canGenerate: true }), "generate");
		assert.equal(audioSourceFor({ ready: false, canGenerate: false }), "speech");
	});
	it("can generate only with a key and a language that has a voice", () => {
		assert.equal(canGenerate({ keyConfigured: true, language: "it" }), true);
		assert.equal(canGenerate({ keyConfigured: true, language: "unknown" }), false);
		assert.equal(canGenerate({ keyConfigured: false, language: "en" }), false);
	});
	it("builds the audio URL from the two ids, encoded", () => {
		assert.equal(audioUrl(LEC, "b1"), `/api/ext/lectures/${LEC}/audio/b1`);
		assert.equal(audioUrl(LEC, "a b"), `/api/ext/lectures/${LEC}/audio/a%20b`);
	});
	it("keeps only the ready blocks of a manifest", () => {
		const manifest = {
			version: 1 as const,
			lectureId: LEC,
			language: "en" as const,
			voice: "aura-2-thalia-en",
			blocks: [READY, { blockId: "b2", status: "failed" as const, chars: 3, durationSec: 0, chunks: [], error: "x" }],
		};
		assert.deepEqual(Object.keys(readyBlocks(manifest)), ["b1"]);
		assert.deepEqual(readyBlocks(null), {});
	});
});

describe("the requests", () => {
	it("reads the state, and reports null when it cannot", async () => {
		const state = { keyConfigured: true, language: "en", voice: "aura-2-thalia-en", ready: 0, total: 2, manifest: null };
		const seen: string[] = [];
		const got = await fetchAudioState(LEC, async (url) => (seen.push(url), reply(200, state)));
		assert.deepEqual(got, state);
		assert.deepEqual(seen, [`/api/ext/lectures/${LEC}/audio`]);
		assert.equal(await fetchAudioState(LEC, async () => reply(404, { error: "unknown lecture" })), null);
		assert.equal(await fetchAudioState(LEC, async () => {
			throw new TypeError("offline");
		}), null);
	});

	it("generates a block on demand and returns it when ready; null otherwise", async () => {
		const bodies: unknown[] = [];
		const ok = await generateBlockAudio(LEC, "b1", async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), reply(200, { block: READY })));
		assert.deepEqual(ok, READY);
		assert.deepEqual(bodies, [{ blockId: "b1" }]);
		assert.equal(await generateBlockAudio(LEC, "b7", async () => reply(502, { error: "x" })), null);
		assert.equal(await generateBlockAudio(LEC, "b8", async () => {
			throw new TypeError("offline");
		}), null);
	});

	it("shares a generation already running for the same block", async () => {
		let calls = 0;
		const slow = async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return reply(200, { block: READY });
		};
		const [a, b] = await Promise.all([generateBlockAudio(LEC, "b3", slow), generateBlockAudio(LEC, "b3", slow)]);
		assert.equal(calls, 1);
		assert.deepEqual(a, b);
	});

	it("starts the batch and reports the server's fixed sentence when refused", async () => {
		let sent: unknown = null;
		assert.equal(await startLectureAudio(LEC, async (_u, init) => ((sent = JSON.parse(String(init?.body))), reply(202, { started: true }))), null);
		assert.deepEqual(sent, {});
		assert.equal(await startLectureAudio(LEC, async () => reply(503, { error: "no text-to-speech key is configured (DEEPGRAM_API_KEY)" })), "no text-to-speech key is configured (DEEPGRAM_API_KEY)");
		assert.equal(await startLectureAudio(LEC, async () => {
			throw new TypeError("offline");
		}), "The audio could not be started.");
	});
});

describe("the lectures tree's audio line", () => {
	it("says how many blocks are ready, and why the browser voice is used without a key", () => {
		assert.equal(audioLineText({ ready: 2, total: 5, keyConfigured: true }), "Audio: 2 of 5 blocks ready");
		assert.equal(audioLineText({ ready: 0, total: 1, keyConfigured: true }), "Audio: 0 of 1 block ready");
		assert.equal(audioLineText({ ready: 0, total: 3, keyConfigured: false }), "Audio: 0 of 3 blocks ready (no Deepgram key: the browser voice is used)");
	});
	it("offers the button only with a key and a missing block", () => {
		assert.equal(canGenerateAudioLine({ ready: 2, total: 5, keyConfigured: true }), true);
		assert.equal(canGenerateAudioLine({ ready: 5, total: 5, keyConfigured: true }), false);
		assert.equal(canGenerateAudioLine({ ready: 0, total: 5, keyConfigured: false }), false);
	});
	it("carries the lecture's audio counts through the tree", () => {
		const books = buildLectureTree([], [{ id: LEC, bookId: "b0123abcd", title: "T", bookTitle: "B", chapter: { index: 2, title: "C" }, order: 1, exercises: [], audio: { ready: 1, total: 4, keyConfigured: true } }]);
		assert.deepEqual(books[0]!.chapters[0]!.lectures[0]!.audio, { ready: 1, total: 4, keyConfigured: true });
	});
});
