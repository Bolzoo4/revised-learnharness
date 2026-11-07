// src/store/ext/exams-store.ts
/**
 * Exam training files (REQ-ex-01). One folder per collection:
 *   data/ext/exams/<collectionId>/collection.json
 *   data/ext/exams/<collectionId>/exams.json              (ExamDoc[])
 *   data/ext/exams/<collectionId>/exercises-<examId>.json (Exercise[])
 *   data/ext/exams/<collectionId>/materials.json          (MaterialDoc[])
 *   data/ext/exams/<collectionId>/chunks-<materialId>.jsonl
 * The PDFs themselves live in the documents store (data/ext/documents/).
 *
 * Every id becomes part of a path, so each one is checked against ID_RE before use: a
 * malformed id reads as absent and is refused on write. Reads never write; a corrupt JSON
 * file reads as absent, and a corrupt chunk line is skipped.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExamsStore, StoredChunk } from "../../core/ext/exams/ports.ts";
import type { Collection, ExamDoc, Exercise, MaterialDoc } from "../../core/ext/exams/types.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function writeJson(extDir: string, dir: string, file: string, value: unknown): void {
	ensureExtFormat(extDir);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify(value, null, "\t")}\n`, { allowInPlaceFallback: true });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function asCollection(v: unknown): Collection | null {
	if (!isRecord(v) || !isId(v.id) || typeof v.title !== "string" || typeof v.createdAt !== "string") return null;
	return { id: v.id, title: v.title, createdAt: v.createdAt };
}

function asExam(v: unknown): ExamDoc | null {
	if (!isRecord(v) || !isId(v.id) || !isId(v.collectionId) || typeof v.title !== "string" || !isId(v.documentId)) return null;
	if (typeof v.pages !== "number" || typeof v.reviewed !== "boolean") return null;
	return { id: v.id, collectionId: v.collectionId, title: v.title, documentId: v.documentId, pages: v.pages, reviewed: v.reviewed };
}

function asExercise(v: unknown): Exercise | null {
	if (!isRecord(v) || !isId(v.id) || !isId(v.examId) || typeof v.order !== "number") return null;
	if (typeof v.pageStart !== "number" || typeof v.pageEnd !== "number" || typeof v.text !== "string") return null;
	const out: Exercise = { id: v.id, examId: v.examId, order: v.order, pageStart: v.pageStart, pageEnd: v.pageEnd, text: v.text };
	if (typeof v.solution === "string") out.solution = v.solution;
	if (v.origin === "exam") out.origin = "exam";
	return out;
}

function asMaterial(v: unknown): MaterialDoc | null {
	if (!isRecord(v) || !isId(v.id) || !isId(v.collectionId) || typeof v.title !== "string" || !isId(v.documentId)) return null;
	if (typeof v.pages !== "number" || typeof v.indexedAt !== "string") return null;
	return { id: v.id, collectionId: v.collectionId, title: v.title, documentId: v.documentId, pages: v.pages, indexedAt: v.indexedAt };
}

function asChunk(v: unknown): StoredChunk | null {
	if (!isRecord(v) || typeof v.index !== "number" || typeof v.page !== "number" || typeof v.text !== "string") return null;
	return { index: v.index, page: v.page, text: v.text };
}

function listOf<T>(raw: unknown, parse: (v: unknown) => T | null): T[] {
	if (!Array.isArray(raw)) return [];
	const out: T[] = [];
	for (const item of raw) {
		const parsed = parse(item);
		if (parsed !== null) out.push(parsed);
	}
	return out;
}

function assertId(id: string, what: string): void {
	if (!isId(id)) throw new Error(`exams store: invalid ${what} id`);
}

export function createExamsStore(extDir: string): ExamsStore {
	const root = path.resolve(extDir, "exams");
	const dirOf = (collectionId: string): string => path.join(root, collectionId);
	/** Reads: the format guard first, and a missing or invalid collection id reads as empty. */
	const readFile = (collectionId: string, name: string): unknown => {
		assertExtFormat(extDir);
		if (!isId(collectionId)) return null;
		return readJson(path.join(dirOf(collectionId), name));
	};

	return {
		listCollectionIds() {
			assertExtFormat(extDir);
			let names: string[];
			try {
				names = fs.readdirSync(root);
			} catch {
				return [];
			}
			return names.filter((n) => isId(n) && asCollection(readJson(path.join(root, n, "collection.json"))) !== null).sort();
		},

		readCollection(id) {
			return asCollection(readFile(id, "collection.json"));
		},

		writeCollection(collection) {
			assertId(collection.id, "collection");
			writeJson(extDir, dirOf(collection.id), path.join(dirOf(collection.id), "collection.json"), collection);
		},

		readExams(collectionId) {
			return listOf(readFile(collectionId, "exams.json"), asExam);
		},

		writeExams(collectionId, exams) {
			assertId(collectionId, "collection");
			writeJson(extDir, dirOf(collectionId), path.join(dirOf(collectionId), "exams.json"), exams);
		},

		readExercises(collectionId, examId) {
			if (!isId(examId)) return [];
			return listOf(readFile(collectionId, `exercises-${examId}.json`), asExercise);
		},

		writeExercises(collectionId, examId, exercises) {
			assertId(collectionId, "collection");
			assertId(examId, "exam");
			writeJson(extDir, dirOf(collectionId), path.join(dirOf(collectionId), `exercises-${examId}.json`), exercises);
		},

		readMaterials(collectionId) {
			return listOf(readFile(collectionId, "materials.json"), asMaterial);
		},

		writeMaterials(collectionId, materials) {
			assertId(collectionId, "collection");
			writeJson(extDir, dirOf(collectionId), path.join(dirOf(collectionId), "materials.json"), materials);
		},

		readChunks(collectionId, materialId) {
			if (!isId(materialId)) return [];
			assertExtFormat(extDir);
			if (!isId(collectionId)) return [];
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(dirOf(collectionId), `chunks-${materialId}.jsonl`), "utf-8");
			} catch {
				return [];
			}
			const out: StoredChunk[] = [];
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					continue;
				}
				const chunk = asChunk(value);
				if (chunk !== null) out.push(chunk);
			}
			return out;
		},

		writeChunks(collectionId, materialId, chunks) {
			assertId(collectionId, "collection");
			assertId(materialId, "material");
			const dir = dirOf(collectionId);
			ensureExtFormat(extDir);
			fs.mkdirSync(dir, { recursive: true });
			const text = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length > 0 ? "\n" : "");
			writeFileAtomicSync(path.join(dir, `chunks-${materialId}.jsonl`), text, { allowInPlaceFallback: true });
		},
	};
}
