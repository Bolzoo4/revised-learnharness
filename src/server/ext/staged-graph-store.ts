// src/server/ext/staged-graph-store.ts
/**
 * A STAGING overlay over the real graph store (lecture chapters, docs/ext/CONTRACTS.md
 * "Staged chapter graph"). Reads return the base ∪ the staged writes, so an extraction run
 * dedupes and links against existing nodes and against its own earlier parts. Every write goes
 * to memory only: nothing reaches the base until commit(), and a crash or restart discards it.
 *
 * Commit replays the staged writes into the base in the order sources, usage, nodes, chains,
 * coverage, checkpoints, once. A link-append to an existing node id stays staged: the base node
 * line is never changed, and the merged view adds the phrasings the same way getGraph does for
 * any two lines of one id.
 *
 * Two upstream operations are not staged: deleteSources (removing sources is never a chapter's
 * business) throws, and rewriteLedgers supports chains only. The chain rewrite is the
 * simplification pass in mergeFindings; it may drop staged chain lines, never base chain lines,
 * so a chapter cannot hide what already exists.
 */

import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	SessionCheckpoint,
} from "../../core/contracts.ts";
import type { GraphStore } from "../../core/ports.ts";

export interface StagedCommitStats {
	sources: number;
	usage: number;
	nodes: number;
	chains: number;
	coverage: number;
	checkpoints: number;
}

export interface StagedGraphStore extends GraphStore {
	/** Replays every staged write into the base, once. A second call is a no-op. */
	commit(): StagedCommitStats;
	/** Drops every staged write. Writes after this throw. Safe after commit (the staged memory is cleared). */
	discard(): void;
	/** "open" until commit or discard. */
	readonly state: "open" | "committed" | "discarded";
}

const ZERO: StagedCommitStats = { sources: 0, usage: 0, nodes: 0, chains: 0, coverage: 0, checkpoints: 0 };

const lineKey = (line: unknown): string => JSON.stringify(line);

export function createStagedGraphStore(base: GraphStore): StagedGraphStore {
	let state: StagedGraphStore["state"] = "open";
	const sources = new Map<string, NotesSource>();
	let usage: Array<{ id: string; entry: ExtractionRunUsage }> = [];
	const nodes: GraphNode[] = [];
	let chains: GraphChain[] = [];
	const coverage: CoverageEntry[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	let positions: Record<string, Position> | undefined;

	const writable = (op: string): void => {
		if (state !== "open") throw new Error(`staged graph store: ${op} after ${state === "committed" ? "commit" : "discard"}`);
	};

	/** The base source record with the staged usage merged in (usage is a log, deduped per startedAt). */
	function sourceView(id: string): NotesSource | undefined {
		const staged = sources.get(id);
		const baseRecord = base.readSources().find((s) => s.id === id);
		if (staged === undefined) return baseRecord;
		const extractions: ExtractionRunUsage[] = [...(baseRecord?.extractions ?? [])];
		for (const u of usage) {
			if (u.id === id && !extractions.some((e) => e.startedAt === u.entry.startedAt)) extractions.push(u.entry);
		}
		return { ...staged, extractions };
	}

	const store: Omit<StagedGraphStore, "commit" | "discard"> = {
		get state() {
			return state;
		},

		appendNode(node) {
			writable("appendNode");
			nodes.push(node);
		},
		readNodes() {
			return [...base.readNodes(), ...nodes];
		},

		appendChain(assertion) {
			writable("appendChain");
			chains.push(assertion);
		},
		readChains() {
			return [...base.readChains(), ...chains];
		},

		appendCheckpoint(checkpoint) {
			writable("appendCheckpoint");
			checkpoints.push(checkpoint);
		},
		readCheckpoints() {
			return [...base.readCheckpoints(), ...checkpoints];
		},

		appendCoverage(entry) {
			writable("appendCoverage");
			coverage.push(entry);
		},
		readCoverage() {
			return [...base.readCoverage(), ...coverage];
		},

		upsertSource(source) {
			writable("upsertSource");
			sources.set(source.id, { id: source.id, filePath: source.filePath, importedAt: source.importedAt, ...(source.contentFp !== undefined ? { contentFp: source.contentFp } : {}) });
		},
		readSources() {
			const ids = new Set(base.readSources().map((s) => s.id));
			for (const id of sources.keys()) ids.add(id);
			return [...ids].map((id) => sourceView(id)!).filter((s) => s !== undefined);
		},
		deleteSources() {
			throw new Error("staged graph store: deleteSources is not staged (a chapter never removes sources)");
		},
		appendSourceUsage(id, entry) {
			writable("appendSourceUsage");
			// Like the base: no such source (staged or real), nothing to bill against.
			if (sourceView(id) === undefined) return;
			usage.push({ id, entry });
		},

		readPositions() {
			return positions === undefined ? base.readPositions() : { ...positions };
		},
		writePositions(next) {
			writable("writePositions");
			positions = { ...next };
		},

		rewriteLedgers(next) {
			writable("rewriteLedgers");
			if (next.nodes !== undefined || next.coverage !== undefined || next.checkpoints !== undefined) {
				throw new Error("staged graph store: rewriteLedgers supports chains only");
			}
			if (next.chains === undefined) return;
			// Keep the staged lines the rewrite keeps; base lines are never dropped.
			const kept = new Set(next.chains.map(lineKey));
			chains = chains.filter((c) => kept.has(lineKey(c)));
		},
	};

	return Object.assign(store, {
		commit(): StagedCommitStats {
			if (state === "discarded") throw new Error("staged graph store: cannot commit after discard");
			if (state === "committed") return { ...ZERO };
			// Set first: a replay that throws half-way must never be replayed again.
			state = "committed";
			const stats: StagedCommitStats = { ...ZERO };
			for (const source of sources.values()) {
				base.upsertSource(source);
				stats.sources++;
			}
			for (const u of usage) {
				base.appendSourceUsage(u.id, u.entry);
				stats.usage++;
			}
			for (const node of nodes) {
				base.appendNode(node);
				stats.nodes++;
			}
			for (const chain of chains) {
				base.appendChain(chain);
				stats.chains++;
			}
			for (const entry of coverage) {
				base.appendCoverage(entry);
				stats.coverage++;
			}
			for (const checkpoint of checkpoints) {
				base.appendCheckpoint(checkpoint);
				stats.checkpoints++;
			}
			clearStaged();
			return stats;
		},
		discard(): void {
			if (state === "open") state = "discarded";
			clearStaged();
		},
	});

	function clearStaged(): void {
		sources.clear();
		usage = [];
		nodes.length = 0;
		chains = [];
		coverage.length = 0;
		checkpoints.length = 0;
		positions = undefined;
	}
}
