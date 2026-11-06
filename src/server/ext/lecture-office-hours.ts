// src/server/ext/lecture-office-hours.ts
/**
 * Office hours opened from a lecture's exercise: the session's designated source is the text of the
 * lecture's chapter (re-read from the stored book PDF pages), its focus is the exercise. Everything
 * impure is injected; the live wiring is in lecture-live.ts.
 */

import type { Lecture } from "../../core/ext/lecture/lecture.ts";
import type { Chapter } from "../../core/ext/lecture/chapters.ts";
import { HttpError } from "./http-error.ts";

export const CHAPTER_TEXT_UNAVAILABLE = "the chapter text is not available: its book PDF is no longer stored";

export interface LectureOfficeHoursDeps {
	lectures: { get(id: string): Lecture | null };
	/** The stored PDF of a book (by bookId), or null when the book has none. */
	bookPdf(bookId: string): string | null;
	readChapterText(pdfPath: string, chapter: Chapter): Promise<string>;
	startSession(input: { label: string; sourceText: string; focus: string }): { chatId: string };
}

export function createLectureOfficeHours(deps: LectureOfficeHoursDeps) {
	return {
		/** Validates the lecture and the exercise block, reads the chapter text, and opens the session. */
		async open(lectureId: string, blockId: unknown): Promise<{ chatId: string }> {
			const lecture = deps.lectures.get(lectureId);
			if (lecture === null) throw new HttpError(404, "unknown lecture");
			if (typeof blockId !== "string" || blockId === "") throw new HttpError(400, "blockId is required");
			const block = lecture.blocks.find((b) => b.id === blockId);
			if (block === undefined) throw new HttpError(404, "unknown exercise");
			if (block.role !== "exercise") throw new HttpError(400, "that block is not an exercise");

			const pdf = deps.bookPdf(lecture.bookId);
			if (pdf === null) throw new HttpError(409, CHAPTER_TEXT_UNAVAILABLE);
			let sourceText: string;
			try {
				sourceText = await deps.readChapterText(pdf, lecture.chapter);
			} catch {
				throw new HttpError(409, CHAPTER_TEXT_UNAVAILABLE);
			}
			if (sourceText.trim() === "") throw new HttpError(409, CHAPTER_TEXT_UNAVAILABLE);

			const number = lecture.blocks.filter((b) => b.role === "exercise").findIndex((b) => b.id === blockId) + 1;
			const label = `${lecture.bookTitle} ch. ${lecture.chapter.index}: ${lecture.title} · exercise ${number}`;
			return deps.startSession({ label, sourceText, focus: block.text });
		},
	};
}

export type LectureOfficeHours = ReturnType<typeof createLectureOfficeHours>;
