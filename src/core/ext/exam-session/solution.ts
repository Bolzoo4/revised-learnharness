// src/core/ext/exam-session/solution.ts
/**
 * Solution status (REQ-ex-08), pure. The status is computed here, from evidence
 * the code can see; the model never supplies it. Order, strongest first:
 *
 *   exam        the presented text is a verbatim part of the exam's own solution
 *   material    a passage the code handed out this turn supports it
 *   derived     a second, independent derivation reaches the same final answer
 *   unverified  none of the above
 *
 * "Verbatim" is checked on normalised text, and a quote must be long enough to
 * mean something (MIN_QUOTE_CHARS), so a bare "6" that happens to occur in an
 * exam solution never upgrades a candidate to `exam`.
 *
 * "Independent" is checked as far as text can check it: the second derivation
 * names a different approach and does not repeat the first one's steps. A model
 * that writes the same reasoning twice under two labels is not caught here; the
 * status then says `derived` for a shared mistake, as the design accepts.
 */

import type { SolutionStatus } from "../exams/types.ts";

export type { SolutionStatus };

/** A quote shorter than this (normalised characters) cannot make a solution `exam`. */
export const MIN_QUOTE_CHARS = 40;

export interface Derivation {
	/** A short label of the method used (for the independence check). Optional on the candidate. */
	approach?: string;
	steps: string;
	finalAnswer: string;
}

export interface CheckInput {
	/** The solution the agent presents (or the one it is checking). */
	candidate: Derivation;
	/** The exam's own solution for the exercise, when the exam carries one. */
	examSolution?: string;
	/** True when a passage handed out this turn (a valid label) supports the candidate. */
	supported: boolean;
	/** A second derivation written independently of the candidate. */
	second?: Derivation;
}

export interface CheckResult {
	status: SolutionStatus;
	/** The candidate is a verbatim part of the exam's solution. */
	quotesExam: boolean;
	/** The second derivation is independent and agrees on the final answer. */
	secondAgrees: boolean;
}

/** Normalised form for comparisons: lower case, no whitespace, no dollar or math delimiters, no trailing period. */
export function normalizeAnswer(text: string): string {
	return text
		.toLowerCase()
		.replace(/\\\(|\\\)|\\\[|\\\]|\$/g, "")
		.replace(/\s+/g, "")
		.replace(/\.+$/, "");
}

/** True when two final answers are non-empty and equal after normalisation. */
export function sameAnswer(a: string, b: string): boolean {
	const x = normalizeAnswer(a);
	return x !== "" && x === normalizeAnswer(b);
}

/** Whether the second derivation is independent of the candidate and reaches the candidate's final answer. */
export function secondAgrees(candidate: Derivation, second: Derivation): boolean {
	if (!sameAnswer(candidate.finalAnswer, second.finalAnswer)) return false;
	if (candidate.approach !== undefined && second.approach !== undefined && normalizeAnswer(candidate.approach) === normalizeAnswer(second.approach)) return false;
	if (normalizeAnswer(second.steps) === normalizeAnswer(candidate.steps)) return false;
	return true;
}

/** True when the candidate text is a verbatim (normalised) part of the exam's own solution, and long enough to count. */
export function quotesExamSolution(candidateText: string, examSolution: string | undefined): boolean {
	if (examSolution === undefined || examSolution.trim() === "") return false;
	const quote = normalizeAnswer(candidateText);
	if (quote.length < MIN_QUOTE_CHARS) return false;
	return normalizeAnswer(examSolution).includes(quote);
}

/** The status of a presented solution. The strongest supported status wins; nothing downgrades an exam quote. */
export function checkSolution(input: CheckInput): CheckResult {
	const quotesExam = quotesExamSolution(input.candidate.steps, input.examSolution);
	const secondAgreesNow = input.second !== undefined && secondAgrees(input.candidate, input.second);
	let status: SolutionStatus = "unverified";
	if (quotesExam) status = "exam";
	else if (input.supported) status = "material";
	else if (secondAgreesNow) status = "derived";
	return { status, quotesExam, secondAgrees: secondAgreesNow };
}
