// src/agent/ext/study/study-instructions.ts
/**
 * The study session's system prompt: fixed rules plus, per turn, the page the
 * learner is on (REQ-study-06). The agent is rebuilt for every turn, so this is
 * composed from the newest user message each time.
 */

import { latestStudyContext } from "../../../core/ext/study/context.ts";
import type { StudyToolContext } from "./study-tools.ts";
import { clipPage } from "./study-tools.ts";

export const STUDY_INSTRUCTIONS = [
	"You are a study companion. The learner is reading a document and asks you questions about it as they go.",
	"",
	"How to answer",
	"- Ground every answer in the document. The page the learner is on is given below; for other pages use read_page, and use search_pages to find where something is discussed.",
	"- Cite the pages you rely on as (p. N), for example (p. 12). The learner clicks a citation to jump to that page. Write only page numbers that exist in the document.",
	"- If the document does not say it, say so, then answer from general knowledge and mark it clearly as not from the document.",
	"- When the learner selected text, the question is about that text.",
	"- Explain simply first, then precisely. Reply in the learner's language.",
	"",
	"What you do not do",
	"- You do not create cards, nodes or notes. The learner makes cards with the Card button next to the page.",
	"- You do not judge whether the learner is right unless the document settles it; then quote or cite the page.",
	"",
	"Each learner message begins with a line starting [study-context]. It carries the page and the selection; it is metadata, do not repeat it.",
].join("\n");

/** The full prompt for one turn. */
export function studyPrompt(ctx: StudyToolContext): string {
	const doc = ctx.document();
	if (doc === null) return `${STUDY_INSTRUCTIONS}\n\nThe session's document is not available: tell the learner and stop.`;
	const parts = [STUDY_INSTRUCTIONS, "", `Document: ${doc.title} (${doc.pageCount} pages).`];
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	const current = latestStudyContext(messages);
	if (current !== null && current.documentId === doc.id && current.page <= doc.pageCount) {
		const text = ctx.pageText(current.page);
		parts.push("", `The learner is on page ${current.page}. Its text:`, "<<<PAGE", text === null || text.trim() === "" ? "(no extractable text on this page)" : clipPage(text), "PAGE>>>");
		if (current.selection !== "") parts.push("", "The learner selected:", "<<<SELECTION", current.selection, "SELECTION>>>");
	}
	return parts.join("\n");
}
