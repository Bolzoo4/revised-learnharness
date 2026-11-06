// src/server/ext/lecture-live.ts
/**
 * Composition of the lecture stage: the live stores, the teacher-slot engine,
 * upstream's notes import for the chapter graphs, and the shared cost gate.
 * Only wiring; everything testable is in lecture-service.ts and src/agent/ext.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBookmarks, readChapterText, readPageTexts } from "../../agent/ext/lecture/pdf-facts.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../../agent/ext/lecture/writers.ts";
import { emit } from "../../core/events.ts";
import { getGraph } from "../../core/graph.ts";
import { audioVoicesFromEnv } from "../../core/ext/lecture/audio.ts";
import type { Lecture } from "../../core/ext/lecture/lecture.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { keyValue } from "../keys.ts";
import { extraction } from "../chat-handler.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveAudioGate, liveCostGate } from "./cost-live.ts";
import { createLectureAudio } from "./lecture-audio.ts";
import { bookIdFor, createLectureService, type BookRunStatus } from "./lecture-service.ts";
import { createLectureOfficeHours } from "./lecture-office-hours.ts";
import { practiceService } from "./practice-live.ts";
import { keepStagedPdf } from "./pdf-upload.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";

/** The run registry survives dev-server module reloads. */
const g = globalThis as { __lhExtLectureRuns?: Map<string, BookRunStatus> };
const runs = (g.__lhExtLectureRuns ??= new Map<string, BookRunStatus>());

const sourceIdOf = (filePath: string): string => `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

/**
 * Narration audio (Deepgram). Its files live under <data>/ext/lecture-audio; the key is read server-side
 * (DEEPGRAM_API_KEY), and its spend is on the audio gate, not the model ceiling.
 */
export const lectureAudio = createLectureAudio({
	dir: path.join(EXT_PATHS.dir, "lecture-audio"),
	apiKey: () => keyValue("DEEPGRAM_API_KEY") || undefined,
	gate: liveAudioGate,
	voices: () => audioVoicesFromEnv(process.env),
});

/**
 * The lecture store as the chapter run sees it: a stored lecture starts its audio in the background (the
 * run never waits for it), and a removed lecture drops its audio. Reads and the rest pass through.
 */
const lecturesWithAudio: LecturesStore = {
	...extStores.lecturesStore,
	save(lecture: Lecture) {
		extStores.lecturesStore.save(lecture);
		lectureAudio.prefetch(lecture);
	},
	remove(id: string) {
		extStores.lecturesStore.remove(id);
		lectureAudio.removeLecture(id);
	},
};

export const lectureService = createLectureService({
	lectures: lecturesWithAudio,
	library: createSourceLibrary(extStores.sourcesStore),
	gate: liveCostGate,
	graphNodes: () => getGraph(stores.graphStore).nodes,
	importChapterGraph: async ({ filePath, text }) => {
		sourceDirectory.registerImport(filePath);
		try {
			await extraction.importNotes({ filePath, text });
		} finally {
			emit("sources-changed", {});
		}
	},
	findSourceId: (filePath) => {
		const id = sourceIdOf(filePath);
		return sourceDirectory.read().sources.some((s) => s.id === id) ? id : null;
	},
	pdf: { exists: (p) => fs.existsSync(p), readBookmarks, readPageTexts, readChapterText },
	writers: {
		detectChaptersWithLlm: (excerpt, pageCount) => detectChaptersWithLlm(writerDeps(), excerpt, pageCount),
		writeOutline: (chapter, text) => writeOutline(writerDeps(), chapter, text),
		writeLecture: (input) => writeLectureDraft(writerDeps(), input),
	},
	runs,
});

/** An uploaded book's staged copy, kept in the documents store: the stable path the ingest reads (same bytes, same path). */
export function keepUploadedBook(stagedPath: string): Promise<string> {
	return keepStagedPdf(stagedPath, extStores.documentFiles);
}

/** Office hours from a lecture's exercise: the chapter text is the source, the exercise the focus. */
export const lectureOfficeHours = createLectureOfficeHours({
	lectures: extStores.lecturesStore,
	bookPdf: (bookId) => {
		const entry = createSourceLibrary(extStores.sourcesStore).list().find((e) => e.kind === "pdf" && bookIdFor(e.locator) === bookId);
		return entry?.locator ?? null;
	},
	readChapterText,
	startSession: (input) => practiceService.startSession(input),
});
