// src/core/ext/sources.ts
/**
 * The source library (REQ-src-01..03, 11). A source not matched by an ACTIVE
 * entry is "unvetted" and never counts as evidence. Agent-proposed entries
 * are `proposed` and invisible to matching until the user activates them.
 * Tiers come from here, never from the model (REQ-src-06).
 */

import { randomBytes } from "node:crypto";
import type { SourcesStore } from "./ports.ts";

export type SourceKind = "pdf" | "url-prefix" | "repo";
export type SourceTier = "primary" | "secondary";
export type SourceStatus = "active" | "proposed";
export type SourceAddedBy = "user" | "agent";

export interface SourceEntry {
	id: string;
	kind: SourceKind;
	/** pdf: absolute path. url-prefix: a URL prefix ("https://…") or a bare domain ("arxiv.org"). repo: "owner/name". */
	locator: string;
	tier: SourceTier;
	label: string;
	/** Optional author label, used for the independence check (REQ-src-10). */
	author?: string;
	status: SourceStatus;
	addedBy: SourceAddedBy;
}

const KINDS = new Set<string>(["pdf", "url-prefix", "repo"]);

export function parseSourceEntry(raw: unknown): SourceEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
	if (typeof r.locator !== "string" || r.locator.trim() === "") return null;
	if (r.tier !== "primary" && r.tier !== "secondary") return null;
	if (typeof r.label !== "string" || r.label.trim() === "") return null;
	if (r.status !== "active" && r.status !== "proposed") return null;
	if (r.addedBy !== "user" && r.addedBy !== "agent") return null;
	if (r.author !== undefined && typeof r.author !== "string") return null;
	const entry: SourceEntry = {
		id: r.id,
		kind: r.kind as SourceKind,
		locator: r.locator.trim(),
		tier: r.tier,
		label: r.label.trim(),
		status: r.status,
		addedBy: r.addedBy,
	};
	if (typeof r.author === "string" && r.author.trim() !== "") entry.author = r.author.trim();
	return entry;
}

/** The sources.json document is `{ "entries": [...] }`. Invalid entries and repeated ids are dropped. */
export function parseSourceLibrary(raw: unknown): SourceEntry[] {
	if (typeof raw !== "object" || raw === null) return [];
	const list = (raw as { entries?: unknown }).entries;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: SourceEntry[] = [];
	for (const item of list) {
		const e = parseSourceEntry(item);
		if (e === null || seen.has(e.id)) continue;
		seen.add(e.id);
		out.push(e);
	}
	return out;
}

function parseUrl(s: string): URL | null {
	try {
		const u = new URL(s);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/** Score of a URL against an entry: the length of the matched prefix, 0 for no match. */
function matchScore(entry: SourceEntry, url: URL): number {
	if (entry.kind === "url-prefix") {
		const prefix = parseUrl(entry.locator);
		if (prefix !== null) return url.href.startsWith(prefix.href) ? prefix.href.length : 0;
		const host = entry.locator.toLowerCase();
		return url.hostname === host || url.hostname.endsWith(`.${host}`) ? host.length : 0;
	}
	if (entry.kind === "repo") {
		const repo = entry.locator.replace(/^\/+|\/+$/g, "");
		for (const base of [`https://github.com/${repo}`, `https://raw.githubusercontent.com/${repo}`]) {
			if (url.href === base || url.href.startsWith(`${base}/`)) return base.length;
		}
	}
	return 0;
}

/**
 * The ACTIVE entry a source reference belongs to, or null (= unvetted).
 * `ref` is an entry id, a local PDF path, or a URL. URLs match the entry with
 * the longest matching prefix (REQ-src-03); PDFs match by path.
 */
export function matchSource(ref: string, entries: readonly SourceEntry[]): SourceEntry | null {
	const active = entries.filter((e) => e.status === "active");
	const byId = active.find((e) => e.id === ref);
	if (byId !== undefined) return byId;
	const url = parseUrl(ref);
	if (url === null) return active.find((e) => e.kind === "pdf" && e.locator === ref) ?? null;
	let best: SourceEntry | null = null;
	let bestScore = 0;
	for (const e of active) {
		const score = matchScore(e, url);
		if (score > bestScore) {
			best = e;
			bestScore = score;
		}
	}
	return best;
}

/** Host used by the independence rule; "" for a local PDF. */
export function hostOfEntry(entry: SourceEntry): string {
	if (entry.kind === "pdf") return "";
	if (entry.kind === "repo") return "github.com";
	const u = parseUrl(entry.locator);
	return u !== null ? u.hostname : entry.locator.toLowerCase();
}

export interface NewSourceInput {
	kind: SourceKind;
	locator: string;
	tier: SourceTier;
	label: string;
	author?: string;
	addedBy: SourceAddedBy;
}

export interface SourceProposal {
	kind: SourceKind;
	locator: string;
	label: string;
}

export interface SourceLibrary {
	list(): SourceEntry[];
	/** User entries are active; agent entries are proposed. Throws on invalid input or a repeated (kind, locator). */
	add(input: NewSourceInput): SourceEntry;
	/** The only way a proposed entry becomes active. Throws on an unknown id. */
	setStatus(id: string, status: SourceStatus, tier?: SourceTier): SourceEntry;
	/** Adds proposed secondary entries for locators not yet in the library. Never activates. */
	propose(proposals: readonly SourceProposal[]): SourceEntry[];
}

function defaultSourceId(): string {
	return `lib_${randomBytes(4).toString("hex")}`;
}

export function createSourceLibrary(store: SourcesStore, newId: () => string = defaultSourceId): SourceLibrary {
	return {
		list: () => store.read(),
		add(input) {
			const entries = store.read();
			if (entries.some((e) => e.kind === input.kind && e.locator === input.locator.trim())) {
				throw new Error(`source library: ${input.locator} is already in the library`);
			}
			const entry = parseSourceEntry({ id: newId(), ...input, status: input.addedBy === "user" ? "active" : "proposed" });
			if (entry === null) throw new Error("source library: invalid entry (kind, locator, tier and label are required)");
			store.write([...entries, entry]);
			return entry;
		},
		setStatus(id, status, tier) {
			const entries = store.read();
			const i = entries.findIndex((e) => e.id === id);
			if (i < 0) throw new Error(`source library: unknown source ${id}`);
			const next: SourceEntry = { ...entries[i]!, status, ...(tier !== undefined ? { tier } : {}) };
			entries[i] = next;
			store.write(entries);
			return next;
		},
		propose(proposals) {
			const entries = store.read();
			const added: SourceEntry[] = [];
			for (const p of proposals) {
				if (entries.some((e) => e.kind === p.kind && e.locator === p.locator.trim())) continue;
				const entry = parseSourceEntry({
					id: newId(),
					kind: p.kind,
					locator: p.locator,
					tier: "secondary",
					label: p.label,
					status: "proposed",
					addedBy: "agent",
				});
				if (entry === null) continue;
				entries.push(entry);
				added.push(entry);
			}
			if (added.length > 0) store.write(entries);
			return added;
		},
	};
}
