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

export interface SpendHold {
	/** Writes the amount to the ledger and frees the hold. Idempotent. */
	commit(): void;
	/** Frees the hold without spend. Idempotent. */
	release(): void;
}

/** The amounts reserved by calls in flight, shared by every gate instance that must respect the same ceiling. */
export interface SpendReservations {
	total(): number;
	hold(usd: number): () => void;
}

export function createSpendReservations(): SpendReservations {
	let held = 0;
	return {
		total: () => held,
		hold(usd) {
			held += usd;
			let live = true;
			return () => {
				if (!live) return;
				live = false;
				held = Math.max(0, held - usd);
			};
		},
	};
}

export interface CostGate {
	allowed(): boolean;
	record(usd: number, source: string): void;
	/** Holds usd against the ceiling before a call spends it: refused (null) when the ceiling, counting every hold, would be exceeded. */
	reserve?(usd: number, source: string): SpendHold | null;
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

export function createCostGate(deps: { store: CostStore; ceilingUsd: number; now?: () => string; providerPause?: ProviderPause; reservations?: SpendReservations }): CostGate {
	const now = deps.now ?? (() => new Date().toISOString());
	const holds = deps.reservations ?? createSpendReservations();
	const spentToday = () => spentOnDay(deps.store.readEvents(), now().slice(0, 10));
	const reason = (): CostGateRefusal | null => {
		if (deps.providerPause?.isPaused(Date.parse(now())) === true) return "provider-limit";
		return spentToday() + holds.total() < deps.ceilingUsd ? null : "ceiling";
	};
	const record = (usd: number, source: string) => {
		if (!Number.isFinite(usd) || usd < 0) return;
		deps.store.appendEvent({ type: "spend", usd, source, at: now() });
	};
	return {
		allowed: () => reason() === null,
		reason,
		record,
		reserve(usd, source) {
			// One synchronous step: the check and the hold cannot interleave with another call.
			if (!Number.isFinite(usd) || usd < 0) return null;
			if (deps.providerPause?.isPaused(Date.parse(now())) === true) return null;
			if (spentToday() + holds.total() + usd > deps.ceilingUsd) return null;
			const drop = holds.hold(usd);
			let open = true;
			return {
				commit() {
					if (!open) return;
					open = false;
					try {
						record(usd, source);
					} finally {
						drop();
					}
				},
				release() {
					if (!open) return;
					open = false;
					drop();
				},
			};
		},
	};
}

/** The source of agent-triggered spend (the study agent's file imports, REQ-graph-agent-18). */
export const AGENT_SPEND_SOURCE = "agent";
/** Its own daily ceiling, equal to the verification default by design. */
export const DEFAULT_AGENT_CEILING_USD = 2;

/**
 * A view of the ledger that keeps only agent spend, so the agent kind has its own ceiling.
 * Writes go to the same ledger, so total spend stays visible; the shared gate still counts every event.
 */
export function agentSpendOnly(store: CostStore): CostStore {
	return {
		appendEvent: (event) => store.appendEvent(event),
		readEvents: () => store.readEvents().filter((e) => e.source === AGENT_SPEND_SOURCE),
	};
}
