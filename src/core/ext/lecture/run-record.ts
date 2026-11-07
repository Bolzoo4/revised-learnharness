// src/core/ext/lecture/run-record.ts
/**
 * The persisted state of a lecture ingest (pure): one record per book with the
 * PDF locator needed to run it again, its chapters and their states. The file
 * is validated on every load; a record that does not parse is dropped, and an
 * unreadable file reads as empty. A run that was in flight when the app closed
 * is converted to `interrupted` on load (interruptBook).
 */

import type { Chapter } from "./chapters.ts";

export type ChapterState = "queued" | "graph" | "outline" | "writing" | "done" | "failed" | "stopped_cost" | "stopped_provider" | "interrupted";
export type ChapterStage = "graph" | "outline" | "writing";
export type BookPhase = "detecting" | "running" | "done" | "failed" | "interrupted";

export const CHAPTER_STATES: readonly ChapterState[] = ["queued", "graph", "outline", "writing", "done", "failed", "stopped_cost", "stopped_provider", "interrupted"];
export const BOOK_PHASES: readonly BookPhase[] = ["detecting", "running", "done", "failed", "interrupted"];
const WORKING: ReadonlySet<string> = new Set(["queued", "graph", "outline", "writing"]);
const RETRYABLE: ReadonlySet<string> = new Set(["failed", "interrupted", "stopped_cost", "stopped_provider"]);

/** The one fixed text of an interrupted chapter or book. */
export const INTERRUPTED_TEXT = "interrupted when the app was closed";

/** Bounds: the file never grows past these, and a longer text is cut. */
export const MAX_RUN_BOOKS = 50;
export const MAX_RUN_CHAPTERS = 500;
const MAX_TITLE_CHARS = 300;
const MAX_ERROR_CHARS = 2000;
const MAX_PATH_CHARS = 4096;
const FORMAT_VERSION = 1;

export interface ChapterRun {
	chapter: Chapter;
	state: ChapterState;
	/** The last working stage the chapter reached (kept on a final state). */
	stage?: ChapterStage;
	lectures: number;
	uncovered: number;
	error?: string;
	/** Graph parts imported and checkpointed so far (see splitForGraphImport). */
	importedParts?: number;
	startedAt?: string;
	updatedAt?: string;
}

export interface BookRun {
	bookId: string;
	title: string;
	/** The stable PDF path the run reads (the documents copy for an upload, never a temp path). */
	pdfPath: string;
	phase: BookPhase;
	chapters: ChapterRun[];
	error?: string;
	startedAt: string;
	updatedAt?: string;
}

/** The port the service persists through; the store adapter lives in src/store/ext. */
export interface LectureRunStore {
	load(): BookRun[];
	save(books: readonly BookRun[]): void;
}

export function isWorkingState(state: string): boolean {
	return WORKING.has(state);
}

export function isRetryableState(state: string): boolean {
	return RETRYABLE.has(state);
}

export function isRunningPhase(phase: BookPhase): boolean {
	return phase === "detecting" || phase === "running";
}

/** The file's JSON, validated. Unknown version, a bad shape or a bad book gives nothing for that part. */
export function parseRunRecords(json: unknown): BookRun[] {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return [];
	const obj = json as { version?: unknown; books?: unknown };
	if (obj.version !== FORMAT_VERSION || !Array.isArray(obj.books)) return [];
	const seen = new Set<string>();
	const out: BookRun[] = [];
	for (const raw of obj.books) {
		const book = parseBook(raw);
		if (book !== null && !seen.has(book.bookId)) {
			seen.add(book.bookId);
			out.push(book);
		}
	}
	return out;
}

/** Bounded for the file: every running book is kept, the newest of the others fill up to max. Newest first. */
export function boundRunRecords(books: readonly BookRun[], max: number = MAX_RUN_BOOKS): BookRun[] {
	const sorted = [...books].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	const running = sorted.filter((b) => isRunningPhase(b.phase));
	const others = sorted.filter((b) => !isRunningPhase(b.phase));
	const keep = new Set<BookRun>([...running, ...others.slice(0, Math.max(0, max - running.length))]);
	return sorted.filter((b) => keep.has(b));
}

/**
 * A book that was in flight when the app closed: its running chapters and the book
 * become `interrupted` with the fixed text. `interrupted` lists the chapters converted.
 */
export function interruptBook(book: BookRun, at: string): { book: BookRun; interrupted: ChapterRun[] } {
	const bookWasRunning = isRunningPhase(book.phase);
	const chapters = book.chapters.map((c) =>
		isWorkingState(c.state) ? { ...c, state: "interrupted" as const, error: INTERRUPTED_TEXT, updatedAt: at } : c,
	);
	const interrupted = chapters.filter((c, i) => isWorkingState(book.chapters[i]!.state));
	const converted: BookRun = {
		...book,
		chapters,
		phase: bookWasRunning ? "interrupted" : book.phase,
		...(bookWasRunning ? { error: INTERRUPTED_TEXT } : {}),
		...(bookWasRunning ? { updatedAt: at } : {}),
	};
	return { book: converted, interrupted };
}

export interface ChapterOutcome {
	bookId: string;
	chapter: { index: number; title: string };
	state: ChapterState;
	error?: string;
	stage?: ChapterStage;
	seconds?: number;
}

/** One log line for a chapter's final state: ids, index, title, state, the explained error, stage and duration. Never a path or text. */
export function formatChapterOutcome(o: ChapterOutcome): string {
	const detail = o.error ? `: ${oneLine(o.error)}` : "";
	const stage = `stage ${o.stage ?? "queued"}`;
	const where = o.seconds === undefined ? stage : `${stage}, ${o.seconds}s`;
	return `[lectures] book ${o.bookId} chapter ${o.chapter.index} "${oneLine(o.chapter.title)}" ${o.state}${detail} (${where})`;
}

/** Whole seconds between two ISO timestamps, or undefined when either is missing or invalid. */
export function secondsBetween(startIso: string | undefined, endIso: string): number | undefined {
	if (startIso === undefined) return undefined;
	const ms = Date.parse(endIso) - Date.parse(startIso);
	return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : undefined;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// ---- validation ----------------------------------------------------------

function isInt(v: unknown, min: number): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= min;
}

function parseBook(raw: unknown): BookRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const b = raw as Record<string, unknown>;
	if (typeof b.bookId !== "string" || !/^b[0-9a-f]{8}$/.test(b.bookId)) return null;
	if (typeof b.title !== "string" || b.title.trim() === "") return null;
	if (typeof b.pdfPath !== "string" || b.pdfPath.length === 0 || b.pdfPath.length > MAX_PATH_CHARS) return null;
	if (!/^(\/|[A-Za-z]:[\\/])/.test(b.pdfPath) || !b.pdfPath.toLowerCase().endsWith(".pdf")) return null;
	if (typeof b.phase !== "string" || !BOOK_PHASES.includes(b.phase as BookPhase)) return null;
	if (typeof b.startedAt !== "string") return null;
	if (b.error !== undefined && typeof b.error !== "string") return null;
	if (!Array.isArray(b.chapters) || b.chapters.length > MAX_RUN_CHAPTERS) return null;
	const chapters: ChapterRun[] = [];
	for (const c of b.chapters) {
		const chapter = parseChapter(c);
		if (chapter === null) return null;
		chapters.push(chapter);
	}
	return {
		bookId: b.bookId,
		title: b.title.slice(0, MAX_TITLE_CHARS),
		pdfPath: b.pdfPath,
		phase: b.phase as BookPhase,
		chapters,
		...(typeof b.error === "string" ? { error: b.error.slice(0, MAX_ERROR_CHARS) } : {}),
		startedAt: b.startedAt,
		...(typeof b.updatedAt === "string" ? { updatedAt: b.updatedAt } : {}),
	};
}

function parseChapter(raw: unknown): ChapterRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const c = raw as Record<string, unknown>;
	const ch = c.chapter as Record<string, unknown> | undefined;
	if (typeof ch !== "object" || ch === null) return null;
	if (!isInt(ch.index, 1) || typeof ch.title !== "string" || !isInt(ch.pageStart, 1) || !isInt(ch.pageEnd, 1) || (ch.pageEnd as number) < (ch.pageStart as number)) return null;
	if (typeof c.state !== "string" || !CHAPTER_STATES.includes(c.state as ChapterState)) return null;
	if (!isInt(c.lectures, 0) || !isInt(c.uncovered, 0)) return null;
	if (c.stage !== undefined && c.stage !== "graph" && c.stage !== "outline" && c.stage !== "writing") return null;
	if (c.error !== undefined && typeof c.error !== "string") return null;
	if (c.importedParts !== undefined && !isInt(c.importedParts, 0)) return null;
	if (c.startedAt !== undefined && typeof c.startedAt !== "string") return null;
	if (c.updatedAt !== undefined && typeof c.updatedAt !== "string") return null;
	return {
		chapter: { index: ch.index as number, title: (ch.title as string).slice(0, MAX_TITLE_CHARS), pageStart: ch.pageStart as number, pageEnd: ch.pageEnd as number },
		state: c.state as ChapterState,
		...(c.stage !== undefined ? { stage: c.stage as ChapterStage } : {}),
		lectures: c.lectures as number,
		uncovered: c.uncovered as number,
		...(typeof c.error === "string" ? { error: c.error.slice(0, MAX_ERROR_CHARS) } : {}),
		...(c.importedParts !== undefined ? { importedParts: c.importedParts as number } : {}),
		...(typeof c.startedAt === "string" ? { startedAt: c.startedAt } : {}),
		...(typeof c.updatedAt === "string" ? { updatedAt: c.updatedAt } : {}),
	};
}
