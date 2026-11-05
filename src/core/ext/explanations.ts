// src/core/ext/explanations.ts
/**
 * Explanation events (node-knowledge spec: REQ-node-01, REQ-node-02).
 * Versioned events per node, derived state: the CURRENT explanation is the
 * latest ACCEPTED version; a PROPOSED version (an agent text written over a
 * user-authored one) becomes current only after an `approved` decision.
 * Pure: no IO, no clock.
 */

export type ExplanationAuthor = "agent" | "user";

export type ExplanationEvent =
	| {
			type: "version";
			nodeId: string;
			version: number;
			body: string;
			author: ExplanationAuthor;
			/** Snapshot hashes the text is grounded in; [] when none. */
			sourceRefs: string[];
			/** Hash of the style guide the writer used; "user" for user text. */
			styleVersion: string;
			/** concludingFingerprint at write time (explanation-rules.ts). */
			fingerprint: string;
			/** True when generated without source text ("no source context"). */
			noSource: boolean;
			/** True only for an agent text awaiting the user's decision. */
			proposed: boolean;
			at: string;
	  }
	| { type: "decision"; nodeId: string; version: number; decision: "approved" | "rejected"; at: string };

export interface ExplanationVersion {
	nodeId: string;
	version: number;
	body: string;
	author: ExplanationAuthor;
	sourceRefs: string[];
	styleVersion: string;
	fingerprint: string;
	noSource: boolean;
	at: string;
}

export interface NodeExplanation {
	nodeId: string;
	current: ExplanationVersion | null;
	/** Highest undecided proposed version newer than `current`; else null. */
	proposal: ExplanationVersion | null;
	/** Highest version number ever written (proposals included); 0 if none. */
	latestVersion: number;
}

function isNonEmptyString(x: unknown): x is string {
	return typeof x === "string" && x !== "";
}

export function parseExplanationEvent(raw: unknown): ExplanationEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isNonEmptyString(r.nodeId) || typeof r.at !== "string") return null;
	if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) return null;
	if (r.type === "decision") {
		if (r.decision !== "approved" && r.decision !== "rejected") return null;
		return { type: "decision", nodeId: r.nodeId, version: r.version, decision: r.decision, at: r.at };
	}
	if (r.type === "version") {
		if (typeof r.body !== "string" || r.body.trim() === "") return null;
		if (r.author !== "agent" && r.author !== "user") return null;
		if (!Array.isArray(r.sourceRefs) || !r.sourceRefs.every((s) => typeof s === "string")) return null;
		if (typeof r.styleVersion !== "string" || typeof r.fingerprint !== "string") return null;
		if (typeof r.noSource !== "boolean" || typeof r.proposed !== "boolean") return null;
		if (r.proposed && r.author !== "agent") return null;
		return {
			type: "version",
			nodeId: r.nodeId,
			version: r.version,
			body: r.body,
			author: r.author,
			sourceRefs: [...(r.sourceRefs as string[])],
			styleVersion: r.styleVersion,
			fingerprint: r.fingerprint,
			noSource: r.noSource,
			proposed: r.proposed,
			at: r.at,
		};
	}
	return null;
}

interface Slot {
	version: ExplanationVersion;
	proposed: boolean;
	decision?: "approved" | "rejected";
}

/** Replay the events. First line for a (node, version) wins; decisions only bind proposed versions. */
export function deriveExplanations(events: readonly ExplanationEvent[]): Map<string, NodeExplanation> {
	const byNode = new Map<string, Map<number, Slot>>();
	for (const e of events) {
		if (e.type !== "version") continue;
		let slots = byNode.get(e.nodeId);
		if (slots === undefined) {
			slots = new Map();
			byNode.set(e.nodeId, slots);
		}
		if (slots.has(e.version)) continue;
		slots.set(e.version, {
			proposed: e.proposed,
			version: {
				nodeId: e.nodeId,
				version: e.version,
				body: e.body,
				author: e.author,
				sourceRefs: [...e.sourceRefs],
				styleVersion: e.styleVersion,
				fingerprint: e.fingerprint,
				noSource: e.noSource,
				at: e.at,
			},
		});
	}
	for (const e of events) {
		if (e.type !== "decision") continue;
		const slot = byNode.get(e.nodeId)?.get(e.version);
		if (slot !== undefined && slot.proposed) slot.decision = e.decision;
	}
	const out = new Map<string, NodeExplanation>();
	for (const [nodeId, slots] of byNode) {
		const ordered = [...slots.values()].sort((a, b) => a.version.version - b.version.version);
		let current: ExplanationVersion | null = null;
		for (const s of ordered) if (!s.proposed || s.decision === "approved") current = s.version;
		let proposal: ExplanationVersion | null = null;
		for (const s of ordered) {
			if (s.proposed && s.decision === undefined && s.version.version > (current?.version ?? 0)) proposal = s.version;
		}
		const last = ordered[ordered.length - 1];
		out.set(nodeId, { nodeId, current, proposal, latestVersion: last?.version.version ?? 0 });
	}
	return out;
}
