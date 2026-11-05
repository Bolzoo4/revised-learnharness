// src/core/ext/verifier-output.ts
/**
 * The verifier agent's deliverable: one JSON object in its final message.
 * Only the RAW claims are trusted as claims; every field that matters
 * (tier, snapshot, quote existence) is recomputed by code (verify.ts).
 */

import type { SourceKind, SourceProposal } from "./sources.ts";
import type { Stance } from "./trust.ts";

export interface RawEvidence {
	sourceRef: string;
	locator: string;
	quote: string;
	stance: Stance;
}

export interface VerifierOutput {
	results: { nodeId: string; evidence: RawEvidence[] }[];
	proposedSources: SourceProposal[];
}

const KINDS = new Set<string>(["pdf", "url-prefix", "repo"]);

function extractJson(text: string): string | null {
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
	const last = fences[fences.length - 1];
	if (last !== undefined) return last[1]!.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parseVerifierOutput(text: string): VerifierOutput | null {
	const json = extractJson(text);
	if (json === null) return null;
	let root: unknown;
	try {
		root = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof root !== "object" || root === null) return null;
	const r = root as { results?: unknown; proposedSources?: unknown };
	if (!Array.isArray(r.results)) return null;
	const results: VerifierOutput["results"] = [];
	for (const item of r.results) {
		const it = item as { nodeId?: unknown; evidence?: unknown };
		if (typeof it?.nodeId !== "string" || it.nodeId === "" || !Array.isArray(it.evidence)) continue;
		const evidence: RawEvidence[] = [];
		for (const raw of it.evidence) {
			const e = raw as Record<string, unknown>;
			if (typeof e?.sourceRef !== "string" || e.sourceRef === "") continue;
			if (typeof e.quote !== "string" || e.quote === "") continue;
			if (e.stance !== "supports" && e.stance !== "contradicts") continue;
			evidence.push({ sourceRef: e.sourceRef, locator: typeof e.locator === "string" ? e.locator : "", quote: e.quote, stance: e.stance });
		}
		results.push({ nodeId: it.nodeId, evidence });
	}
	const proposedSources: SourceProposal[] = [];
	if (Array.isArray(r.proposedSources)) {
		for (const raw of r.proposedSources) {
			const p = raw as Record<string, unknown>;
			if (typeof p?.kind !== "string" || !KINDS.has(p.kind)) continue;
			if (typeof p.locator !== "string" || p.locator.trim() === "" || typeof p.label !== "string" || p.label.trim() === "") continue;
			proposedSources.push({ kind: p.kind as SourceKind, locator: p.locator, label: p.label });
		}
	}
	return { results, proposedSources };
}
