// src/server/ext/semantic-live.ts
/**
 * The running app's semantic index: one indexer over the live graph (REQ-search-07). The post-merge hook
 * schedules a debounced refresh after each merge that added nodes. The embedder is the Transformers.js adapter
 * with downloads off: until the owner has downloaded the model (scripts/embed-download.ts --yes), a refresh
 * records "unavailable: model not downloaded" and writes nothing.
 */

import path from "node:path";

import { DEFAULT_EMBEDDER_SPEC, type EmbedderLoad } from "../../core/ext/embedder.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { stores } from "../stores.ts";
import { createSemanticIndexer, type SemanticIndexer } from "./semantic-indexer.ts";
import { createTransformersLoader } from "./embedder-transformers.ts";
import { vectorIndexPath } from "./vector-index-store.ts";
import { embedAgentQuery, type EmbedQueryAnswer } from "./agent-embed.ts";
import type { GraphNode } from "../../core/contracts.ts";

const REFRESH_DEBOUNCE_MS = 5000;

/**
 * The app's one embedder loader, shared by the index refresh and the query embeddings so the model is held once.
 * Downloads are off: the model loads from the cache only, and is unavailable until the owner downloads it.
 */
const liveEmbedLoad: () => Promise<EmbedderLoad> = createTransformersLoader(DEFAULT_EMBEDDER_SPEC, { allowDownload: false });
let queryLoad: () => Promise<EmbedderLoad> = liveEmbedLoad;

/** Test seam: replaces the query embedder's loader (null restores the live one). The index keeps its own. */
export function setQueryEmbedLoadForTests(load: (() => Promise<EmbedderLoad>) | null): void {
	queryLoad = load ?? liveEmbedLoad;
}

/** POST /api/ext/agent/embed-query: the app embeds one search query with its live model (see agent-embed.ts). */
export function embedAgentQueryLive(raw: unknown): Promise<EmbedQueryAnswer> {
	return embedAgentQuery(raw, { spec: DEFAULT_EMBEDDER_SPEC, load: () => queryLoad() });
}

export interface LiveIndexerOptions {
	/** The index file (vectorIndexPath). */
	file: string;
	readNodes(): GraphNode[];
	/** Model cache directory, for a loader of its own. Default: <data dir>/ext/models (the shared loader). */
	cacheDir?: string;
	debounceMs: number;
}

/** The indexer the app runs: the default model, loaded from the cache only (downloads off). */
export function createLiveSemanticIndexer(options: LiveIndexerOptions): SemanticIndexer {
	return createSemanticIndexer({
		file: options.file,
		spec: DEFAULT_EMBEDDER_SPEC,
		readNodes: options.readNodes,
		loadEmbedder: options.cacheDir === undefined ? liveEmbedLoad : createTransformersLoader(DEFAULT_EMBEDDER_SPEC, { cacheDir: options.cacheDir, allowDownload: false }),
		debounceMs: options.debounceMs,
	});
}

const indexer = createLiveSemanticIndexer({
	file: vectorIndexPath(path.dirname(EXT_PATHS.dir)),
	readNodes: () => stores.graphStore.readNodes(),
	debounceMs: REFRESH_DEBOUNCE_MS,
});

/** Called after a merge that added nodes. Fire-and-forget: never waits, never throws. */
export function scheduleSemanticRefresh(): void {
	indexer.schedule();
}

export function semanticIndexStatus() {
	return indexer.status();
}
