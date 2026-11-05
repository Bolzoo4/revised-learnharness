// tests/helpers/ext-node-fixtures.ts
/**
 * Builders and fakes shared by the node-knowledge tests: graph nodes and
 * chains, an in-memory explanations store, a scripted writer and cost gates.
 */

import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { ExplanationEvent } from "../../src/core/ext/explanations.ts";
import type {
	CostGate,
	ExplanationsStore,
	ExplanationWriter,
	WriterRequest,
} from "../../src/core/ext/node-knowledge-ports.ts";
import type { GraphStore } from "../../src/core/ports.ts";
import { createMemoryGraphStore } from "./memory-graph-store.ts";

export const T0 = "2026-11-04T10:00:00.000Z";

export function node(id: string, name: string = id, statement: string = `${name} holds.`): GraphNode {
	return { id, name, statement, aliases: [], createdAt: T0, provenance: [] };
}

export function chain(id: string, premises: string[], conclusion: string): GraphChain {
	return { id, premises, conclusion, provenance: [], createdAt: T0 };
}

export function graphWith(nodes: GraphNode[], chains: GraphChain[]): GraphStore {
	const store = createMemoryGraphStore();
	for (const n of nodes) store.appendNode(n);
	for (const c of chains) store.appendChain(c);
	return store;
}

export function memoryExplanations(): ExplanationsStore & { events: ExplanationEvent[] } {
	const events: ExplanationEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export interface FakeWriter extends ExplanationWriter {
	requests: WriterRequest[];
}

/** bodyFor(nodeId, attempt) -> body; attempt counts earlier requests that contained the node. */
export function fakeWriter(
	bodyFor: (nodeId: string, attempt: number) => string,
	costUsd = 0.01,
): FakeWriter {
	const requests: WriterRequest[] = [];
	const attempts = new Map<string, number>();
	return {
		requests,
		async write(request) {
			requests.push(request);
			const bodies: Record<string, string> = {};
			for (const n of request.nodes) {
				const attempt = attempts.get(n.id) ?? 0;
				attempts.set(n.id, attempt + 1);
				bodies[n.id] = bodyFor(n.id, attempt);
			}
			return { bodies, costUsd, styleVersion: "style-test" };
		},
	};
}

/** Allows generation until `limit` costs have been recorded. */
export function limitedGate(limit: number): CostGate & { spent: number[] } {
	const spent: number[] = [];
	return { spent, allowed: () => spent.length < limit, record: (usd) => void spent.push(usd) };
}

export const openGate = (): CostGate & { spent: number[] } => limitedGate(Number.POSITIVE_INFINITY);
export const closedGate = (): CostGate & { spent: number[] } => limitedGate(0);
