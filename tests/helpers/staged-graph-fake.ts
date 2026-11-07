// tests/helpers/staged-graph-fake.ts
/**
 * A fake staged graph for the lecture service tests: each chapter stages its import, commit moves the
 * chapter's nodes into the "real" graph (keyed by the chapter's source path, as upstream keys them), and
 * a discarded or failed chapter leaves the real graph as it was. No model, no files.
 */

import { sourceIdForPath, type GraphNodeView, type StagedChapterGraph } from "../../src/agent/ext/lecture/chapter-run.ts";
import { NODE_A, NODE_B } from "./lecture-fixture.ts";

export function fakeStagedGraphs(opts: { nodeIds?: string[]; importError?: Error } = {}) {
	/** Real graph: the nodes of each committed chapter, by file path. */
	const committed = new Map<string, GraphNodeView[]>();
	const imports: Array<{ filePath: string; text: string }> = [];
	const nodesFor = (filePath: string): GraphNodeView[] =>
		(opts.nodeIds ?? [NODE_A, NODE_B]).map((id) => ({ id, name: id, statement: "s", provenance: [{ chatId: sourceIdForPath(filePath), messageId: "" }] }));

	const stageGraph = (): StagedChapterGraph => {
		let path: string | undefined;
		let staged: GraphNodeView[] = [];
		return {
			importText: async ({ filePath, text }) => {
				imports.push({ filePath, text });
				if (opts.importError) throw opts.importError;
				path = filePath;
				staged = nodesFor(filePath);
			},
			hasSource: () => path !== undefined,
			readNodes: () => [...[...committed.values()].flat(), ...staged],
			commit: () => {
				if (path !== undefined) committed.set(path, staged);
				staged = [];
			},
			discard: () => {
				staged = [];
			},
		};
	};
	return {
		stageGraph,
		activeGraph: (filePath: string) => (committed.has(filePath) ? { sourceId: sourceIdForPath(filePath), nodes: committed.get(filePath)! } : null),
		/** The real graph's nodes (what the overlay and the back-links read). */
		graphNodes: (): GraphNodeView[] => [...committed.values()].flat(),
		committed,
		imports,
	};
}
