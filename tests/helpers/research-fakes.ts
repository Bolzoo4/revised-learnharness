// tests/helpers/research-fakes.ts
import type { CycleDeps, GapFinding } from "../../src/core/ext/cycle.ts";
import { DEFAULT_RESEARCH_CONFIG } from "../../src/core/ext/research-config.ts";
import type { EventLog } from "../../src/core/ext/research-ports.ts";
import type { Goal } from "../../src/core/ext/goals.ts";

export function memLog<T>(initial: T[] = []): EventLog<T> & { events: T[] } {
	const events = [...initial];
	return { events, append: (e) => void events.push(e), readAll: () => [...events] };
}

export const goal = (over: Partial<Goal> = {}): Goal => ({
	id: "goal_1",
	title: "g",
	origin: "user",
	originRef: "",
	targetNodeIds: ["t"],
	priority: 3,
	status: "active",
	createdAt: "t",
	updatedAt: "t",
	...over,
});

export const nodes = ["t", "p1", "p2"].map((id) => ({ id, name: `name-${id}`, statement: `Statement of ${id} about gradients.` }));
export const chains = [{ premises: ["p1", "p2"], conclusion: "t" }];

export function finding(over: Partial<GapFinding & { costUsd: number }> = {}): GapFinding & { costUsd: number } {
	return { questions: ["what?"], confidence: 0.9, rationale: "enough", stoppedBy: "confidence", sources: [], unfetched: [], costUsd: 0.05, ...over };
}

/** A fully scripted CycleDeps; override any part. Records what the cycle called. */
export function fakeDeps(over: Partial<CycleDeps> = {}) {
	const calls = { research: [] as string[], extracted: [] as string[], ingested: [] as string[], verified: [] as string[][], classified: [] as string[] };
	let n = 0;
	const deps: CycleDeps = {
		now: () => new Date("2026-11-04T12:00:00.000Z"),
		newId: (prefix) => `${prefix}_${++n}`,
		config: DEFAULT_RESEARCH_CONFIG,
		costGate: { allowed: () => true, record: () => {} },
		graph: () => ({ nodes, chains }),
		goals: () => [goal()],
		uncovered: () => [],
		weakNodeIds: () => [],
		frontier: memLog(),
		log: memLog(),
		inbox: memLog(),
		radar: memLog(),
		watchlist: { read: () => [] },
		verification: {
			trustOf: () => new Map([["p1", { trust: "sourced" as const, hasPrimarySupport: true }], ["p2", { trust: "sourced" as const, hasPrimarySupport: true }], ["t", { trust: "sourced" as const, hasPrimarySupport: true }]]),
			verifyNodes: async (ids) => void calls.verified.push([...ids]),
		},
		library: { isActive: () => false, activeLocators: () => [], activate: () => {} },
		snapshots: { put: (text) => `hash:${text.length}` },
		extractChat: async (chatId) => (calls.extracted.push(chatId), 2),
		ingest: async (src) => (calls.ingested.push(src.locator), 3),
		researchGap: async (gap) => (calls.research.push(gap.id), finding()),
		fetchItems: async () => [],
		classify: async (item) => (calls.classified.push(item.id), { relation: "extends", action: "ingest", rationale: "r", nearestNodeIds: ["p1"] }),
		takeSteers: () => [],
		allSteers: () => [],
		isAborted: () => false,
		...over,
	};
	return { deps, calls };
}
