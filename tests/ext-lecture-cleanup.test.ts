import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoverageEntry, GraphChain, GraphNode, NotesSource } from "../src/core/contracts.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";
import type { GraphStore, SourceOrganizationStore } from "../src/core/ports.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import type { BookRun } from "../src/core/ext/lecture/run-record.ts";
import { chapterSourceId } from "../src/agent/ext/lecture/chapter-run.ts";
import { createLectureCleanup } from "../src/server/ext/lecture-cleanup.ts";
import { HttpError } from "../src/server/ext/http-error.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

const BOOK = "b0123abcd";
const TITLE = "Probability 1";
const chapter = { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 19 };
const SRC = chapterSourceId({ bookId: BOOK, bookTitle: TITLE }, chapter);
const OTHER = "chat_other0001";
const T = "2026-11-07T09:00:00.000Z";

const point = (chatId: string) => [{ chatId, messageId: "" }];
const node = (id: string, provenance: GraphNode["provenance"], over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name: id,
	statement: `statement ${id}`,
	aliases: [],
	createdAt: T,
	provenance,
	...over,
});
const chain = (id: string, premises: string[], conclusion: string, provenance: GraphChain["provenance"]): GraphChain => ({ id, premises, conclusion, createdAt: T, provenance });
const source = (id: string, filePath: string): NotesSource => ({ id, filePath, importedAt: T });

/** A full in-memory graph store, with every write visible to the assertions. */
function memStore(seed: { nodes: GraphNode[]; chains: GraphChain[]; coverage?: CoverageEntry[]; sources: NotesSource[] }) {
	let nodes = [...seed.nodes];
	let chains = [...seed.chains];
	let coverage = [...(seed.coverage ?? [])];
	let sources = [...seed.sources];
	const store: GraphStore = {
		appendNode: (n) => void nodes.push(n),
		readNodes: () => [...nodes],
		appendChain: (c) => void chains.push(c),
		readChains: () => [...chains],
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: (c) => void coverage.push(c),
		readCoverage: () => [...coverage],
		upsertSource: (s) => void (sources = [...sources.filter((x) => x.id !== s.id), s]),
		readSources: () => [...sources],
		deleteSources: (ids) => {
			const before = sources.length;
			sources = sources.filter((s) => !ids.has(s.id));
			return before - sources.length;
		},
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes = [...next.nodes];
			if (next.chains) chains = [...next.chains];
			if (next.coverage) coverage = [...next.coverage];
		},
	};
	return { store, nodes: () => nodes, chains: () => chains, coverage: () => coverage, sources: () => sources };
}

function memOrganization(initial: SourceOrganization): SourceOrganizationStore & { value: () => SourceOrganization } {
	let state = structuredClone(initial);
	return { read: () => structuredClone(state), write: (s) => void (state = structuredClone(s)), value: () => state };
}

const bookRun = (over: Partial<BookRun> = {}): BookRun => ({
	bookId: BOOK,
	title: TITLE,
	pdfPath: "/books/prob.pdf",
	phase: "failed",
	chapters: [
		{ chapter: { index: 1, title: "First", pageStart: 1, pageEnd: 9 }, state: "done", lectures: 1, uncovered: 0 },
		{ chapter: chapter, state: "failed", lectures: 0, uncovered: 0, error: "boom" },
	],
	startedAt: T,
	...over,
});

/**
 * The fixture: the failed chapter left NL1 (its own, dies with it), NL2 (its own, and also used by OTHER: stays,
 * the chapter's point goes), and NO1 (created by OTHER, with a link line from the chapter: the link dies, the node stays).
 * CA is a chain of the chapter's (its premise dies: it goes); CB is OTHER's (stays).
 */
function fixture(over: { books?: BookRun[]; lectures?: Lecture[]; running?: boolean; extraction?: boolean; org?: SourceOrganization } = {}) {
	const g = memStore({
		nodes: [
			node("n_leftover1", point(SRC)),
			node("n_shared22", [...point(SRC), ...point(OTHER)]),
			node("n_other333", point(OTHER)),
			node("n_other333", point(SRC), { statement: "a phrasing from the chapter" }),
		],
		chains: [chain("arg_a", ["n_leftover1"], "n_other333", point(SRC)), chain("arg_b", ["n_other333"], "n_shared22", point(OTHER))],
		coverage: [{ chatId: SRC, fp: "f", tokens: 1, foldedAt: T }, { chatId: OTHER, fp: "g", tokens: 1, foldedAt: T }],
		sources: [source(SRC, `${TITLE}/02 ${chapter.title}`), source(OTHER, "/notes/other.txt")],
	});
	const org = memOrganization(
		over.org ?? { version: 1, folders: [], placements: { [SRC]: { folderId: null }, [OTHER]: { folderId: null } } },
	);
	const books = over.books ?? [bookRun({ phase: over.running ? "running" : "failed" })];
	const cleanup = createLectureCleanup({
		graphStore: g.store,
		organization: org,
		books: () => books,
		lectures: () => over.lectures ?? [],
		extractionRunning: () => over.extraction ?? false,
	});
	return { g, org, cleanup };
}

const code = (f: () => unknown): number | string => {
	try {
		f();
	} catch (e) {
		return e instanceof HttpError ? e.status : "not an HttpError";
	}
	return 0;
};

describe("findStalePartialChapters", () => {
	it("lists a failed chapter with what it left: its nodes, its links, and the nodes others also use", () => {
		const { cleanup } = fixture();
		assert.deepEqual(cleanup.findStalePartialChapters(), [
			{ bookId: BOOK, bookTitle: TITLE, chapterIndex: 2, chapterTitle: chapter.title, state: "failed", nodes: 1, chains: 1, kept: 2 },
		]);
	});
	it("never lists a done chapter, a chapter that has a lecture, or any chapter of a book still being made", () => {
		const lecture = makeLecture({ bookId: BOOK, chapter });
		assert.deepEqual(fixture({ lectures: [lecture] }).cleanup.findStalePartialChapters(), []);
		assert.deepEqual(fixture({ running: true }).cleanup.findStalePartialChapters(), []);
		const done = fixture({ books: [bookRun({ chapters: [{ ...bookRun().chapters[1]!, state: "done" }] })] });
		assert.deepEqual(done.cleanup.findStalePartialChapters(), []);
	});
	it("lists a stopped or interrupted chapter too", () => {
		for (const state of ["stopped_cost", "stopped_provider", "interrupted"] as const) {
			const f = fixture({ books: [bookRun({ chapters: [bookRun().chapters[0]!, { ...bookRun().chapters[1]!, state }] })] });
			assert.equal(f.cleanup.findStalePartialChapters()[0]?.state, state);
		}
	});
});

describe("removeStalePartialChapter", () => {
	it("removes what only the chapter refers to, keeps what another source also uses, and drops its source and placement", () => {
		const f = fixture();
		const stats = f.cleanup.removeStalePartialChapter(BOOK, 2);
		assert.deepEqual(stats, { nodesRemoved: 1, chainsRemoved: 1, nodesKept: 2 });
		assert.deepEqual(f.g.nodes().map((n) => [n.id, n.provenance.map((p) => p.chatId)]), [
			["n_shared22", [OTHER]],
			["n_other333", [OTHER]],
		], "the chapter's own node is gone, the shared node keeps the other source only, and the link line dies with its phrasings");
		assert.deepEqual(f.g.chains().map((c) => c.id), ["arg_b"], "the chain that only the chapter asserted is gone");
		assert.deepEqual(f.g.coverage().map((c) => c.chatId), [OTHER], "the chapter's coverage rows are gone");
		assert.deepEqual(f.g.sources().map((s) => s.id), [OTHER], "the chapter's source record is gone");
		assert.deepEqual(f.org.value().placements, { [OTHER]: { folderId: null } });
	});
	it("after the removal there is nothing left to list", () => {
		const f = fixture();
		f.cleanup.removeStalePartialChapter(BOOK, 2);
		assert.deepEqual(f.cleanup.findStalePartialChapters(), []);
	});
	it("refuses with the status the route answers, and never touches the graph", () => {
		const cases: Array<[string, ReturnType<typeof fixture>, number | string]> = [
			["unknown book", fixture(), 404],
			["unknown chapter", fixture(), 400],
			["a book still being made", fixture({ running: true }), 409],
			["a chapter that is running", fixture({ books: [bookRun({ chapters: [bookRun().chapters[0]!, { ...bookRun().chapters[1]!, state: "writing" }] })] }), 409],
			["a chapter that is done", fixture({ books: [bookRun({ chapters: [bookRun().chapters[0]!, { ...bookRun().chapters[1]!, state: "done" }] })] }), 409],
			["a chapter with a lecture", fixture({ lectures: [makeLecture({ bookId: BOOK, chapter })] }), 409],
			["an extraction running", fixture({ extraction: true }), 409],
		];
		for (const [name, f, expected] of cases) {
			const before = JSON.stringify([f.g.nodes(), f.g.chains(), f.g.sources()]);
			const index = name === "unknown chapter" ? 9 : name === "unknown book" ? undefined : 2;
			const bookId = name === "unknown book" ? "b00000000" : BOOK;
			const got = code(() => f.cleanup.removeStalePartialChapter(bookId, index ?? 2));
			assert.equal(got, expected, name);
			assert.equal(JSON.stringify([f.g.nodes(), f.g.chains(), f.g.sources()]), before, `${name}: the graph is unchanged`);
		}
	});
});
