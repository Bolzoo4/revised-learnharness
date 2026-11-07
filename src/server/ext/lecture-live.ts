// src/server/ext/lecture-live.ts
/**
 * Composition of the lecture stage: the live stores, the teacher-slot engine,
 * the staged chapter graphs (upstream's notes pipeline over a staging overlay,
 * committed once a chapter's lectures are all written), and the shared cost gate.
 * Only wiring; everything testable is in lecture-service.ts and src/agent/ext.
 */

import fs from "node:fs";
import path from "node:path";
import { createExtractionPipeline, extractionStatuses } from "../../agent/subagents/extraction.ts";
import { readBookmarks, readChapterText, readPageTexts } from "../../agent/ext/lecture/pdf-facts.ts";
import { sourceIdForPath, type GraphNodeView, type StagedChapterGraph } from "../../agent/ext/lecture/chapter-run.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../../agent/ext/lecture/writers.ts";
import { emit } from "../../core/events.ts";
import { getGraph, type EmissionStats } from "../../core/graph.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { audioVoicesFromEnv } from "../../core/ext/lecture/audio.ts";
import type { Lecture } from "../../core/ext/lecture/lecture.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { keyValue } from "../keys.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveAudioGate, liveCostGate } from "./cost-live.ts";
import { extractionModelDeps } from "./extraction-deps.ts";
import { createLectureAudio } from "./lecture-audio.ts";
import { bookIdFor, createLectureService, type BookRunStatus } from "./lecture-service.ts";
import { createLectureCleanup } from "./lecture-cleanup.ts";
import { createLectureOfficeHours } from "./lecture-office-hours.ts";
import { practiceService } from "./practice-live.ts";
import { keepStagedPdf } from "./pdf-upload.ts";
import { createStagedGraphStore } from "./staged-graph-store.ts";
import { extStores } from "./stores.ts";
import { verifyAfterMerge } from "./verification.ts";
import { writerDeps } from "./study-engine.ts";

/** The run registry survives dev-server module reloads. */
const g = globalThis as { __lhExtLectureRuns?: Map<string, BookRunStatus> };
const runs = (g.__lhExtLectureRuns ??= new Map<string, BookRunStatus>());

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

/**
 * One chapter's graph, STAGED (docs/ext/CONTRACTS.md "Staged chapter graph"): the upstream notes pipeline
 * runs over a staging overlay of the real store, so nothing it writes is visible until commit(). The
 * pipeline is built here with the same model wiring as the live one (extraction-deps.ts), but not
 * wrapped in the live post-merge hook: the hook's steps run once, after the commit, below.
 */
function stageChapterGraph(): StagedChapterGraph {
	const staged = createStagedGraphStore(stores.graphStore);
	const pipeline = createExtractionPipeline({ ...stores, graphStore: staged, ...extractionModelDeps() });
	let importedPath: string | undefined;
	let imported: EmissionStats = { nodes: 0, chains: 0 };
	return {
		async importText({ filePath, text }) {
			importedPath = filePath;
			imported = await pipeline.importNotes({ filePath, text });
		},
		hasSource: (filePath) => staged.readSources().some((s) => s.filePath === filePath),
		readNodes: (): ReadonlyArray<GraphNodeView> => getGraph(staged).nodes,
		commit() {
			staged.commit();
			// The commit has happened: nothing below may fail the chapter, so each step is isolated.
			afterCommit(importedPath, imported.nodes);
		},
		discard: () => staged.discard(),
	};
}

/** What the live pipeline did after a merge, moved to the commit: the layout, the source listing, the activity event, the verification. */
function afterCommit(filePath: string | undefined, addedNodes: number): void {
	try {
		if (filePath !== undefined) sourceDirectory.registerImport(filePath);
		settleGraphLayout(stores.graphStore);
	} catch (err) {
		console.error("[lectures] after the chapter commit (layout or listing):", err instanceof Error ? err.name : "error");
	}
	emit("sources-changed", {});
	// Same gate as the live post-merge hook: inert under NODE_ENV=test, fire-and-forget, never delays the run.
	if (addedNodes > 0 && process.env.NODE_ENV !== "test") {
		void verifyAfterMerge().catch((err) => console.error("[ext] post-merge verification failed:", err));
	}
}

/** A chapter's graph when it is already active in the real graph (its source record is committed), or null. */
function activeChapterGraph(filePath: string): { sourceId: string; nodes: ReadonlyArray<GraphNodeView> } | null {
	const sourceId = sourceIdForPath(filePath);
	if (!stores.graphStore.readSources().some((s) => s.id === sourceId)) return null;
	const nodes = getGraph(stores.graphStore).nodes.filter((n) => n.provenance.some((p) => p.chatId === sourceId));
	return { sourceId, nodes };
}

export const lectureService = createLectureService({
	lectures: lecturesWithAudio,
	library: createSourceLibrary(extStores.sourcesStore),
	gate: liveCostGate,
	graphNodes: () => getGraph(stores.graphStore).nodes,
	stageGraph: stageChapterGraph,
	activeGraph: activeChapterGraph,
	pdf: { exists: (p) => fs.existsSync(p), readBookmarks, readPageTexts, readChapterText },
	writers: {
		detectChaptersWithLlm: (excerpt, pageCount) => detectChaptersWithLlm(writerDeps(), excerpt, pageCount),
		writeOutline: (chapter, text) => writeOutline(writerDeps(), chapter, text),
		writeLecture: (input) => writeLectureDraft(writerDeps(), input),
	},
	runs,
	runStore: extStores.lectureRunStore,
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

/** Leftovers of chapters that did not finish before staging (lecture-cleanup.ts). */
export const lectureCleanup = createLectureCleanup({
	graphStore: stores.graphStore,
	organization: stores.sourceOrganizationStore,
	books: () => lectureService.runStatuses(),
	lectures: () => extStores.lecturesStore.list(),
	extractionRunning: () => extractionStatuses().length > 0,
});
