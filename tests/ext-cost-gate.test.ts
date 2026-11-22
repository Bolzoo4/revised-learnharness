// tests/ext-cost-gate.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCostGate, createSpendReservations, spentOnDay, type CostEvent } from "../src/core/ext/cost-gate.ts";

function mem() {
	const events: CostEvent[] = [];
	return { events, store: { appendEvent: (e: CostEvent) => void events.push(e), readEvents: () => [...events] } };
}

describe("cost gate (REQ-src-16 / REQ-cost-01)", () => {
	it("sums spend per UTC day", () => {
		const events: CostEvent[] = [
			{ type: "spend", usd: 0.5, source: "verification", at: "2026-11-04T01:00:00.000Z" },
			{ type: "spend", usd: 0.25, source: "research", at: "2026-11-04T23:00:00.000Z" },
			{ type: "spend", usd: 9, source: "verification", at: "2026-11-03T23:59:00.000Z" },
		];
		assert.equal(spentOnDay(events, "2026-11-04"), 0.75);
	});
	it("allows below the ceiling, refuses at it, and resets the next day", () => {
		const { store } = mem();
		let now = "2026-11-04T10:00:00.000Z";
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now });
		assert.equal(gate.allowed(), true);
		gate.record(0.6, "verification");
		assert.equal(gate.allowed(), true);
		gate.record(0.4, "research");
		assert.equal(gate.allowed(), false);
		now = "2026-11-05T00:00:01.000Z";
		assert.equal(gate.allowed(), true);
	});
	it("ignores non-finite and negative amounts", () => {
		const { store, events } = mem();
		const gate = createCostGate({ store, ceilingUsd: 1 });
		gate.record(Number.NaN, "verification");
		gate.record(-3, "verification");
		assert.equal(events.length, 0);
	});
});

describe("agent spend kind (REQ-graph-agent-18)", () => {
	it("counts only agent-kind spend against its own ceiling", async () => {
		const { agentSpendOnly, AGENT_SPEND_SOURCE, DEFAULT_AGENT_CEILING_USD } = await import("../src/core/ext/cost-gate.ts");
		assert.equal(AGENT_SPEND_SOURCE, "agent");
		assert.equal(DEFAULT_AGENT_CEILING_USD, 2, "default equals the verification ceiling");
		const { store, events } = mem();
		const shared = createCostGate({ store, ceilingUsd: 1, now: () => "2026-11-22T10:00:00.000Z" });
		const agent = createCostGate({ store: agentSpendOnly(store), ceilingUsd: 1, now: () => "2026-11-22T10:00:00.000Z" });
		shared.record(5, "verification");
		assert.equal(agent.allowed(), true, "verification spend does not close the agent kind");
		agent.record(1, AGENT_SPEND_SOURCE);
		assert.equal(agent.allowed(), false, "agent spend closes the agent kind at its ceiling");
		assert.equal(events.length, 2, "agent spend lands in the same ledger");
	});
});

describe("spend reservations: concurrent requests share one ceiling (REQ-graph-agent-18)", () => {
	it("two requests that each need more than half of the remaining budget: only the first is reserved", () => {
		const { events, store } = mem();
		const gate = createCostGate({ store, ceilingUsd: 0.15, now: () => "2026-11-22T10:00:00.000Z" });
		const first = gate.reserve?.(0.1, "agent");
		const second = gate.reserve?.(0.1, "agent");
		assert.ok(first, "the first request is reserved");
		assert.equal(second, null, "the second is refused while the first is in flight");
		assert.equal(events.length, 0, "a reservation is not ledger spend");
		assert.equal(gate.allowed(), true, "the reserved amount still counts only against the ceiling");
	});

	it("a commit writes the ledger spend once and frees the reservation; a release frees it without spend", () => {
		const { events, store } = mem();
		const gate = createCostGate({ store, ceilingUsd: 0.15, now: () => "2026-11-22T10:00:00.000Z" });
		const hold = gate.reserve?.(0.1, "agent");
		assert.ok(hold);
		hold!.commit();
		hold!.commit();
		assert.deepEqual(events.map((e) => [e.usd, e.source]), [[0.1, "agent"]]);
		assert.ok(gate.reserve?.(0.04, "agent"), "the committed spend is now ledger spend, so 0.04 more fits");
		const other = createCostGate({ store: mem().store, ceilingUsd: 0.15, now: () => "2026-11-22T10:00:00.000Z" });
		const dropped = other.reserve?.(0.1, "agent");
		dropped!.release();
		dropped!.release();
		assert.ok(other.reserve?.(0.1, "agent"), "a released reservation no longer holds budget, and releasing twice never goes below zero");
	});

	it("reservations shared between gate instances (one per call, as the live gate builds them) still hold the budget", () => {
		const { store } = mem();
		const book = createSpendReservations();
		const a = createCostGate({ store, ceilingUsd: 0.15, reservations: book, now: () => "2026-11-22T10:00:00.000Z" });
		const b = createCostGate({ store, ceilingUsd: 0.15, reservations: book, now: () => "2026-11-22T10:00:00.000Z" });
		assert.ok(a.reserve?.(0.1, "agent"));
		assert.equal(b.reserve?.(0.1, "agent"), null);
		assert.equal(book.total(), 0.1);
	});

	it("a reservation is refused when a provider pause is in force, and a zero or invalid amount is never held", () => {
		const { store } = mem();
		const paused = createCostGate({ store, ceilingUsd: 1, providerPause: { isPaused: () => true } as never, now: () => "2026-11-22T10:00:00.000Z" });
		assert.equal(paused.reserve?.(0.1, "agent"), null);
		const open = createCostGate({ store, ceilingUsd: 1, now: () => "2026-11-22T10:00:00.000Z" });
		assert.equal(open.reserve?.(-1, "agent"), null);
		assert.equal(open.reserve?.(Number.NaN, "agent"), null);
	});
});
