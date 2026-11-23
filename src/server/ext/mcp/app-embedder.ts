// src/server/ext/mcp/app-embedder.ts
/**
 * The read-only server's query embedder (REQ-search-09, REQ-mcp-01). The server holds no model: each query is embedded
 * by the running app (AppApiPort.embedQuery, POST /api/ext/agent/embed-query), which uses the model the index was
 * built with. Network-free itself: the only network use is the injected appApi (app-api.ts).
 *
 * The index header is checked before this embedder is ever asked (semantic.ts refuses an index built by another model),
 * so comparing each answer with the spec is the same check as comparing it with the index header.
 * An app that has no model, is not running or gives a stale answer makes the embedding throw a ToolError with its reason;
 * search_nodes then answers from keywords and says why.
 */

import type { Embedder, EmbedderLoad, EmbedderSpec, EmbedKind } from "../../../core/ext/embedder.ts";
import { ToolError } from "../../../core/ext/mcp/errors.ts";
import type { AppApiPort } from "../../../core/ext/mcp/ports.ts";

const STALE_MESSAGE = "the app's embedding model differs from the index; the index is stale until the app rebuilds it.";

/** A loader that always succeeds: the app is asked per query, so its unavailability surfaces as the embedding's error. */
export function appQueryEmbedder(appApi: AppApiPort, spec: EmbedderSpec): () => Promise<EmbedderLoad> {
	const embedder: Embedder = {
		spec,
		async embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]> {
			if (kind !== "query") throw new Error("the app embeds only the search query, never a document");
			const out: Float32Array[] = [];
			for (const text of texts) {
				const answer = await appApi.embedQuery(text);
				if (answer.modelId !== spec.id || answer.dim !== spec.dim) throw new ToolError("app_rejected", STALE_MESSAGE);
				out.push(Float32Array.from(answer.vector));
			}
			return out;
		},
	};
	const load: EmbedderLoad = { ok: true, embedder };
	return async () => load;
}
