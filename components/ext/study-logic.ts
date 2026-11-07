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

// ─── the reading area: pages, scroll, split, zoom (pure) ──────────────────────

/** A page's box in the scroll content's coordinates (px from the top of the content). */
export interface PageRect {
	page: number;
	top: number;
	height: number;
}
/** The part of the scroll content on screen, in the same coordinates. */
export interface Viewport {
	top: number;
	height: number;
}
export interface VisiblePages {
	/** The page with the largest visible part of the viewport, or null when no page is visible. */
	primary: number | null;
	/** The other visible pages (ascending), at most two: together with the primary, at most three pages. */
	others: number[];
}

/** A page other than the primary counts when this share of its height, or of the viewport, is visible. */
export const EXTRA_PAGE_SHARE = 0.2;
/** Most pages the tutor is told about at once (the primary page included). */
export const MAX_VISIBLE_PAGES = 3;

/**
 * The pages on screen. The primary page is the one with the most visible pixels (a tie goes to the lower
 * page number). Another page is listed when at least EXTRA_PAGE_SHARE of its height or of the viewport is
 * visible, the strongest two of them, ordered by page number.
 */
export function visiblePages(rects: readonly PageRect[], viewport: Viewport): VisiblePages {
	const bottom = viewport.top + viewport.height;
	const shown: Array<{ page: number; visible: number; height: number }> = [];
	for (const r of rects) {
		if (!(r.height > 0)) continue;
		const visible = Math.min(r.top + r.height, bottom) - Math.max(r.top, viewport.top);
		if (visible > 0) shown.push({ page: r.page, visible, height: r.height });
	}
	if (shown.length === 0) return { primary: null, others: [] };
	shown.sort((a, b) => b.visible - a.visible || a.page - b.page);
	const [first, ...rest] = shown;
	const others = rest
		.filter((s) => s.visible >= EXTRA_PAGE_SHARE * s.height || s.visible >= EXTRA_PAGE_SHARE * viewport.height)
		.slice(0, MAX_VISIBLE_PAGES - 1)
		.map((s) => s.page)
		.sort((a, b) => a - b);
	return { primary: first!.page, others };
}

/** Vertical layout of pages stacked with a gap; `ratios[i]` is page i+1's height over its width. */
export function stackPages(ratios: readonly number[], width: number, gap: number): { tops: number[]; heights: number[]; total: number } {
	const tops: number[] = [];
	const heights: number[] = [];
	let y = gap;
	for (const ratio of ratios) {
		const h = (ratio > 0 && Number.isFinite(ratio) ? ratio : FALLBACK_RATIO) * Math.max(0, width);
		tops.push(y);
		heights.push(h);
		y += h + gap;
	}
	return { tops, heights, total: y };
}
const FALLBACK_RATIO = Math.SQRT2;

/**
 * The pages to keep rendered: those on screen plus `extra` pages on each side. Returns 1-based
 * inclusive bounds, or null for an empty document. With no page on screen (for example before the
 * layout is measured) it returns the first pages.
 */
export function renderWindow(rects: readonly PageRect[], viewport: Viewport, extra: number): { first: number; last: number } | null {
	if (rects.length === 0) return null;
	const bottom = viewport.top + viewport.height;
	let first = -1;
	let last = -1;
	for (const [i, r] of rects.entries()) {
		if (r.top + r.height > viewport.top && r.top < bottom) {
			if (first === -1) first = i;
			last = i;
		}
	}
	if (first === -1) return { first: 1, last: Math.min(rects.length, extra + 1) };
	return { first: Math.max(1, first + 1 - extra), last: Math.min(rects.length, last + 1 + extra) };
}

/** Narrowest a pane may be, in CSS px. Neither pane of the split can be dragged below it. */
export const MIN_PANE_PX = 320;
export const DEFAULT_SPLIT_RATIO = 0.6;
/** Arrow-key step of the divider, as a share of the width. */
export const SPLIT_STEP = 0.02;

/** The lowest and highest ratio the divider can take for a container of `width` px; 0.5 both when there is no room for two minimum panes. */
export function splitBounds(width: number, minPx = MIN_PANE_PX): { lo: number; hi: number } {
	if (!(width > 0) || 2 * minPx > width) return { lo: 0.5, hi: 0.5 };
	const lo = minPx / width;
	return { lo, hi: 1 - lo };
}

/** A ratio clamped to the bounds; anything that is not a finite number becomes the default ratio. */
export function clampRatio(value: unknown, width: number, minPx = MIN_PANE_PX): number {
	const v = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SPLIT_RATIO;
	const { lo, hi } = splitBounds(width, minPx);
	return Math.min(hi, Math.max(lo, v));
}

/** The ratio a pointer position gives: the pane's share of the container width, clamped. */
export function ratioFromPointer(clientX: number, containerLeft: number, width: number, minPx = MIN_PANE_PX): number {
	if (!(width > 0)) return DEFAULT_SPLIT_RATIO;
	return clampRatio((clientX - containerLeft) / width, width, minPx);
}

/** The divider's keyboard rule: arrows move one step, Home and End go to the bounds. Null for any other key. */
export function splitStep(ratio: number, key: string, width: number, minPx = MIN_PANE_PX): number | null {
	const { lo, hi } = splitBounds(width, minPx);
	switch (key) {
		case "ArrowLeft":
			return clampRatio(ratio - SPLIT_STEP, width, minPx);
		case "ArrowRight":
			return clampRatio(ratio + SPLIT_STEP, width, minPx);
		case "Home":
			return lo;
		case "End":
			return hi;
		default:
			return null;
	}
}

/** Zoom of the PDF as a multiple of fit-to-width. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

/** The next zoom step up (dir 1) or down (dir -1); a zoom between steps moves to the neighbouring step. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
	const top = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
	if (dir === 1) return ZOOM_STEPS.find((s) => s > zoom + 1e-9) ?? top;
	const below = ZOOM_STEPS.filter((s) => s < zoom - 1e-9);
	return below.length > 0 ? below[below.length - 1]! : ZOOM_STEPS[0]!;
}

/** The layout the learner left: the divider ratio and whether the chat is open. */
export interface LayoutPrefs {
	ratio: number;
	chatOpen: boolean;
}
export const LAYOUT_KEY = "lh.study.layout";
export const DEFAULT_LAYOUT: LayoutPrefs = { ratio: DEFAULT_SPLIT_RATIO, chatOpen: true };

/** Reads the stored layout. Anything unreadable (not JSON, not an object, out-of-range values) falls back per field. */
export function parseLayoutPrefs(raw: unknown): LayoutPrefs {
	if (typeof raw !== "string") return { ...DEFAULT_LAYOUT };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_LAYOUT };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_LAYOUT };
	const r = parsed as Record<string, unknown>;
	const ratio = typeof r.ratio === "number" && Number.isFinite(r.ratio) && r.ratio > 0 && r.ratio < 1 ? r.ratio : DEFAULT_LAYOUT.ratio;
	const chatOpen = typeof r.chatOpen === "boolean" ? r.chatOpen : DEFAULT_LAYOUT.chatOpen;
	return { ratio, chatOpen };
}

/** The storage the layout is kept in. The getter may throw (private windows, blocked site data); every access is guarded. */
export function readLayoutPrefs(getStorage: () => Pick<Storage, "getItem">): LayoutPrefs {
	try {
		return parseLayoutPrefs(getStorage().getItem(LAYOUT_KEY));
	} catch {
		return { ...DEFAULT_LAYOUT };
	}
}

export function writeLayoutPrefs(getStorage: () => Pick<Storage, "setItem">, prefs: LayoutPrefs): void {
	try {
		getStorage().setItem(LAYOUT_KEY, JSON.stringify(prefs));
	} catch {
		// Not persisted: the layout still works for this visit.
	}
}
