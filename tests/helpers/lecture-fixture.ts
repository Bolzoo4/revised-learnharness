// tests/helpers/lecture-fixture.ts
import { LECTURE_VERSION, type Block, type Lecture } from "../../src/core/ext/lecture/lecture.ts";

export const NODE_A = "n_aaaa1111";
export const NODE_B = "n_bbbb2222";

/** A small valid lecture: two slides, narrate -> exercise -> reveal -> note. */
export function makeLecture(overrides: Partial<Lecture> = {}): Lecture {
	const blocks: Block[] = [
		{ id: "b1", role: "narrate", slideId: "s1", text: "A sigma algebra is a family closed under complements and countable unions.", nodeIds: [NODE_A], cues: [{ atChar: 2, target: "e1", style: "box" }] },
		{ id: "b2", role: "exercise", slideId: "s1", text: "Try it yourself on a three element set.", nodeIds: [], cues: [], seconds: 60 },
		{ id: "b3", role: "reveal", slideId: "s1", text: "Yes, the four listed sets are closed under both operations.", nodeIds: [NODE_A], cues: [] },
		{ id: "b4", role: "note", slideId: "s2", text: "You will meet this again with Brownian motion.", nodeIds: [], cues: [] },
	];
	return {
		version: LECTURE_VERSION,
		id: "lec_b0123abcd_c02_l01",
		bookId: "b0123abcd",
		bookTitle: "Probability 1",
		chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 },
		order: 1,
		title: "Sigma algebras",
		summary: "We defined sigma algebras.",
		chapterSourceId: "src_0123456789ab",
		createdAt: "2026-11-04T10:00:00.000Z",
		slides: [
			{ id: "s1", heading: "Sigma algebra", elements: [{ id: "e1", type: "text", content: "A [[n_aaaa1111|sigma algebra]] is a family of sets." }] },
			{ id: "s2", heading: "Looking ahead", elements: [{ id: "e2", type: "list", items: ["Brownian motion", "[[n_bbbb2222]]"] }] },
		],
		blocks,
		...overrides,
	};
}
