// components/ext/lectures-tree.ts
/**
 * The lectures page's tree (book > chapter > lecture > exercise), built from the two lists the page
 * fetches: the ingest runs (in memory, per chapter progress) and the saved lectures. Pure, so the
 * grouping and the plain-words states are tested without a DOM.
 */

export interface ChapterRunRow {
	chapter: { index: number; title: string };
	state: string;
	lectures: number;
	uncovered: number;
	error?: string;
}
export interface RunRow {
	bookId: string;
	title: string;
	phase: string;
	error?: string;
	chapters: ChapterRunRow[];
}
export interface LectureRow {
	id: string;
	bookId: string;
	title: string;
	bookTitle: string;
	chapter: { index: number; title: string };
	order: number;
	exercises: Array<{ blockId: string; prompt: string }>;
	/** Narration audio: blocks ready, blocks in all, and whether a Deepgram key is configured. */
	audio?: { ready: number; total: number; keyConfigured: boolean };
}

export type TreeLecture = LectureRow;

/** A chapter of an earlier attempt that left something in the graph (GET /api/ext/lectures/stale). */
export interface LeftoverRow {
	bookId: string;
	chapterIndex: number;
	nodes: number;
	chains: number;
	kept: number;
}
export interface TreeLeftovers {
	nodes: number;
	chains: number;
	kept: number;
}
export interface TreeChapter {
	index: number;
	title: string;
	/** The server's chapter state as sent (saved-only chapters read "saved"). */
	state: string;
	/** The plain-words state of the chapter (see chapterStateText). */
	stateText: string;
	/** True when the chapter can be retried (failed, interrupted or stopped). */
	retryable: boolean;
	/** Chapter nodes no lecture covers yet, when the chapter's run is known. */
	uncovered: number;
	error?: string;
	/** What an earlier attempt of this chapter left in the graph, when it did (and it has no lecture). */
	leftovers?: TreeLeftovers;
	lectures: TreeLecture[];
}
export interface TreeBook {
	bookId: string;
	title: string;
	/** The plain-words phase of the book's run, or "saved" when only saved lectures are known. */
	phaseText: string;
	/** True while the book's run is in flight (its retry buttons wait for it to finish). */
	making: boolean;
	error?: string;
	chapters: TreeChapter[];
}

const CHAPTER_STATES: Record<string, string> = {
	queued: "waiting to start",
	graph: "reading the chapter",
	outline: "planning the lectures",
	writing: "writing the lectures",
	done: "done",
	failed: "failed",
	stopped_cost: "stopped: the daily limit for background work is spent",
	stopped_provider: "stopped: the provider's usage limit is reached",
	interrupted: "interrupted",
};
const BOOK_PHASES: Record<string, string> = {
	detecting: "finding the chapters",
	running: "making the lectures",
	done: "done",
	failed: "finished with errors",
	interrupted: "interrupted",
};

/** The states a Retry button is offered for. */
const RETRYABLE_STATES: ReadonlySet<string> = new Set(["failed", "interrupted", "stopped_cost", "stopped_provider"]);
export function isRetryableChapterState(state: string): boolean {
	return RETRYABLE_STATES.has(state);
}

/** The plain-words state of a chapter; an unknown state reads as itself, so a new server state is still shown. */
export function chapterStateText(state: string): string {
	return CHAPTER_STATES[state] ?? state;
}

/** "Audio: 3 of 5 blocks ready", with the reason when no key is configured (the browser voice is used then). */
export function audioLineText(audio: { ready: number; total: number; keyConfigured: boolean }): string {
	const blocks = `${audio.total} block${audio.total === 1 ? "" : "s"}`;
	const base = `Audio: ${audio.ready} of ${blocks} ready`;
	return audio.keyConfigured ? base : `${base} (no Deepgram key: the browser voice is used)`;
}

/** The "Generate audio" button is offered only with a key and while some block is missing. */
export function canGenerateAudioLine(audio: { ready: number; total: number; keyConfigured: boolean }): boolean {
	return audio.keyConfigured && audio.ready < audio.total;
}

export function bookPhaseText(phase: string): string {
	return BOOK_PHASES[phase] ?? phase;
}

/** "1 node", "2 nodes": the count with its noun. */
function counted(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The note under a chapter that left something behind: the nodes (or links) of an earlier attempt, in plain words. */
export function leftoversText(l: TreeLeftovers): string {
	if (l.nodes > 0) return `${counted(l.nodes, "node")} from an earlier attempt ${l.nodes === 1 ? "is" : "are"} still in your graph`;
	if (l.chains > 0) return `${counted(l.chains, "link")} from an earlier attempt ${l.chains === 1 ? "is" : "are"} still in your graph`;
	return "An earlier attempt left its source in your library";
}

/** The confirm step before a removal: the numbers first, and what stays. */
export function leftoverConfirmText(l: TreeLeftovers): string {
	const removed = `Remove ${counted(l.nodes, "node")} and ${counted(l.chains, "link")} from your graph?`;
	return l.kept > 0 ? `${removed} ${counted(l.kept, "node")} that other chapters, lectures or chats also use stay.` : removed;
}

/** Groups runs and lectures by book, then chapter (by index), then lecture (by order). Books keep their first-seen order. */
export function buildLectureTree(runs: readonly RunRow[], lectures: readonly LectureRow[], leftovers: readonly LeftoverRow[] = []): TreeBook[] {
	const books = new Map<string, TreeBook & { chapterMap: Map<number, TreeChapter> }>();
	const bookOf = (bookId: string, title: string) => {
		let book = books.get(bookId);
		if (book === undefined) {
			book = { bookId, title, phaseText: "saved", making: false, chapters: [], chapterMap: new Map() };
			books.set(bookId, book);
		}
		return book;
	};
	const chapterOf = (book: TreeBook & { chapterMap: Map<number, TreeChapter> }, index: number, title: string): TreeChapter => {
		let chapter = book.chapterMap.get(index);
		if (chapter === undefined) {
			chapter = { index, title, state: "saved", stateText: "saved", retryable: false, uncovered: 0, lectures: [] };
			book.chapterMap.set(index, chapter);
		}
		return chapter;
	};

	for (const run of runs) {
		const book = bookOf(run.bookId, run.title);
		book.title = run.title;
		book.phaseText = bookPhaseText(run.phase);
		book.making = run.phase === "detecting" || run.phase === "running";
		if (run.error) book.error = run.error;
		for (const c of run.chapters) {
			const chapter = chapterOf(book, c.chapter.index, c.chapter.title);
			chapter.title = c.chapter.title;
			chapter.state = c.state;
			chapter.stateText = chapterStateText(c.state);
			chapter.retryable = isRetryableChapterState(c.state);
			chapter.uncovered = c.uncovered;
			if (c.error) chapter.error = c.error;
		}
	}
	for (const lecture of lectures) {
		const book = bookOf(lecture.bookId, lecture.bookTitle);
		const chapter = chapterOf(book, lecture.chapter.index, lecture.chapter.title);
		chapter.lectures.push(lecture);
	}

	for (const row of leftovers) {
		const book = books.get(row.bookId);
		const chapter = book?.chapterMap.get(row.chapterIndex);
		// A chapter with lectures is never a leftover (the server guarantees it; the tree keeps the lectures' view).
		if (chapter !== undefined && chapter.lectures.length === 0) chapter.leftovers = { nodes: row.nodes, chains: row.chains, kept: row.kept };
	}

	return [...books.values()].map(({ chapterMap, ...book }) => ({
		...book,
		chapters: [...chapterMap.values()]
			.sort((a, b) => a.index - b.index)
			.map((c) => ({ ...c, lectures: [...c.lectures].sort((a, b) => a.order - b.order) })),
	}));
}
