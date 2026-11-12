// The agent's own workspace: uploads are copied in and kept, names never collide, protected files and folders are not copied.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIntoWorkspace, keepBytes, MAX_FOLDER_FILES, safeFileName } from "../src/server/ext/workspace.ts";

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
	it("returns a path already inside the workspace unchanged", () => {
		const { root } = tmp();
		const inside = path.join(root, "kept.txt");
		fs.writeFileSync(inside, "k");
		const r = importIntoWorkspace([inside], root);
		assert.deepEqual(r, { paths: [inside], errors: [] });
		assert.equal(fs.existsSync(path.join(root, "uploads")), false);
	});
	it("copies a whole folder, keeps its structure and the directory marker, and leaves the original", () => {
		const { dir, root } = tmp();
		const folder = path.join(dir, "Study");
		fs.mkdirSync(path.join(folder, "week1"), { recursive: true });
		fs.writeFileSync(path.join(folder, "a.md"), "A");
		fs.writeFileSync(path.join(folder, "week1", "b.md"), "B");
		const r = importIntoWorkspace([`${folder}/`], root);
		assert.deepEqual(r.errors, []);
		assert.equal(r.paths[0], `${path.join(root, "uploads", "Study")}/`);
		assert.equal(fs.readFileSync(path.join(root, "uploads", "Study", "week1", "b.md"), "utf8"), "B");
		assert.equal(fs.existsSync(path.join(folder, "a.md")), true);
	});
	it("leaves out .git, node_modules and links, and never follows a link out of the folder", () => {
		const { dir, root } = tmp();
		const folder = path.join(dir, "proj");
		fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
		fs.mkdirSync(path.join(folder, "node_modules"));
		fs.writeFileSync(path.join(folder, ".git", "HEAD"), "x");
		fs.writeFileSync(path.join(folder, "node_modules", "m.js"), "x");
		fs.writeFileSync(path.join(folder, "ok.txt"), "ok");
		const outside = path.join(dir, "secret.txt");
		fs.writeFileSync(outside, "secret");
		fs.symlinkSync(outside, path.join(folder, "link.txt"));
		const r = importIntoWorkspace([folder], root);
		const copied = path.join(root, "uploads", "proj");
		assert.deepEqual(fs.readdirSync(copied), ["ok.txt"]);
		assert.match(r.errors[0]!, /1 protected or unsupported entries were left out/);
	});
	it("a folder over the file limit is not copied at all", () => {
		const { dir, root } = tmp();
		const folder = path.join(dir, "big");
		fs.mkdirSync(folder);
		for (let i = 0; i <= MAX_FOLDER_FILES; i++) fs.writeFileSync(path.join(folder, `f${i}.txt`), "x");
		const r = importIntoWorkspace([folder], root);
		assert.deepEqual(r.paths, [folder]);
		assert.match(r.errors[0]!, /too large to copy/);
		assert.equal(fs.existsSync(path.join(root, "uploads", "big")), false);
	});
	it("a folder that holds the workspace does not copy the workspace into itself", () => {
		const { dir, root } = tmp();
		fs.writeFileSync(path.join(dir, "n.txt"), "n");
		fs.writeFileSync(path.join(root, "old.txt"), "old");
		importIntoWorkspace([dir], root);
		const copied = path.join(root, "uploads", path.basename(dir));
		assert.deepEqual(fs.readdirSync(copied).sort(), ["n.txt"]);
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
