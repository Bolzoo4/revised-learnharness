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
export * from "./prompt-catalog.ts";
export * from "./theme.ts";
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
export {
	audioCostUsd,
	audioVoicesFromEnv,
	AUDIO_CHUNK_CHARS,
	AUDIO_CONCURRENCY,
	BLOCK_ID_RE,
	charIndexAtTime,
	chunkText,
	guessLanguage,
	isVoiceFor,
	languageOfBlocks,
	parseAudioManifest,
	speakUrl,
	timedChunks,
	type AudioBlock,
	type AudioChunk,
	type AudioLanguage,
	type AudioManifest,
	type CharRange,
} from "./lecture/audio.ts";

// Exam training records (read by the Exams pages through the core barrel).
export type {
	Collection as ExamCollection,
	ExamDoc,
	Exercise as ExamExercise,
	MaterialDoc,
	SearchHit as MaterialSearchHit,
	SolutionStatus,
} from "./exams/types.ts";
