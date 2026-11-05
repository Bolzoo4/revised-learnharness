// tests/helpers/study-fakes.ts
/** In-memory dependencies for the study service tests. */

import { createHash } from "node:crypto";
import type { CardDraft, PageDraft } from "../../src/agent/ext/study/draft-writer.ts";
import { createSourceLibrary } from "../../src/core/ext/sources.ts";
import type { CandidateNode } from "../../src/core/ext/study/card-node.ts";
import type { DocumentEvent } from "../../src/core/ext/study/documents.ts";
import type { DraftEvent } from "../../src/core/ext/study/drafts.ts";
import type { StudyLinkEvent } from "../../src/core/ext/study/links.ts";
import type { DocumentFiles, LedgerLike } from "../../src/core/ext/study/ports.ts";
import type { ReadingEvent } from "../../src/core/ext/study/reading.ts";
import { createStudyService, type StudyServiceDeps } from "../../src/server/ext/study-service.ts";
import { fakeGate, memSourcesStore } from "./ext-fakes.ts";

export const memLedger = <T>(): LedgerLike<T> & { events: T[] } => {
	const events: T[] = [];
	return { events, append: (e) => void events.push(e), readAll: () => [...events] };
};

export function memFiles(): DocumentFiles & { pdfs: Map<string, Uint8Array>; pages: Map<string, string[]> } {
	const pdfs = new Map<string, Uint8Array>();
	const pages = new Map<string, string[]>();
	return {
		pdfs,
		pages,
		putPdf(bytes) {
			const id = createHash("sha256").update(bytes).digest("hex");
			pdfs.set(id, bytes);
			return { id, path: `/data/ext/documents/${id}.pdf` };
		},
		pdfPath: (id) => (pdfs.has(id) ? `/data/ext/documents/${id}.pdf` : null),
		putPages: (id, p) => void pages.set(id, [...p]),
		getPages: (id) => pages.get(id) ?? null,
	};
}

export const PDF_A = new TextEncoder().encode("%PDF-1.4 book A");
export const PDF_B = new TextEncoder().encode("%PDF-1.4 book B");
export const idOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const BOOK_PAGES = ["Cover page.", "A sigma algebra is closed under complement.", "", "Every convergent sequence is bounded.", "Compact sets are closed."];

export interface StudyHarness {
	svc: ReturnType<typeof createStudyService>;
	/** A new service over the same ledgers and files, as after an app restart (the page cache is empty). */
	restart(): void;
	fail: { draft: boolean; pipeline: boolean };
	documents: ReturnType<typeof memLedger<DocumentEvent>>;
	reading: ReturnType<typeof memLedger<ReadingEvent>>;
	links: ReturnType<typeof memLedger<StudyLinkEvent>>;
	drafts: ReturnType<typeof memLedger<DraftEvent>>;
	files: ReturnType<typeof memFiles>;
	gate: ReturnType<typeof fakeGate>;
	library: ReturnType<typeof createSourceLibrary>;
	clock: { t: number };
	imports: Array<{ filePath: string; text: string }>;
	cards: { created: unknown[]; proposed: unknown[]; approved: string[]; pinned: string[] };
	chats: string[];
	goals: unknown[];
	pageCalls: Array<{ title: string; pages: Array<{ page: number; text: string }>; known: Array<{ page: number; statement: string }> }>;
	cardCalls: Array<{ title: string; page: number; from: string; text: string }>;
	/** What the fake pipeline returns for the next import(s): by default one node per import. */
	pipeline: { next: CandidateNode[] | null; bySource: Map<string, CandidateNode[]> };
	byte: { files: Map<string, Uint8Array> };
}

export function studyHarness(opts: {
	proposals?: PageDraft[][] | (() => Promise<PageDraft[]>);
	cardDraft?: CardDraft;
	pages?: string[];
	existingNodes?: CandidateNode[];
	maxPdfBytes?: number;
	/** Called each time the page-draft writer is asked, before it answers. */
	onPropose?: () => void;
} = {}): StudyHarness {
	const fail = { draft: false, pipeline: false };
	const documents = memLedger<DocumentEvent>();
	const reading = memLedger<ReadingEvent>();
	const links = memLedger<StudyLinkEvent>();
	const drafts = memLedger<DraftEvent>();
	const files = memFiles();
	const gate = fakeGate();
	const library = createSourceLibrary(memSourcesStore());
	const clock = { t: Date.UTC(2026, 10, 4, 10, 0, 0) };
	const imports: StudyHarness["imports"] = [];
	const cards: StudyHarness["cards"] = { created: [], proposed: [], approved: [], pinned: [] };
	const chats: string[] = [];
	const goals: unknown[] = [];
	const pageCalls: StudyHarness["pageCalls"] = [];
	const cardCalls: StudyHarness["cardCalls"] = [];
	const pipeline: StudyHarness["pipeline"] = { next: null, bySource: new Map() };
	const byte = { files: new Map<string, Uint8Array>([["/books/a.pdf", PDF_A], ["/books/b.pdf", PDF_B]]) };
	const queue = Array.isArray(opts.proposals) ? [...opts.proposals] : [];
	let nodeSeq = 0;
	let cardSeq = 0;
	const nodes = new Map<string, CandidateNode>((opts.existingNodes ?? []).map((n) => [n.id, n]));

	const deps: StudyServiceDeps = {
		documents, reading, links, drafts, files, library, gate,
		...(opts.maxPdfBytes !== undefined ? { maxPdfBytes: opts.maxPdfBytes } : {}),
		readFile: async (p) => {
			const b = byte.files.get(p);
			if (b === undefined) throw new Error("ENOENT");
			return b;
		},
		readPages: async () => {
			const pages = opts.pages ?? BOOK_PAGES;
			return { pageCount: pages.length, pages };
		},
		createSession: (title) => {
			chats.push(title);
			return { id: `chat_${chats.length}` };
		},
		writers: {
			draftCard: async (input) => {
				if (fail.draft) throw new Error("model unavailable");
				cardCalls.push(input);
				return opts.cardDraft ?? { proposition: "P.", question: "Q?", answer: "A." };
			},
			proposePageDrafts: async (input) => {
				pageCalls.push({ title: input.title, pages: input.pages, known: input.known });
				opts.onPropose?.();
				if (typeof opts.proposals === "function") return opts.proposals();
				return queue.shift() ?? [];
			},
		},
		nodesByIds: (ids) => ids.flatMap((id) => (nodes.has(id) ? [nodes.get(id)!] : [])),
		importProposition: async (input) => {
			if (fail.pipeline) throw new Error("no model configured");
			imports.push(input);
			const made = pipeline.next ?? [{ id: `n_${++nodeSeq}`, name: `Node ${nodeSeq}`, statement: input.text.trim(), aliases: [] }];
			pipeline.next = null;
			for (const n of made) nodes.set(n.id, n);
			pipeline.bySource.set(input.filePath, made);
		},
		nodesFromSource: (filePath) => pipeline.bySource.get(filePath) ?? [],
		cards: {
			createUser: (input) => {
				cards.created.push(input);
				return `card_${++cardSeq}`;
			},
			proposeAgent: (input) => {
				cards.proposed.push(input);
				return `card_${++cardSeq}`;
			},
			approve: (id) => void cards.approved.push(id),
			pin: (id) => void cards.pinned.push(id),
		},
		createGoal: (input) => {
			goals.push(input);
			return { id: "goal_1" };
		},
		now: () => new Date(clock.t).toISOString(),
		newId: (() => {
			let i = 0;
			return () => `id${++i}`;
		})(),
	};
	const harness: StudyHarness = {
		svc: createStudyService(deps),
		restart: () => void (harness.svc = createStudyService(deps)),
		fail,
		documents, reading, links, drafts, files, gate, library, clock, imports, cards, chats, goals, pageCalls, cardCalls, pipeline, byte,
	};
	return harness;
}

/** Registers book A and returns its id. */
export async function registerA(h: StudyHarness): Promise<string> {
	return (await h.svc.registerDocument({ path: "/books/a.pdf" })).id;
}

/** Reads the given pages (5 seconds each) and closes. */
export function readPages(h: StudyHarness, documentId: string, pages: number[]): void {
	for (const page of pages) {
		h.svc.recordReading({ documentId, kind: "visit", page });
		h.clock.t += 6000;
	}
	h.svc.recordReading({ documentId, kind: "close" });
	h.clock.t += 1000;
}
