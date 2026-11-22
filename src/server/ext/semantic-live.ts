// src/server/ext/semantic-live.ts
/**
 * The running app's semantic index: one indexer over the live graph (REQ-search-07). The post-merge hook
 * schedules a debounced refresh after each merge that added nodes. The embedder is `unavailableEmbedder`
 * until the model adapter is approved; until then a refresh records "unavailable: model not installed" and
 * writes nothing.
 */

import path from "node:path";

import { DEFAULT_EMBEDDER_SPEC } from "../../core/ext/embedder.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { stores } from "../stores.ts";
import { createSemanticIndexer, unavailableEmbedder } from "./semantic-indexer.ts";
import { vectorIndexPath } from "./vector-index-store.ts";

const REFRESH_DEBOUNCE_MS = 5000;

const indexer = createSemanticIndexer({
	file: vectorIndexPath(path.dirname(EXT_PATHS.dir)),
	spec: DEFAULT_EMBEDDER_SPEC,
	readNodes: () => stores.graphStore.readNodes(),
	loadEmbedder: unavailableEmbedder,
	debounceMs: REFRESH_DEBOUNCE_MS,
});

/** Called after a merge that added nodes. Fire-and-forget: never waits, never throws. */
export function scheduleSemanticRefresh(): void {
	indexer.schedule();
}

export function semanticIndexStatus() {
	return indexer.status();
}
