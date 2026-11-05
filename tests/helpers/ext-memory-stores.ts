// tests/helpers/ext-memory-stores.ts
/** In-memory extension stores and a seeded graph for the personal-layer tests. */

import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { CardEvent } from "../../src/core/ext/cards.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { CardsStore, GoalsStore, ReviewStore } from "../../src/core/ext/ports.ts";
import type { ReviewEvent } from "../../src/core/ext/review.ts";
import type { QueryDeps } from "../../src/core/ext/review-queries.ts";
import { createMemoryGraphStore } from "./memory-graph-store.ts";

function memoryStore<T>(): { events: T[]; appendEvent: (e: T) => void; readEvents: () => T[] } {
	const events: T[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export const node = (id: string, name = id): GraphNode => ({
	id, name, statement: `${name} holds.`, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [],
});
export const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id, premises, conclusion, provenance: [], createdAt: "2026-11-01T00:00:00.000Z",
});

export interface Harness {
	deps: QueryDeps;
	review: ReviewStore & { events: ReviewEvent[] };
	cards: CardsStore & { events: CardEvent[] };
	goals: GoalsStore & { events: GoalEvent[] };
	clock: { now: string };
}

export function harness(opts: { nodes: GraphNode[]; chains?: GraphChain[]; now?: string }): Harness {
	const graphStore = createMemoryGraphStore();
	for (const n of opts.nodes) graphStore.appendNode(n);
	for (const c of opts.chains ?? []) graphStore.appendChain(c);
	const review = memoryStore<ReviewEvent>();
	const cards = memoryStore<CardEvent>();
	const goals = memoryStore<GoalEvent>();
	const clock = { now: opts.now ?? "2026-11-04T10:00:00.000Z" };
	let n = 0;
	return {
		deps: {
			graphStore, reviewStore: review, cardsStore: cards, goalsStore: goals,
			now: () => clock.now, newCardId: () => `card_t${++n}`,
		},
		review, cards, goals, clock,
	};
}

export function addGoal(h: Harness, goalId: string, targets: string[], priority = 3): void {
	h.goals.appendEvent({
		type: "created", goalId, title: goalId, origin: "user", originRef: "", targetNodeIds: targets, priority,
		at: "2026-11-01T00:00:00.000Z",
	});
}
