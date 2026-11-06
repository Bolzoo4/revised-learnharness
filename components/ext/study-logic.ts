// components/ext/study-logic.ts
/**
 * Pure helpers of the study session's client code (no DOM, no React), so the
 * failure paths and the page input rules are tested directly.
 */

/** The only failure text the study UI shows: raw server messages are never displayed. */
export const REQUEST_FAILED = "The request failed. Try again.";

export interface PostResult {
	ok: boolean;
	json: Record<string, unknown>;
}
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST a JSON body. Never rejects: a network failure (or an unserialisable body) is
 * { ok: false, json: { error: REQUEST_FAILED } }, so the caller's busy flags always reset.
 * A body that is not a JSON object is treated as empty.
 */
export async function postJson(fetcher: Fetcher, url: string, body: unknown): Promise<PostResult> {
	let res: Response;
	try {
		res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		return { ok: false, json: { error: REQUEST_FAILED } };
	}
	const parsed: unknown = await res.json().catch(() => undefined);
	const json = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	return { ok: res.ok, json };
}

/** The page the viewer shows for a typed value, clamped to 1..pageCount; null when the text is not a page number. */
export function pageFromInput(text: string, pageCount: number): number | null {
	const t = text.trim();
	if (!/^\d{1,6}$/.test(t)) return null;
	return Math.max(1, Math.min(Number(t), pageCount));
}

export interface DraftRowLike {
	id: string;
	page: number;
	proposition: string;
	question: string;
	answer: string;
}

/** The drafts of a list response; anything that is not a list of drafts is an empty list. */
export function draftsOf(json: Record<string, unknown>): DraftRowLike[] {
	if (!Array.isArray(json.drafts)) return [];
	return json.drafts.filter(
		(d): d is DraftRowLike =>
			typeof d === "object" && d !== null && typeof (d as DraftRowLike).id === "string" && typeof (d as DraftRowLike).page === "number",
	);
}

/** Runs `job` once `previous` has settled, whether it succeeded or failed. Jobs chained this way never overlap. */
export function afterSettled(previous: Promise<unknown>, job: () => Promise<void>): Promise<void> {
	return previous.then(
		() => undefined,
		() => undefined,
	).then(job);
}
