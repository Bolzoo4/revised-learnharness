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
