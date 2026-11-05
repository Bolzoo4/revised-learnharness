// src/core/ext/research-ports.ts
/**
 * Ports of the research loop. Core codes against these; adapters live in
 * src/store/ext/ and src/server/ext/. The verification, library and weak-premise
 * ports are thin views over the implemented source-verification and personal-layer
 * services; src/server/ext/research-adapters.ts is the single file that adapts them.
 * The cost ceiling is the shared `CostGate` of src/core/ext/cost-gate.ts.
 */

import type { TrustLevel } from "./trust.ts";

/** Append-only event log: structurally the store's createLedger result. */
export interface EventLog<T> {
	append(event: T): void;
	readAll(): T[];
}

export interface TrustInfo {
	trust: TrustLevel;
	/** True when some supporting evidence of the node's latest check comes from a primary library source. */
	hasPrimarySupport: boolean;
}

/** Adapter over the source-verification service (src/server/ext/verification.ts). */
export interface VerificationAccess {
	/** Derived trust per node id (a missing id reads as unverified, no primary support). */
	trustOf(nodeIds: readonly string[]): Map<string, TrustInfo>;
	/** Run the verification stage for these nodes (it enforces the shared cost ceiling itself). */
	verifyNodes(nodeIds: readonly string[]): Promise<void>;
}

export interface LibraryEntryInput {
	locator: string;
	kind: "pdf" | "url-prefix" | "repo";
	label: string;
	tier: "primary" | "secondary";
}

/** Adapter over the source library (data/ext/sources.json, src/core/ext/sources.ts). */
export interface SourceLibraryAccess {
	/** True iff the locator matches an ACTIVE library entry. */
	isActive(locator: string): boolean;
	/** Locators of the active entries (the research agent tries these first). */
	activeLocators(): string[];
	/** The user's decision: add the entry as active (or activate an existing one with the same locator), which re-verifies in-scope unverified/contested nodes. */
	activate(entry: LibraryEntryInput): void;
}

/** A chat whose teacher prose is not yet extracted into the graph. */
export interface UncoveredChat {
	chatId: string;
	title: string;
	messages: number;
}

export interface GraphNodeLite {
	id: string;
	name: string;
	statement: string;
}

export interface ChainLite {
	premises: string[];
	conclusion: string;
}

export interface IngestSource {
	locator: string;
	title: string;
	text: string;
}

/**
 * What `CycleDeps.researchGap` should throw when the research failed AFTER money was
 * spent: an Error with `costUsd` set to the spend so far. The cycle records it (sanitized:
 * finite and >= 0, else 0) in the gap's log and in the mark's budget. The Task 10 adapter
 * must attach it to every error it rethrows.
 */
export interface GapError extends Error {
	costUsd?: number;
}
