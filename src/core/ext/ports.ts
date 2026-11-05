/**
 * Storage ports of the extension layer (same hexagonal rule as
 * src/core/ports.ts: core codes against these types, adapters live in
 * src/store/ext/, wiring happens once in src/server/ext/stores.ts).
 */

import type { GoalEvent } from "./goals.ts";

export interface GoalsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: GoalEvent): void;
	/** Valid events in append order. */
	readEvents(): GoalEvent[];
}

import type { SourceEntry } from "./sources.ts";

/** The source library: a configuration file, read-modify-write (not an event ledger). */
export interface SourcesStore {
	/** Valid entries only; [] when the file is absent or unreadable. Throws on a newer stamp. */
	read(): SourceEntry[];
	write(entries: SourceEntry[]): void;
}

import type { VerificationEvent } from "./trust.ts";

/** Immutable text snapshots addressed by sha256 (REQ-src-04). */
export interface SnapshotStore {
	/** Stores the text (idempotent) and returns its sha256 hex. */
	put(text: string): string;
}

export interface VerificationStore {
	/** Throws if the event is invalid. */
	appendEvent(event: VerificationEvent): void;
	readEvents(): VerificationEvent[];
}

import type { VerifierOutput } from "./verifier-output.ts";

/** Re-reads a source's text for the snapshot. The model's view of a source is never trusted. */
export interface SourceTextReader {
	/** `ref` is a URL or the locator of a library PDF. null when unreadable. */
	read(ref: string): Promise<string | null>;
}

export interface VerifierInput {
	nodes: { id: string; statement: string }[];
	/** ACTIVE library entries only. */
	library: SourceEntry[];
}

export interface VerifierRun {
	/** null when the agent's final message held no usable JSON. */
	output: VerifierOutput | null;
	/** Provider-qualified model that produced it, for the event's `checker`. */
	checker: string;
}

export interface Verifier {
	run(
		input: VerifierInput,
		hooks: { signal: AbortSignal; onCostUsd(usd: number): void },
	): Promise<VerifierRun>;
}

import type { CardEvent } from "./cards.ts";
import type { ReviewEvent } from "./review.ts";

export interface ReviewStore {
	/** Throws if the event is invalid. */
	appendEvent(event: ReviewEvent): void;
	/** Valid events in append order. */
	readEvents(): ReviewEvent[];
}

export interface CardsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: CardEvent): void;
	/** Valid events in append order. */
	readEvents(): CardEvent[];
}
