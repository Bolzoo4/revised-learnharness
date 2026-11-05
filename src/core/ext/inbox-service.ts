// src/core/ext/inbox-service.ts
/**
 * The user's decision on a pending inbox source (REQ-rs-08, REQ-rs-09):
 * reject (never proposed again), approve (ingest this one source once), or
 * activate (add it to the library as an active source and ingest it). Only the
 * USER decides; nothing in the cycle calls this.
 */

import { deriveInbox, ingestedEvent, normalizeLocator, type InboxDecision, type InboxEvent } from "./inbox.ts";
import type { EventLog, IngestSource, LibraryEntryInput } from "./research-ports.ts";
import type { SourceTier } from "./sources.ts";

export class InboxError extends Error {
	constructor(
		readonly code: "not-found" | "not-pending" | "in-progress" | "snapshot-missing" | "bad-decision" | "bad-tier",
		message: string,
	) {
		super(message);
		this.name = "InboxError";
	}
}

export interface InboxServiceDeps {
	inbox: EventLog<InboxEvent>;
	/** Reads a snapshot stored by SnapshotStore.put (study-ports.ts SnapshotReader). */
	snapshots: { get(sha256: string): string | null };
	library: { activate(entry: LibraryEntryInput): void };
	ingest(source: IngestSource): Promise<number>;
	now(): Date;
}

export interface InboxDecisionResult {
	decision: InboxDecision;
	nodesAdded: number;
}

/**
 * Decisions in flight per inbox log: two concurrent calls on one locator must not both ingest.
 * The guard is in-process only, and keyed on the stable `inbox` log object (not on `deps`, which
 * callers may rebuild per call); a second process or a different log object is not covered.
 */
const inFlight = new WeakMap<object, Set<string>>();

/**
 * Apply the user's decision to a pending item.
 *
 * Ordering and failure semantics:
 * - Validation (decision, tier, item, snapshot) happens before any side effect.
 * - `activated` adds the library entry BEFORE ingesting. If the ingest then fails, the entry stays
 *   active while the item is still pending; retrying is safe because activate is idempotent.
 * - At-least-once: there is a crash window between the ingest and the two ledger appends
 *   (`decided`, then `ingested`). A crash there leaves the item pending although its nodes exist,
 *   so a retry ingests again. Accepted: the log has no transaction across ingest and append.
 */
export async function decideInboxItem(
	deps: InboxServiceDeps,
	rawLocator: string,
	decision: InboxDecision,
	tier: SourceTier = "secondary",
): Promise<InboxDecisionResult> {
	if (decision !== "approved" && decision !== "rejected" && decision !== "activated") {
		throw new InboxError("bad-decision", `unknown decision ${String(decision)}`);
	}
	if (tier !== "primary" && tier !== "secondary") throw new InboxError("bad-tier", `unknown tier ${String(tier)}`);
	const locator = normalizeLocator(rawLocator);
	const item = deriveInbox(deps.inbox.readAll()).find((i) => i.locator === locator);
	if (item === undefined) throw new InboxError("not-found", `no inbox item for ${locator}`);
	if (item.status !== "pending") throw new InboxError("not-pending", `${locator} was already ${item.status}`);
	const busy = inFlight.get(deps.inbox) ?? new Set<string>();
	inFlight.set(deps.inbox, busy);
	if (busy.has(locator)) throw new InboxError("in-progress", `${locator} is being decided`);
	busy.add(locator);
	try {
		const at = deps.now().toISOString();
		if (decision === "rejected") {
			deps.inbox.append({ type: "decided", locator, decision, at });
			return { decision, nodesAdded: 0 };
		}
		const text = deps.snapshots.get(item.snapshot);
		if (text === null || text === "") throw new InboxError("snapshot-missing", `the stored text of ${locator} is gone`);
		if (decision === "activated") deps.library.activate({ locator, kind: "url-prefix", label: item.title || locator, tier });
		const count = await deps.ingest({ locator, title: item.title, text });
		const ingested = ingestedEvent(locator, count, at);
		deps.inbox.append({ type: "decided", locator, decision, at });
		deps.inbox.append(ingested);
		return { decision, nodesAdded: ingested.nodesAdded };
	} finally {
		busy.delete(locator);
	}
}
