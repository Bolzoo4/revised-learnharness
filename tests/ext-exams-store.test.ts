// tests/ext-exams-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createExamsStore } from "../src/store/ext/exams-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import type { Collection, ExamDoc, Exercise, MaterialDoc } from "../src/core/ext/exams/types.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exams-store-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const col: Collection = { id: "c1", title: "Algoritmi", createdAt: "2026-11-07T10:00:00.000Z" };
const exam: ExamDoc = { id: "e1", collectionId: "c1", title: "Esame", documentId: "d".repeat(64), pages: 3, reviewed: false };
const ex: Exercise = { id: "x1", examId: "e1", order: 1, pageStart: 1, pageEnd: 2, text: "Testo", solution: "Sol", origin: "exam" };
const mat: MaterialDoc = { id: "m1", collectionId: "c1", title: "Dispensa", documentId: "f".repeat(64), pages: 2, indexedAt: "2026-11-07T10:00:00.000Z" };

describe("exams store layout (REQ-ex-01)", () => {
	it("writes each file under data/ext/exams/<collectionId>/ and reads it back", () => {
		const dir = tmp();
		const store = createExamsStore(dir);
		store.writeCollection(col);
		store.writeExams("c1", [exam]);
		store.writeExercises("c1", "e1", [ex]);
		store.writeMaterials("c1", [mat]);
		store.writeChunks("c1", "m1", [{ index: 0, page: 1, text: "uno" }, { index: 1, page: 2, text: "due" }]);
		const folder = path.join(dir, "exams", "c1");
		for (const f of ["collection.json", "exams.json", "exercises-e1.json", "materials.json", "chunks-m1.jsonl"]) {
			assert.ok(fs.existsSync(path.join(folder, f)), f);
		}
		assert.deepEqual(store.readCollection("c1"), col);
		assert.deepEqual(store.readExams("c1"), [exam]);
		assert.deepEqual(store.readExercises("c1", "e1"), [ex]);
		assert.deepEqual(store.readMaterials("c1"), [mat]);
		assert.deepEqual(store.readChunks("c1", "m1").map((c) => c.text), ["uno", "due"]);
		assert.deepEqual(store.listCollectionIds(), ["c1"]);
	});

	it("stamps the extension format on first write and never on read", () => {
		const dir = tmp();
		const store = createExamsStore(dir);
		assert.deepEqual(store.listCollectionIds(), []);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false);
		store.writeCollection(col);
		const stamp = JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8"));
		assert.equal(stamp.version, CURRENT_EXT_FORMAT_VERSION);
	});

	it("a malformed id never reaches a path: it reads as absent and is refused on write", () => {
		const dir = tmp();
		const store = createExamsStore(dir);
		store.writeCollection(col);
		assert.equal(store.readCollection("../c1"), null);
		assert.deepEqual(store.readExams("../../etc"), []);
		assert.deepEqual(store.readExercises("c1", "../e1"), []);
		assert.throws(() => store.writeCollection({ ...col, id: "../evil" }), /invalid collection id/);
		assert.throws(() => store.writeExercises("c1", "a/b", []), /invalid exam id/);
		assert.equal(fs.existsSync(path.join(dir, "evil")), false);
	});

	it("a corrupt chunk line is skipped, and a corrupt JSON file reads as absent", () => {
		const dir = tmp();
		const store = createExamsStore(dir);
		store.writeCollection(col);
		store.writeChunks("c1", "m1", [{ index: 0, page: 1, text: "ok" }]);
		fs.appendFileSync(path.join(dir, "exams", "c1", "chunks-m1.jsonl"), "{not json\n");
		fs.writeFileSync(path.join(dir, "exams", "c1", "exams.json"), "{broken");
		assert.deepEqual(store.readChunks("c1", "m1").map((c) => c.text), ["ok"]);
		assert.deepEqual(store.readExams("c1"), []);
	});

	it("an invalid record in a list is skipped, the valid ones are kept", () => {
		const dir = tmp();
		const store = createExamsStore(dir);
		store.writeCollection(col);
		fs.writeFileSync(path.join(dir, "exams", "c1", "exams.json"), JSON.stringify([exam, { id: 3 }]));
		assert.deepEqual(store.readExams("c1"), [exam]);
	});
});
