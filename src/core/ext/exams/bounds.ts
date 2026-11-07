// src/core/ext/exams/bounds.ts
/** Limits of the exam training data (REQ-ex-02, REQ-ex-05). Pure constants: no IO. */

/** Longest text of one exercise (characters). */
export const MAX_EXERCISE_CHARS = 20_000;
/** Most exercises one exam may hold after a split. */
export const MAX_EXERCISES_PER_EXAM = 200;
/** Longest title, in characters. */
export const MAX_TITLE_CHARS = 200;
/** Longest search query, in characters. */
export const MAX_QUERY_CHARS = 500;
/** Text of an exam, in characters, that one split call may read (the rest is refused, not truncated). */
export const MAX_SPLIT_CHARS = 60_000;
/** Non-space characters the text layer must hold for a PDF to count as having text (below it: a scan). */
export const MIN_TEXT_LAYER_CHARS = 100;
