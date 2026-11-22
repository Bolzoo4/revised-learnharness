/**
 * The server seam of the teaching gate (REQ-graph-agent-19/20): the per-chat
 * registry of the in-flight extraction, the wait before a teaching turn, and
 * the not-extracted marker that the next extraction run catches up.
 *
 * The marker is durable: an append-only JSONL ledger (store/ext/ledger.ts),
 * folded into memory on first read. The coverage ledger stays the truth for
 * which passages are merged; this marker only forces the catch-up run.
 */

import { awaitExtraction, TEACHING_GATE_TIMEOUT_MS, type GateStatus, type GateTimer } from "../core/ext/teaching-gate.ts";
import { coverageOf } from "../core/coverage.ts";
import type { CoverageEntry, PlanTree } from "../core/contracts.ts";
import { derivePlanStatusesLh } from "../core/contracts/plan.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { createLedger, type Ledger } from "../store/ext/ledger.ts";
import { EXT_PATHS } from "../store/ext/paths.ts";

// ─── the durable marker ledger ──────────────────────────────────────────────

export type TeachingGateEvent =
	| { kind: "mark"; chatId: string; messageIds: string[] }
	| { kind: "clear"; chatId: string };

export function parseTeachingGateEvent(raw: unknown): TeachingGateEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as { kind?: unknown; chatId?: unknown; messageIds?: unknown };
	if (typeof e.chatId !== "string") return null;
	if (e.kind === "clear") return { kind: "clear", chatId: e.chatId };
	if (e.kind === "mark" && Array.isArray(e.messageIds) && e.messageIds.every((id) => typeof id === "string")) {
		return { kind: "mark", chatId: e.chatId, messageIds: e.messageIds as string[] };
	}
	return null;
}

/** A marker ledger rooted at `dir` (the production root is EXT_PATHS.dir). */
export function makeTeachingGateLedger(dir: string): Ledger<TeachingGateEvent> {
	return createLedger(dir, "teaching-gate.jsonl", parseTeachingGateEvent);
}

let ledger: Ledger<TeachingGateEvent> | null = null;
/** chatId -> un-extracted message ids; null until the ledger is folded. */
let marks: Map<string, Set<string>> | null = null;

function activeLedger(): Ledger<TeachingGateEvent> {
	return ledger ?? (ledger = makeTeachingGateLedger(EXT_PATHS.dir));
}

function apply(into: Map<string, Set<string>>, e: TeachingGateEvent): void {
	if (e.kind === "clear") into.delete(e.chatId);
	else into.set(e.chatId, new Set([...(into.get(e.chatId) ?? []), ...e.messageIds]));
}

function state(): Map<string, Set<string>> {
	if (marks) return marks;
	const folded = new Map<string, Set<string>>();
	try {
		for (const e of activeLedger().readAll()) apply(folded, e);
	} catch (err) {
		console.error("[teaching-gate] marker ledger unreadable — starting empty:", err);
	}
	return (marks = folded);
}

function record(e: TeachingGateEvent): void {
	apply(state(), e);
	try {
		activeLedger().append(e);
	} catch (err) {
		// The in-memory marker still holds; only durability is lost for this event.
		console.error(`[chat ${e.chatId}] teaching gate marker not persisted:`, err);
	}
}

/** Test seam: swap the marker ledger (null restores the production ledger). */
export function setTeachingGateLedger(next: Ledger<TeachingGateEvent> | null): void {
	ledger = next;
	marks = null;
}

// ─── timing and the in-flight registry ──────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();
/** Chats whose last run rejected before anyone waited on it: the next wait reports "failed". */
const failedRuns = new Set<string>();
let timingOverride: { timeoutMs: number; timer: GateTimer } | null = null;

const realTimer: GateTimer = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Test seam: shorten the cap or inject a clock. `null` restores the real 60 s. */
export function setTeachingGateTiming(timing: { timeoutMs: number; timer: GateTimer } | null): void {
	timingOverride = timing;
}

/** Register a chat's in-flight extraction. One run per chat: a second
 *  registration while one is in flight is ignored (the first owns the wait). */
export function trackExtraction(chatId: string, run: Promise<unknown>): void {
	if (inFlight.has(chatId)) return;
	inFlight.set(chatId, run);
	failedRuns.delete(chatId);
	const release = () => {
		if (inFlight.get(chatId) === run) inFlight.delete(chatId);
	};
	run.then(release, () => {
		failedRuns.add(chatId);
		release();
	});
}

/** The chat's in-flight extraction, or null when none runs. */
export function pendingExtraction(chatId: string): Promise<unknown> | null {
	return inFlight.get(chatId) ?? null;
}

/** A teaching plan is being followed: the record has a plan tree and some
 *  node has not been visited yet (a quiz on it, the current one counts as visited
 *  once a later node starts). */
export function planInProgress(chat: { tree?: PlanTree | null; messages: readonly LhMessage[] }): boolean {
	const tree = chat.tree;
	if (!tree || tree.nodes.length === 0) return false;
	const statuses = derivePlanStatusesLh(tree, chat.messages);
	const done = new Set<string>([...statuses.visited, ...(statuses.current ? [statuses.current] : [])]);
	return tree.nodes.some((n) => !done.has(n.id));
}

/**
 * Wait for the chat's in-flight extraction, capped at 60 s; never throws.
 * Marks the teacher prose the run left uncovered (timeout, failure, or a run
 * that finished with prose still unmerged, i.e. a failed batch) so the next
 * extraction run catches it up. `messages`/`entries` are the record and the
 * coverage ledger as this turn sees them.
 */
export async function waitForTeaching(
	chatId: string,
	messages: readonly LhMessage[],
	entries: readonly CoverageEntry[],
): Promise<GateStatus> {
	const pending = pendingExtraction(chatId);
	const status: GateStatus =
		pending === null && failedRuns.delete(chatId)
			? "failed"
			: (await awaitExtraction(pending, timingOverride ?? { timeoutMs: TEACHING_GATE_TIMEOUT_MS, timer: realTimer })).status;
	if (status === "none") return status;
	console.info(`[chat ${chatId}] teaching gate: extraction ${status}`);
	const covered = coverageOf(messages, entries, chatId);
	const uncovered = covered.uncovered.map((i) => covered.slots[i]!.message.id);
	if (status !== "done" || uncovered.length > 0) markNotExtracted(chatId, uncovered);
	return status;
}

// ─── the marker API ─────────────────────────────────────────────────────────

export function markNotExtracted(chatId: string, messageIds: readonly string[]): void {
	if (messageIds.length === 0) return;
	record({ kind: "mark", chatId, messageIds: [...messageIds] });
}

export function notExtractedIds(chatId: string): ReadonlySet<string> {
	return state().get(chatId) ?? new Set<string>();
}

/** True while the chat has marked turns: the next trigger runs below the budget. */
export function forceExtractionFor(chatId: string): boolean {
	return notExtractedIds(chatId).size > 0;
}

/** A successful extraction run caught the marked turns up. */
export function clearNotExtracted(chatId: string): void {
	if (!state().has(chatId)) return;
	record({ kind: "clear", chatId });
}
