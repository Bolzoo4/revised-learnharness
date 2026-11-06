// src/server/ext/study-service.ts
/**
 * Assisted study (child spec 7). Everything impure is injected; the live
 * wiring is study-live.ts.
 *
 * A document is a registered PDF with ONE conversation (a chat of kind
 * `study`). Nothing from a document reaches the graph unless the learner
 * confirms a proposition (REQ-study-12): confirmation sends that one
 * proposition through the extraction pipeline's notes front door, then links
 * and cards are written to the extension ledgers. The "complete" run only
 * proposes: its drafts are events in study-drafts.jsonl until approved.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CardDraft, PageDraft } from "../../agent/ext/study/draft-writer.ts";
import { MAX_PROPOSITION_CHARS } from "../../agent/ext/study/draft-writer.ts";
import { CostCeilingError } from "../../agent/ext/lecture/structured.ts";
import type { StudyToolContext } from "../../agent/ext/study/study-tools.ts";
import { pickCardNode, type CandidateNode } from "../../core/ext/study/card-node.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import { deriveDocuments, documentOfChat, type DocumentEvent, type StudyDocument } from "../../core/ext/study/documents.ts";
import { deriveDrafts, dropRepeats, processedPages, type Draft, type DraftEvent } from "../../core/ext/study/drafts.ts";
import { nodeIdsOnPages, type StudyLinkEvent } from "../../core/ext/study/links.ts";
import type { DocumentFiles, LedgerLike } from "../../core/ext/study/ports.ts";
import { deriveReading, type ReadingEvent } from "../../core/ext/study/reading.ts";
import { studySourcePath, studySourceText } from "../../core/ext/study/source-path.ts";
import { HttpError } from "./http-error.ts";

export class StudyError extends HttpError {}

export const MAX_PDF_BYTES = 200 * 1024 * 1024;
/** Pages per model call in a complete run. */
export const COMPLETE_BATCH_PAGES = 4;
/** Most proposals kept per page in a complete run. */
export const MAX_DRAFTS_PER_PAGE = 5;
/** Longest text a card draft is made from. */
export const MAX_DRAFT_SOURCE_CHARS = 6000;
const MAX_FIELD_CHARS = 2000;

export interface StudyServiceDeps {
	documents: LedgerLike<DocumentEvent>;
	reading: LedgerLike<ReadingEvent>;
	links: LedgerLike<StudyLinkEvent>;
	drafts: LedgerLike<DraftEvent>;
	files: DocumentFiles;
	/** The bytes of a local file; rejects when it cannot be read. */
	readFile(filePath: string): Promise<Uint8Array>;
	/** Largest PDF accepted (default MAX_PDF_BYTES). */
	maxPdfBytes?: number;
	readPages(pdfPath: string): Promise<{ pageCount: number; pages: string[] }>;
	library: SourceLibrary;
	gate: CostGate;
	/** Creates a `study` chat. */
	createSession(title: string): { id: string };
	writers: {
		/** User-initiated: not blocked by the daily ceiling. */
		draftCard(input: { title: string; page: number; from: "selection" | "page"; text: string }): Promise<CardDraft>;
		/** Background: the writer refuses with CostCeilingError once the ceiling is reached. */
		proposePageDrafts(input: {
			title: string;
			pages: Array<{ page: number; text: string }>;
			known: Array<{ page: number; statement: string }>;
		}): Promise<PageDraft[]>;
	};
	nodesByIds(ids: readonly string[]): CandidateNode[];
	/** Runs the extraction pipeline's notes front door over one proposition. */
	importProposition(input: { filePath: string; text: string }): Promise<void>;
	/** Nodes whose provenance is the given notes source (created or linked by that import). */
	nodesFromSource(filePath: string): CandidateNode[];
	cards: {
		createUser(input: { nodeId: string; question: string; answer: string }): string;
		proposeAgent(input: { nodeId: string; question: string; answer: string }): string;
		approve(cardId: string): void;
		pin(nodeId: string): void;
	};
	createGoal(input: { title: string; statement: string; originRef: string }): { id: string };
	now?: () => string;
	newId?: () => string;
}

export interface DocumentView {
	id: string;
	title: string;
	pageCount: number;
	chatId: string | null;
	lastPage: number | null;
	readCount: number;
}

export interface OpenView {
	document: DocumentView;
	chatId: string;
	/** Where to resume: the last page visited, or 1. */
	page: number;
	readPages: number[];
}

export interface CardContent {
	proposition: string;
	question: string;
	answer: string;
}

export interface ConfirmResult {
	cardId: string;
	/** The node the card is attached to. */
	nodeId: string;
	/** Every node the proposition produced or was linked to; all are linked to the page. */
	nodeIds: string[];
}

export interface CompleteResult {
	proposed: number;
	/** Pages handled by this run. */
	pages: number[];
	/** Read pages still waiting (because the ceiling was reached). */
	remaining: number;
	ceilingReached: boolean;
}

export interface DecideResult {
	approved: Array<{ draftId: string } & ConfirmResult>;
	rejected: string[];
	failed: Array<{ draftId: string; error: string }>;
}

function text(v: unknown, field: string, max: number): string {
	if (typeof v !== "string" || v.trim() === "") throw new StudyError(400, `${field} is required`);
	if ([...v].length > max) throw new StudyError(400, `${field} is too long (at most ${max} characters)`);
	return v.trim();
}

export function createStudyService(deps: StudyServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(5).toString("hex"));
	const pageCache = new Map<string, string[]>();
	const running = new Set<string>();

	const allDocuments = (): StudyDocument[] => deriveDocuments(deps.documents.readAll());
	function documentById(id: string): StudyDocument {
		const doc = allDocuments().find((d) => d.id === id);
		if (doc === undefined) throw new StudyError(404, "unknown document");
		return doc;
	}
	function checkPage(doc: StudyDocument, page: unknown): number {
		if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > doc.pageCount) {
			throw new StudyError(400, `page must be a whole number from 1 to ${doc.pageCount}`);
		}
		return page;
	}
	function view(doc: StudyDocument): DocumentView {
		const state = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount });
		return { id: doc.id, title: doc.title, pageCount: doc.pageCount, chatId: doc.chatId, lastPage: state.lastPage, readCount: state.readPages.length };
	}
	function pagesOf(id: string): string[] | null {
		const cached = pageCache.get(id);
		if (cached !== undefined) return cached;
		const pages = deps.files.getPages(id);
		if (pages !== null) pageCache.set(id, pages);
		return pages;
	}
	/** Re-extracts the page texts when the file is missing (a crash between the copy and the extraction). */
	async function ensurePages(doc: StudyDocument): Promise<string[]> {
		const have = pagesOf(doc.id);
		if (have !== null) return have;
		const stored = deps.files.pdfPath(doc.id);
		if (stored === null) throw new StudyError(409, "the stored copy of this document is missing: register it again");
		const { pages } = await deps.readPages(stored);
		deps.files.putPages(doc.id, pages);
		pageCache.set(doc.id, pages);
		return pages;
	}
	function pageTextOf(doc: StudyDocument, page: number): string | null {
		if (page < 1 || page > doc.pageCount) return null;
		return pagesOf(doc.id)?.[page - 1] ?? null;
	}
	/** REQ-study-02: idempotent, and it promotes an entry that was proposed or demoted. */
	function ensureInLibrary(doc: StudyDocument): void {
		const stored = deps.files.pdfPath(doc.id);
		if (stored !== null) registerBookAsPrimary(deps.library, stored, doc.title);
	}

	// ─── documents (REQ-study-01, 02, 05) ──────────────────────────────────

	async function registerDocument(input: { path: unknown; title?: unknown }): Promise<DocumentView> {
		const source = text(input.path, "path", 4096);
		if (!path.isAbsolute(source) || !source.toLowerCase().endsWith(".pdf")) throw new StudyError(400, "path must be the absolute path of a .pdf file");
		let bytes: Uint8Array;
		try {
			bytes = await deps.readFile(source);
		} catch {
			throw new StudyError(404, "that file cannot be read");
		}
		if (bytes.length > (deps.maxPdfBytes ?? MAX_PDF_BYTES)) throw new StudyError(400, "that PDF is too large (limit 200 MB)");
		if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") throw new StudyError(400, "that file is not a PDF");

		const stored = deps.files.putPdf(bytes);
		const known = allDocuments().find((d) => d.id === stored.id);
		if (known !== undefined) {
			await ensurePages(known);
			ensureInLibrary(known);
			return view(known);
		}
		let extracted: { pageCount: number; pages: string[] };
		try {
			extracted = await deps.readPages(stored.path);
		} catch {
			throw new StudyError(422, "this PDF could not be read (it may be damaged or encrypted)");
		}
		if (extracted.pages.every((p) => p.trim() === "")) {
			throw new StudyError(422, "this PDF has no extractable text (a scan); OCR is not supported");
		}
		const title = typeof input.title === "string" && input.title.trim() !== "" ? input.title.trim() : path.basename(source, path.extname(source));
		deps.files.putPages(stored.id, extracted.pages);
		pageCache.set(stored.id, extracted.pages);
		deps.documents.append({ type: "registered", documentId: stored.id, title, pageCount: extracted.pageCount, at: now() });
		const doc = documentById(stored.id);
		ensureInLibrary(doc);
		return view(doc);
	}

	function listDocuments(): DocumentView[] {
		return allDocuments().map(view);
	}

	/** REQ-study-05: the first call creates the conversation, every later call returns it. Synchronous between the read and the append. */
	async function open(documentId: string): Promise<OpenView> {
		let doc = documentById(documentId);
		await ensurePages(doc);
		ensureInLibrary(doc);
		if (doc.chatId === null) {
			const chat = deps.createSession(`Study: ${doc.title}`);
			deps.documents.append({ type: "chat", documentId: doc.id, chatId: chat.id, at: now() });
			doc = documentById(documentId);
		}
		const state = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount });
		return { document: view(doc), chatId: doc.chatId!, page: state.lastPage ?? 1, readPages: state.readPages };
	}

	function pdfFile(documentId: string): string {
		const stored = deps.files.pdfPath(documentById(documentId).id);
		if (stored === null) throw new StudyError(404, "the stored copy of this document is missing");
		return stored;
	}

	// ─── reading (REQ-study-03) ────────────────────────────────────────────

	function recordReading(input: { documentId: string; kind: "visit" | "close"; page?: unknown }): void {
		const doc = documentById(input.documentId);
		if (input.kind === "close") {
			deps.reading.append({ type: "close", documentId: doc.id, at: now() });
			return;
		}
		deps.reading.append({ type: "visit", documentId: doc.id, page: checkPage(doc, input.page), at: now() });
	}

	// ─── the conversation's tools (REQ-study-06, 07) ───────────────────────

	function toolContext(chatId: string, chatStore: StudyToolContext["chatStore"]): StudyToolContext {
		const doc = (): StudyDocument | null => documentOfChat(allDocuments(), chatId);
		return {
			chatId,
			chatStore,
			document: () => {
				const d = doc();
				return d === null ? null : { id: d.id, title: d.title, pageCount: d.pageCount };
			},
			pageText: (page) => {
				const d = doc();
				return d === null ? null : pageTextOf(d, page);
			},
			search: (query) => {
				const d = doc();
				const pages = d === null ? null : pagesOf(d.id);
				const needle = query.trim().toLowerCase();
				if (pages === null || needle === "") return [];
				const hits: Array<{ page: number; snippet: string }> = [];
				for (const [i, p] of pages.entries()) {
					const at = p.toLowerCase().indexOf(needle);
					if (at === -1) continue;
					const from = Math.max(0, at - 40);
					hits.push({ page: i + 1, snippet: p.slice(from, at + needle.length + 60).replace(/\s+/g, " ").trim() });
					if (hits.length >= 50) break;
				}
				return hits;
			},
		};
	}

	// ─── cards (REQ-study-08, 09, 10, 12) ──────────────────────────────────

	async function draftCard(input: { documentId: string; page: unknown; selection?: unknown }): Promise<CardDraft> {
		const doc = documentById(input.documentId);
		const page = checkPage(doc, input.page);
		const selection = typeof input.selection === "string" ? input.selection.trim() : "";
		if ([...selection].length > MAX_DRAFT_SOURCE_CHARS) throw new StudyError(400, `select less text (at most ${MAX_DRAFT_SOURCE_CHARS} characters)`);
		const from = selection !== "" ? "selection" : "page";
		const source = from === "selection" ? selection : (pageTextOf(doc, page) ?? "").trim().slice(0, MAX_DRAFT_SOURCE_CHARS);
		if (source === "") throw new StudyError(422, "this page has no text to make a card from: select text or write the card yourself");
		try {
			return await deps.writers.draftCard({ title: doc.title, page, from, text: source });
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new StudyError(502, `the model could not draft a card: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** The one path from a confirmed proposition to a node, a card and a link. */
	async function attach(doc: StudyDocument, page: number, c: CardContent, author: "user" | "agent", pin: boolean): Promise<ConfirmResult> {
		const filePath = studySourcePath(doc.title, page, c.proposition, doc.id);
		try {
			await deps.importProposition({ filePath, text: studySourceText(c.proposition) });
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new StudyError(502, `the extraction pipeline failed, so nothing was added: ${e instanceof Error ? e.message : String(e)}`);
		}
		const nodes = deps.nodesFromSource(filePath);
		if (nodes.length === 0) {
			throw new StudyError(422, "the extraction pipeline found no proposition in this text, so nothing was added: rephrase the proposition and try again");
		}
		const nodeId = pickCardNode(c.proposition, nodes)!;
		const at = now();
		for (const n of nodes) deps.links.append({ type: "link", nodeId: n.id, documentId: doc.id, page, at });
		const body = { nodeId, question: c.question, answer: c.answer };
		let cardId: string;
		if (author === "user") {
			cardId = deps.cards.createUser(body);
		} else {
			cardId = deps.cards.proposeAgent(body);
			deps.cards.approve(cardId);
		}
		if (pin) deps.cards.pin(nodeId);
		return { cardId, nodeId, nodeIds: nodes.map((n) => n.id) };
	}

	function cardContent(raw: { proposition?: unknown; question?: unknown; answer?: unknown }): CardContent {
		return {
			proposition: text(raw.proposition, "proposition", MAX_PROPOSITION_CHARS),
			question: text(raw.question, "question", MAX_FIELD_CHARS),
			answer: text(raw.answer, "answer", MAX_FIELD_CHARS),
		};
	}

	/** REQ-study-08/09: the learner's confirmation. `pin` (default true) puts the node in the review deck even outside any goal. */
	async function confirmCard(input: { documentId: string; page: unknown; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }): Promise<ConfirmResult> {
		const doc = documentById(input.documentId);
		return attach(doc, checkPage(doc, input.page), cardContent(input), "user", input.pin !== false);
	}

	// ─── complete (REQ-study-11, 12, 13) ───────────────────────────────────

	function knownOnPages(doc: StudyDocument, pages: readonly number[]): Array<{ page: number; statement: string }> {
		const known: Array<{ page: number; statement: string }> = [];
		const linkEvents = deps.links.readAll();
		for (const page of pages) {
			const ids = nodeIdsOnPages(linkEvents, doc.id, [page]);
			for (const n of deps.nodesByIds(ids)) known.push({ page, statement: n.statement });
		}
		for (const d of deriveDrafts(deps.drafts.readAll())) {
			if (d.documentId === doc.id && pages.includes(d.page)) known.push({ page: d.page, statement: d.proposition });
		}
		return known;
	}

	async function complete(documentId: string): Promise<CompleteResult> {
		const doc = documentById(documentId);
		if (running.has(doc.id)) throw new StudyError(409, "a complete run is already in progress for this document");
		running.add(doc.id);
		try {
			await ensurePages(doc);
			const read = deriveReading(deps.reading.readAll(), doc.id, { pageCount: doc.pageCount }).readPages;
			const done = new Set(processedPages(deps.drafts.readAll(), doc.id));
			const todo = read.filter((p) => !done.has(p));
			const handled: number[] = [];
			let proposed = 0;
			let ceilingReached = false;
			for (let i = 0; i < todo.length; i += COMPLETE_BATCH_PAGES) {
				const batch = todo.slice(i, i + COMPLETE_BATCH_PAGES);
				if (!deps.gate.allowed()) {
					ceilingReached = true;
					break;
				}
				const withText = batch.map((page) => ({ page, text: (pageTextOf(doc, page) ?? "").trim() })).filter((p) => p.text !== "");
				let drafts: PageDraft[] = [];
				if (withText.length > 0) {
					const known = knownOnPages(doc, batch);
					try {
						drafts = await deps.writers.proposePageDrafts({ title: doc.title, pages: withText, known });
					} catch (e) {
						if (e instanceof CostCeilingError) {
							ceilingReached = true;
							break;
						}
						throw e;
					}
					drafts = dropRepeats(
						drafts.filter((d) => batch.includes(d.page)),
						known.map((k) => k.statement),
						MAX_DRAFTS_PER_PAGE,
					);
				}
				for (const d of drafts) {
					deps.drafts.append({ type: "proposed", draftId: `draft_${newId()}`, documentId: doc.id, page: d.page, proposition: d.proposition, question: d.question, answer: d.answer, at: now() });
				}
				deps.drafts.append({ type: "pages_processed", documentId: doc.id, pages: batch, at: now() });
				proposed += drafts.length;
				handled.push(...batch);
			}
			return { proposed, pages: handled, remaining: todo.length - handled.length, ceilingReached };
		} finally {
			running.delete(doc.id);
		}
	}

	function listDrafts(documentId: string): Draft[] {
		const doc = documentById(documentId);
		return deriveDrafts(deps.drafts.readAll()).filter((d) => d.documentId === doc.id && d.status === "pending");
	}

	/** REQ-study-11: nothing becomes a card or a node without the learner's approval; approval may carry edits. */
	async function decideDrafts(input: {
		approve: Array<{ draftId: string; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }>;
		reject: string[];
	}): Promise<DecideResult> {
		const result: DecideResult = { approved: [], rejected: [], failed: [] };
		const byId = new Map(deriveDrafts(deps.drafts.readAll()).map((d) => [d.id, d] as const));
		for (const item of input.approve) {
			const draft = byId.get(item.draftId);
			if (draft === undefined || draft.status !== "pending") {
				result.failed.push({ draftId: item.draftId, error: "not a pending draft" });
				continue;
			}
			try {
				const doc = documentById(draft.documentId);
				const content = cardContent({
					proposition: item.proposition ?? draft.proposition,
					question: item.question ?? draft.question,
					answer: item.answer ?? draft.answer,
				});
				const edited = content.proposition !== draft.proposition || content.question !== draft.question || content.answer !== draft.answer;
				const done = await attach(doc, draft.page, content, edited ? "user" : "agent", item.pin !== false);
				deps.drafts.append({ type: "decided", draftId: draft.id, decision: "approved", at: now() });
				result.approved.push({ draftId: draft.id, ...done });
			} catch (e) {
				if (!(e instanceof HttpError)) throw e;
				result.failed.push({ draftId: item.draftId, error: e.message });
			}
		}
		for (const draftId of input.reject) {
			const draft = byId.get(draftId);
			if (draft === undefined || draft.status !== "pending") {
				result.failed.push({ draftId, error: "not a pending draft" });
				continue;
			}
			deps.drafts.append({ type: "decided", draftId, decision: "rejected", at: now() });
			result.rejected.push(draftId);
		}
		return result;
	}

	// ─── goal from a document (umbrella REQ-goal-01) ───────────────────────

	function startGoal(input: { documentId: string; title: unknown; statement: unknown }): { goalId: string } {
		const doc = documentById(input.documentId);
		const goal = deps.createGoal({ title: text(input.title, "title", 200), statement: text(input.statement, "statement", MAX_PROPOSITION_CHARS), originRef: doc.id });
		return { goalId: goal.id };
	}

	return { registerDocument, listDocuments, open, pdfFile, recordReading, toolContext, draftCard, confirmCard, complete, listDrafts, decideDrafts, startGoal };
}

export type StudyService = ReturnType<typeof createStudyService>;