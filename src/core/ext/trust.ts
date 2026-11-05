// src/core/ext/trust.ts
/**
 * Trust (REQ-src-06..12, 14; REQ-ver-01). Evidence stored in an event has
 * already passed the quote check; its tier was assigned by code from the
 * library at check time ("unvetted" when no ACTIVE entry matched). The
 * outcome function is pure and order independent.
 */

export type Stance = "supports" | "contradicts";
export type EvidenceTier = "primary" | "secondary" | "unvetted";
export type TrustLevel = "unverified" | "sourced" | "contested" | "refuted";
export type DiscardReason = "quote_not_found" | "quote_too_short" | "source_unreadable";

export interface Evidence {
	/** What the verifier cited: a library entry id, a local PDF path, or a URL. */
	sourceRef: string;
	/** The ACTIVE library entry it matched, or null (unvetted). */
	sourceId: string | null;
	locator: string;
	quote: string;
	/** sha256 of the snapshot the quote was checked against. */
	snapshot: string;
	stance: Stance;
	/** Tier at the time of the check (REQ-src-14). */
	tier: EvidenceTier;
	host: string;
	author?: string;
}

export interface Discarded {
	sourceRef: string;
	reason: DiscardReason;
}

export type VerificationEvent =
	| {
			type: "checked";
			nodeId: string;
			outcome: TrustLevel;
			evidence: Evidence[];
			discarded: Discarded[];
			checker: string;
			at: string;
	  }
	| { type: "check_failed"; nodeId: string; reason: string; at: string };

const LEVELS = new Set<string>(["unverified", "sourced", "contested", "refuted"]);
const TIERS = new Set<string>(["primary", "secondary", "unvetted"]);
const REASONS = new Set<string>(["quote_not_found", "quote_too_short", "source_unreadable"]);

function sameAuthor(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** REQ-src-10: distinct library entries AND (different hosts OR provably different author labels). */
export function independent(a: Evidence, b: Evidence): boolean {
	if (a.sourceId === null || b.sourceId === null || a.sourceId === b.sourceId) return false;
	if (a.host !== b.host) return true;
	return a.author !== undefined && b.author !== undefined && !sameAuthor(a.author, b.author);
}

function hasIndependentPair(items: readonly Evidence[]): boolean {
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) if (independent(items[i]!, items[j]!)) return true;
	}
	return false;
}

/** REQ-src-07..09, 11. Precedence: sourced, contested, refuted, unverified. */
export function outcomeOf(evidence: readonly Evidence[]): TrustLevel {
	const qualified = evidence.filter((e) => e.tier !== "unvetted");
	const supporting = qualified.filter((e) => e.stance === "supports");
	const against = qualified.filter((e) => e.stance === "contradicts");
	const supportedByPrimary = supporting.some((e) => e.tier === "primary");
	const contradictedByPrimary = against.some((e) => e.tier === "primary");
	const secondaries = supporting.filter((e) => e.tier === "secondary");
	if ((supportedByPrimary || hasIndependentPair(secondaries)) && !contradictedByPrimary) return "sourced";
	if (supporting.length > 0 && against.length > 0) return "contested";
	if (against.length > 0) return "refuted";
	return "unverified";
}

function parseEvidence(raw: unknown): Evidence | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.sourceRef !== "string" || r.sourceRef === "") return null;
	if (r.sourceId !== null && typeof r.sourceId !== "string") return null;
	if (typeof r.locator !== "string" || typeof r.quote !== "string" || r.quote === "") return null;
	if (typeof r.snapshot !== "string" || r.snapshot === "") return null;
	if (r.stance !== "supports" && r.stance !== "contradicts") return null;
	if (typeof r.tier !== "string" || !TIERS.has(r.tier)) return null;
	if (typeof r.host !== "string") return null;
	if (r.author !== undefined && typeof r.author !== "string") return null;
	const e: Evidence = {
		sourceRef: r.sourceRef,
		sourceId: r.sourceId as string | null,
		locator: r.locator,
		quote: r.quote,
		snapshot: r.snapshot,
		stance: r.stance,
		tier: r.tier as EvidenceTier,
		host: r.host,
	};
	if (typeof r.author === "string") e.author = r.author;
	return e;
}

export function parseVerificationEvent(raw: unknown): VerificationEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.nodeId !== "string" || r.nodeId === "" || typeof r.at !== "string") return null;
	if (r.type === "check_failed") {
		if (typeof r.reason !== "string") return null;
		return { type: "check_failed", nodeId: r.nodeId, reason: r.reason, at: r.at };
	}
	if (r.type !== "checked") return null;
	if (typeof r.outcome !== "string" || !LEVELS.has(r.outcome)) return null;
	if (typeof r.checker !== "string" || !Array.isArray(r.evidence) || !Array.isArray(r.discarded)) return null;
	const evidence: Evidence[] = [];
	for (const item of r.evidence) {
		const e = parseEvidence(item);
		if (e === null) return null;
		evidence.push(e);
	}
	const discarded: Discarded[] = [];
	for (const item of r.discarded) {
		const d = item as { sourceRef?: unknown; reason?: unknown };
		if (typeof d?.sourceRef !== "string" || typeof d.reason !== "string" || !REASONS.has(d.reason)) return null;
		discarded.push({ sourceRef: d.sourceRef, reason: d.reason as DiscardReason });
	}
	return { type: "checked", nodeId: r.nodeId, outcome: r.outcome as TrustLevel, evidence, discarded, checker: r.checker, at: r.at };
}

export interface TrustState {
	level: TrustLevel;
	at: string;
	evidence: Evidence[];
}

/**
 * Latest `checked` event per node. `check_failed` events are ignored here
 * (REQ-src-12): a failed or aborted run never changes the level. A node
 * absent from the map is `unverified`.
 */
export function deriveTrustMap(events: readonly VerificationEvent[]): Map<string, TrustState> {
	const map = new Map<string, TrustState>();
	for (const e of events) {
		if (e.type === "checked") map.set(e.nodeId, { level: e.outcome, at: e.at, evidence: e.evidence });
	}
	return map;
}

/** One self-explanatory line for the teacher's context (REQ-src-15). */
export function trustTag(level: TrustLevel): string {
	switch (level) {
		case "sourced":
			return "[trust: sourced — a quotation was confirmed in a vetted source]";
		case "contested":
			return "[trust: contested — vetted sources disagree]";
		case "refuted":
			return "[trust: refuted — a vetted source contradicts this]";
		default:
			return "[trust: unverified — not checked against any vetted source]";
	}
}
