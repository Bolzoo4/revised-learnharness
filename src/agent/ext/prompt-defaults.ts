// src/agent/ext/prompt-defaults.ts
/**
 * The DEFAULT text of every editable extension prompt (the source text the
 * agents run without an override). Keyed by the catalog's ExtPromptId, so a
 * catalog entry without a default does not compile. Read on every call: the
 * style guides are files.
 */

import { type ExtPromptId } from "../../core/ext/prompt-catalog.ts";
import { loadDebriefStyle } from "./debrief-writer.ts";
import { loadStyleGuide } from "./explanation-writer.ts";
import { GAP_RESEARCH_INSTRUCTIONS } from "./gap-research.ts";
import { OFFICE_HOURS_INSTRUCTIONS } from "./practice/office-hours-instructions.ts";
import { RESEARCH_INSTRUCTIONS } from "./research-instructions.ts";
import { REVIEW_CARD_BODY, REVIEW_INSTRUCTIONS, REVIEW_NODE_BODY } from "./review-instructions.ts";
import { SESSION_NOTE_INSTRUCTIONS } from "./session-notes-writer.ts";
import { STUDY_INSTRUCTIONS } from "./study/study-instructions.ts";
import { VERIFIER_INSTRUCTIONS } from "./verifier.ts";
import { VIDEO_BUILDER_INSTRUCTIONS } from "./video-builder.ts";
import { VISUAL_JOB_INSTRUCTIONS } from "./visual-job-tools.ts";
import { WATCH_CLASSIFY_INSTRUCTIONS } from "./watch-classify.ts";

export const EXT_PROMPT_DEFAULTS: Record<ExtPromptId, () => string> = {
	verifier: () => VERIFIER_INSTRUCTIONS,
	"research-chat": () => RESEARCH_INSTRUCTIONS,
	"gap-researcher": () => GAP_RESEARCH_INSTRUCTIONS,
	"watch-classifier": () => WATCH_CLASSIFY_INSTRUCTIONS,
	"review-daily": () => REVIEW_INSTRUCTIONS,
	"review-card": () => REVIEW_CARD_BODY,
	"review-node": () => REVIEW_NODE_BODY,
	"study-assistant": () => STUDY_INSTRUCTIONS,
	"office-hours": () => OFFICE_HOURS_INSTRUCTIONS,
	"visual-jobs": () => VISUAL_JOB_INSTRUCTIONS,
	"debrief-style": () => loadDebriefStyle(),
	"explanation-style": () => loadStyleGuide(),
	"session-notes": () => SESSION_NOTE_INSTRUCTIONS,
	"video-builder": () => VIDEO_BUILDER_INSTRUCTIONS,
};

/** The default text of one catalog prompt. */
export function extPromptDefault(id: ExtPromptId): string {
	return EXT_PROMPT_DEFAULTS[id]();
}
