// tests/ext-exams-api.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createCollection,
	editExercise,
	getCollection,
	listCollections,
	listExercises,
	markReviewed,
	startPractice,
	uploadExam,
	uploadMaterial,
} from "../components/ext/exams-api.ts";

interface Seen {
	url: string;
	method: string;
	body: unknown;
}

/** A fake fetch that answers with one canned response and records each request. */
function fakeFetch(status: number, json: unknown, seen: Seen[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
		seen.push({ url: String(input), method: init?.method ?? "GET", body });
		return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const EXAM = { id: "exam-1", collectionId: "col-1", title: "Esame 2025", documentId: "doc-1", pages: 6, reviewed: false };
const EX = { id: "ex-1", examId: "exam-1", order: 1, pageStart: 1, pageEnd: 2, text: "Compute the limit." };

describe("collections routes", () => {
	it("lists the collections under the collections key", async () => {
		const seen: Seen[] = [];
		const r = await listCollections(fakeFetch(200, { collections: [{ id: "c1", title: "Analisi", createdAt: "2026-11-07T00:00:00Z" }] }, seen));
		assert.deepEqual(seen, [{ url: "/api/ext/exams/collections", method: "GET", body: undefined }]);
		assert.deepEqual(r, { ok: true, value: [{ id: "c1", title: "Analisi", createdAt: "2026-11-07T00:00:00Z" }] });
	});

	it("creates a collection with the title as JSON", async () => {
		const seen: Seen[] = [];
		const r = await createCollection(fakeFetch(200, { id: "c2", title: "Fisica", createdAt: "x" }, seen), "Fisica");
		assert.equal(seen[0]!.method, "POST");
		assert.deepEqual(seen[0]!.body, { title: "Fisica" });
		assert.equal(r.ok && r.value.id, "c2");
	});

	it("reads one collection with its exams and materials, the id encoded in the path", async () => {
		const seen: Seen[] = [];
		const detail = { collection: { id: "c/1", title: "T", createdAt: "x" }, exams: [EXAM], materials: [] };
		const r = await getCollection(fakeFetch(200, detail, seen), "c/1");
		assert.equal(seen[0]!.url, "/api/ext/exams/collections/c%2F1");
		assert.equal(r.ok && r.value.exams.length, 1);
	});

	it("a refusal shows the server's fixed message, and a non-JSON failure gets the fallback", async () => {
		const seen: Seen[] = [];
		const refused = await createCollection(fakeFetch(400, { error: "title is too long" }, seen), "x");
		assert.deepEqual(refused, { ok: false, error: "title is too long" });
		const bare = (async () => new Response("<html>boom</html>", { status: 500 })) as typeof fetch;
		const fallback = await getCollection(bare, "c1");
		assert.equal(fallback.ok, false);
		if (!fallback.ok) assert.ok(fallback.error.length > 0 && !fallback.error.includes("<html>"));
	});

	it("a network failure gives the fallback text, never the thrown message", async () => {
		const down = (async () => {
			throw new Error("ECONNREFUSED 127.0.0.1:3000");
		}) as typeof fetch;
		const r = await listCollections(down);
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(!r.error.includes("ECONNREFUSED"));
	});

	it("a success with a body of the wrong shape is a failure, not a crash", async () => {
		const r = await listCollections(fakeFetch(200, { nope: true }, []));
		assert.equal(r.ok, false);
	});
});

describe("uploads", () => {
	it("posts the exam PDF as multipart with the file field and the optional title", async () => {
		const seen: Array<{ url: string; method: string; form: FormData }> = [];
		const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({ url: String(input), method: init?.method ?? "", form: init?.body as FormData });
			return new Response(JSON.stringify(EXAM), { status: 200 });
		}) as typeof fetch;
		const file = new File(["%PDF-1.4"], "Esame 2025.pdf", { type: "application/pdf" });
		const r = await uploadExam(f, "col-1", file, "Esame 2025");
		assert.equal(seen[0]!.url, "/api/ext/exams/collections/col-1/exams");
		assert.equal(seen[0]!.method, "POST");
		assert.ok(seen[0]!.form.get("file") instanceof Blob);
		assert.equal(seen[0]!.form.get("title"), "Esame 2025");
		assert.equal(r.ok && r.value.id, "exam-1");
	});

	it("posts material to the materials route and leaves the title out when none was typed", async () => {
		const seen: Array<{ url: string; form: FormData }> = [];
		const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({ url: String(input), form: init?.body as FormData });
			return new Response(JSON.stringify({ id: "m1", collectionId: "col-1", title: "Dispensa", documentId: "d", pages: 3, indexedAt: "x" }), { status: 200 });
		}) as typeof fetch;
		const r = await uploadMaterial(f, "col-1", new File(["%PDF-"], "dispensa.pdf", { type: "application/pdf" }), "");
		assert.equal(seen[0]!.url, "/api/ext/exams/collections/col-1/materials");
		assert.equal(seen[0]!.form.has("title"), false);
		assert.equal(r.ok && r.value.id, "m1");
	});

	it("an upload refused by the server shows its fixed message", async () => {
		const f = (async () => new Response(JSON.stringify({ error: "that file is not a PDF" }), { status: 400 })) as typeof fetch;
		const r = await uploadExam(f, "col-1", new File(["x"], "a.pdf"), "");
		assert.deepEqual(r, { ok: false, error: "that file is not a PDF" });
	});
});

describe("exercise routes", () => {
	it("lists the exercises of an exam", async () => {
		const seen: Seen[] = [];
		const r = await listExercises(fakeFetch(200, { exercises: [EX] }, seen), "exam-1");
		assert.equal(seen[0]!.url, "/api/ext/exams/exam-1/exercises");
		assert.equal(seen[0]!.method, "GET");
		assert.deepEqual(r, { ok: true, value: [EX] });
	});

	it("sends each edit as the operation body of a PATCH and returns the new list", async () => {
		const ops = [
			{ op: "merge", firstId: "ex-1" },
			{ op: "split", id: "ex-1", at: 12 },
			{ op: "delete", id: "ex-1" },
			{ op: "edit", id: "ex-1", text: "New text" },
		] as const;
		for (const op of ops) {
			const seen: Seen[] = [];
			const r = await editExercise(fakeFetch(200, { exercises: [EX] }, seen), "exam-1", op);
			assert.equal(seen[0]!.method, "PATCH");
			assert.equal(seen[0]!.url, "/api/ext/exams/exam-1/exercises");
			assert.deepEqual(seen[0]!.body, op);
			assert.equal(r.ok && r.value.length, 1);
		}
	});

	it("an edit the server refuses shows its message", async () => {
		const r = await editExercise(fakeFetch(409, { error: "that exercise no longer exists" }, []), "exam-1", { op: "delete", id: "gone" });
		assert.deepEqual(r, { ok: false, error: "that exercise no longer exists" });
	});

	it("marks the exam reviewed with the reviewed action and returns the exam", async () => {
		const seen: Seen[] = [];
		const r = await markReviewed(fakeFetch(200, { ...EXAM, reviewed: true }, seen), "exam-1");
		assert.equal(seen[0]!.method, "POST");
		assert.deepEqual(seen[0]!.body, { action: "reviewed" });
		assert.equal(r.ok && r.value.reviewed, true);
	});
});

describe("practice route", () => {
	it("posts the collection and exercise and returns the chat id", async () => {
		const seen: Seen[] = [];
		const r = await startPractice(fakeFetch(200, { chatId: "chat-9" }, seen), "col-1", "ex-1");
		assert.equal(seen[0]!.url, "/api/ext/exams/session");
		assert.deepEqual(seen[0]!.body, { collectionId: "col-1", exerciseId: "ex-1" });
		assert.deepEqual(r, { ok: true, value: { chatId: "chat-9" } });
	});

	it("a success without a chat id is a failure with the practice fallback text", async () => {
		const r = await startPractice(fakeFetch(200, {}, []), "col-1", "ex-1");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /practice/i);
	});
});
