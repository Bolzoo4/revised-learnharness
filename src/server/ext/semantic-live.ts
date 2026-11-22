// src/server/ext/semantic-live.ts
/**
 * The running app's semantic index: one indexer over the live graph (REQ-search-07). The post-merge hook
 * schedules a debounced refresh after each merge that added nodes. The embedder is the Transformers.js adapter
 * with downloads off: until the owner has downloaded the model (scripts/embed-download.ts --yes), a refresh
 * records "unavailable: model not downloaded" and writes nothing.
 */

import path from "node:path";

import { DEFAULT_EMBEDDER_SPEC } from "../../core/ext/embedder.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { stores } from "../stores.ts";
import { createSemanticIndexer, type SemanticIndexer } from "./semantic-indexer.ts";
import { createTransformersLoader } from "./embedder-transformers.ts";
import { vectorIndexPath } from "./vector-index-store.ts";
import type { GraphNode } from "../../core/contracts.ts";

const REFRESH_DEBOUNCE_MS = 5000;

export interface LiveIndexerOptions {
	/** The index file (vectorIndexPath). */
	file: string;
	readNodes(): GraphNode[];
	/** Model cache directory. Default: <data dir>/ext/models. */
	cacheDir?: string;
	debounceMs: number;
}

/** The indexer the app runs: the default model, loaded from the cache only (downloads off). */
export function createLiveSemanticIndexer(options: LiveIndexerOptions): SemanticIndexer {
	return createSemanticIndexer({
		file: options.file,
		spec: DEFAULT_EMBEDDER_SPEC,
		readNodes: options.readNodes,
		loadEmbedder: createTransformersLoader(DEFAULT_EMBEDDER_SPEC, { cacheDir: options.cacheDir, allowDownload: false }),
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
