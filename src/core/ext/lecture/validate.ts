// src/core/ext/lecture/validate.ts
/**
 * The lecture validator (REQ-lec-07, REQ-lec-08): pure rules that reject a
 * generated lecture with feedback the writer can act on, plus the chapter
 * coverage report. Contracts: docs/ext/CONTRACTS.md "Lecture validator".
 */

import { lectureNodeRefs, lectureSlideTexts, stripNodeLinks, textNodeRefs, type Lecture } from "./lecture.ts";

/** A narrated run of this many consecutive words found in the chapter text is a verbatim copy. */
export const VERBATIM_RUN_WORDS = 12;

export interface ValidationContext {
	/** Every node id in the graph. */
	existingNodeIds: ReadonlySet<string>;
	/** The chapter's plain text, the source the discourse must not copy. */
	chapterText: string;
}

const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The first run of `n` consecutive words of `text` that also occurs in `source`, or null. */
export function firstSharedRun(text: string, source: string, n: number = VERBATIM_RUN_WORDS): string | null {
	const src = words(source);
	if (src.length < n) return null;
	const grams = new Set<string>();
	for (let i = 0; i + n <= src.length; i++) grams.add(src.slice(i, i + n).join(" "));
	const tw = words(text);
	for (let i = 0; i + n <= tw.length; i++) {
		const gram = tw.slice(i, i + n).join(" ");
		if (grams.has(gram)) return gram;
	}
	return null;
}

/** All rule violations, in a stable order. Empty = valid. */
export function validateLecture(lecture: Lecture, ctx: ValidationContext): string[] {
	const errors: string[] = [];
	if (lecture.slides.length === 0) errors.push("the lecture has no slides");
	if (lecture.blocks.length === 0) errors.push("the lecture has no blocks");

	const slideIds = new Set<string>();
	const elementsBySlide = new Map<string, Set<string>>();
	for (const s of lecture.slides) {
		if (slideIds.has(s.id)) errors.push(`duplicate slide id ${s.id}`);
		slideIds.add(s.id);
		elementsBySlide.set(s.id, new Set(s.elements.map((e) => e.id)));
	}
	const blockIds = new Set<string>();
	lecture.blocks.forEach((b, i) => {
		if (blockIds.has(b.id)) errors.push(`duplicate block id ${b.id}`);
		blockIds.add(b.id);
		if (!slideIds.has(b.slideId)) errors.push(`block ${b.id} points at unknown slide ${b.slideId}`);
		if (b.role === "narrate" && b.nodeIds.length === 0) errors.push(`narrate block ${b.id} cites no node`);
		for (const id of b.nodeIds) if (!ctx.existingNodeIds.has(id)) errors.push(`block ${b.id} cites unknown node ${id}`);
		for (const c of b.cues) {
			if (c.atChar > b.text.length) errors.push(`block ${b.id} has a cue past the end of its text (${c.atChar})`);
			if (slideIds.has(b.slideId) && !elementsBySlide.get(b.slideId)!.has(c.target)) {
				errors.push(`block ${b.id} has a cue on unknown element ${c.target} of slide ${b.slideId}`);
			}
		}
		const next = lecture.blocks[i + 1];
		if (b.role === "exercise" && next?.role !== "reveal") errors.push(`exercise block ${b.id} must be followed by a reveal block`);
		if (b.role === "reveal" && lecture.blocks[i - 1]?.role !== "exercise") errors.push(`reveal block ${b.id} must follow an exercise block`);
		const copied = firstSharedRun(stripNodeLinks(b.text), ctx.chapterText);
		if (copied !== null) errors.push(`block ${b.id} copies the source verbatim ("${copied.split(" ").slice(0, 8).join(" ")} ..."): rephrase it`);
	});

	for (const t of lectureSlideTexts(lecture)) {
		for (const id of textNodeRefs(t)) if (!ctx.existingNodeIds.has(id)) errors.push(`a slide links unknown node ${id}`);
	}
	return [...new Set(errors)];
}

/** Chapter nodes cited by none of the lectures (REQ-lec-07 report). */
export function uncoveredChapterNodes(lectures: readonly Lecture[], chapterNodeIds: readonly string[]): string[] {
	const covered = new Set<string>();
	for (const l of lectures) for (const id of lectureNodeRefs(l)) covered.add(id);
	return chapterNodeIds.filter((id) => !covered.has(id));
}

/** The feedback paragraph handed to the writer on a retry. */
export function feedbackFromErrors(errors: readonly string[]): string {
	return `The previous attempt was rejected for these reasons. Fix every one of them:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
