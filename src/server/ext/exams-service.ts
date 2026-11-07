// src/server/ext/exams-service.ts
/**
 * Exam training, data and ingestion (REQ-ex-01..05). Every impure dependency is injected;
 * the live wiring is exams-live.ts.
 *
 * Refusals are ExamsError (an HttpError) with fixed messages written here. Any other
 * failure from a dependency is logged under a fixed label and answered with the fixed
 * message of the operation, so no raw error text reaches a response.
 *
 * Same bytes again: an exam or a material already in the collection (same sha256) is
 * returned as it is. An exam is not split twice, a material is not indexed twice.
 */

import { createHash, randomBytes } from "node:crypto";
import { MAX_PDF_BYTES } from "./study-service.ts";
import { HttpError } from "./http-error.ts";
import type { ExerciseSplitter } from "../../agent/ext/exams/exercise-splitter.ts";
import { chunkPages } from "../../core/ext/exams/chunker.ts";
import { MAX_SPLIT_CHARS, MAX_TITLE_CHARS, MIN_TEXT_LAYER_CHARS } from "../../core/ext/exams/bounds.ts";
import { applyExerciseOp, ExerciseEditError, parseExerciseOp, type ExerciseOp } from "../../core/ext/exams/exercises.ts";
import type { ExamsStore, StoredChunk } from "../../core/ext/exams/ports.ts";
import { searchChunks, searchOptions, type SearchChunk, type SearchOptions } from "../../core/ext/exams/search.ts";
import { SplitRefused, type RawExercise } from "../../core/ext/exams/split.ts";
import type { Collection, ExamDoc, Exercise, MaterialDoc, SearchHit } from "../../core/ext/exams/types.ts";
import type { DocumentFiles } from "../../core/ext/study/ports.ts";

export class ExamsError extends HttpError {}

/** A private copy of a PDF on disk, valid until release(). Never rejects on release. */
export interface StagedFile {
	readonly path: string;
	release(): Promise<void>;
}

export interface ExamsServiceDeps {
	store: ExamsStore;
	files: Pick<DocumentFiles, "putPdf" | "putPages">;
	/** Writes the bytes to a private temp file for the text reader. */
	stage(bytes: Uint8Array): Promise<StagedFile>;
	/** The text layer of a PDF, one string per page (page 1 first); rejects when the file cannot be read. */
	readPages(pdfPath: string): Promise<{ pageCount: number; pages: string[] }>;
	splitter: ExerciseSplitter;
	/** Largest PDF accepted (default MAX_PDF_BYTES). */
	maxPdfBytes?: number;
	now?: () => string;
	newId?: () => string;
}

// Fixed messages. A raw error never reaches a message.
const MSG = {
	tooLarge: "that PDF is too large (limit 500 MB)",
	notPdf: "that file is not a PDF",
	unreadable: "that PDF could not be read",
	noText:
		"this PDF has no text layer (it looks like a scan): phase 1 reads only PDFs with selectable text, so scanned exams and scanned material cannot be used yet",
	tooLong: `this exam is too long to split in one pass (phase 1 limit: ${MAX_SPLIT_CHARS} characters of text)`,
	ceiling: "the daily cost ceiling is reached, so the exam cannot be split now; try again tomorrow",
	split: "the exercises could not be split; try again",
	store: "the change could not be saved; try again",
	unknownCollection: "unknown collection",
	unknownExam: "unknown exam",
	titleRequired: "title is required",
	titleType: "title must be text",
	titleLong: `title is too long (at most ${MAX_TITLE_CHARS} characters)`,
	queryType: "query must be text",
	reviewEmpty: "the exam has no exercises to review",
} as const;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function isPdfBytes(bytes: Uint8Array): boolean {
	return bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** The optional title: flattened to one line, blank means "use the default", a non-string or an over-long title is refused. */
function titleOf(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new ExamsError(400, MSG.titleType);
	const flat = v.replace(/\s+/g, " ").trim();
	if (flat === "") return undefined;
	if ([...flat].length > MAX_TITLE_CHARS) throw new ExamsError(400, MSG.titleLong);
	return flat;
}

/** True when the text layer holds enough characters to count as text (a scan holds none). */
export function hasTextLayer(pages: readonly string[]): boolean {
	let chars = 0;
	for (const page of pages) {
		for (const ch of page) if (!/\s/.test(ch)) chars += 1;
		if (chars >= MIN_TEXT_LAYER_CHARS) return true;
	}
	return false;
}

export function createExamsService(deps: ExamsServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(8).toString("hex"));
	const maxBytes = deps.maxPdfBytes ?? MAX_PDF_BYTES;
	const store = deps.store;

	function collectionOrThrow(id: string): Collection {
		const collection = store.readCollection(id);
		if (collection === null) throw new ExamsError(404, MSG.unknownCollection);
		return collection;
	}

	/** The exam with the given id, and its collection's exams, or a 404. */
	function examOrThrow(examId: string): { collectionId: string; exam: ExamDoc; exams: ExamDoc[] } {
		for (const collectionId of store.listCollectionIds()) {
			const exams = store.readExams(collectionId);
			const exam = exams.find((e) => e.id === examId);
			if (exam !== undefined) return { collectionId, exam, exams };
		}
		throw new ExamsError(404, MSG.unknownExam);
	}

	/** Size and PDF header, read before anything is stored. Returns the bytes. */
	async function pdfBytes(file: Blob): Promise<Uint8Array> {
		if (file.size > maxBytes) throw new ExamsError(413, MSG.tooLarge);
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (!isPdfBytes(bytes)) throw new ExamsError(400, MSG.notPdf);
		return bytes;
	}

	/** The text layer of the PDF, read from a private copy that is removed whatever happens. A PDF with no text layer is refused. */
	async function textOf(bytes: Uint8Array): Promise<string[]> {
		const staged = await deps.stage(bytes);
		let pages: string[];
		try {
			pages = (await deps.readPages(staged.path)).pages;
		} catch {
			console.error("[exams] text layer could not be read");
			throw new ExamsError(422, MSG.unreadable);
		} finally {
			await staged.release();
		}
		if (!hasTextLayer(pages)) throw new ExamsError(422, MSG.noText);
		return pages;
	}

	// ─── collections ───────────────────────────────────────────────────────

	function createCollection(title: unknown): Collection {
		const t = titleOf(title);
		if (t === undefined) throw new ExamsError(400, MSG.titleRequired);
		const collection: Collection = { id: newId(), title: t, createdAt: now() };
		try {
			store.writeCollection(collection);
		} catch {
			console.error("[exams] collection write failed");
			throw new ExamsError(500, MSG.store);
		}
		return collection;
	}

	function listCollections(): Collection[] {
		return store
			.listCollectionIds()
			.map((id) => store.readCollection(id))
			.filter((c): c is Collection => c !== null)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	function getCollection(id: string): { collection: Collection; exams: ExamDoc[]; materials: MaterialDoc[] } | null {
		const collection = store.readCollection(id);
		if (collection === null) return null;
		return { collection, exams: store.readExams(id), materials: store.readMaterials(id) };
	}

	// ─── exams (REQ-ex-02) ─────────────────────────────────────────────────

	/**
	 * Stores an exam PDF and its exercises. The text is read and split BEFORE anything is stored,
	 * so a refused PDF leaves no copy behind. Same bytes already in the collection: that exam, as is.
	 */
	async function addExam(collectionId: string, pdf: Blob, title?: unknown): Promise<ExamDoc> {
		collectionOrThrow(collectionId);
		const bytes = await pdfBytes(pdf);
		const t = titleOf(title);
		const documentId = sha256(bytes);
		const existing = store.readExams(collectionId).find((e) => e.documentId === documentId);
		if (existing !== undefined) return existing;

		const pages = await textOf(bytes);
		const chars = pages.reduce((n, p) => n + p.length, 0);
		if (chars > MAX_SPLIT_CHARS) throw new ExamsError(422, MSG.tooLong);

		const titleFinal = t ?? `Exam ${store.readExams(collectionId).length + 1}`;
		let raw: RawExercise[];
		try {
			raw = await deps.splitter.split({ title: titleFinal, pages });
		} catch (error) {
			if (error instanceof SplitRefused && error.reason === "ceiling") throw new ExamsError(429, MSG.ceiling);
			if (!(error instanceof SplitRefused)) console.error("[exams] split failed");
			throw new ExamsError(422, MSG.split);
		}

		// Read again after the await: another exam may have been added while the splitter ran.
		const exams = store.readExams(collectionId);
		const stored = deps.files.putPdf(bytes);
		deps.files.putPages(stored.id, pages);
		const examId = newId();
		const exam: ExamDoc = { id: examId, collectionId, title: titleFinal, documentId, pages: pages.length, reviewed: false };
		const exercises: Exercise[] = raw.map((r, i) => {
			const ex: Exercise = { id: newId(), examId, order: i + 1, pageStart: r.pageStart, pageEnd: r.pageEnd, text: r.text };
			if (r.solution !== undefined) {
				ex.solution = r.solution;
				ex.origin = "exam";
			}
			return ex;
		});
		try {
			store.writeExercises(collectionId, examId, exercises);
			store.writeExams(collectionId, [...exams, exam]);
		} catch {
			console.error("[exams] exam write failed");
			throw new ExamsError(500, MSG.store);
		}
		return exam;
	}

	function listExercises(examId: string): Exercise[] {
		const { collectionId, exam } = examOrThrow(examId);
		return store.readExercises(collectionId, exam.id).sort((a, b) => a.order - b.order);
	}

	/**
	 * One learner edit of the exercise list (REQ-ex-03). The exam becomes unreviewed: the list
	 * the learner reviewed is no longer the one stored, so it must be reviewed again.
	 */
	function editExercises(examId: string, op: unknown): Exercise[] {
		const { collectionId, exam, exams } = examOrThrow(examId);
		let parsed: ExerciseOp;
		try {
			parsed = parseExerciseOp(op);
		} catch (error) {
			if (error instanceof ExerciseEditError) throw new ExamsError(400, error.message);
			throw error;
		}
		const current = store.readExercises(collectionId, exam.id);
		let next: Exercise[];
		try {
			next = applyExerciseOp(current, parsed, newId);
		} catch (error) {
			if (error instanceof ExerciseEditError) throw new ExamsError(400, error.message);
			throw error;
		}
		try {
			store.writeExercises(collectionId, exam.id, next);
			if (exam.reviewed) {
				store.writeExams(
					collectionId,
					exams.map((e) => (e.id === exam.id ? { ...e, reviewed: false } : e)),
				);
			}
		} catch {
			console.error("[exams] exercise write failed");
			throw new ExamsError(500, MSG.store);
		}
		return next;
	}

	/** Marks the exam reviewed: its exercises may then be practised (REQ-ex-03). */
	function markReviewed(examId: string): ExamDoc {
		const { collectionId, exam, exams } = examOrThrow(examId);
		if (store.readExercises(collectionId, exam.id).length === 0) throw new ExamsError(409, MSG.reviewEmpty);
		const done = { ...exam, reviewed: true };
		try {
			store.writeExams(collectionId, exams.map((e) => (e.id === exam.id ? done : e)));
		} catch {
			console.error("[exams] review write failed");
			throw new ExamsError(500, MSG.store);
		}
		return done;
	}

	// ─── material (REQ-ex-04, REQ-ex-05) ───────────────────────────────────

	/** Indexes a material PDF once: the same bytes already in the collection give the same material, with no re-index. */
	async function addMaterial(collectionId: string, pdf: Blob, title?: unknown): Promise<MaterialDoc> {
		collectionOrThrow(collectionId);
		const bytes = await pdfBytes(pdf);
		const t = titleOf(title);
		const documentId = sha256(bytes);
		const existing = store.readMaterials(collectionId).find((m) => m.documentId === documentId);
		if (existing !== undefined) return existing;

		const pages = await textOf(bytes);
		const materials = store.readMaterials(collectionId);
		const material: MaterialDoc = {
			id: newId(),
			collectionId,
			title: t ?? `Material ${materials.length + 1}`,
			documentId,
			pages: pages.length,
			indexedAt: now(),
		};
		const stored = deps.files.putPdf(bytes);
		deps.files.putPages(stored.id, pages);
		const chunks: StoredChunk[] = chunkPages(pages).map((c, index) => ({ index, page: c.page, text: c.text }));
		try {
			store.writeChunks(collectionId, material.id, chunks);
			store.writeMaterials(collectionId, [...materials, material]);
		} catch {
			console.error("[exams] material write failed");
			throw new ExamsError(500, MSG.store);
		}
		return material;
	}

	/**
	 * The best chunks of the collection's material for a query (REQ-ex-05). K and the token cap are
	 * clamped to the service maximum. An empty array means nothing matched; nothing is padded.
	 */
	function searchMaterial(collectionId: string, query: unknown, opts?: { k?: unknown; maxTokens?: unknown }): SearchHit[] {
		collectionOrThrow(collectionId);
		if (typeof query !== "string") throw new ExamsError(400, MSG.queryType);
		const options: SearchOptions = searchOptions(opts);
		const chunks: SearchChunk[] = store.readMaterials(collectionId).flatMap((m) =>
			store.readChunks(collectionId, m.id).map((c) => ({ materialId: m.id, title: m.title, page: c.page, text: c.text })),
		);
		return searchChunks(query, chunks, options);
	}

	return {
		createCollection,
		listCollections,
		getCollection,
		addExam,
		addMaterial,
		listExercises,
		editExercises,
		markReviewed,
		searchMaterial,
	};
}

export type ExamsService = ReturnType<typeof createExamsService>;
