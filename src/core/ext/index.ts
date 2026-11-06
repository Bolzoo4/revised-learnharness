// src/core/ext/index.ts
/**
 * Browser-safe barrel of the extension core. Only modules without node:
 * imports belong here (graph-reading modules such as node-panel.ts and
 * goal-service.ts stay out, like core/graph.ts stays out of core/index.ts).
 */
export * from "./explanation-check.ts";
export * from "./neighbourhood.ts";
export * from "./node-panel-types.ts";
export * from "./panel-history.ts";
export { isPracticeLike, sessionMatchesFilter, type SessionListFilter } from "./practice/session-kind.ts";
export * from "./study/context.ts";
export { activeCue } from "./lecture/cues.ts";
export { exercisesOf, MAX_EXERCISE_PROMPT_CHARS, parseNodeLinks, stripNodeLinks, type ExerciseItem, type TextPart } from "./lecture/lecture.ts";
export type {
	Block as LectureBlock,
	Cue as LectureCue,
	Lecture,
	Slide as LectureSlide,
	SlideElement as LectureSlideElement,
} from "./lecture/lecture.ts";
