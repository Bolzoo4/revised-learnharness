/**
 * The server seam of the teaching gate (REQ-graph-agent-19/20): the per-chat
 * registry of the in-flight extraction, the wait before a teaching turn, and
 * the not-extracted marker that the next extraction run catches up.
 *
 * In-memory by design: the durable truth of "not extracted" is the coverage
 * ledger (an un-merged passage stays uncovered across restarts). The marker
 * only forces the catch-up run below the chunk budget.
 */

import { awaitExtraction, TEACHING_GATE_TIMEOUT_MS, type GateStatus, type GateTimer } from "../core/ext/teaching-gate.ts";
import { coverageOf } from "../core/coverage.ts";
import type { CoverageEntry } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";

const inFlight = new Map<string, Promise<unknown>>();
/** Chats whose last run rejected before anyone waited on it: the next wait reports "failed". */
const failedRuns = new Set<string>();
const notExtracted = new Map<string, Set<string>>();
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

export function markNotExtracted(chatId: string, messageIds: readonly string[]): void {
	const set = notExtracted.get(chatId) ?? new Set<string>();
	for (const id of messageIds) set.add(id);
	notExtracted.set(chatId, set);
}

export function notExtractedIds(chatId: string): ReadonlySet<string> {
	return notExtracted.get(chatId) ?? new Set<string>();
}

/** True while the chat has marked turns: the next trigger runs below the budget. */
export function forceExtractionFor(chatId: string): boolean {
	return notExtractedIds(chatId).size > 0;
}

/** A successful extraction run caught the marked turns up. */
export function clearNotExtracted(chatId: string): void {
	notExtracted.delete(chatId);
}
