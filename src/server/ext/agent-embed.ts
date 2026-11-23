// src/server/ext/agent-embed.ts
/**
 * The app's query embedding for the read-only MCP server (POST /api/ext/agent/embed-query). The server has no model:
 * a search query is embedded here, by the app's own embedder, which is the one the index was built with. Pure: the
 * embedder loader is injected (the live wiring is in semantic-live.ts). Answers:
 *   200 { vector, modelId, dim }   the query vector
 *   400 { error }                  the body is not { text: string (1..2000 chars), kind?: "query" }
 *   503 { unavailable }            no model in the cache, or the embedding failed; the reason is fixed text
 */

import type { EmbedderLoad, EmbedderSpec } from "../../core/ext/embedder.ts";

/** The longest query the app embeds (characters, after trimming). */
export const MAX_EMBED_QUERY_CHARS = 2000;

const EMBED_FAILED = "query embedding failed";
const ALLOWED_FIELDS = new Set(["text", "kind"]);

export type EmbedQueryAnswer =
	| { status: 200; body: { vector: number[]; modelId: string; dim: number } }
	| { status: 400; body: { error: string } }
	| { status: 503; body: { unavailable: string } };

/** Checks the body and embeds the query. Never throws: a failure is a 503 with a fixed reason. */
export async function embedAgentQuery(raw: unknown, opts: { spec: EmbedderSpec; load: () => Promise<EmbedderLoad> }): Promise<EmbedQueryAnswer> {
	const checked = checkBody(raw);
	if (!checked.ok) return { status: 400, body: { error: checked.error } };

	const load = await opts.load();
	if (!load.ok) return { status: 503, body: { unavailable: load.reason } };
	let vector: Float32Array | undefined;
	try {
		[vector] = await load.embedder.embed([checked.text], "query");
	} catch {
		return { status: 503, body: { unavailable: EMBED_FAILED } };
	}
	if (vector === undefined || vector.length !== opts.spec.dim) return { status: 503, body: { unavailable: EMBED_FAILED } };
	return { status: 200, body: { vector: Array.from(vector), modelId: opts.spec.id, dim: opts.spec.dim } };
}

/** The trimmed text, or the first problem found. */
function checkBody(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "the request body must be a JSON object" };
	const body = raw as Record<string, unknown>;
	for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: `unknown field: ${key}` };
	if (typeof body.text !== "string") return { ok: false, error: "text must be a string" };
	if (body.text.length > MAX_EMBED_QUERY_CHARS) return { ok: false, error: `text must be at most ${MAX_EMBED_QUERY_CHARS} characters` };
	const text = body.text.trim();
	if (text === "") return { ok: false, error: "text must not be empty" };
	if (body.kind !== undefined && body.kind !== "query") return { ok: false, error: 'kind must be "query" when given' };
	return { ok: true, text };
}
