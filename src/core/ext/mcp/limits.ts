// src/core/ext/mcp/limits.ts
/**
 * Every bound of the server in one place (REQ-mcp-08). Lists are wrapped in a
 * Page ({items, count, truncated}); long text is cut with an explicit marker;
 * numbers handed back are finite or null.
 */

export const LIMITS = Object.freeze({
	listDefault: 20,
	listMax: 50,
	lecturesMax: 100,
	documentsMax: 100,
	debriefsDefault: 10,
	debriefsMax: 50,
	queryMaxChars: 200,
	queryMaxTokens: 8,
	idMaxChars: 200,
	nameChars: 200,
	titleChars: 200,
	listStatementChars: 400,
	statementChars: 2000,
	explanationChars: 6000,
	quoteChars: 400,
	locatorChars: 120,
	noteChars: 200,
	summaryChars: 1500,
	promptChars: 600,
	commentaryChars: 3000,
	factsBytes: 4096,
	aliasesMax: 10,
	evidenceMax: 8,
	argumentsMax: 8,
	premisesPerArgumentMax: 12,
	conclusionsMax: 20,
	citingLecturesMax: 20,
	goalsPerNodeMax: 20,
	neighbourNodesMax: 60,
	neighbourEdgesMax: 120,
	targetsMax: 20,
	citedNodesMax: 200,
	slidesMax: 200,
	exercisesMax: 50,
	slideNodesMax: 20,
	marksMax: 20,
	pendingGoalsMax: 20,
	futureDaysMax: 30,
	/** A serialized tool result above this is refused, never cut (fail closed). */
	responseMaxBytes: 128 * 1024,
	/** The part of a response that one list may use when the response holds more than the list. */
	listBudgetBytes: 96 * 1024,
	/** A request line above this is refused by the transport. */
	requestMaxBytes: 256 * 1024,
	maxToolInputElements: 50,
	ledgerMaxBytes: 128 * 1024 * 1024,
	lectureFileMaxBytes: 4 * 1024 * 1024,
	lectureFilesMax: 1000,
});

export interface Page<T> {
	items: T[];
	count: number;
	truncated: boolean;
}

/** The first `limit` items; `truncated` says whether more existed. */
export function page<T>(all: readonly T[], limit: number): Page<T> {
	const items = all.slice(0, Math.max(0, limit));
	return { items, count: items.length, truncated: all.length > items.length };
}

/**
 * A page whose serialized items fit in `budgetBytes`: items are dropped from the
 * end until they do, and `truncated` says so. A byte budget cannot be met by
 * per-field caps alone when a page holds many large entries.
 */
export function fitToBudget<T>(p: Page<T>, budgetBytes: number): Page<T> {
	let items = p.items;
	while (items.length > 0 && Buffer.byteLength(JSON.stringify(items), "utf-8") > budgetBytes) items = items.slice(0, items.length - 1);
	return { items, count: items.length, truncated: p.truncated || items.length < p.items.length };
}

/** A page of strings, each cut to `chars`. */
export function textPage(all: readonly string[], limit: number, chars: number): Page<string> {
	const p = page(all, limit);
	return { ...p, items: p.items.map((s) => capText(s, chars)) };
}

/**
 * A caller-supplied limit: an integer >= 1, else the default (NaN, Infinity,
 * fractions, zero, negatives and non-numbers all mean the default); above the
 * maximum it is capped.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fallback;
	return Math.min(raw, max);
}

/**
 * `value` itself when it fits, else its first `max` UTF-16 units (never ending
 * in half a surrogate pair) followed by an explicit marker.
 */
export function capText(value: string, max: number): string {
	if (value.length <= max) return value;
	let cut = Math.max(0, max);
	const last = value.charCodeAt(cut - 1);
	if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
	return `${value.slice(0, cut)}… [truncated: ${value.length - cut} more characters]`;
}

/** A finite number rounded to 4 decimals, else null. */
export function round4(n: number): number | null {
	return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null;
}

/** A finite number rounded to 1 decimal, else 0. */
export function round1(n: number): number {
	return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function finiteOrNull(n: unknown): number | null {
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}
