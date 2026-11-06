// src/core/ext/mcp/lectures.ts
/**
 * list_lectures and get_lecture (REQ-mcp-04). A lecture is shown as an outline:
 * headings, the nodes each slide covers, and the timed exercises. The narration
 * (narrate, note and reveal blocks) is never returned (spec: slides' narration
 * text is omitted); the exercise prompt is, capped.
 */

import { isValidLectureId, lectureNodeRefs, type Lecture } from "../lecture/lecture.ts";
import type { Call } from "./call.ts";
import { ToolError, invalid } from "./errors.ts";
import { optionalInt, requireText } from "./input.ts";
import { capText, LIMITS, page, textPage } from "./limits.ts";

export function listLectures(call: Call, input: Record<string, unknown>) {
	const chapter = optionalInt(input.chapter, "chapter", 1, 100_000);
	const all = call.deps.lectures
		.list()
		.filter((l) => chapter === undefined || l.chapter.index === chapter)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const p = page(all, LIMITS.lecturesMax);
	return {
		...p,
		items: p.items.map((l) => ({
			id: l.id,
			title: capText(l.title, LIMITS.titleChars),
			bookTitle: capText(l.bookTitle, LIMITS.titleChars),
			chapter: { index: l.chapter.index, title: capText(l.chapter.title, LIMITS.titleChars), pageStart: l.chapter.pageStart, pageEnd: l.chapter.pageEnd },
			order: l.order,
			createdAt: l.createdAt,
			slideCount: l.slides.length,
			exerciseCount: l.blocks.filter((b) => b.role === "exercise").length,
			citedNodeCount: lectureNodeRefs(l).length,
		})),
	};
}

function outline(l: Lecture) {
	const slides = page(
		l.slides.map((s) => {
			const blocks = l.blocks.filter((b) => b.slideId === s.id);
			const ids = [...new Set(blocks.flatMap((b) => b.nodeIds))];
			return { id: s.id, heading: capText(s.heading, LIMITS.titleChars), blockCount: blocks.length, nodeIds: textPage(ids, LIMITS.slideNodesMax, LIMITS.idMaxChars) };
		}),
		LIMITS.slidesMax,
	);
	const exercises = page(
		l.blocks
			.filter((b) => b.role === "exercise")
			.map((b) => ({
				blockId: b.id,
				slideId: b.slideId,
				seconds: b.seconds ?? 0,
				prompt: capText(b.text, LIMITS.promptChars),
				nodeIds: textPage(b.nodeIds, LIMITS.slideNodesMax, LIMITS.idMaxChars),
			})),
		LIMITS.exercisesMax,
	);
	return {
		id: l.id,
		title: capText(l.title, LIMITS.titleChars),
		bookTitle: capText(l.bookTitle, LIMITS.titleChars),
		chapter: { index: l.chapter.index, title: capText(l.chapter.title, LIMITS.titleChars), pageStart: l.chapter.pageStart, pageEnd: l.chapter.pageEnd },
		order: l.order,
		summary: capText(l.summary, LIMITS.summaryChars),
		createdAt: l.createdAt,
		slides,
		exercises,
		citedNodes: textPage(lectureNodeRefs(l), LIMITS.citedNodesMax, LIMITS.idMaxChars),
	};
}

export function getLecture(call: Call, input: Record<string, unknown>) {
	const id = requireText(input.id, "id", LIMITS.idMaxChars);
	if (!isValidLectureId(id)) throw invalid("id is not a lecture id (expected lec_b<8 hex>_c<NN>_l<NN>).");
	const lecture = call.deps.lectures.get(id);
	if (lecture === null) throw new ToolError("not_found", `No lecture with id "${id}".`);
	return outline(lecture);
}
