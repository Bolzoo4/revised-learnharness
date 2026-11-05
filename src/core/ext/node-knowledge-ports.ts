// src/core/ext/node-knowledge-ports.ts
/**
 * Ports of the node-knowledge feature (same hexagonal rule as ports.ts):
 * core codes against these types, adapters live in src/store/ext/ and
 * src/agent/ext/, wiring happens in src/server/ext/.
 */

import type { ExplanationEvent } from "./explanations.ts";
import type { ExplanationForm } from "./explanation-rules.ts";

export interface ExplanationsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: ExplanationEvent): void;
	/** Valid events in append order. */
	readEvents(): ExplanationEvent[];
}

/** Text a generation is grounded in; `refs` are snapshot hashes (may be empty). */
export interface SourceContext {
	text: string;
	refs: string[];
}

/** What the writer needs to know about one node. */
export interface WriterNode {
	id: string;
	name: string;
	statement: string;
	aliases: string[];
	form: ExplanationForm;
	/** One entry per chain concluding this node: that chain's premises. */
	arguments: Array<Array<{ id: string; name: string; statement: string }>>;
	/** Nodes that use this node as a premise. */
	usedIn: Array<{ id: string; name: string }>;
}

export interface WriterRequest {
	nodes: WriterNode[];
	source: SourceContext | null;
	/** nodeId -> problems found in the previous attempt (empty on the first). */
	feedback: Record<string, string[]>;
}

export interface WriterResult {
	/** nodeId -> markdown body (with `[[node id]]` inline links). */
	bodies: Record<string, string>;
	costUsd: number;
	/** Hash of the style guide used. */
	styleVersion: string;
}

export interface ExplanationWriter {
	write(request: WriterRequest): Promise<WriterResult>;
}

/** The single daily cost ceiling of the umbrella spec (REQ-cost-01, REQ-node-16). */
export interface CostGate {
	allowed(): boolean;
	record(usd: number): void;
}
