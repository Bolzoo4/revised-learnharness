// src/core/ext/study/context.ts
/**
 * What a study message carries (REQ-study-06) and the page citations the
 * agent writes (REQ-study-07). Browser-safe: no node: imports, because the
 * study view builds the message and reads the citations in the browser.
 *
 * Wire format of a user message in a study session: a first line
 * `[study-context] <JSON>` and, after the first newline, the learner's text.
 * JSON.stringify escapes every newline, so a selection can never end the
 * first line early.
 */

import { MAX_PAGE } from "./bounds.ts";

export const STUDY_CONTEXT_PREFIX = "[study-context] ";
/** Longest selection a message carries, in UTF-16 units; longer selections are cut before a surrogate pair. */
export const MAX_SELECTION_CHARS = 2000;
/** Longest context line accepted by the parser; a longer first line is refused before JSON.parse. */
export const MAX_CONTEXT_LINE_CHARS = 64 * 1024;

export interface StudyContext {
	documentId: string;
	/** 1-based page the learner is looking at. */
	page: number;
	/** Text the learner selected (empty when none). */
	selection: string;
}

/** The first MAX_SELECTION_CHARS UTF-16 units, stopping before a code point that would not fit. */
function clip(selection: string): string {
	let out = "";
	for (const ch of selection.trim()) {
		if (out.length + ch.length > MAX_SELECTION_CHARS) break;
		out += ch;
	}
	return out;
}

/** The text to send: the context line, then the learner's own text. */
export function encodeStudyContext(ctx: { documentId: string; page: number; selection?: string }, text: string): string {
	const payload = { documentId: ctx.documentId, page: ctx.page, selection: clip(ctx.selection ?? "") };
	return `${STUDY_CONTEXT_PREFIX}${JSON.stringify(payload)}\n${text}`;
}

/** The context and the learner's text, or null when the message has no valid context line. */
export function parseStudyContext(message: string): { context: StudyContext; text: string } | null {
	if (!message.startsWith(STUDY_CONTEXT_PREFIX)) return null;
	const newline = message.indexOf("\n");
	const line = newline === -1 ? message : message.slice(0, newline);
	if (line.length > MAX_CONTEXT_LINE_CHARS) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(line.slice(STUDY_CONTEXT_PREFIX.length));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1 || r.page > MAX_PAGE) return null;
	if (r.selection !== undefined && typeof r.selection !== "string") return null;
	return {
		context: { documentId: r.documentId, page: r.page, selection: clip(typeof r.selection === "string" ? r.selection : "") },
		text: newline === -1 ? "" : message.slice(newline + 1),
	};
}

/** Plain text of a stored user message (a string, or the text parts of a content array). */
export function userMessageText(message: { role: string; content: unknown }): string {
	if (message.role !== "user") return "";
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.map((part) =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/** The context of the NEWEST user message, or null when that message has none. */
export function latestStudyContext(messages: readonly { role: string; content: unknown }[]): StudyContext | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		return parseStudyContext(userMessageText(m))?.context ?? null;
	}
	return null;
}

export interface PageCitation {
	page: number;
	/** Offsets of the whole `(p. N)` in the searched text. */
	start: number;
	end: number;
}

/** Every `(p. N)` in the text, in order. N is a positive integer. */
export function pageCitations(text: string): PageCitation[] {
	const found: PageCitation[] = [];
	for (const m of text.matchAll(/\(p\.\s*(\d{1,5})\)/g)) {
		const page = Number(m[1]);
		if (page >= 1) found.push({ page, start: m.index, end: m.index + m[0].length });
	}
	return found;
}

/** The page of the citation that covers `offset`, or null. */
export function citationAt(text: string, offset: number): number | null {
	return pageCitations(text).find((c) => offset >= c.start && offset < c.end)?.page ?? null;
}
