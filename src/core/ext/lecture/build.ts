// src/core/ext/lecture/build.ts
/**
 * From the writer's submission (LectureDraft) to the stored document (REQ-lec-06):
 * attaches identity and provenance, nothing else. Structural validity is
 * checked afterwards by parseLecture, semantic validity by validateLecture.
 */

import { LECTURE_VERSION, lectureId, type Block, type Lecture, type Slide } from "./lecture.ts";
import type { Chapter } from "./chapters.ts";

export interface LectureDraft {
	title: string;
	summary: string;
	slides: Slide[];
	blocks: Block[];
}

export interface LectureMeta {
	bookId: string;
	bookTitle: string;
	chapter: Chapter;
	order: number;
	chapterSourceId: string;
	createdAt: string;
}

export function buildLecture(draft: LectureDraft, meta: LectureMeta): Lecture {
	return {
		version: LECTURE_VERSION,
		id: lectureId(meta.bookId, meta.chapter.index, meta.order),
		bookId: meta.bookId,
		bookTitle: meta.bookTitle,
		chapter: { index: meta.chapter.index, title: meta.chapter.title, pageStart: meta.chapter.pageStart, pageEnd: meta.chapter.pageEnd },
		order: meta.order,
		title: draft.title,
		summary: draft.summary,
		chapterSourceId: meta.chapterSourceId,
		createdAt: meta.createdAt,
		slides: draft.slides,
		// `seconds` belongs to exercise blocks only.
		blocks: draft.blocks.map((b) => {
			if (b.role === "exercise") return b;
			const { seconds: _seconds, ...rest } = b;
			return rest;
		}),
	};
}
