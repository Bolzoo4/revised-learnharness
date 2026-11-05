// src/core/ext/cost-gate.ts
/**
 * ASSUMED INTERFACE shared with the research-loop plan (REQ-cost-01): one
 * daily ceiling for verification and research. Spend is an append-only
 * ledger (cost.jsonl); the day is the UTC date of the event timestamp.
 * When the ceiling is reached the gate refuses; reading and reviewing never
 * consult it.
 */

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

export interface CostGate {
	allowed(): boolean;
	record(usd: number, source: string): void;
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

export function createCostGate(deps: { store: CostStore; ceilingUsd: number; now?: () => string }): CostGate {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		allowed: () => spentOnDay(deps.store.readEvents(), now().slice(0, 10)) < deps.ceilingUsd,
		record(usd, source) {
			if (!Number.isFinite(usd) || usd < 0) return;
			deps.store.appendEvent({ type: "spend", usd, source, at: now() });
		},
	};
}
