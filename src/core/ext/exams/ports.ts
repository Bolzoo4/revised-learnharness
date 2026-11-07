// src/core/ext/exams/ports.ts
/** The storage port of exam training. The adapter is src/store/ext/exams-store.ts. Ids are validated by the adapter before any path is built. */

import type { Collection, ExamDoc, Exercise, MaterialDoc } from "./types.ts";

/** One indexed chunk of a material, as stored (one JSON line of chunks-<materialId>.jsonl). */
export interface StoredChunk {
	index: number;
	page: number;
	text: string;
}

export interface ExamsStore {
	listCollectionIds(): string[];
	readCollection(id: string): Collection | null;
	writeCollection(collection: Collection): void;
	readExams(collectionId: string): ExamDoc[];
	writeExams(collectionId: string, exams: ExamDoc[]): void;
	readExercises(collectionId: string, examId: string): Exercise[];
	writeExercises(collectionId: string, examId: string, exercises: Exercise[]): void;
	readMaterials(collectionId: string): MaterialDoc[];
	writeMaterials(collectionId: string, materials: MaterialDoc[]): void;
	readChunks(collectionId: string, materialId: string): StoredChunk[];
	writeChunks(collectionId: string, materialId: string, chunks: StoredChunk[]): void;
}
