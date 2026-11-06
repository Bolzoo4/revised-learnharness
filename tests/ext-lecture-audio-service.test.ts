import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCostGate, type CostEvent } from "../src/core/ext/cost-gate.ts";
import { parseLecture, type Lecture } from "../src/core/ext/lecture/lecture.ts";
import { audioRange, createLectureAudio } from "../src/server/ext/lecture-audio.ts";
import { HttpError } from "../src/server/ext/http-error.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

const KEY = "dg_test_key_0123456789";
const VOICE_EN = "aura-2-thalia-en";
const EN_TEXT = "The set is closed under complements and the union of two sets is a set of the algebra. This is the first step of the proof.";
const EN_TEXT_2 = "We know that the family is closed under countable unions, and therefore it is a sigma algebra for the space.";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-audio-"));
	dirs.push(d);
	return d;
}

/** A lecture whose blocks are English prose (the fixture's blocks are too short to name a language). */
function englishLecture(texts: string[] = [EN_TEXT, EN_TEXT_2], id = "lec_b0123abcd_c02_l01"): Lecture {
	const base = makeLecture({ id });
	const blocks = texts.map((text, i) => ({ id: `b${i + 1}`, role: "narrate" as const, slideId: "s1", text, nodeIds: [], cues: [] }));
	return { ...base, blocks };
}

function memoryGate(ceilingUsd = 10) {
	const events: CostEvent[] = [];
	const gate = createCostGate({
		store: { appendEvent: (e) => void events.push(e), readEvents: () => [...events] },
		ceilingUsd,
		now: () => "2026-11-06T10:00:00.000Z",
	});
	return { gate, events, spent: () => events.reduce((s, e) => s + e.usd, 0) };
}

interface Sent {
	url: string;
	auth: string | null;
	text: string;
	spendAtSend: number;
}

/** A fake Deepgram: answers with `bytesPerChar` bytes per character; `plan(n)` may return a status for request n. */
function fakeDeepgram(opts: { bytesPerChar?: number; plan?: (n: number) => number | undefined; onSend?: () => void; gate?: { events: CostEvent[]; spent(): number } } = {}) {
	const sent: Sent[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = init?.headers as Record<string, string>;
		const body = JSON.parse(String(init?.body)) as { text: string };
		const n = sent.length;
		sent.push({ url: String(input), auth: headers.Authorization ?? null, text: body.text, spendAtSend: opts.gate?.spent() ?? 0 });
		opts.onSend?.();
		if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise((resolve) => setImmediate(resolve));
			const status = opts.plan?.(n);
			if (status !== undefined && status !== 200) return new Response("provider detail that must never leak", { status });
			return new Response(Buffer.alloc(body.text.length * (opts.bytesPerChar ?? 10), 7), { status: 200 });
		} finally {
			inFlight--;
		}
	};
	return { fetch: fetchFn as typeof fetch, sent, maxInFlight: () => maxInFlight };
}

function service(dir: string, over: Partial<Parameters<typeof createLectureAudio>[0]> & { key?: string | undefined; fetch?: typeof fetch; gate?: ReturnType<typeof memoryGate>["gate"] } = {}) {
	const sleeps: number[] = [];
	const audio = createLectureAudio({
		dir,
		apiKey: () => ("key" in over ? over.key : KEY),
		gate: over.gate ?? memoryGate().gate,
		voices: () => ({ it: "aura-2-livia-it", en: VOICE_EN }),
		fetch: over.fetch,
		sleep: async (ms) => void sleeps.push(ms),
		timeoutMs: 5000,
		maxAttempts: over.maxAttempts,
	});
	return { audio, sleeps };
}

describe("narration audio synthesis", () => {
	it("writes the block files and the manifest, with each chunk of the block text sent once", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch });
		const lecture = englishLecture();

		const report = await audio.generateMissing(lecture);
		assert.deepEqual(report, { generated: 2, skipped: null });
		assert.ok(deepgram.sent.length >= 2);
		for (const s of deepgram.sent) {
			assert.equal(s.url, `https://api.deepgram.com/v1/speak?model=${VOICE_EN}&encoding=mp3&bit_rate=48000`);
			assert.equal(s.auth, `Token ${KEY}`);
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, lecture.id, "audio.json"), "utf-8"));
		assert.equal(manifest.language, "en");
		assert.equal(manifest.voice, VOICE_EN);
		assert.equal(manifest.blocks.length, 2);
		const b1 = manifest.blocks[0];
		assert.equal(b1.status, "ready");
		assert.equal(b1.chars, EN_TEXT.length);
		assert.equal(b1.chunks[0].startChar, 0);
		assert.equal(b1.chunks.at(-1).endChar, EN_TEXT.length);
		const file = fs.readFileSync(path.join(dir, lecture.id, "b1.mp3"));
		assert.equal(file.length, b1.chunks.reduce((s: number, c: { bytes: number }) => s + c.bytes, 0));
		assert.ok(Math.abs(b1.durationSec - (file.length * 8) / 48000) < 1e-9);
		assert.equal(audio.blockFile(lecture, "b1")?.size, file.length);
	});

	it("never sends a whitespace-only chunk and never sends node link markup", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch });
		const text = `${"The set is closed under the union of two sets of the algebra. ".repeat(20)}${" ".repeat(1500)}The [[n_aaaa1111|sigma algebra]] is a set of the family.`;
		await audio.generateBlock(englishLecture([text]), "b1");
		assert.equal(deepgram.sent.some((s) => s.text.trim() === ""), false);
		assert.equal(deepgram.sent.some((s) => s.text.includes("[[")), false);
		assert.ok(deepgram.sent.some((s) => s.text.includes("sigma algebra is a set")));
	});

	it("serves the audio of a cached chunk without a request and without spend", async () => {
		const dir = tmpDir();
		const meter = memoryGate();
		const deepgram = fakeDeepgram({ gate: meter });
		const { audio } = service(dir, { fetch: deepgram.fetch, gate: meter.gate });
		await audio.generateMissing(englishLecture());
		const requests = deepgram.sent.length;
		const spent = meter.spent();
		assert.ok(spent > 0);

		// another lecture with the same text and voice: every chunk is a cache hit
		const again = englishLecture([EN_TEXT, EN_TEXT_2], "lec_b0123abcd_c03_l01");
		const report = await audio.generateMissing(again);
		assert.equal(report.generated, 2);
		assert.equal(deepgram.sent.length, requests);
		assert.equal(meter.spent(), spent);
	});

	it("records the spend before every request is sent", async () => {
		const dir = tmpDir();
		const meter = memoryGate();
		const deepgram = fakeDeepgram({ gate: meter });
		const { audio } = service(dir, { fetch: deepgram.fetch, gate: meter.gate });
		await audio.generateBlock(englishLecture(), "b1");
		for (const s of deepgram.sent) assert.ok(s.spendAtSend >= 0);
		// the first request is recorded before it is sent: at its send, the recorded spend includes its own cost
		assert.equal(meter.events.length, deepgram.sent.length);
		assert.equal(meter.events[0]!.source, "audio");
		assert.ok(deepgram.sent[0]!.spendAtSend > 0, "the request's own cost is already on the ledger when it is sent");
	});

	it("refuses when the audio gate is closed: no request, no file, no failed entry", async () => {
		const dir = tmpDir();
		const meter = memoryGate(0.0001);
		meter.gate.record(1, "audio");
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch, gate: meter.gate });
		await assert.rejects(audio.generateBlock(englishLecture(), "b1"), (err: unknown) => err instanceof HttpError && err.status === 429);
		assert.equal(deepgram.sent.length, 0);
		assert.equal(fs.existsSync(path.join(dir, "lec_b0123abcd_c02_l01", "audio.json")), false);
	});

	it("retries a 429 with a backoff and then succeeds", async () => {
		const dir = tmpDir();
		const meter = memoryGate();
		const deepgram = fakeDeepgram({ gate: meter, plan: (n) => (n === 0 ? 429 : 200) });
		const { audio, sleeps } = service(dir, { fetch: deepgram.fetch, gate: meter.gate });
		const entry = await audio.generateBlock(englishLecture([EN_TEXT]), "b1");
		assert.equal(entry.status, "ready");
		assert.deepEqual(sleeps, [1000]);
		assert.equal(deepgram.sent.length, 2, "one refused attempt, one that succeeds");
		assert.equal(meter.events.length, deepgram.sent.length, "every attempt is recorded before it is sent");
	});

	it("a failed block is recorded as failed with a fixed text, and the lecture stays valid", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram({ plan: () => 500 });
		const { audio } = service(dir, { fetch: deepgram.fetch, maxAttempts: 2 });
		const lecture = englishLecture([EN_TEXT]);
		const entry = await audio.generateBlock(lecture, "b1");
		assert.equal(entry.status, "failed");
		assert.equal(entry.error, "the text-to-speech service answered 500");
		assert.equal(parseLecture(JSON.parse(JSON.stringify(lecture))) !== null, true);
		const manifest = fs.readFileSync(path.join(dir, lecture.id, "audio.json"), "utf-8");
		assert.equal(manifest.includes("provider detail"), false);
		assert.equal(manifest.includes(KEY), false);
		assert.equal(audio.summary(lecture).statuses[0]!.status, "failed");
	});

	it("a refused key is a fixed text, and a network failure is retried then fixed", async () => {
		const dir = tmpDir();
		const refused = service(dir, { fetch: fakeDeepgram({ plan: () => 401 }).fetch });
		assert.equal((await refused.audio.generateBlock(englishLecture([EN_TEXT]), "b1")).error, "the text-to-speech key was refused");

		const down = service(tmpDir(), {
			fetch: (async () => {
				throw new TypeError("socket hang up");
			}) as unknown as typeof fetch,
			maxAttempts: 3,
		});
		const entry = await down.audio.generateBlock(englishLecture([EN_TEXT]), "b1");
		assert.equal(entry.error, "the text-to-speech service could not be reached");
		assert.deepEqual(down.sleeps, [1000, 2000]);
	});

	it("generates again a block that failed earlier, once the service answers", async () => {
		const dir = tmpDir();
		const lecture = englishLecture([EN_TEXT]);
		const failing = service(dir, { fetch: fakeDeepgram({ plan: () => 500 }).fetch, maxAttempts: 1 });
		assert.equal((await failing.audio.generateBlock(lecture, "b1")).status, "failed");
		const working = service(dir, { fetch: fakeDeepgram().fetch });
		assert.deepEqual(await working.audio.generateMissing(lecture), { generated: 1, skipped: null });
		assert.equal(working.audio.summary(lecture).ready, 1);
	});

	it("honours an abort: nothing is recorded for the block", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(audio.generateBlock(englishLecture([EN_TEXT]), "b1", { signal: controller.signal }));
		assert.equal(fs.existsSync(path.join(dir, "lec_b0123abcd_c02_l01", "audio.json")), false);
	});

	it("keeps at most four requests in flight for one block", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch });
		const long = Array.from({ length: 150 }, (_, i) => `Sentence number ${i} of the long block says that the set is closed under unions. `).join("");
		const entry = await audio.generateBlock(englishLecture([long]), "b1");
		assert.equal(entry.status, "ready");
		assert.ok(deepgram.sent.length > 4);
		assert.ok(deepgram.maxInFlight() <= 4, `in flight ${deepgram.maxInFlight()}`);
		assert.ok(deepgram.maxInFlight() > 1);
	});
});

describe("narration audio refusals before any work", () => {
	it("no key: 503 with the fixed text, and the batch is skipped", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { key: undefined, fetch: deepgram.fetch });
		const lecture = englishLecture();
		await assert.rejects(audio.generateBlock(lecture, "b1"), (err: unknown) => err instanceof HttpError && err.status === 503);
		assert.deepEqual(await audio.generateMissing(lecture), { generated: 0, skipped: "no-key" });
		assert.equal(deepgram.sent.length, 0);
		assert.equal(audio.summary(lecture).keyConfigured, false);
	});

	it("a language with no voice is refused and recorded; the batch is skipped", async () => {
		const dir = tmpDir();
		const deepgram = fakeDeepgram();
		const { audio } = service(dir, { fetch: deepgram.fetch });
		const lecture = englishLecture(["Sigma."]);
		await assert.rejects(audio.generateBlock(lecture, "b1"), (err: unknown) => err instanceof HttpError && err.status === 422);
		assert.deepEqual(await audio.generateMissing(lecture), { generated: 0, skipped: "language" });
		assert.equal(deepgram.sent.length, 0);
		assert.equal(audio.summary(lecture).language, "unknown");
	});

	it("an unknown block is 404 and never reaches the service", async () => {
		const deepgram = fakeDeepgram();
		const { audio } = service(tmpDir(), { fetch: deepgram.fetch });
		await assert.rejects(audio.generateBlock(englishLecture(), "../../etc"), (err: unknown) => err instanceof HttpError && err.status === 404);
		await assert.rejects(audio.generateBlock(englishLecture(), "b99"), (err: unknown) => err instanceof HttpError && err.status === 404);
		assert.equal(deepgram.sent.length, 0);
	});
});

describe("summary, voices and removal", () => {
	it("counts ready blocks for the current voice only, and forgets audio of another voice", async () => {
		const dir = tmpDir();
		const lecture = englishLecture();
		const { audio } = service(dir, { fetch: fakeDeepgram().fetch });
		await audio.generateMissing(lecture);
		assert.equal(audio.summary(lecture).ready, 2);
		assert.equal(audio.summary(lecture).total, 2);

		const other = createLectureAudio({ dir, apiKey: () => KEY, gate: memoryGate().gate, voices: () => ({ it: "aura-2-livia-it", en: "aura-2-odysseus-en" }) });
		assert.equal(other.summary(lecture).ready, 0);
		assert.equal(other.blockFile(lecture, "b1"), null);
	});

	it("removes a lecture's audio directory", async () => {
		const dir = tmpDir();
		const lecture = englishLecture([EN_TEXT]);
		const { audio } = service(dir, { fetch: fakeDeepgram().fetch });
		await audio.generateMissing(lecture);
		audio.removeLecture(lecture.id);
		assert.equal(fs.existsSync(path.join(dir, lecture.id)), false);
		audio.removeLecture("../escape");
	});

	it("prefetch never throws, even without a key", () => {
		const { audio } = service(tmpDir(), { key: undefined });
		assert.doesNotThrow(() => audio.prefetch(englishLecture()));
	});
});

describe("audioRange", () => {
	it("answers a whole file without a header, and the asked part of a range", () => {
		assert.deepEqual(audioRange(null, 100), { kind: "full" });
		assert.deepEqual(audioRange("bytes=10-19", 100), { kind: "partial", start: 10, end: 19 });
		assert.deepEqual(audioRange("bytes=90-", 100), { kind: "partial", start: 90, end: 99 });
		assert.deepEqual(audioRange("bytes=-10", 100), { kind: "partial", start: 90, end: 99 });
		assert.deepEqual(audioRange("bytes=50-500", 100), { kind: "partial", start: 50, end: 99 });
	});
	it("refuses an unsatisfiable range and ignores an unparseable one", () => {
		assert.deepEqual(audioRange("bytes=100-", 100), { kind: "unsatisfiable" });
		assert.deepEqual(audioRange("bytes=20-10", 100), { kind: "unsatisfiable" });
		assert.deepEqual(audioRange("bytes=-0", 100), { kind: "unsatisfiable" });
		assert.deepEqual(audioRange("items=1-2", 100), { kind: "full" });
		assert.deepEqual(audioRange("bytes=0-1, 5-6", 100), { kind: "full" });
	});
});
