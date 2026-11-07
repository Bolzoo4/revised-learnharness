// tests/ext-exams-service.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createExamsStore } from "../src/store/ext/exams-store.ts";
import type { ExerciseSplitter } from "../src/agent/ext/exams/exercise-splitter.ts";
import { SplitRefused, type RawExercise } from "../src/core/ext/exams/split.ts";
import { createExamsService, ExamsError, hasTextLayer, type StagedFile } from "../src/server/ext/exams-service.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake PDF: the bytes after the magic are the page texts, separated by a marker. */
const SEP = "\n---PAGE---\n";
const pdf = (...pages: string[]) => new File([`%PDF-1.4\n${pages.join(SEP)}`], "x.pdf", { type: "application/pdf" });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function harness(opts: { splitter?: ExerciseSplitter; maxPdfBytes?: number; documentFileId?: string } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exams-svc-"));
	dirs.push(dir);
	const store = createExamsStore(dir);
	const staged = new Map<string, Uint8Array>();
	let n = 0;
	const putPdfCalls: string[] = [];
	const splitCalls: Array<{ title: string; pages: readonly string[] }> = [];
	const readCalls: string[] = [];
	const splitter: ExerciseSplitter = opts.splitter ?? {
		async split(input) {
			splitCalls.push({ title: input.title, pages: input.pages });
			return input.pages.map((p, i): RawExercise => ({ pageStart: i + 1, pageEnd: i + 1, text: p.trim() }));
		},
	};
	const service = createExamsService({
		store,
		files: {
			putPdf(bytes) {
				putPdfCalls.push(sha(bytes));
				const id = opts.documentFileId ?? sha(bytes);
				return { id, path: `/stored/${id}.pdf` };
			},
			putPages() {},
		},
		async stage(bytes): Promise<StagedFile> {
			const p = `/staged/${++n}.pdf`;
			staged.set(p, bytes);
			return {
				path: p,
				async release() {
					staged.delete(p);
				},
			};
		},
		async readPages(p) {
			readCalls.push(p);
			const text = new TextDecoder().decode(staged.get(p)!).replace(/^%PDF-1\.4\n/, "");
			const pages = text.split(SEP);
			return { pageCount: pages.length, pages };
		},
		splitter,
		maxPdfBytes: opts.maxPdfBytes,
		now: () => "2026-11-07T10:00:00.000Z",
		newId: (() => {
			let k = 0;
			return () => `id${++k}`;
		})(),
	});
	return { service, store, dir, putPdfCalls, splitCalls, readCalls, staged };
}

const LONG = "Esercizio 1. Calcola il tempo medio di risposta con un algoritmo di scheduling round robin. ".repeat(3);

async function refused(promise: Promise<unknown>, status: number, message: string | RegExp) {
	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof ExamsError, `expected ExamsError, got ${String(err)}`);
		assert.equal(err.status, status);
		if (typeof message === "string") assert.equal(err.message, message);
		else assert.match(err.message, message);
		return true;
	});
}

describe("collections (REQ-ex-01)", () => {
	it("creates a collection with a flattened title and lists it; an unknown id reads as null", () => {
		const { service, store } = harness();
		const c = service.createCollection("  Sistemi\n operativi ");
		assert.deepEqual(c, { id: "id1", title: "Sistemi operativi", createdAt: "2026-11-07T10:00:00.000Z" });
		assert.deepEqual(service.listCollections(), [c]);
		assert.equal(service.getCollection("nope"), null);
		assert.deepEqual(store.readCollection("id1"), c);
	});

	it("refuses a blank or a non-text title", () => {
		const { service } = harness();
		assert.throws(() => service.createCollection("   "), (e: unknown) => e instanceof ExamsError && e.status === 400);
		assert.throws(() => service.createCollection(42), (e: unknown) => e instanceof ExamsError && e.status === 400);
	});
});

describe("exam loading (REQ-ex-02)", () => {
	it("refuses a file that is not a PDF, stores nothing and reads nothing", async () => {
		const h = harness();
		const c = h.service.createCollection("Algoritmi");
		await refused(h.service.addExam(c.id, new File(["hello"], "a.txt")), 400, "that file is not a PDF");
		assert.deepEqual(h.readCalls, []);
		assert.deepEqual(h.service.getCollection(c.id)!.exams, []);
	});

	it("refuses a PDF over the size limit before reading it", async () => {
		const h = harness({ maxPdfBytes: 20 });
		const c = h.service.createCollection("Algoritmi");
		await refused(h.service.addExam(c.id, pdf(LONG)), 413, "that PDF is too large (limit 500 MB)");
		assert.deepEqual(h.readCalls, []);
	});

	it("refuses a PDF with no text layer with the fixed scan message, and stores nothing", async () => {
		const h = harness();
		const c = h.service.createCollection("Algoritmi");
		await refused(h.service.addExam(c.id, pdf("", "  ")), 422, /no text layer \(it looks like a scan\)/);
		assert.equal(h.splitCalls.length, 0);
		assert.deepEqual(h.service.getCollection(c.id)!.exams, []);
	});

	it("splits the exam into exercises, stores them in order, and leaves the exam unreviewed", async () => {
		const h = harness();
		const c = h.service.createCollection("Algoritmi");
		const exam = await h.service.addExam(c.id, pdf(LONG, LONG), "Esame 2024");
		assert.equal(exam.title, "Esame 2024");
		assert.equal(exam.pages, 2);
		assert.equal(exam.reviewed, false);
		assert.equal(exam.collectionId, c.id);
		assert.equal(h.splitCalls.length, 1);
		const exercises = h.service.listExercises(exam.id);
		assert.deepEqual(exercises.map((e) => [e.order, e.pageStart, e.pageEnd]), [[1, 1, 1], [2, 2, 2]]);
		assert.equal(exercises[0]!.examId, exam.id);
	});

	it("the same bytes again are recognised even when the documents store answers with another id", async () => {
		const h = harness({ documentFileId: "stored-elsewhere" });
		const c = h.service.createCollection("Algoritmi");
		const a = await h.service.addExam(c.id, pdf(LONG));
		const b = await h.service.addExam(c.id, pdf(LONG));
		assert.equal(a.id, b.id);
		assert.equal(h.splitCalls.length, 1);
	});

	it("the same bytes again give the same exam without splitting twice", async () => {
		const h = harness();
		const c = h.service.createCollection("Algoritmi");
		const a = await h.service.addExam(c.id, pdf(LONG));
		const b = await h.service.addExam(c.id, pdf(LONG));
		assert.deepEqual(a, b);
		assert.equal(h.splitCalls.length, 1);
		assert.equal(h.service.getCollection(c.id)!.exams.length, 1);
	});

	it("a refused split stores nothing: the cost ceiling answers 429, any other failure 422 with a fixed message", async () => {
		const ceiling: ExerciseSplitter = { split: async () => Promise.reject(new SplitRefused("ceiling")) };
		const h1 = harness({ splitter: ceiling });
		const c1 = h1.service.createCollection("A");
		await refused(h1.service.addExam(c1.id, pdf(LONG)), 429, /daily cost ceiling/);
		assert.deepEqual(h1.service.getCollection(c1.id)!.exams, []);

		const broken: ExerciseSplitter = { split: async () => Promise.reject(new Error("secret provider text 123")) };
		const h2 = harness({ splitter: broken });
		const c2 = h2.service.createCollection("A");
		await assert.rejects(h2.service.addExam(c2.id, pdf(LONG)), (e: unknown) => {
			assert.ok(e instanceof ExamsError);
			assert.equal(e.status, 422);
			assert.doesNotMatch(e.message, /secret/);
			return true;
		});
		assert.deepEqual(h2.service.getCollection(c2.id)!.exams, []);
	});

	it("an unknown collection is a 404", async () => {
		const h = harness();
		await refused(h.service.addExam("missing", pdf(LONG)), 404, "unknown collection");
	});
});

describe("exercise edits and review (REQ-ex-03)", () => {
	async function withExam() {
		const h = harness({
			splitter: {
				async split() {
					return [
						{ pageStart: 1, pageEnd: 1, text: "Primo esercizio." },
						{ pageStart: 1, pageEnd: 2, text: "Secondo esercizio." },
					];
				},
			},
		});
		const c = h.service.createCollection("Algoritmi");
		const exam = await h.service.addExam(c.id, pdf(LONG));
		return { h, exam };
	}

	it("a merge persists, and an edit after review sends the exam back to unreviewed", async () => {
		const { h, exam } = await withExam();
		const ids = h.service.listExercises(exam.id).map((e) => e.id);
		h.service.markReviewed(exam.id);
		assert.equal(h.service.getCollection(h.service.listCollections()[0]!.id)!.exams[0]!.reviewed, true);
		const next = h.service.editExercises(exam.id, { op: "merge", firstId: ids[0] });
		assert.equal(next.length, 1);
		assert.equal(next[0]!.pageEnd, 2);
		assert.equal(h.service.getCollection(h.service.listCollections()[0]!.id)!.exams[0]!.reviewed, false);
	});

	it("refuses a bad op with the fixed edit message, and an unknown exercise", async () => {
		const { h, exam } = await withExam();
		await assert.rejects(async () => h.service.editExercises(exam.id, { op: "drop" }), (e: unknown) => e instanceof ExamsError && e.status === 400 && /unknown edit/.test(e.message));
		await assert.rejects(async () => h.service.editExercises(exam.id, { op: "delete", id: "nope" }), (e: unknown) => e instanceof ExamsError && e.status === 400);
	});

	it("marks reviewed; refuses an exam with no exercises; unknown exam is a 404", async () => {
		const { h, exam } = await withExam();
		const done = h.service.markReviewed(exam.id);
		assert.equal(done.reviewed, true);
		for (const id of h.service.listExercises(exam.id).map((e) => e.id)) h.service.editExercises(exam.id, { op: "delete", id });
		assert.throws(() => h.service.markReviewed(exam.id), (e: unknown) => e instanceof ExamsError && e.status === 409);
		assert.throws(() => h.service.listExercises("nope"), (e: unknown) => e instanceof ExamsError && e.status === 404);
	});
});

describe("material index (REQ-ex-04, REQ-ex-05)", () => {
	it("indexes material once: the same bytes again give the same material and no second read", async () => {
		const h = harness();
		const c = h.service.createCollection("Sistemi");
		const a = await h.service.addMaterial(c.id, pdf(LONG, LONG));
		const b = await h.service.addMaterial(c.id, pdf(LONG, LONG));
		assert.deepEqual(a, b);
		assert.equal(a.pages, 2);
		assert.equal(h.readCalls.length, 1);
	});

	it("a scanned material is refused with the scan message", async () => {
		const h = harness();
		const c = h.service.createCollection("Sistemi");
		await refused(h.service.addMaterial(c.id, pdf("", "")), 422, /no text layer/);
		assert.deepEqual(h.service.getCollection(c.id)!.materials, []);
	});

	it("searches the material: hits carry document and page, nothing matched is an empty array, the query must be text", async () => {
		const h = harness();
		const c = h.service.createCollection("Sistemi");
		const m = await h.service.addMaterial(c.id, pdf(LONG, `${LONG} Scheduling round robin: ogni processo riceve un quanto di tempo.`), "Dispensa");
		const hits = h.service.searchMaterial(c.id, "round robin quanto");
		assert.equal(hits.length, 2);
		assert.equal(hits[0]!.materialId, m.id);
		assert.equal(hits[0]!.title, "Dispensa");
		assert.equal(hits[0]!.page, 2);
		assert.deepEqual(h.service.searchMaterial(c.id, "crittografia"), []);
		assert.deepEqual(h.service.searchMaterial(c.id, "   "), []);
		assert.throws(() => h.service.searchMaterial(c.id, 7), (e: unknown) => e instanceof ExamsError && e.status === 400);
		assert.throws(() => h.service.searchMaterial("missing", "x"), (e: unknown) => e instanceof ExamsError && e.status === 404);
	});

	it("K and the token cap are clamped: a request for more gets the service maximum, never more", async () => {
		const h = harness();
		const c = h.service.createCollection("Sistemi");
		const pages = Array.from({ length: 30 }, (_, i) => `Pagina ${i} parla di scheduling e round robin con dettagli numerici ${i}.`);
		await h.service.addMaterial(c.id, pdf(...pages));
		const many = h.service.searchMaterial(c.id, "scheduling round robin", { k: 500, maxTokens: 1_000_000 });
		assert.ok(many.length <= 10, `returned ${many.length}`);
		const small = h.service.searchMaterial(c.id, "scheduling round robin", { k: 50, maxTokens: 40 });
		const spent = small.reduce((n, h2) => n + Math.ceil(h2.text.length / 3), 0);
		assert.ok(spent <= 40, `spent ${spent}`);
	});
});

describe("text layer", () => {
	it("is present when enough non-space characters exist, absent for blank pages", () => {
		assert.equal(hasTextLayer(["", "   \n "]), false);
		assert.equal(hasTextLayer(["x".repeat(100)]), true);
		assert.equal(hasTextLayer(["x".repeat(99)]), false);
	});
});
