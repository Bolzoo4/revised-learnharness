// src/agent/ext/lecture/prompts.ts
/**
 * Prompts of the lecture writers (pure strings). Doctrine from the teacher
 * project (CLAUDE.md, formato-lezione-spec.md): continuous prose, full formal
 * definitions, editorial additions tagged, never verbatim, timed toy
 * exercises, split from the outline.
 */

import type { Chapter } from "../../../core/ext/lecture/chapters.ts";
import type { OutlineBlock } from "../../../core/ext/lecture/split.ts";

export interface PromptNode {
	id: string;
	name: string;
	statement: string;
}

export const OUTLINE_SYSTEM = `You prepare the lesson plan of one textbook chapter.
Read the chapter and list its conceptual blocks IN THE ORDER the chapter presents them. For each block give a short title, a kind and a one-sentence summary.
Kinds: "definition" (a definition and its immediate comments), "theorem" (a theorem, lemma or proposition together with its proof), "example", "motivation" (introductory or connecting discussion), "remark".
Cover the whole chapter. Do not invent content that is not in the chapter. Write titles and summaries in the language of the chapter.
Submit the list with the submit_outline tool.`;

export function outlinePrompt(chapter: Chapter, chapterText: string): string {
	return `Chapter ${chapter.index}: ${chapter.title}\n\n--- CHAPTER TEXT ---\n${chapterText}`;
}

export const LECTURE_SYSTEM = `You write ONE lecture of a narrated university course from a textbook chapter. A lecture is a structured document: slides (what is shown) and blocks (what is said, in order). Submit it with the submit_lecture tool.

Language: write everything in the language of the chapter text.

Blocks:
- role "narrate": spoken discourse in continuous prose (no bullet points). For each concept: the formal definition stated in full, then the intuition, then for theorems the idea of the proof, then a look ahead.
- role "note": an editorial addition that is NOT in the source (motivation, a link to a later topic, an aside). All editorial material goes in note blocks and only there.
- role "exercise": a short toy example the listener works on for "seconds" (between 30 and 180), placed right after the main idea of a concept. It MUST be followed immediately by a block with role "reveal": the discussion of the solution.
- REPHRASE the source. Never copy sentences from the chapter text: a run of 12 or more consecutive words copied from it is rejected automatically.
- Every "narrate" block lists in nodeIds the graph nodes (given in the task) whose statement it states or explains. Use ONLY ids from that list. Try to cover all the nodes of your outline blocks across the lecture.
- Aim for about 2000 words of narrated text in total.

Slides:
- Each slide has a unique id, a heading and elements. Each element has a unique id (across the lecture) and a type: "text" (content), "formula" (content is LaTeX without delimiters) or "list" (items). Inline math in text and list items uses $...$.
- Mention a graph concept on a slide as [[node_id|visible words]] (for example [[n_ab12cd|sigma algebra]]). Only ids from the node list.
- Every block names the slide it is spoken over (slideId).

Cues: a block may highlight a slide element while it is spoken. A cue has atChar (the character offset in the block text where the highlight starts), target (an element id on that block's slide) and style "box" or "underline". Blocks without highlights have an empty cues list.

summary: 3 to 4 sentences recapping this lecture. The next lecture opens from it.
If a summary of the previous lecture is given, open by connecting to it in one or two sentences.`;

const nodeLines = (nodes: readonly PromptNode[]): string => nodes.map((n) => `- [${n.id}] ${n.name}: ${n.statement}`).join("\n");

export function lecturePrompt(input: {
	bookTitle: string;
	chapter: Chapter;
	order: number;
	lectureCount: number;
	blocks: readonly OutlineBlock[];
	nodes: readonly PromptNode[];
	previousSummary: string | null;
	chapterText: string;
	feedback: string | null;
}): string {
	const outline = input.blocks.map((b, i) => `${i + 1}. (${b.kind}) ${b.title}: ${b.summary}`).join("\n");
	const parts = [
		`Book: ${input.bookTitle}`,
		`Chapter ${input.chapter.index}: ${input.chapter.title}`,
		`You are writing lecture ${input.order} of ${input.lectureCount} of this chapter.`,
		`Outline blocks this lecture must cover, in order:\n${outline}`,
		`Previous lecture summary: ${input.previousSummary ?? "(this is the first lecture)"}`,
		`Graph nodes of this chapter (cite by id):\n${nodeLines(input.nodes)}`,
		`--- CHAPTER TEXT (source; rephrase, never copy) ---\n${input.chapterText}`,
	];
	if (input.feedback !== null) parts.push(input.feedback);
	return parts.join("\n\n");
}

export const CHAPTER_DETECT_SYSTEM = `You identify the top-level chapters of a book from an excerpt of its PDF. Chapters, not sections inside them.
Give each chapter its title and the 1-based PDF page number of the page where its heading appears. Pages must strictly increase and lie inside the book. If unsure about a page, use the page where the heading appears in the body text, not in the table of contents.
Submit with the submit_chapters tool.`;

export function chapterDetectPrompt(excerpt: string, pageCount: number): string {
	return `The book has ${pageCount} pages.\n\n--- EXCERPT ---\n${excerpt}`;
}
