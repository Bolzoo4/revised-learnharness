// src/core/ext/cost-gate.ts
/**
 * ASSUMED INTERFACE shared with the research-loop plan (REQ-cost-01): one
 * daily ceiling for verification and research. Spend is an append-only
 * ledger (cost.jsonl); the day is the UTC date of the event timestamp.
 * When the ceiling is reached the gate refuses; reading and reviewing never
 * consult it.
 *
 * A provider pause (provider-limit.ts) closes the same gate while a provider's
 * usage limit is in force, because subscription and unpriced models spend $0 and
 * would never reach the ceiling. `reason()` says which one closed it; the
 * provider pause wins, since it is transient and the ceiling is not.
 */

import { type ProviderPause } from "./provider-limit.ts";

export interface CostEvent {
	type: "spend";
	usd: number;
	/** "verification" | "research" */
	source: string;
	at: string;
}

export interface CostStore {
	appendEvent(event: CostEvent): void;
	readEvents(): CostEvent[];
}

export type CostGateRefusal = "ceiling" | "provider-limit";

export interface CostGate {
	allowed(): boolean;
	record(usd: number, source: string): void;
	/** Why the gate is closed, or null when it is open. Optional: a gate without it is read as "ceiling" when closed. */
	reason?(): CostGateRefusal | null;
}

export function parseCostEvent(raw: unknown): CostEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "spend" || typeof r.usd !== "number" || !Number.isFinite(r.usd) || r.usd < 0) return null;
	if (typeof r.source !== "string" || r.source === "" || typeof r.at !== "string") return null;
	return { type: "spend", usd: r.usd, source: r.source, at: r.at };
}

export function spentOnDay(events: readonly CostEvent[], day: string): number {
	let total = 0;
	for (const e of events) if (e.at.slice(0, 10) === day) total += e.usd;
	return total;
}

export function createCostGate(deps: { store: CostStore; ceilingUsd: number; now?: () => string; providerPause?: ProviderPause }): CostGate {
	const now = deps.now ?? (() => new Date().toISOString());
	const reason = (): CostGateRefusal | null => {
		if (deps.providerPause?.isPaused(Date.parse(now())) === true) return "provider-limit";
		return spentOnDay(deps.store.readEvents(), now().slice(0, 10)) < deps.ceilingUsd ? null : "ceiling";
	};
	return {
		allowed: () => reason() === null,
		reason,
		record(usd, source) {
			if (!Number.isFinite(usd) || usd < 0) return;
			deps.store.appendEvent({ type: "spend", usd, source, at: now() });
		},
	};
}
