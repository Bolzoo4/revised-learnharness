// src/core/ext/watch.ts
/**
 * The state-of-the-art watch (REQ-rs-11, REQ-rs-12, REQ-rs-13, REQ-rs-14).
 * `watchlist.json` is configuration; `radar.jsonl` records which items were
 * seen and the PROPOSED relation to the graph. A relation is a proposal: links
 * are only ever created by the extraction pipeline. Pure: parsing, URLs, the
 * feed parser and the due/seen derivations; fetching is a port.
 */

import type { GraphNodeLite } from "./research-ports.ts";

export type WatchKind = "arxiv-query" | "feed" | "repo";
export type Relation = "extends" | "contradicts" | "applies" | "unrelated";
export type RadarAction = "ingest" | "ignore";

export interface WatchEntry {
	id: string;
	kind: WatchKind;
	/** arxiv-query: an arXiv search query. feed: the feed URL. repo: "owner/name". */
	query: string;
	cadenceHours: number;
	/** Optional: compare against this goal's scope instead of all active scopes. */
	goalId?: string;
}

export const DEFAULT_WATCH_CADENCE_HOURS = 24;
/** A feed longer than this is truncated: each item may cost a classifier call. */
export const MAX_FEED_ITEMS = 50;
const KINDS = new Set<string>(["arxiv-query", "feed", "repo"]);

export function parseWatchEntry(raw: unknown): WatchEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "" || typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
	if (typeof r.query !== "string" || r.query.trim() === "") return null;
	const cadence = r.cadenceHours === undefined ? DEFAULT_WATCH_CADENCE_HOURS : r.cadenceHours;
	if (typeof cadence !== "number" || !Number.isFinite(cadence) || cadence <= 0) return null;
	if (r.goalId !== undefined && (typeof r.goalId !== "string" || r.goalId === "")) return null;
	const entry: WatchEntry = { id: r.id, kind: r.kind as WatchKind, query: r.query.trim(), cadenceHours: cadence };
	if (typeof r.goalId === "string") entry.goalId = r.goalId;
	return validateWatchTarget(entry) === null ? entry : null;
}

/** The watchlist.json document is `{ "entries": [...] }`; invalid entries are dropped, the first of a repeated id wins. */
export function parseWatchlist(raw: unknown): WatchEntry[] {
	const list = typeof raw === "object" && raw !== null ? (raw as { entries?: unknown }).entries : undefined;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: WatchEntry[] = [];
	for (const item of list) {
		const e = parseWatchEntry(item);
		if (e === null || seen.has(e.id)) continue;
		seen.add(e.id);
		out.push(e);
	}
	return out;
}

const isDots = (s: string): boolean => /^\.+$/.test(s);

/** null when the entry's query is usable for its kind, otherwise the reason. */
export function validateWatchTarget(entry: Pick<WatchEntry, "kind" | "query">): string | null {
	if (entry.kind === "repo") {
		const m = /^([\w.-]+)\/([\w.-]+)$/.exec(entry.query);
		return m !== null && !isDots(m[1]!) && !isDots(m[2]!) ? null : "a repo is written owner/name";
	}
	if (entry.kind === "feed") {
		try {
			const u = new URL(entry.query);
			if (u.protocol !== "http:" && u.protocol !== "https:") return "a feed must be an http(s) URL";
			return u.username !== "" || u.password !== "" ? "a feed URL must not carry credentials" : null;
		} catch {
			return "a feed must be an http(s) URL";
		}
	}
	return entry.query.trim() === "" ? "an arXiv query must not be empty" : null;
}

/** The URL to fetch: arXiv's public API, the feed itself, or a repository's public releases feed. */
export function feedUrl(entry: WatchEntry): string {
	if (entry.kind === "arxiv-query") {
		return `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(entry.query)}&sortBy=submittedDate&sortOrder=descending&max_results=10`;
	}
	if (entry.kind === "repo") return `https://github.com/${entry.query}/releases.atom`;
	return entry.query;
}

export interface FeedItem {
	/** Stable id: the feed's own id, else the link. */
	id: string;
	title: string;
	link: string;
	summary: string;
	publishedAt?: string;
}

function codePoint(n: number): string {
	return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
}

function decode(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number.parseInt(d, 10)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}
const clean = (s: string): string => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block: string, name: string): string | null => {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
	return m ? clean(m[1]!) : null;
};

function httpUrl(s: string): string | null {
	try {
		const u = new URL(s);
		return u.protocol === "http:" || u.protocol === "https:" ? s : null;
	} catch {
		return null;
	}
}

/**
 * Atom `<entry>` and RSS `<item>` blocks. Items without a title, or without an
 * http(s) link, are dropped; a repeated id keeps the first; at most MAX_FEED_ITEMS.
 */
export function parseFeed(xml: string): FeedItem[] {
	const out: FeedItem[] = [];
	const ids = new Set<string>();
	for (const m of xml.matchAll(/<(entry|item)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
		const block = m[2]!;
		const title = tag(block, "title");
		const attrs = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((x) => x[1]!);
		const alt = attrs.find((a) => !/rel=["'](related|enclosure|self)["']/.test(a) && !/title=["']pdf["']/.test(a) && /href=["']/.test(a));
		const rawLink = alt !== undefined ? decode(/href=["']([^"']+)["']/.exec(alt)![1]!) : tag(block, "link");
		const link = rawLink === null ? null : httpUrl(rawLink.trim());
		if (title === null || title === "" || link === null) continue;
		const id = tag(block, "id") || tag(block, "guid") || link;
		if (ids.has(id)) continue;
		ids.add(id);
		const summary = tag(block, "summary") ?? tag(block, "description") ?? tag(block, "content") ?? "";
		const published = tag(block, "published") || tag(block, "updated") || tag(block, "pubDate");
		out.push({ id, title, link, summary, ...(published ? { publishedAt: published } : {}) });
		if (out.length >= MAX_FEED_ITEMS) break;
	}
	return out;
}

export type RadarEvent =
	| { type: "checked"; entryId: string; ok: boolean; items: number; at: string }
	| {
			type: "classified";
			entryId: string;
			itemId: string;
			title: string;
			link: string;
			nearestNodeIds: string[];
			relation: Relation;
			action: RadarAction;
			rationale: string;
			at: string;
	  };

const RELATIONS = new Set<string>(["extends", "contradicts", "applies", "unrelated"]);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseRadarEvent(raw: unknown): RadarEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.entryId) || !isStr(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "checked") {
		return typeof r.ok === "boolean" && typeof r.items === "number" && Number.isInteger(r.items) && r.items >= 0
			? { type: "checked", entryId: r.entryId, ok: r.ok, items: r.items, at: r.at }
			: null;
	}
	if (r.type !== "classified") return null;
	if (!isStr(r.itemId) || typeof r.title !== "string" || typeof r.link !== "string") return null;
	if (typeof r.relation !== "string" || !RELATIONS.has(r.relation)) return null;
	if (r.action !== "ingest" && r.action !== "ignore") return null;
	if (typeof r.rationale !== "string") return null;
	if (!Array.isArray(r.nearestNodeIds) || !r.nearestNodeIds.every(isStr)) return null;
	return {
		type: "classified",
		entryId: r.entryId,
		itemId: r.itemId,
		title: r.title,
		link: r.link,
		nearestNodeIds: [...(r.nearestNodeIds as string[])],
		relation: r.relation as Relation,
		action: r.action,
		rationale: r.rationale,
		at: r.at,
	};
}

/**
 * Ids of the items already classified. Pass `entryId` to scope to one watch
 * entry: feed ids (RSS guids) are only unique within their feed.
 */
export function seenItemIds(radar: readonly RadarEvent[], entryId?: string): Set<string> {
	const seen = new Set<string>();
	for (const e of radar) if (e.type === "classified" && (entryId === undefined || e.entryId === entryId)) seen.add(e.itemId);
	return seen;
}

/** Entries never checked, or last checked at least `cadenceHours` ago. An unreadable `nowIso` makes nothing due. */
export function dueEntries(entries: readonly WatchEntry[], radar: readonly RadarEvent[], nowIso: string): WatchEntry[] {
	const now = Date.parse(nowIso);
	if (Number.isNaN(now)) return [];
	const last = new Map<string, number>();
	for (const e of radar) {
		if (e.type !== "checked") continue;
		const t = Date.parse(e.at);
		if (!Number.isNaN(t) && t > (last.get(e.entryId) ?? Number.NEGATIVE_INFINITY)) last.set(e.entryId, t);
	}
	return entries.filter((entry) => {
		const at = last.get(entry.id);
		return at === undefined || now - at >= entry.cadenceHours * 3_600_000;
	});
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/\p{L}{4,}/gu) ?? []);

/** The `k` nodes sharing the most distinct words (4+ letters) with the text; nodes sharing none are never returned. */
export function rankNodesByOverlap(text: string, nodes: readonly GraphNodeLite[], k: number): GraphNodeLite[] {
	if (!Number.isFinite(k) || k < 1) return [];
	const target = words(text);
	const seen = new Set<string>();
	const scored: { n: GraphNodeLite; score: number }[] = [];
	for (const n of nodes) {
		if (seen.has(n.id)) continue;
		seen.add(n.id);
		let score = 0;
		for (const w of words(`${n.name} ${n.statement}`)) if (target.has(w)) score++;
		if (score > 0) scored.push({ n, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || (a.n.id < b.n.id ? -1 : a.n.id > b.n.id ? 1 : 0))
		.slice(0, Math.floor(k))
		.map((x) => x.n);
}
