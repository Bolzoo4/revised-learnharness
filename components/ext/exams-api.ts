// components/ext/exams-api.ts
/**
 * The Exams pages' calls to the exam routes (app/api/ext/exams/**). Pure over an
 * injected fetch, so every request and every refusal is tested without a DOM.
 * A refusal shows the server's fixed `error` text; anything else (a network
 * failure, a body of the wrong shape) shows the call's own fallback text, never
 * the thrown message.
 *
 * Response bodies: lists are wrapped under their key (collections, exercises);
 * single records (a collection detail, an exam, a material, a chat id) are the
 * object itself.
 */

import type { Collection, Exercise, ExamDoc, MaterialDoc } from "./exams-types.ts";
import { buildPdfUploadForm, failureText } from "./pdf-upload.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CollectionDetail {
	collection: Collection;
	exams: ExamDoc[];
	materials: MaterialDoc[];
}

/** The edit operations of the exercise route (PATCH body). */
export type ExerciseOp =
	| { op: "merge"; firstId: string }
	| { op: "split"; id: string; at: number }
	| { op: "delete"; id: string }
	| { op: "edit"; id: string; text: string };

export const COLLECTIONS_FAILED = "The collections could not be loaded. Try again.";
export const COLLECTION_FAILED = "This collection could not be loaded. Try again.";
export const CREATE_FAILED = "The collection could not be created. Try again.";
export const UPLOAD_FAILED = "The PDF could not be added. Choose the file again.";
export const EXERCISES_FAILED = "The exercises could not be loaded. Try again.";
export const EDIT_FAILED = "The change could not be saved. Try again.";
export const REVIEW_FAILED = "The exam could not be marked as reviewed. Try again.";
export const PRACTICE_FAILED = "Practice could not be started for this exercise. Try again.";

const BASE = "/api/ext/exams";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): v is string => typeof v === "string" && v !== "";

function isCollection(v: unknown): v is Collection {
	const o = obj(v);
	return o !== null && str(o.id) && typeof o.title === "string" && typeof o.createdAt === "string";
}
function isExam(v: unknown): v is ExamDoc {
	const o = obj(v);
	return o !== null && str(o.id) && str(o.collectionId) && typeof o.title === "string" && typeof o.reviewed === "boolean";
}
function isMaterial(v: unknown): v is MaterialDoc {
	const o = obj(v);
	return o !== null && str(o.id) && str(o.collectionId) && typeof o.title === "string" && typeof o.indexedAt === "string";
}
function isExercise(v: unknown): v is Exercise {
	const o = obj(v);
	return o !== null && str(o.id) && str(o.examId) && typeof o.order === "number" && typeof o.text === "string";
}

/** Runs one call: a refusal gets the server's text, a bad body or a thrown error gets the fallback. */
async function call<T>(fetchFn: typeof fetch, url: string, init: RequestInit, fallback: string, parse: (json: unknown) => T | null): Promise<Result<T>> {
	let res: Response;
	try {
		res = await fetchFn(url, init);
	} catch {
		return { ok: false, error: fallback };
	}
	if (!res.ok) return { ok: false, error: await failureText(res, fallback) };
	const value = parse(await res.json().catch(() => null));
	return value === null ? { ok: false, error: fallback } : { ok: true, value };
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const list = <T>(key: string, guard: (v: unknown) => v is T) => (json: unknown): T[] | null => {
	const items = obj(json)?.[key];
	return Array.isArray(items) && items.every(guard) ? items : null;
};

export function listCollections(fetchFn: typeof fetch): Promise<Result<Collection[]>> {
	return call(fetchFn, `${BASE}/collections`, { method: "GET" }, COLLECTIONS_FAILED, list("collections", isCollection));
}

export function createCollection(fetchFn: typeof fetch, title: string): Promise<Result<Collection>> {
	return call(fetchFn, `${BASE}/collections`, jsonInit("POST", { title }), CREATE_FAILED, (json) => (isCollection(json) ? json : null));
}

export function getCollection(fetchFn: typeof fetch, id: string): Promise<Result<CollectionDetail>> {
	return call(fetchFn, `${BASE}/collections/${encodeURIComponent(id)}`, { method: "GET" }, COLLECTION_FAILED, (json) => {
		const o = obj(json);
		if (o === null || !isCollection(o.collection)) return null;
		if (!Array.isArray(o.exams) || !o.exams.every(isExam)) return null;
		if (!Array.isArray(o.materials) || !o.materials.every(isMaterial)) return null;
		return { collection: o.collection, exams: o.exams, materials: o.materials };
	});
}

export function uploadExam(fetchFn: typeof fetch, collectionId: string, file: Blob, title: string): Promise<Result<ExamDoc>> {
	return call(
		fetchFn,
		`${BASE}/collections/${encodeURIComponent(collectionId)}/exams`,
		{ method: "POST", body: buildPdfUploadForm(file, title) },
		UPLOAD_FAILED,
		(json) => (isExam(json) ? json : null),
	);
}

export function uploadMaterial(fetchFn: typeof fetch, collectionId: string, file: Blob, title: string): Promise<Result<MaterialDoc>> {
	return call(
		fetchFn,
		`${BASE}/collections/${encodeURIComponent(collectionId)}/materials`,
		{ method: "POST", body: buildPdfUploadForm(file, title) },
		UPLOAD_FAILED,
		(json) => (isMaterial(json) ? json : null),
	);
}

export function listExercises(fetchFn: typeof fetch, examId: string): Promise<Result<Exercise[]>> {
	return call(fetchFn, `${BASE}/${encodeURIComponent(examId)}/exercises`, { method: "GET" }, EXERCISES_FAILED, list("exercises", isExercise));
}

export function editExercise(fetchFn: typeof fetch, examId: string, op: ExerciseOp): Promise<Result<Exercise[]>> {
	return call(fetchFn, `${BASE}/${encodeURIComponent(examId)}/exercises`, jsonInit("PATCH", op), EDIT_FAILED, list("exercises", isExercise));
}

export function markReviewed(fetchFn: typeof fetch, examId: string): Promise<Result<ExamDoc>> {
	return call(fetchFn, `${BASE}/${encodeURIComponent(examId)}/exercises`, jsonInit("POST", { action: "reviewed" }), REVIEW_FAILED, (json) =>
		isExam(json) ? json : null,
	);
}

/** Starts an exam practice chat on one exercise; the caller opens the returned chat. */
export function startPractice(fetchFn: typeof fetch, collectionId: string, exerciseId: string): Promise<Result<{ chatId: string }>> {
	return call(fetchFn, `${BASE}/session`, jsonInit("POST", { collectionId, exerciseId }), PRACTICE_FAILED, (json) => {
		const chatId = obj(json)?.chatId;
		return str(chatId) ? { chatId } : null;
	});
}
