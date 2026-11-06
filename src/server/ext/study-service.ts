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
 *
 * Errors: a StudyError (HttpError) carries a fixed message written here. Any
 * other failure from a dependency is logged under a fixed label and answered
 * with the fixed message of the operation, so no raw error text reaches a
 * response.
 */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_PROPOSITION_CHARS, type CardDraft, type PageDraft } from "../../agent/ext/study/draft-writer.ts";
import { CostCeilingError } from "../../agent/ext/lecture/structured.ts";
import type { StudyToolContext } from "../../agent/ext/study/study-tools.ts";
import { pickCardNode, type CandidateNode } from "../../core/ext/study/card-node.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import { MAX_PAGE, MAX_TEXT_CHARS, MAX_TITLE_CHARS, flattenText } from "../../core/ext/study/bounds.ts";
import { deriveDocuments, documentOfChat, type DocumentEvent, type StudyDocument } from "../../core/ext/study/documents.ts";
import { deriveDrafts, dropRepeats, processedPages, type Draft, type DraftEvent } from "../../core/ext/study/drafts.ts";
import { nodeIdsOnPages, type StudyLinkEvent } from "../../core/ext/study/links.ts";
import { isDocumentId, type DocumentFiles, type LedgerLike } from "../../core/ext/study/ports.ts";
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
/** Most drafts one approve/reject request may name. */
const MAX_DECISIONS = 200;

export interface StudyServiceDeps {
	documents: LedgerLike<DocumentEvent>;
	reading: LedgerLike<ReadingEvent>;
	links: LedgerLike<StudyLinkEvent>;
	drafts: LedgerLike<DraftEvent>;
	files: DocumentFiles;
	/** The bytes of a local file; rejects when it cannot be read. */
	readFile(filePath: string): Promise<Uint8Array>;
	/** The size in bytes of a local file, read before the file itself so an oversize PDF is never loaded. Optional: without it the size is checked after the read. */
	fileSize?(filePath: string): Promise<number>;
	/** Largest PDF accepted (default MAX_PDF_BYTES). */
	maxPdfBytes?: number;
	/** Extracts the page texts of a PDF on disk; rejects when it cannot be read. */
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

export interface Approval {
	draftId: string;
	proposition?: unknown;
	question?: unknown;
	answer?: unknown;
	pin?: unknown;
}

// Fixed messages. A raw error never reaches a message.
const MSG = {
	register: "the PDF could not be registered; nothing was added, try again",
	open: "the study conversation could not be opened; try again",
	record: "the reading position could not be saved; try again",
	draft: "the card could not be drafted; try again",
	confirm: "the card could not be added; nothing was added, try again",
	complete: "the study run could not finish; the pages not yet handled are proposed next time",
	list: "the drafts could not be read",
	decide: "the decision could not be completed; nothing else was changed",
	goal: "the goal could not be created",
	pdf: "the stored copy of this document is not available",
	tools: "the study tools are not available",
} as const;
const NOT_PENDING = "not a pending draft";
const CEILING = "the daily cost ceiling is reached, so this draft stays pending";
const APPROVE_FAILED = "this draft could not be approved; it stays pending and nothing was added";
const RECORD_RETRY = "the card was added but its decision could not be recorded: approve it again to finish";
const REJECT_FAILED = "this draft could not be rejected; try again";

/** A StudyError stays as it is. Anything else is logged under its label only and becomes a StudyError with the fixed message. */
function asStudyError(label: string, error: unknown, status: number, message: string): StudyError {
	if (error instanceof StudyError) return error;
	console.error(`[study] ${label} failed`);
	return new StudyError(status, message);
}

/** Wraps a synchronous operation so that only StudyError values leave it. */
function guardSync<A extends unknown[], R>(label: string, message: string, fn: (...args: A) => R): (...args: A) => R {
	return (...args) => {
		try {
			return fn(...args);
		} catch (error) {
			throw asStudyError(label, error, 500, message);
		}
	};
}

/**
 * Wraps an operation that returns a promise. A synchronous throw from it (an
 * argument shape check that runs before any await) is rethrown synchronously,
 * as a StudyError, so callers that expect it at call time still see it there.
 */
function guardAsync<A extends unknown[], R>(label: string, message: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	return (...args) => {
		let pending: Promise<R>;
		try {
			pending = fn(...args);
		} catch (error) {
			throw asStudyError(label, error, 500, message);
		}
		return pending.catch((error: unknown) => {
			throw asStudyError(label, error, 500, message);
		});
	};
}

/**
 * A required text field: missing or blank is refused; otherwise the text is
 * flattened to one line (so a newline cannot hide a longer value) and a value
 * over `max` characters is refused.
 */
function requiredText(v: unknown, field: string, max: number): string {
	if (v === undefined || v === null) throw new StudyError(400, `${field} is required`);
	if (typeof v !== "string") throw new StudyError(400, `${field} must be text`);
	const flat = flattenText(v, v.length);
	if (flat === "") throw new StudyError(400, `${field} is required`);
	if ([...flat].length > max) throw new StudyError(400, `${field} is too long (at most ${max} characters)`);
	return flat;
}

/** An optional edit of an approved draft: absent or null means "not edited"; otherwise it is checked like a required field. */
function editOf(v: unknown, field: string, max: number): string | undefined {
	if (v === undefined || v === null) return undefined;
	return requiredText(v, field, max);
}

/** `pin` defaults to true; anything other than a boolean is refused (the string "false" must not pin). */
function pinOf(v: unknown): boolean {
	if (v === undefined) return true;
	if (typeof v !== "boolean") throw new StudyError(400, "pin must be true or false");
	return v;
}

/** The document title as given: flattened and cut. Absent or blank gives undefined (the file name is used); a non-string is refused. */
function titleOf(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new StudyError(400, "title must be text");
	const flat = flattenText(v, MAX_TITLE_CHARS);
	return flat === "" ? undefined : flat;
}

/** A proposal with every field flattened and bounded, or null when one is empty. */
function flattenDraft(d: PageDraft): PageDraft | null {
	const proposition = flattenText(d.proposition, MAX_TEXT_CHARS);
	const question = flattenText(d.question, MAX_TEXT_CHARS);
	const answer = flattenText(d.answer, MAX_TEXT_CHARS);
	return proposition === "" || question === "" || answer === "" ? null : { page: d.page, proposition, question, answer };
}

export function createStudyService(deps: StudyServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(5).toString("hex"));
	const pageCache = new Map<string, string[]>();
	/** Document ids with a complete run in progress. */
	const running = new Set<string>();
	/** Content hashes with a registration in progress: a second call for the same bytes awaits the first. */
	const registering = new Map<string, Promise<DocumentView>>();
	/** Draft ids with an approval in progress (claimed synchronously, before the first await). */
	const deciding = new Set<string>();
	/** Drafts whose import and card succeeded but whose `decided` event could not be written: completed on retry without a second import. */
	const imported = new Map<string, ConfirmResult>();

	const allDocuments = (): StudyDocument[] => deriveDocuments(deps.documents.readAll());
	function documentById(id: unknown): StudyDocument {
		const doc = typeof id === "string" && isDocumentId(id) ? allDocuments().find((d) => d.id === id) : undefined;
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

	/**
	 * Registers the file at `source`. Extraction runs BEFORE the copy is stored, so a
	 * refused PDF (damaged, scanned, empty, too long) leaves no stored copy. A second
	 * registration of the same bytes, while the first is in progress, shares its result.
	 */
	async function registerDocument(input: { path: unknown; title?: unknown }): Promise<DocumentView> {
		const source = pathText(input.path);
		if (!path.isAbsolute(source) || !source.toLowerCase().endsWith(".pdf")) throw new StudyError(400, "path must be the absolute path of a .pdf file");
		const title = titleOf(input.title);
		const limit = deps.maxPdfBytes ?? MAX_PDF_BYTES;
		if (deps.fileSize !== undefined) {
			let size: number;
			try {
				size = await deps.fileSize(source);
			} catch {
				throw new StudyError(404, "that file cannot be read");
			}
			if (size > limit) throw new StudyError(400, "that PDF is too large (limit 200 MB)");
		}
		let bytes: Uint8Array;
		try {
			bytes = await deps.readFile(source);
		} catch {
			throw new StudyError(404, "that file cannot be read");
		}
		if (bytes.length > limit) throw new StudyError(400, "that PDF is too large (limit 200 MB)");
		if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") throw new StudyError(400, "that file is not a PDF");

		const id = createHash("sha256").update(bytes).digest("hex");
		// No await between this check and the set: the claim is atomic.
		const inFlight = registering.get(id);
		if (inFlight !== undefined) return inFlight;
		const job = registerBytes(id, bytes, source, title);
		registering.set(id, job);
		try {
			return await job;
		} finally {
			registering.delete(id);
		}
	}

	async function registerBytes(id: string, bytes: Uint8Array, source: string, title: string | undefined): Promise<DocumentView> {
		const known = allDocuments().find((d) => d.id === id);
		if (known !== undefined) {
			deps.files.putPdf(bytes);
			await ensurePages(known);
			ensureInLibrary(known);
			return view(known);
		}
		let extracted: { pages: string[] };
		try {
			extracted = await deps.readPages(source);
		} catch {
			throw new StudyError(422, "this PDF could not be read (it may be damaged or encrypted)");
		}
		const pages = extracted.pages;
		if (pages.length === 0) throw new StudyError(422, "this PDF has no pages");
		if (pages.length > MAX_PAGE) throw new StudyError(422, `this PDF has more pages than a study document can hold (limit ${MAX_PAGE})`);
		if (pages.every((p) => p.trim() === "")) throw new StudyError(422, "this PDF has no extractable text (a scan); OCR is not supported");

		const stored = deps.files.putPdf(bytes);
		deps.files.putPages(stored.id, pages);
		pageCache.set(stored.id, pages);
		const fromName = flattenText(path.basename(source, path.extname(source)), MAX_TITLE_CHARS);
		deps.documents.append({ type: "registered", documentId: stored.id, title: title ?? (fromName || "document"), pageCount: pages.length, at: now() });
		const doc = documentById(stored.id);
		ensureInLibrary(doc);
		return view(doc);
	}

	function listDocuments(): DocumentView[] {
		return allDocuments().map(view);
	}

	/**
	 * REQ-study-05: the first call binds the conversation; every later call returns it.
	 * The document is read after the await, and from that read to the append nothing
	 * awaits, so two concurrent opens cannot both bind.
	 */
	async function open(documentId: string): Promise<OpenView> {
		const first = documentById(documentId);
		await ensurePages(first);
		ensureInLibrary(first);
		let doc = documentById(documentId);
		if (doc.chatId === null) {
			const chat = deps.createSession(flattenText(`Study: ${doc.title}`, MAX_TITLE_CHARS));
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

	function recordReading(input: { documentId: string; kind: unknown; page?: unknown }): void {
		const doc = documentById(input.documentId);
		if (input.kind === "close") {
			deps.reading.append({ type: "close", documentId: doc.id, at: now() });
			return;
		}
		if (input.kind !== "visit") throw new StudyError(400, "kind must be visit or close");
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

	/** The learner's selection: absent or null is none, a blank string is none, anything else must be text. */
	function selectionOf(raw: unknown): string {
		if (raw === undefined || raw === null) return "";
		if (typeof raw !== "string") throw new StudyError(400, "selection must be text");
		return raw.trim();
	}

	/** Interactive drafting: not gated by the daily ceiling (REQ-study-13 names only complete runs; plan decision 4). */
	async function draftCard(input: { documentId: string; page: unknown; selection?: unknown }): Promise<CardDraft> {
		const doc = documentById(input.documentId);
		const page = checkPage(doc, input.page);
		const selection = selectionOf(input.selection);
		if ([...selection].length > MAX_DRAFT_SOURCE_CHARS) throw new StudyError(400, `select less text (at most ${MAX_DRAFT_SOURCE_CHARS} characters)`);
		const from = selection !== "" ? "selection" : "page";
		const source = from === "selection" ? selection : (pageTextOf(doc, page) ?? "").trim().slice(0, MAX_DRAFT_SOURCE_CHARS);
		if (source === "") throw new StudyError(422, "this page has no text to make a card from: select text or write the card yourself");
		try {
			return await deps.writers.draftCard({ title: flattenText(doc.title, MAX_TITLE_CHARS), page, from, text: source });
		} catch (e) {
			throw asStudyError("draftCard", e, 502, "the model could not draft a card; try again");
		}
	}

	/** The one path from a confirmed proposition to a node, a card and a link. */
	async function attach(doc: StudyDocument, page: number, c: CardContent, author: "user" | "agent", pin: boolean): Promise<ConfirmResult> {
		const filePath = studySourcePath(doc.title, page, c.proposition, doc.id);
		try {
			await deps.importProposition({ filePath, text: studySourceText(c.proposition) });
		} catch (e) {
			throw asStudyError("import", e, 502, "the extraction pipeline failed, so nothing was added; try again");
		}
		const nodes = deps.nodesFromSource(filePath);
		if (nodes.length === 0) {
			throw new StudyError(422, "the extraction pipeline found no proposition in this text, so nothing was added: rephrase the proposition and try again");
		}
		const nodeId = pickCardNode(c.proposition, nodes)!;
		const at = now();
		const body = { nodeId, question: c.question, answer: c.answer };
		let cardId: string;
		try {
			for (const n of nodes) deps.links.append({ type: "link", nodeId: n.id, documentId: doc.id, page, at });
			if (author === "user") {
				cardId = deps.cards.createUser(body);
			} else {
				cardId = deps.cards.proposeAgent(body);
				deps.cards.approve(cardId);
			}
			if (pin) deps.cards.pin(nodeId);
		} catch (e) {
			throw asStudyError("attach", e, 500, "the card could not be added; nothing was added, try again");
		}
		return { cardId, nodeId, nodeIds: nodes.map((n) => n.id) };
	}

	function cardContent(raw: { proposition?: unknown; question?: unknown; answer?: unknown }): CardContent {
		return {
			proposition: requiredText(raw.proposition, "proposition", MAX_PROPOSITION_CHARS),
			question: requiredText(raw.question, "question", MAX_TEXT_CHARS),
			answer: requiredText(raw.answer, "answer", MAX_TEXT_CHARS),
		};
	}

	/**
	 * REQ-study-08/09: the learner's confirmation. `pin` (default true) puts the node in the review deck even outside any goal.
	 * The pin flag is checked synchronously, before anything is queued: a malformed flag is refused at the call, and
	 * every other refusal of the confirmation is a rejected promise.
	 */
	function confirmCard(input: { documentId: string; page: unknown; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }): Promise<ConfirmResult> {
		const pin = pinOf(input.pin);
		return confirmCardChecked(input, pin);
	}

	async function confirmCardChecked(input: { documentId: string; page: unknown; proposition?: unknown; question?: unknown; answer?: unknown }, pin: boolean): Promise<ConfirmResult> {
		const doc = documentById(input.documentId);
		const page = checkPage(doc, input.page);
		const content = cardContent(input);
		return attach(doc, page, content, "user", pin);
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

	/** Proposes drafts for read pages, a batch at a time, gated by the daily ceiling before each model call. */
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
				const withText = batch
					.map((page) => ({ page, text: (pageTextOf(doc, page) ?? "").trim().slice(0, MAX_DRAFT_SOURCE_CHARS) }))
					.filter((p) => p.text !== "");
				let drafts: PageDraft[] = [];
				if (withText.length > 0) {
					const known = knownOnPages(doc, batch);
					try {
						drafts = await deps.writers.proposePageDrafts({ title: flattenText(doc.title, MAX_TITLE_CHARS), pages: withText, known });
					} catch (e) {
						if (e instanceof CostCeilingError) {
							ceilingReached = true;
							break;
						}
						throw asStudyError("complete", e, 502, MSG.complete);
					}
					const flat = drafts.filter((d) => batch.includes(d.page)).flatMap((d) => {
						const f = flattenDraft(d);
						return f === null ? [] : [f];
					});
					drafts = dropRepeats(flat, known.map((k) => k.statement), MAX_DRAFTS_PER_PAGE);
				}
				try {
					for (const d of drafts) {
						deps.drafts.append({ type: "proposed", draftId: `draft_${newId()}`, documentId: doc.id, page: d.page, proposition: d.proposition, question: d.question, answer: d.answer, at: now() });
					}
					deps.drafts.append({ type: "pages_processed", documentId: doc.id, pages: batch, at: now() });
				} catch (e) {
					throw asStudyError("complete", e, 500, MSG.complete);
				}
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

	/** The draft as the ledger has it now, when it is still pending; a snapshot taken earlier is never trusted. */
	function pendingDraft(draftId: string): Draft | undefined {
		return deriveDrafts(deps.drafts.readAll()).find((d) => d.id === draftId && d.status === "pending");
	}

	/**
	 * REQ-study-11: nothing becomes a card or a node without the learner's approval; approval may carry edits.
	 * The shape of the request is checked before anything runs (a throw here is synchronous).
	 */
	function decideDrafts(input: { approve: Approval[]; reject: string[] }): Promise<DecideResult> {
		if (!Array.isArray(input.approve) || !Array.isArray(input.reject)) throw new StudyError(400, "approve and reject must be lists");
		if (input.approve.length + input.reject.length > MAX_DECISIONS) throw new StudyError(400, "too many drafts in one request");
		for (const item of input.approve) {
			if (typeof item !== "object" || item === null || typeof item.draftId !== "string") throw new StudyError(400, "every approved draft needs a draftId");
		}
		for (const draftId of input.reject) {
			if (typeof draftId !== "string") throw new StudyError(400, "rejected drafts are listed by draftId");
		}
		return runDecisions(input.approve, input.reject);
	}

	/** Items run one after another. A repeated draft is simply not pending the second time: the ledger is re-read for each item. */
	async function runDecisions(approve: Approval[], reject: string[]): Promise<DecideResult> {
		const result: DecideResult = { approved: [], rejected: [], failed: [] };
		for (const item of approve) {
			const outcome = await approveOne(item);
			if ("error" in outcome) result.failed.push(outcome);
			else result.approved.push(outcome);
		}
		for (const draftId of reject) {
			const problem = rejectOne(draftId);
			if (problem === null) result.rejected.push(draftId);
			else result.failed.push({ draftId, error: problem });
		}
		return result;
	}

	/**
	 * One approval. The draft is claimed before its first await, re-read from the
	 * ledger, checked against the ceiling, then imported and attached. The import
	 * is never repeated for a draft whose `decided` event failed to write.
	 */
	async function approveOne(item: Approval): Promise<({ draftId: string } & ConfirmResult) | { draftId: string; error: string }> {
		const draftId = item.draftId;
		if (deciding.has(draftId)) return { draftId, error: NOT_PENDING };
		deciding.add(draftId);
		try {
			const draft = pendingDraft(draftId);
			if (draft === undefined) return { draftId, error: NOT_PENDING };
			let done = imported.get(draftId);
			if (done === undefined) {
				// Every check happens before the import: a refused edit or pin imports nothing.
				const content = cardContent({
					proposition: editOf(item.proposition, "proposition", MAX_PROPOSITION_CHARS) ?? draft.proposition,
					question: editOf(item.question, "question", MAX_TEXT_CHARS) ?? draft.question,
					answer: editOf(item.answer, "answer", MAX_TEXT_CHARS) ?? draft.answer,
				});
				const pin = pinOf(item.pin);
				if (!deps.gate.allowed()) return { draftId, error: CEILING };
				const doc = documentById(draft.documentId);
				const edited = content.proposition !== draft.proposition || content.question !== draft.question || content.answer !== draft.answer;
				done = await attach(doc, draft.page, content, edited ? "user" : "agent", pin);
				imported.set(draftId, done);
			}
			try {
				deps.drafts.append({ type: "decided", draftId, decision: "approved", at: now() });
			} catch {
				console.error("[study] decided event failed");
				return { draftId, error: RECORD_RETRY };
			}
			imported.delete(draftId);
			return { draftId, ...done };
		} catch (e) {
			return { draftId, error: asStudyError("approve", e, 500, APPROVE_FAILED).message };
		} finally {
			deciding.delete(draftId);
		}
	}

	/** One rejection: null when recorded, otherwise the fixed reason it was not. */
	function rejectOne(draftId: string): string | null {
		if (deciding.has(draftId) || imported.has(draftId)) return NOT_PENDING;
		if (pendingDraft(draftId) === undefined) return NOT_PENDING;
		try {
			deps.drafts.append({ type: "decided", draftId, decision: "rejected", at: now() });
			return null;
		} catch {
			console.error("[study] decided event failed");
			return REJECT_FAILED;
		}
	}

	// ─── goal from a document (umbrella REQ-goal-01) ───────────────────────

	function startGoal(input: { documentId: string; title: unknown; statement: unknown }): { goalId: string } {
		const doc = documentById(input.documentId);
		const goal = deps.createGoal({
			title: requiredText(input.title, "title", MAX_TITLE_CHARS),
			statement: requiredText(input.statement, "statement", MAX_PROPOSITION_CHARS),
			originRef: doc.id,
		});
		return { goalId: goal.id };
	}

	/** The path of a registration request: text, trimmed. Anything else is refused before the file is touched. */
	function pathText(raw: unknown): string {
		if (typeof raw !== "string" || raw.trim() === "") throw new StudyError(400, "path is required");
		if (raw.length > 4096) throw new StudyError(400, "path is too long");
		return raw.trim();
	}

	return {
		registerDocument: guardAsync("registerDocument", MSG.register, registerDocument),
		listDocuments: guardSync("listDocuments", MSG.list, listDocuments),
		open: guardAsync("open", MSG.open, open),
		pdfFile: guardSync("pdfFile", MSG.pdf, pdfFile),
		recordReading: guardSync("recordReading", MSG.record, recordReading),
		toolContext: guardSync("toolContext", MSG.tools, toolContext),
		draftCard: guardAsync("draftCard", MSG.draft, draftCard),
		confirmCard: guardAsync("confirmCard", MSG.confirm, confirmCard),
		complete: guardAsync("complete", MSG.complete, complete),
		listDrafts: guardSync("listDrafts", MSG.list, listDrafts),
		decideDrafts: guardAsync("decideDrafts", MSG.decide, decideDrafts),
		startGoal: guardSync("startGoal", MSG.goal, startGoal),
	};
}

export type StudyService = ReturnType<typeof createStudyService>;
