// src/core/ext/inbox-service.ts
/**
 * The user's decision on a pending inbox source (REQ-rs-08, REQ-rs-09):
 * reject (never proposed again), approve (ingest this one source once), or
 * activate (add it to the library as an active source and ingest it). Only the
 * USER decides; nothing in the cycle calls this.
 */

import { deriveInbox, normalizeLocator, type InboxDecision, type InboxEvent } from "./inbox.ts";
import type { EventLog, IngestSource, LibraryEntryInput } from "./research-ports.ts";
import type { SourceTier } from "./sources.ts";

export class InboxError extends Error {
	constructor(
		readonly code: "not-found" | "not-pending" | "snapshot-missing" | "bad-decision",
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

/** Decisions in flight per inbox log: two concurrent calls on one locator must not both ingest. */
const inFlight = new WeakMap<object, Set<string>>();

export async function decideInboxItem(
	deps: InboxServiceDeps,
	rawLocator: string,
	decision: InboxDecision,
	tier: SourceTier = "secondary",
): Promise<InboxDecisionResult> {
	if (decision !== "approved" && decision !== "rejected" && decision !== "activated") {
		throw new InboxError("bad-decision", `unknown decision ${String(decision)}`);
	}
	const locator = normalizeLocator(rawLocator);
	const item = deriveInbox(deps.inbox.readAll()).find((i) => i.locator === locator);
	if (item === undefined) throw new InboxError("not-found", `no inbox item for ${locator}`);
	if (item.status !== "pending") throw new InboxError("not-pending", `${locator} was already ${item.status}`);
	const busy = inFlight.get(deps.inbox) ?? new Set<string>();
	inFlight.set(deps.inbox, busy);
	if (busy.has(locator)) throw new InboxError("not-pending", `${locator} is being decided`);
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
		const nodesAdded = Number.isInteger(count) && count >= 0 ? count : 0;
		deps.inbox.append({ type: "decided", locator, decision, at });
		deps.inbox.append({ type: "ingested", locator, nodesAdded, at });
		return { decision, nodesAdded };
	} finally {
		busy.delete(locator);
	}
}
