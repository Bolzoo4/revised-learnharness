// src/core/ext/mcp/trust-view.ts
/**
 * Trust as the server shows it. Evidence is mapped field by field (an
 * allow-list): the snapshot hash is omitted, a source is named by its library
 * id, its http(s) URL without credentials, query or fragment, or, for a local
 * PDF, its file name only. An absolute path never leaves the server.
 */

import { capText, LIMITS, page, type Page } from "./limits.ts";
import { deriveTrustMap, type Evidence, type TrustLevel } from "../trust.ts";
import type { VerificationEvent } from "../trust.ts";

export const TRUST_LEVELS: readonly TrustLevel[] = ["unverified", "sourced", "contested", "refuted"];

export function trustLevels(events: readonly VerificationEvent[]): Map<string, { level: TrustLevel; at: string; evidence: Evidence[] }> {
	return deriveTrustMap(events);
}

export function sourceLabel(ev: Pick<Evidence, "sourceRef" | "sourceId">): string {
	if (ev.sourceId !== null && ev.sourceId !== "") return capText(ev.sourceId, 80);
	try {
		const url = new URL(ev.sourceRef);
		if (url.protocol === "http:" || url.protocol === "https:") return capText(`${url.origin}${url.pathname}`, 200);
	} catch {
		// not a URL: fall through to the file-name rule
	}
	const base = ev.sourceRef.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
	return capText(base === "" ? "local source" : base, 80);
}

export interface EvidenceView {
	source: string;
	host: string;
	tier: Evidence["tier"];
	stance: Evidence["stance"];
	locator: string;
	quote: string;
	author?: string;
}

export function evidencePage(evidence: readonly Evidence[]): Page<EvidenceView> {
	const p = page(evidence, LIMITS.evidenceMax);
	return {
		...p,
		items: p.items.map((e) => ({
			source: sourceLabel(e),
			host: capText(e.host, 100),
			tier: e.tier,
			stance: e.stance,
			locator: capText(e.locator, LIMITS.locatorChars),
			quote: capText(e.quote, LIMITS.quoteChars),
			...(e.author !== undefined ? { author: capText(e.author, 100) } : {}),
		})),
	};
}
