// src/server/ext/semantic-indexer.ts
/**
 * App-side maintenance of the node vector index (REQ-search-07, 09). Only the
 * app process runs this; the MCP server reads the file and never writes it.
 *
 * refresh() embeds what changed (new or re-texted nodes), drops what vanished,
 * and writes the file atomically. A failure at any step keeps the previous file
 * and records the reason. Refreshes run one at a time. schedule() debounces a
 * burst of graph changes into one refresh, and never blocks the caller.
 *
 * The embedder comes from `loadEmbedder`. Until the Transformers.js adapter is
 * approved, the app passes `unavailableEmbedder`, which reports that the model is
 * not installed.
 */

import type { GraphNode } from "../../core/contracts.ts";
import { checkEmbedderSpec, type Embedder, type EmbedderSpec } from "../../core/ext/embedder.ts";
import { applyUpdate, baseFor, indexText, planUpdate, textHash, type VectorIndex } from "../../core/ext/vector-index.ts";
import { readVectorIndex, writeVectorIndex } from "./vector-index-store.ts";

export const MODEL_UNAVAILABLE = "unavailable: model not installed";

export type EmbedderLoad = { ok: true; embedder: Embedder } | { ok: false; reason: string };

/** The production loader until the model adapter exists: always unavailable. */
export function unavailableEmbedder(): Promise<EmbedderLoad> {
	return Promise.resolve({ ok: false, reason: MODEL_UNAVAILABLE });
}

export interface RefreshReport {
	status: "updated" | "unchanged" | "failed";
	embedded: number;
	dropped: number;
	reason?: string;
}

export interface IndexerStatus {
	lastError: string | null;
	lastRefreshAt: string | null;
}

export interface SemanticIndexerOptions {
	/** The index file (vectorIndexPath). */
	file: string;
	spec: EmbedderSpec;
	readNodes(): GraphNode[];
	loadEmbedder(): Promise<EmbedderLoad>;
	/** Quiet time after the last schedule() before the refresh runs. */
	debounceMs: number;
	now?: () => string;
}

export interface SemanticIndexer {
	refresh(): Promise<RefreshReport>;
	schedule(): void;
	status(): IndexerStatus;
	dispose(): void;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSemanticIndexer(options: SemanticIndexerOptions): SemanticIndexer {
	const problems = checkEmbedderSpec(options.spec);
	if (problems.length > 0) throw new RangeError(`invalid embedder spec: ${problems.join("; ")}`);
	const now = options.now ?? (() => new Date().toISOString());

	/** undefined until the first refresh reads the file; then the index as last written (or null when absent). */
	let current: VectorIndex | null | undefined;
	let lastError: string | null = null;
	let lastRefreshAt: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	function failed(reason: string): RefreshReport {
		lastError = reason;
		return { status: "failed", embedded: 0, dropped: 0, reason };
	}

	async function run(): Promise<RefreshReport> {
		try {
			if (current === undefined) current = readVectorIndex(options.file);
			const nodes = options.readNodes();
			const hashes = new Map<string, string>();
			const texts = new Map<string, string>();
			for (const node of nodes) {
				const text = indexText(node);
				texts.set(node.id, text);
				hashes.set(node.id, textHash(text));
			}
			const base = baseFor(options.spec, current ?? null);
			const plan = planUpdate(
				nodes.map((node) => ({ id: node.id, hash: hashes.get(node.id)! })),
				base,
			);
			if (plan.embed.length === 0 && plan.drop.length === 0 && base === current) {
				lastError = null;
				return { status: "unchanged", embedded: 0, dropped: 0 };
			}

			const upserts: Array<{ id: string; hash: string; vector: Float32Array }> = [];
			if (plan.embed.length > 0) {
				const load = await options.loadEmbedder();
				if (!load.ok) return failed(load.reason);
				if (load.embedder.spec.id !== options.spec.id || load.embedder.spec.dim !== options.spec.dim) {
					return failed("the loaded embedder does not match the index spec");
				}
				let vectors: Float32Array[];
				try {
					vectors = await load.embedder.embed(
						plan.embed.map((id) => texts.get(id)!),
						"document",
					);
				} catch (error) {
					return failed(`embedding failed: ${message(error)}`);
				}
				if (vectors.length !== plan.embed.length) return failed("the embedder returned the wrong number of vectors");
				plan.embed.forEach((id, i) => upserts.push({ id, hash: hashes.get(id)!, vector: vectors[i]! }));
			}

			const next = applyUpdate(base, { upserts, drop: plan.drop });
			writeVectorIndex(options.file, next);
			current = next;
			lastError = null;
			lastRefreshAt = now();
			return { status: "updated", embedded: upserts.length, dropped: plan.drop.length };
		} catch (error) {
			return failed(`index refresh failed: ${message(error)}`);
		}
	}

	function refresh(): Promise<RefreshReport> {
		const next = queue.then(run, run);
		queue = next.catch(() => undefined);
		return next;
	}

	function schedule(): void {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void refresh();
		}, options.debounceMs);
		timer.unref?.();
	}

	function dispose(): void {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	return { refresh, schedule, status: () => ({ lastError, lastRefreshAt }), dispose };
}
