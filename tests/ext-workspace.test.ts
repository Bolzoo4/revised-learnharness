// The agent's own workspace: uploads are copied in and kept, names never collide, protected files and folders are not copied.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIntoWorkspace, keepBytes, safeFileName } from "../src/server/ext/workspace.ts";

function tmp() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-ws-")));
	const root = path.join(dir, "workspace");
	fs.mkdirSync(root);
	return { dir, root };
}

describe("importIntoWorkspace", () => {
	it("copies a file into uploads and keeps the original", () => {
		const { dir, root } = tmp();
		const src = path.join(dir, "notes.txt");
		fs.writeFileSync(src, "hello");
		const r = importIntoWorkspace([src], root);
		assert.deepEqual(r.errors, []);
		assert.equal(r.paths[0], path.join(root, "uploads", "notes.txt"));
		assert.equal(fs.readFileSync(r.paths[0]!, "utf8"), "hello");
		assert.equal(fs.existsSync(src), true);
	});
	it("never overwrites: the same name twice gets a numbered copy", () => {
		const { dir, root } = tmp();
		const a = path.join(dir, "a", "x.txt");
		const b = path.join(dir, "b", "x.txt");
		fs.mkdirSync(path.dirname(a));
		fs.mkdirSync(path.dirname(b));
		fs.writeFileSync(a, "first");
		fs.writeFileSync(b, "second");
		const r = importIntoWorkspace([a, b], root);
		assert.equal(r.paths[1], path.join(root, "uploads", "x (2).txt"));
		assert.equal(fs.readFileSync(r.paths[0]!, "utf8"), "first");
		assert.equal(fs.readFileSync(r.paths[1]!, "utf8"), "second");
	});
	it("returns a path already inside the workspace unchanged, and does not copy a folder", () => {
		const { dir, root } = tmp();
		const inside = path.join(root, "kept.txt");
		fs.writeFileSync(inside, "k");
		const folder = path.join(dir, "folder");
		fs.mkdirSync(folder);
		const r = importIntoWorkspace([inside, folder], root);
		assert.deepEqual(r.paths, [inside, folder]);
		assert.deepEqual(r.errors, []);
		assert.equal(fs.existsSync(path.join(root, "uploads")), false);
	});
	it("reports a missing file in words and returns its path unchanged", () => {
		const { dir, root } = tmp();
		const missing = path.join(dir, "nope.pdf");
		const r = importIntoWorkspace([missing], root);
		assert.deepEqual(r.paths, [missing]);
		assert.equal(r.errors.length, 1);
		assert.match(r.errors[0]!, /nope\.pdf could not be copied/);
	});
	it("refuses a protected file (an SSH key) even though copying is not reading through the tools", () => {
		const { root } = tmp();
		const key = path.join(os.homedir(), ".ssh", "id_ed25519");
		const r = importIntoWorkspace([key], root);
		assert.equal(r.errors.length, 1);
		assert.equal(fs.existsSync(path.join(root, "uploads")), false);
	});
});

describe("keepBytes and safeFileName", () => {
	it("keeps uploaded bytes under the given subfolder, with a safe name", () => {
		const { root } = tmp();
		const kept = keepBytes(new Uint8Array([1, 2, 3]), "exams/c1", "../../evil/Esame: 1.pdf", root);
		assert.equal(path.dirname(kept), path.join(root, "exams", "c1"));
		assert.equal(path.basename(kept), "Esame_ 1.pdf");
		assert.deepEqual([...fs.readFileSync(kept)], [1, 2, 3]);
	});
	it("never yields an empty or dot name", () => {
		assert.equal(safeFileName(".."), "file");
		assert.equal(safeFileName(""), "file");
	});
});
