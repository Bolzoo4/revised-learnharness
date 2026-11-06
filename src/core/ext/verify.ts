// src/core/ext/verify.ts
/**
 * The verification run for a list of nodes (REQ-src-04..06, 11, 12, 14, 16).
 * The verifier agent only CLAIMS evidence; this module is where claims become
 * facts: it re-reads each source itself, snapshots it, checks the quote
 * against the snapshot, assigns the tier from the library, and appends one
 * event per node. A failed or aborted run appends `check_failed` and never
 * touches the derived level.
 */

import type { GraphNode } from "../contracts.ts";
import type { GraphStore } from "../ports.ts";
import type { CostGate } from "./cost-gate.ts";
import type { SnapshotStore, SourcesStore, SourceTextReader, Verifier, VerificationStore } from "./ports.ts";
import { checkQuote } from "./quote.ts";
import { createSourceLibrary, hostOfEntry, matchSource, type SourceEntry } from "./sources.ts";
import { outcomeOf, type Discarded, type Evidence } from "./trust.ts";
import type { RawEvidence } from "./verifier-output.ts";

/** Nodes per verifier run (open item of the spec). */
export const VERIFY_BATCH_SIZE = 5;
/** Raw evidence items considered per node. */
export const MAX_EVIDENCE_PER_NODE = 8;

export interface VerifyDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	sourcesStore: SourcesStore;
	snapshotStore: SnapshotStore;
	verificationStore: VerificationStore;
	verifier: Verifier;
	reader: SourceTextReader;
	costGate: CostGate;
	now?: () => string;
}

export interface VerifyReport {
	checked: string[];
	failed: string[];
	skippedBudget: string[];
	unknown: string[];
	/** Nodes left unverified (not failed) because a provider usage limit paused the work. */
	providerLimited: string[];
}

function hostOfUrl(ref: string): string {
	try {
		return new URL(ref).hostname;
	} catch {
		return "";
	}
}

export async function buildEvidence(
	raw: readonly RawEvidence[],
	ctx: { sources: readonly SourceEntry[]; reader: SourceTextReader; snapshots: SnapshotStore; cache: Map<string, string | null> },
): Promise<{ evidence: Evidence[]; discarded: Discarded[] }> {
	const evidence: Evidence[] = [];
	const discarded: Discarded[] = [];
	for (const r of raw.slice(0, MAX_EVIDENCE_PER_NODE)) {
		const entry = matchSource(r.sourceRef, ctx.sources);
		const readRef = entry?.kind === "pdf" ? entry.locator : r.sourceRef;
		let text: string | null;
		if (ctx.cache.has(readRef)) text = ctx.cache.get(readRef) ?? null;
		else {
			try {
				text = await ctx.reader.read(readRef);
			} catch {
				text = null;
			}
			ctx.cache.set(readRef, text);
		}
		if (text === null) {
			discarded.push({ sourceRef: r.sourceRef, reason: "source_unreadable" });
			continue;
		}
		const check = checkQuote(text, r.quote);
		if (check !== "ok") {
			discarded.push({ sourceRef: r.sourceRef, reason: check });
			continue;
		}
		evidence.push({
			sourceRef: r.sourceRef,
			sourceId: entry?.id ?? null,
			locator: r.locator,
			quote: r.quote,
			snapshot: ctx.snapshots.put(text),
			stance: r.stance,
			tier: entry?.tier ?? "unvetted",
			host: entry !== null ? hostOfEntry(entry) : hostOfUrl(r.sourceRef),
			...(entry?.author !== undefined ? { author: entry.author } : {}),
		});
	}
	return { evidence, discarded };
}

export async function verifyNodes(nodeIds: readonly string[], deps: VerifyDeps): Promise<VerifyReport> {
	const now = deps.now ?? (() => new Date().toISOString());
	const report: VerifyReport = { checked: [], failed: [], skippedBudget: [], unknown: [], providerLimited: [] };
	/** True when the gate is closed by a provider usage limit (not by the ceiling). */
	const providerLimited = (): boolean => {
		try {
			return deps.costGate.reason?.() === "provider-limit";
		} catch {
			return false;
		}
	};
	const known = new Map<string, GraphNode>(deps.graphStore.readNodes().map((n) => [n.id, n]));
	const ids = [...new Set(nodeIds)];
	report.unknown = ids.filter((id) => !known.has(id));
	const todo = ids.filter((id) => known.has(id));

	for (let i = 0; i < todo.length; i += VERIFY_BATCH_SIZE) {
		const batch = todo.slice(i, i + VERIFY_BATCH_SIZE);
		// A provider usage limit leaves every remaining node unverified, not failed, and starts no batch.
		if (providerLimited()) {
			report.providerLimited.push(...todo.slice(i));
			break;
		}
		if (!deps.costGate.allowed()) {
			report.skippedBudget.push(...batch);
			continue;
		}
		const sources = deps.sourcesStore.read();
		const controller = new AbortController();
		let run: Awaited<ReturnType<Verifier["run"]>> | null = null;
		let failure = "";
		try {
			run = await deps.verifier.run(
				{ nodes: batch.map((id) => ({ id, statement: known.get(id)!.statement })), library: sources.filter((e) => e.status === "active") },
				{
					signal: controller.signal,
					onCostUsd: (usd) => {
						deps.costGate.record(usd, "verification");
						if (!deps.costGate.allowed()) controller.abort();
					},
				},
			);
		} catch (err) {
			failure = controller.signal.aborted ? "budget_exhausted" : `error: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (run === null || run.output === null) {
			// A failure during a provider limit is not a check: the batch stays unverified and the limit's text is never written.
			if (providerLimited()) {
				report.providerLimited.push(...batch, ...todo.slice(i + VERIFY_BATCH_SIZE));
				break;
			}
			const reason = failure !== "" ? failure : "unparseable_output";
			for (const id of batch) {
				deps.verificationStore.appendEvent({ type: "check_failed", nodeId: id, reason, at: now() });
				report.failed.push(id);
			}
			continue;
		}
		const cache = new Map<string, string | null>();
		for (const id of batch) {
			const rawEvidence = run.output.results.find((r) => r.nodeId === id)?.evidence ?? [];
			const { evidence, discarded } = await buildEvidence(rawEvidence, { sources, reader: deps.reader, snapshots: deps.snapshotStore, cache });
			deps.verificationStore.appendEvent({ type: "checked", nodeId: id, outcome: outcomeOf(evidence), evidence, discarded, checker: run.checker, at: now() });
			report.checked.push(id);
		}
		if (run.output.proposedSources.length > 0) createSourceLibrary(deps.sourcesStore).propose(run.output.proposedSources);
	}
	return report;
}
