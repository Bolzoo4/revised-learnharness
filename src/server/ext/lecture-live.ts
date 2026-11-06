// src/server/ext/lecture-live.ts
/**
 * Composition of the lecture stage: the live stores, the teacher-slot engine,
 * upstream's notes import for the chapter graphs, and the shared cost gate.
 * Only wiring; everything testable is in lecture-service.ts and src/agent/ext.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { readBookmarks, readChapterText, readPageTexts } from "../../agent/ext/lecture/pdf-facts.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../../agent/ext/lecture/writers.ts";
import { emit } from "../../core/events.ts";
import { getGraph } from "../../core/graph.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { extraction } from "../chat-handler.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createLectureService, type BookRunStatus } from "./lecture-service.ts";
import { keepStagedPdf } from "./pdf-upload.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";

/** The run registry survives dev-server module reloads. */
const g = globalThis as { __lhExtLectureRuns?: Map<string, BookRunStatus> };
const runs = (g.__lhExtLectureRuns ??= new Map<string, BookRunStatus>());

const sourceIdOf = (filePath: string): string => `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

export const lectureService = createLectureService({
	lectures: extStores.lecturesStore,
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
