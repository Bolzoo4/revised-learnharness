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
export { parseReviewAnswer, parseSessionRequest, type ReviewAnswerInput } from "./review-input.ts";
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
export { audioRange, FAILED_TEXT } from "./lecture-audio.ts";
export * from "./practice-live.ts";
export * from "./study-live.ts";
export { StudyError } from "./study-service.ts";
export { parseDecision, requireString } from "./study-input.ts";
export { HttpError, httpErrorResponse, readJsonObject } from "./http-error.ts";
export { listExtPrompts, resetExtPrompt, updateExtPrompt } from "./prompt-settings.ts";
export { isPdfUpload, stagePdfUpload, type StagedPdf } from "./pdf-upload.ts";
export { ReviewInputError } from "../../core/ext/review-service.ts";
export {
	CYCLE_REFUSALS,
	makeClassify,
	makeResearchGap,
	researchAdmin,
	researchService,
	researchToolContext,
	startResearchScheduler,
	startResearchSession,
} from "./research-live.ts";
export { ResearchInputError } from "./research-errors.ts";
export { InboxError } from "../../core/ext/inbox-service.ts";
export type { AddWatchInput, SetMarkInput } from "./research-admin.ts";
export type { RunTrigger } from "./research-service.ts";
export type { InboxDecision, InboxItem, InboxStatus } from "../../core/ext/inbox.ts";
export type { SourceTier } from "../../core/ext/sources.ts";
export { debriefService, startDebriefScheduler } from "./debrief-live.ts";
export { providerPauseStatus } from "./provider-pause.ts";
export { outcomeResponse, parseLectureActivity, parseListQuery } from "./debrief-input.ts";

