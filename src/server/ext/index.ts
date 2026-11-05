// src/server/ext/index.ts
/** The extension layer's server barrel (re-exported by src/server/index.ts for app/ routes). */
export { withPostMerge } from "./post-merge.ts";
export {
	addLibrarySource,
	listLibrarySources,
	setLibrarySourceStatus,
	trustViews,
	verifyAfterMerge,
	verifyNodesNow,
	withTrustTags,
} from "./verification.ts";
export * from "./personal-layer.ts";
export * from "./personal-panel.ts";
export {
	decideNodeProposal,
	ensureNodeExplanation,
	generateNodeExplanations,
	nodePanel,
	runNodeAction,
	saveNodeExplanation,
} from "./node-knowledge-live.ts";
export { NodeKnowledgeError } from "./node-knowledge.ts";
export * from "./lecture-live.ts";
