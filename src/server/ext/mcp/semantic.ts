// src/server/ext/mcp/semantic.ts
/**
 * The read-only server's view of the semantic index (REQ-search-09). Lazy and in memory: the index file is read
 * on the first use and again only when its size or modification time changes (the app writes it after a merge);
 * the embedder is loaded once, on the first use that needs it. Nothing here writes, and a failed load is not cached.
 */

import fs from "node:fs";

import type { EmbedderLoad, EmbedderSpec } from "../../../core/ext/embedder.ts";
import type { SemanticPort, SemanticState } from "../../../core/ext/mcp/ports.ts";
import type { VectorIndex } from "../../../core/ext/vector-index.ts";
import { readVectorIndexFile } from "../../../store/ext/readonly.ts";

const NOT_BUILT = "the semantic index has not been built yet";

/** The two stat fields the reader compares; a type of its own keeps the closure's fs allowlist to the read calls. */
interface FileStat {
	mtimeMs: number;
	size: number;
}

interface Snapshot {
	mtimeMs: number;
	size: number;
	/** The index, or null when `reason` says why it cannot be used. */
	index: VectorIndex | null;
	reason: string | null;
}

export function createSemanticReader(file: string, spec: EmbedderSpec, loadEmbedder: () => Promise<EmbedderLoad>): SemanticPort {
	let snap: Snapshot | null = null;
	let embedder: Extract<EmbedderLoad, { ok: true }>["embedder"] | null = null;

	function statNow(): FileStat | null {
		try {
			return fs.statSync(file, { throwIfNoEntry: false }) ?? null;
		} catch {
			return null;
		}
	}

	/** The file as it is now: re-read only when its size or modification time changed since the last read. */
	function snapshotFor(stat: FileStat): Snapshot {
		if (snap !== null && snap.mtimeMs === stat.mtimeMs && snap.size === stat.size) return snap;
		const index = readVectorIndexFile(file);
		let reason: string | null = null;
		if (index === null) reason = "the semantic index file is unreadable";
		else if (index.modelId !== spec.id || index.dim !== spec.dim) reason = "the semantic index was built by another model; the app will rebuild it";
		snap = { mtimeMs: stat.mtimeMs, size: stat.size, index: reason === null ? index : null, reason };
		return snap;
	}

	return {
		unavailable(): string | null {
			const stat = statNow();
			if (stat === null) return NOT_BUILT;
			if (snap !== null && snap.mtimeMs === stat.mtimeMs && snap.size === stat.size) return snap.reason;
			return null;
		},
		async load(): Promise<SemanticState> {
			const stat = statNow();
			if (stat === null) return { ok: false, reason: NOT_BUILT };
			const current = snapshotFor(stat);
			if (current.index === null) return { ok: false, reason: current.reason ?? "the semantic index is unavailable" };
			// The embedder is loaded once; a failed load is not kept, so the next call tries again.
			if (embedder === null) {
				const load = await loadEmbedder();
				if (!load.ok) return { ok: false, reason: load.reason };
				embedder = load.embedder;
			}
			const e = embedder;
			return {
				ok: true,
				index: current.index,
				embedQuery: async (text: string) => (await e.embed([text], "query"))[0]!,
			};
		},
	};
}
