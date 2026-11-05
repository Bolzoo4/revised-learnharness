// src/core/ext/inbox.ts
/**
 * The source inbox (REQ-rs-07, REQ-rs-08, REQ-rs-09) and the triage rule.
 * Events: a source is `proposed` (pending), the user `decided` on it, and an
 * `ingested` event records every ingestion (automatic or approved), which is how
 * the loop knows not to ingest the same source twice. Pure.
 */

import { createHash } from "node:crypto";

export type InboxDecision = "approved" | "rejected" | "activated";
export type InboxStatus = "pending" | InboxDecision;

export type InboxEvent =
	| {
			type: "proposed";
			locator: string;
			title: string;
			/** The gap (or `watch:<entryId>`) the source was found for. */
			gapId: string;
			foundBy: "cycle" | "watch";
			cycleId: string;
			/** sha256 of the stored source text (data/ext/snapshots/<hash>.txt). */
			snapshot: string;
			at: string;
	  }
	| { type: "decided"; locator: string; decision: InboxDecision; at: string }
	| { type: "ingested"; locator: string; nodesAdded: number; at: string };

export interface InboxItem {
	locator: string;
	title: string;
	gapId: string;
	foundBy: "cycle" | "watch";
	snapshot: string;
	status: InboxStatus;
	proposedAt: string;
	decidedAt?: string;
}

const DECISIONS = new Set<string>(["approved", "rejected", "activated"]);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseInboxEvent(raw: unknown): InboxEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.locator) || typeof r.at !== "string") return null;
	if (r.type === "decided") {
		return typeof r.decision === "string" && DECISIONS.has(r.decision)
			? { type: "decided", locator: r.locator, decision: r.decision as InboxDecision, at: r.at }
			: null;
	}
	if (r.type === "ingested") {
		return typeof r.nodesAdded === "number" && Number.isInteger(r.nodesAdded) && r.nodesAdded >= 0
			? { type: "ingested", locator: r.locator, nodesAdded: r.nodesAdded, at: r.at }
			: null;
	}
	if (r.type === "proposed") {
		if (typeof r.title !== "string" || !isStr(r.gapId) || !isStr(r.cycleId) || !isStr(r.snapshot)) return null;
		if (r.foundBy !== "cycle" && r.foundBy !== "watch") return null;
		return { type: "proposed", locator: r.locator, title: r.title, gapId: r.gapId, foundBy: r.foundBy, cycleId: r.cycleId, snapshot: r.snapshot, at: r.at };
	}
	return null;
}

/** Items in proposal order. The first `proposed` for a locator defines it; a later one is ignored; the last `decided` wins. */
export function deriveInbox(events: readonly InboxEvent[]): InboxItem[] {
	const items = new Map<string, InboxItem>();
	for (const e of events) {
		if (e.type === "proposed") {
			const locator = normalizeLocator(e.locator);
			if (items.has(locator)) continue;
			items.set(locator, { locator, title: e.title, gapId: e.gapId, foundBy: e.foundBy, snapshot: e.snapshot, status: "pending", proposedAt: e.at });
		} else if (e.type === "decided") {
			const item = items.get(normalizeLocator(e.locator));
			if (item === undefined) continue;
			item.status = e.decision;
			item.decidedAt = e.at;
		}
	}
	return [...items.values()];
}

export function ingestedLocators(events: readonly InboxEvent[]): Set<string> {
	return new Set(events.filter((e) => e.type === "ingested").map((e) => normalizeLocator(e.locator)));
}

/** Canonical form of a source locator: lower-case host, no fragment, no trailing slash on the path. Non-URLs pass through trimmed. */
export function normalizeLocator(raw: string): string {
	const text = raw.trim();
	try {
		const url = new URL(text);
		if (url.protocol !== "http:" && url.protocol !== "https:") return text;
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.origin}${path}${url.search}`;
	} catch {
		return text;
	}
}

/**
 * Deterministic notes-source path for a locator (the extraction pipeline hashes it into the `src_` id).
 * Equivalent locators share a path; the file name always ends in the 8-hex sha256 digest of the full
 * canonical locator, so distinct locators can never collide whatever the readable slug looks like.
 */
export function sourceFilePath(locator: string): string {
	const canonical = normalizeLocator(locator);
	let host = "source";
	let rest = canonical;
	try {
		const url = new URL(canonical);
		host = url.hostname.replace(/^www\./, "").replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "source";
		rest = `${url.pathname}${url.search}`;
	} catch {
		/* not a URL: the whole text is squeezed into a slug */
	}
	const slug = rest.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "index";
	const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
	return `research/${host}/${slug}-${digest}.md`;
}

/**
 * The one way to build an `ingested` event: normalizes the locator and coerces the count to a
 * non-negative integer (anything else is recorded as 0). decideInboxItem uses it, and the research
 * cycle (Task 7) MUST use it too, so both writers produce identical, parseable log entries.
 */
export function ingestedEvent(locator: string, count: number, at: string): Extract<InboxEvent, { type: "ingested" }> {
	return { type: "ingested", locator: normalizeLocator(locator), nodesAdded: Number.isInteger(count) && count >= 0 ? count : 0, at };
}

export type TriageDecision = "ingest" | "inbox" | "skip-rejected" | "skip-seen";

/**
 * REQ-rs-07/08: an active library source is ingested, any other source goes to the
 * inbox; a rejected source is never proposed again, and a source already pending
 * or already ingested is not handled twice.
 */
export function triage(locator: string, isActive: boolean, inbox: readonly InboxEvent[]): TriageDecision {
	locator = normalizeLocator(locator);
	const item = deriveInbox(inbox).find((i) => i.locator === locator);
	if (item?.status === "rejected") return "skip-rejected";
	if (item !== undefined) return "skip-seen";
	if (ingestedLocators(inbox).has(locator)) return "skip-seen";
	return isActive ? "ingest" : "inbox";
}
