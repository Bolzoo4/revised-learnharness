// src/core/ext/prompt-catalog.ts
/**
 * The catalog of the extension's EDITABLE agent prompts (pure: no fs, no
 * node imports). The settings UI lists these; the agent layer reads an
 * override for an id only when that id is here (src/agent/ext/prompt-override.ts).
 *
 * Editable = a static instruction text the code sends as the agent's system
 * prompt. A prompt that interleaves its own per-run data with its schema
 * (lecture outline/lecture/chapter detection, study card and page drafts,
 * exercise writer, the debrief and explanation prompt builders) is NOT here:
 * a user text there could drop the data or break the output contract, so
 * those prompts stay in code (docs/ext/CONTRACTS.md, "Editable extension prompts").
 *
 * The focus variants (review-card, review-node, office-hours) keep only the
 * static body here; the per-run data block is appended by code after it.
 */

/** The ids, in display order. */
export const EXT_PROMPT_IDS = [
	"verifier",
	"research-chat",
	"gap-researcher",
	"watch-classifier",
	"review-daily",
	"review-card",
	"review-node",
	"study-assistant",
	"office-hours",
	"debrief-style",
	"explanation-style",
	"session-notes",
] as const;

export type ExtPromptId = (typeof EXT_PROMPT_IDS)[number];

/** The longest override text the store accepts (characters). */
export const EXT_PROMPT_MAX_TEXT_CHARS = 20_000;

export interface ExtPromptEntry {
	readonly id: ExtPromptId;
	readonly label: string;
	/** One line: what the agent does. */
	readonly description: string;
	/** What the prompt depends on (tool names, output format) that an edit must keep. */
	readonly warning: string;
}

export const EXT_PROMPT_CATALOG: readonly ExtPromptEntry[] = [
	{
		id: "verifier",
		label: "Verifier",
		description: "Finds passages in your library and on the web that support or contradict a graph statement, and returns them as quotations. It judges nothing itself.",
		warning: "Code re-fetches every quoted passage and drops any quote it cannot find. The final JSON block must keep its shape: results, evidence, proposedSources.",
	},
	{
		id: "research-chat",
		label: "Research console",
		description: "The chat where you ask what the background research loop did, steer its frontier, decide sources and manage the watchlist.",
		warning: "Names the research tools (read_log, list_marks, edit_mark, run_cycle, control_cycle, list_inbox, decide_inbox, list_watchlist, edit_watchlist) and their rules. Keep the tool names exactly as they are.",
	},
	{
		id: "gap-researcher",
		label: "Gap researcher",
		description: "The background agent that searches sources to fill one gap in the graph and reports what it found.",
		warning: "It must finish by calling report_findings once, with questions, confidence, rationale, stopped_by and sources, and send progress with report_progress (text, at most 400 characters). The code checks both and the confidence threshold.",
	},
	{
		id: "watch-classifier",
		label: "Watch classifier",
		description: "Triages one new publication against the graph nodes in scope: does it extend, contradict or apply a node, and is it worth reading in?",
		warning: "Must call submit_classification exactly once with relation, action, rationale and nearest_node_ids. The node ids must come from the list it is given.",
	},
	{
		id: "review-daily",
		label: "Daily review",
		description: "Runs the daily review: one question per item, then records the rating the learner confirms.",
		warning: "Depends on the tools next_item, record_review, propose_card and ask_user_question, and on the four ratings Again, Hard, Good and Easy.",
	},
	{
		id: "review-card",
		label: "Card tutor",
		description: "Explains one flashcard the learner asks about. It never rates or records a review.",
		warning: "The card's node, statement, question and answer are appended by the code after this text. propose_card needs the node id that the code provides.",
	},
	{
		id: "review-node",
		label: "Node tutor",
		description: "Explains a node that has no card yet. It never rates or records a review.",
		warning: "The node id, name, statement and explanation are appended by the code after this text. propose_card needs the node id that the code provides.",
	},
	{
		id: "study-assistant",
		label: "Study assistant",
		description: "Answers questions about the document the learner is reading, grounded in its pages.",
		warning: "Citations must be written as (p. N) so the learner can click them. The current page, the selection and the document title are appended by the code after this text.",
	},
	{
		id: "office-hours",
		label: "Office hours",
		description: "Reviews the learner's own work through questions and hints. It never writes the solution and gives a verdict only on the /verdict command.",
		warning: "The verdict tool needs quotations copied exactly from the texts. Keep the tool names and the rule about /verdict. An exercise in focus is appended by the code after this text.",
	},
	{
		id: "debrief-style",
		label: "Debrief style",
		description: "The style guide for session debriefs: tone and emphasis of the four-part commentary.",
		warning: "The four parts (observations, state of learning, critique, suggestion), the submit tool and the rule that facts are data are fixed in code and appended after this guide.",
	},
	{
		id: "explanation-style",
		label: "Explanation style",
		description: "The style guide for node explanations: tone, depth and examples.",
		warning: "The structure (intuition, explanation, why it holds, example, common confusions) and the [[id]] link rule are fixed in code and appended after this guide.",
	},
	{
		id: "session-notes",
		label: "Session notes",
		description: "Reads the learner's own messages from one stretch of a study session and updates the note on how they want to study that session's material (intuition or formulas, kinds of example).",
		warning: "Must call submit_session_note exactly once with update (true or false) and note (the whole new note when update is true). The learner's messages are appended by the code after this text.",
	},
];

/** The catalog entry for an id, or undefined for anything not in the catalog. */
export function extPromptEntry(id: unknown): ExtPromptEntry | undefined {
	return EXT_PROMPT_CATALOG.find((entry) => entry.id === id);
}

/** True only for an id the catalog lists (the only ids that may be read, written or deleted). */
export function isExtPromptId(id: unknown): id is ExtPromptId {
	return extPromptEntry(id) !== undefined;
}

/** One prompt as the settings API reports it (GET /api/ext/prompts). */
export interface ExtPromptView {
	readonly id: ExtPromptId;
	readonly label: string;
	readonly description: string;
	readonly warning: string;
	/** The text the code runs without an override (the source text). */
	readonly defaultText: string;
	/** The saved override file's text, or null when there is no file. */
	readonly overrideText: string | null;
	/** The switch is on AND the file exists: the override is the text in use. */
	readonly enabled: boolean;
}
