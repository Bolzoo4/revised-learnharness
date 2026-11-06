// src/agent/ext/study/study-tools.ts
/**
 * THE STUDY AGENT'S TOOLS (REQ-study-07): it can read any page of the
 * session's document and search the document for a phrase. Both read the text
 * extracted when the document was registered; neither writes anything.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../../core/native-messages.ts";
import { MAX_TITLE_CHARS, flattenText } from "../../../core/ext/study/bounds.ts";
import { invalidInputResult, toToolResult } from "../../tool-execute.ts";
import { healToolRecord } from "../../tools/heal.ts";

/** Longest page text handed to the model. */
export const MAX_PAGE_CHARS = 12_000;
export const MAX_SEARCH_HITS = 10;
/** Longest query the search runs (the schema says the same). */
export const MAX_QUERY_CHARS = 200;
/** Longest snippet of one hit. */
export const MAX_SNIPPET_CHARS = 300;
/** Largest search answer handed to the model. */
export const MAX_SEARCH_OUTPUT_CHARS = 20_000;

export interface StudyToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
	/** The session's document, or null when it cannot be found. */
	document(): { id: string; title: string; pageCount: number } | null;
	/** Text of a page (1-based), or null when out of range. */
	pageText(page: number): string | null;
	/** Case-insensitive literal search across all pages. */
	search(query: string): Array<{ page: number; snippet: string }>;
}

export function clipPage(text: string): string {
	return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[page truncated]` : text;
}

/** The page as the model reads it: a header with the page number, then the text. */
export function formatPage(title: string, page: number, pageCount: number, text: string | null): string {
	const head = `--- ${flattenText(title, MAX_TITLE_CHARS)}, page ${page} of ${pageCount} ---`;
	if (text === null || text.trim() === "") return `${head}\n(This page has no extractable text: it may be a scan or a figure.)`;
	return `${head}\n${clipPage(text)}`;
}

/**
 * The search answer: a JSON array with one hit per line, each hit a JSON string
 * "(p. N) snippet". Valid JSON at every size; the hit count and the total length
 * are capped, so no page of the document can make the answer unbounded.
 */
export function searchOutput(query: string, hits: ReadonlyArray<{ page: number; snippet: string }>): string {
	const items = hits
		.slice(0, MAX_SEARCH_HITS)
		.map((h) => JSON.stringify(`(p. ${h.page}) ${h.snippet.slice(0, MAX_SNIPPET_CHARS)}`));
	if (items.length === 0) return JSON.stringify(`No page contains ${JSON.stringify(query)}.`);
	const join = (xs: readonly string[]): string => `[${xs.join(",\n")}]`;
	let kept = items;
	while (kept.length > 1 && join(kept).length > MAX_SEARCH_OUTPUT_CHARS) kept = kept.slice(0, -1);
	return join(kept);
}

const readInput = Type.Object({ page: Type.Integer({ minimum: 1, description: "Page number, 1-based." }) });
const searchInput = Type.Object({
	query: Type.String({ minLength: 2, maxLength: MAX_QUERY_CHARS, description: "Words or a phrase to find, ignoring case." }),
});

export function studyTools(ctx: StudyToolContext): Record<string, AgentTool<any>> {
	const read_page: AgentTool<typeof readInput> = {
		name: "read_page",
		label: "read_page",
		description: "Read one page of the document the learner is studying. Use it for pages other than the one already given in your instructions. Cite what you use as (p. N).",
		parameters: readInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const doc = ctx.document();
			if (doc === null) return toToolResult("The session's document is not available.");
			if (input.page > doc.pageCount) return invalidInputResult("read_page", [`page ${input.page} is beyond the last page (${doc.pageCount})`]);
			return toToolResult(formatPage(doc.title, input.page, doc.pageCount, ctx.pageText(input.page)));
		},
	};

	const search_pages: AgentTool<typeof searchInput> = {
		name: "search_pages",
		label: "search_pages",
		description: "Find the pages of the document that contain a word or phrase. Returns up to 10 pages with a short snippet; read a page afterwards with read_page.",
		parameters: searchInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const query = input.query.slice(0, MAX_QUERY_CHARS);
			return toToolResult(searchOutput(query, ctx.search(query)));
		},
	};

	return healToolRecord({ read_page, search_pages });
}
