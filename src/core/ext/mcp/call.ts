// src/core/ext/mcp/call.ts
/**
 * One tool call's consistent view of the data. Every ledger is read at most
 * once per call and `now` is fixed, so a tool never mixes two instants or two
 * versions of the files while the app appends (REQ-mcp-03 risk: torn reads are
 * skipped line by line; a changed file between two reads cannot split a call).
 */

import type { GraphChain, GraphNode } from "../../contracts.ts";
import type { GraphStore } from "../../ports.ts";
import type { ReviewDeps } from "../review-service.ts";
import { snapshot, type Snapshot } from "../review-service.ts";
import { ToolError } from "./errors.ts";
import type { McpDeps } from "./ports.ts";

export interface Call {
	deps: McpDeps;
	now: string;
	/** The graph, read once. */
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	/** The app's own ReviewDeps over the same single reads and the fixed `now`. */
	review: ReviewDeps;
}

function memo<T>(read: () => T): () => T {
	let done = false;
	let value: T | undefined;
	return () => {
		if (!done) {
			value = read();
			done = true;
		}
		return value as T;
	};
}

export function openCall(deps: McpDeps): Call {
	deps.assertReadable();
	const now = deps.now();
	const graph: Pick<GraphStore, "readNodes" | "readChains"> = {
		readNodes: memo((): GraphNode[] => deps.review.graphStore.readNodes()),
		readChains: memo((): GraphChain[] => deps.review.graphStore.readChains()),
	};
	const r = deps.review;
	return {
		deps,
		now,
		graph,
		review: {
			...r,
			graphStore: graph,
			goalsStore: { ...r.goalsStore, readEvents: memo(() => r.goalsStore.readEvents()) },
			reviewStore: { ...r.reviewStore, readEvents: memo(() => r.reviewStore.readEvents()) },
			cardsStore: { ...r.cardsStore, readEvents: memo(() => r.cardsStore.readEvents()) },
			now: () => now,
		},
	};
}

/**
 * Runs a replay of the review history. Any failure becomes a fixed-text
 * data_inconsistent error: the raw exception, which may carry paths or ids,
 * never leaves the server.
 */
export function guardReplay<T>(replay: () => T): T {
	try {
		return replay();
	} catch (error) {
		if (error instanceof ToolError) throw error;
		throw new ToolError("data_inconsistent", "The review history could not be replayed; study-state tools are unavailable until it is repaired.");
	}
}

export function snapshotOf(call: Call): Snapshot {
	return guardReplay(() => snapshot(call.review, call.now));
}
