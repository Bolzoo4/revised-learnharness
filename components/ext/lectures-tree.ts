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
export interface TreeChapter {
	index: number;
	title: string;
	/** The plain-words state of the chapter (see chapterStateText). */
	stateText: string;
	/** Chapter nodes no lecture covers yet, when the chapter's run is known. */
	uncovered: number;
	error?: string;
	lectures: TreeLecture[];
}
export interface TreeBook {
	bookId: string;
	title: string;
	/** The plain-words phase of the book's run, or "saved" when only saved lectures are known. */
	phaseText: string;
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
};
const BOOK_PHASES: Record<string, string> = {
	detecting: "finding the chapters",
	running: "making the lectures",
	done: "done",
	failed: "finished with errors",
};

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

/** Groups runs and lectures by book, then chapter (by index), then lecture (by order). Books keep their first-seen order. */
export function buildLectureTree(runs: readonly RunRow[], lectures: readonly LectureRow[]): TreeBook[] {
	const books = new Map<string, TreeBook & { chapterMap: Map<number, TreeChapter> }>();
	const bookOf = (bookId: string, title: string) => {
		let book = books.get(bookId);
		if (book === undefined) {
			book = { bookId, title, phaseText: "saved", chapters: [], chapterMap: new Map() };
			books.set(bookId, book);
		}
		return book;
	};
	const chapterOf = (book: TreeBook & { chapterMap: Map<number, TreeChapter> }, index: number, title: string): TreeChapter => {
		let chapter = book.chapterMap.get(index);
		if (chapter === undefined) {
			chapter = { index, title, stateText: "saved", uncovered: 0, lectures: [] };
			book.chapterMap.set(index, chapter);
		}
		return chapter;
	};

	for (const run of runs) {
		const book = bookOf(run.bookId, run.title);
		book.title = run.title;
		book.phaseText = bookPhaseText(run.phase);
		if (run.error) book.error = run.error;
		for (const c of run.chapters) {
			const chapter = chapterOf(book, c.chapter.index, c.chapter.title);
			chapter.title = c.chapter.title;
			chapter.stateText = chapterStateText(c.state);
			chapter.uncovered = c.uncovered;
			if (c.error) chapter.error = c.error;
		}
	}
	for (const lecture of lectures) {
		const book = bookOf(lecture.bookId, lecture.bookTitle);
		const chapter = chapterOf(book, lecture.chapter.index, lecture.chapter.title);
		chapter.lectures.push(lecture);
	}

	return [...books.values()].map(({ chapterMap, ...book }) => ({
		...book,
		chapters: [...chapterMap.values()]
			.sort((a, b) => a.index - b.index)
			.map((c) => ({ ...c, lectures: [...c.lectures].sort((a, b) => a.order - b.order) })),
	}));
}
