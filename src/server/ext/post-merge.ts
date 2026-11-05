// src/server/ext/post-merge.ts
/**
 * The post-merge hook (REQ-src-13): wraps the app's ONE extraction pipeline
 * so a successful merge that added nodes triggers automatic verification.
 * The hook is fire-and-forget: it never delays or fails the extraction.
 * Inert under NODE_ENV=test (scripted chats are fixtures, not knowledge).
 */

import type { ExtractionPipeline } from "../../agent/subagents/extraction.ts";

export interface PostMergeOptions {
	enabled?: boolean;
	log?: (message: string, err: unknown) => void;
}

export function withPostMerge(
	pipeline: ExtractionPipeline,
	onMerged: () => Promise<unknown>,
	options: PostMergeOptions = {},
): ExtractionPipeline {
	const enabled = options.enabled ?? process.env.NODE_ENV !== "test";
	const log = options.log ?? ((message, err) => console.error(message, err));
	function after<T extends { nodes: number }>(stats: T): T {
		if (enabled && stats.nodes > 0) {
			void Promise.resolve()
				.then(onMerged)
				.catch((err) => log("[ext] post-merge verification failed:", err));
		}
		return stats;
	}
	return {
		runExtraction: async (chatId) => after(await pipeline.runExtraction(chatId)),
		importNotes: async (input) => after(await pipeline.importNotes(input)),
	};
}
