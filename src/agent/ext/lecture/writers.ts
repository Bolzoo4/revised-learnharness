// src/agent/ext/lecture/writers.ts
/**
 * The three model calls of a chapter run: chapter detection (fallback), the
 * chapter outline and one lecture. Each is a single schema-validated
 * submission (runStructured). Semantic validation of a lecture happens in the
 * chapter run (validate.ts + retry with feedback), not here.
 */

import { Type } from "typebox";
import type { Chapter, ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import { validateChapterStarts } from "../../../core/ext/lecture/chapters.ts";
import type { LectureDraft } from "../../../core/ext/lecture/build.ts";
import type { OutlineBlock } from "../../../core/ext/lecture/split.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import type { PiEngine } from "../../models.ts";
import {
	CHAPTER_DETECT_SYSTEM,
	LECTURE_SYSTEM,
	OUTLINE_SYSTEM,
	chapterDetectPrompt,
	lecturePrompt,
	outlinePrompt,
	type PromptNode,
} from "./prompts.ts";
import { runStructured, type StepPricer } from "./structured.ts";

export interface WriterDeps {
	engine: PiEngine;
	gate: CostGate;
	priceStep: StepPricer;
	signal?: AbortSignal;
}

const lit = <T extends string>(...v: T[]) => Type.Union(v.map((x) => Type.Literal(x)));

const ChaptersSchema = Type.Object({
	chapters: Type.Array(Type.Object({ title: Type.String(), page: Type.Integer() }), { minItems: 1 }),
});

export async function detectChaptersWithLlm(deps: WriterDeps, excerpt: string, pageCount: number): Promise<ChapterStart[]> {
	const out = await runStructured<{ chapters: ChapterStart[] }>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_chapters",
		toolDescription: "Submit the list of top-level chapters with their start pages.",
		parameters: ChaptersSchema,
		systemPrompt: CHAPTER_DETECT_SYSTEM,
		prompt: chapterDetectPrompt(excerpt, pageCount),
		validate: (v) => {
			const errors = validateChapterStarts(v.chapters, pageCount);
			return errors.length === 0 ? null : errors.join("; ");
		},
	});
	return out.chapters;
}

const OutlineSchema = Type.Object({
	blocks: Type.Array(
		Type.Object({
			title: Type.String(),
			kind: lit("definition", "theorem", "example", "motivation", "remark"),
			summary: Type.String(),
		}),
		{ minItems: 1 },
	),
});

export async function writeOutline(deps: WriterDeps, chapter: Chapter, chapterText: string): Promise<OutlineBlock[]> {
	const out = await runStructured<{ blocks: OutlineBlock[] }>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_outline",
		toolDescription: "Submit the ordered conceptual blocks of the chapter.",
		parameters: OutlineSchema,
		systemPrompt: OUTLINE_SYSTEM,
		prompt: outlinePrompt(chapter, chapterText),
	});
	return out.blocks;
}

const LectureSchema = Type.Object({
	title: Type.String(),
	summary: Type.String(),
	slides: Type.Array(
		Type.Object({
			id: Type.String(),
			heading: Type.String(),
			elements: Type.Array(
				Type.Object({
					id: Type.String(),
					type: lit("text", "formula", "list"),
					content: Type.Optional(Type.String()),
					items: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
		{ minItems: 1 },
	),
	blocks: Type.Array(
		Type.Object({
			id: Type.String(),
			role: lit("narrate", "note", "exercise", "reveal"),
			slideId: Type.String(),
			text: Type.String(),
			nodeIds: Type.Array(Type.String()),
			cues: Type.Array(Type.Object({ atChar: Type.Integer({ minimum: 0 }), target: Type.String(), style: lit("box", "underline") })),
			seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })),
		}),
		{ minItems: 1 },
	),
});

export interface LectureWriteInput {
	bookTitle: string;
	chapter: Chapter;
	order: number;
	lectureCount: number;
	blocks: readonly OutlineBlock[];
	nodes: readonly PromptNode[];
	previousSummary: string | null;
	chapterText: string;
	feedback: string | null;
}

export async function writeLectureDraft(deps: WriterDeps, input: LectureWriteInput): Promise<LectureDraft> {
	return runStructured<LectureDraft>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_lecture",
		toolDescription: "Submit the lecture: slides and blocks.",
		parameters: LectureSchema,
		systemPrompt: LECTURE_SYSTEM,
		prompt: lecturePrompt(input),
	});
}
