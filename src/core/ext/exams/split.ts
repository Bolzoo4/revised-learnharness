// src/core/ext/exams/split.ts
/**
 * Validation of a split result (REQ-ex-02): the splitter's output is data until this
 * accepts it. Each exercise needs a page span inside the exam, a non-empty text, and an
 * optional solution. `origin` is decided here, not by the model: "exam" exactly when a
 * solution text came with the exercise.
 */

import { MAX_EXERCISE_CHARS, MAX_EXERCISES_PER_EXAM } from "./bounds.ts";

export interface RawExercise {
	pageStart: number;
	pageEnd: number;
	text: string;
	solution?: string;
	origin?: "exam";
}

/** Why a split was not produced: "ceiling" (the daily cost gate is closed) or "failed" (no valid split came back). */
export class SplitRefused extends Error {
	constructor(readonly reason: "ceiling" | "failed") {
		super(reason === "ceiling" ? "the daily cost ceiling is reached" : "the exercises could not be split");
	}
}

const isPage = (v: unknown, pageCount: number): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= pageCount;

/**
 * Checks a split result against the exam's page count. Returns the exercises in page order
 * (stable for equal starts). Throws SplitRefused("failed") for anything that does not fit.
 */
export function parseSplitResult(raw: unknown, pageCount: number): RawExercise[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EXERCISES_PER_EXAM) throw new SplitRefused("failed");
	const out: RawExercise[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) throw new SplitRefused("failed");
		const r = item as Record<string, unknown>;
		if (!isPage(r.pageStart, pageCount) || !isPage(r.pageEnd, pageCount) || r.pageStart > r.pageEnd) throw new SplitRefused("failed");
		if (typeof r.text !== "string") throw new SplitRefused("failed");
		const text = r.text.trim();
		if (text === "" || text.length > MAX_EXERCISE_CHARS) throw new SplitRefused("failed");
		const solution = typeof r.solution === "string" ? r.solution.trim() : "";
		if (solution.length > MAX_EXERCISE_CHARS) throw new SplitRefused("failed");
		const exercise: RawExercise = { pageStart: r.pageStart, pageEnd: r.pageEnd, text };
		if (solution !== "") {
			exercise.solution = solution;
			exercise.origin = "exam";
		}
		out.push(exercise);
	}
	return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.pageStart - b.e.pageStart || a.i - b.i).map((x) => x.e);
}
