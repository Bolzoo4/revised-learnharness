import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLecturesStore } from "../src/store/ext/lectures-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("lectures store", () => {
	it("saves, gets, lists in id order and removes", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		const b = makeLecture({ id: "lec_b0123abcd_c02_l02", order: 2 });
		store.save(b);
		store.save(makeLecture());
		assert.deepEqual(store.list().map((l) => l.id), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c02_l02"]);
		assert.deepEqual(store.get("lec_b0123abcd_c02_l02"), b);
		store.remove("lec_b0123abcd_c02_l02");
		assert.equal(store.get("lec_b0123abcd_c02_l02"), null);
	});
	it("creates the format stamp on first save and not on read", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		assert.deepEqual(store.list(), []);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false);
		store.save(makeLecture());
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8")).version, CURRENT_EXT_FORMAT_VERSION);
	});
	it("refuses an invalid lecture and never reads outside its folder", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		assert.throws(() => store.save({ ...makeLecture(), id: "../evil" }), /not a valid lecture/);
		assert.equal(store.get("../../etc/passwd"), null);
		store.remove("../..");
		assert.ok(fs.existsSync(dir));
	});
	it("skips a corrupt lecture file", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		store.save(makeLecture());
		fs.writeFileSync(path.join(dir, "lectures", "lec_b0123abcd_c02_l01", "lecture.json"), "{broken");
		assert.deepEqual(store.list(), []);
	});
	it("throws on a stamp newer than this build", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		assert.throws(() => createLecturesStore(dir).list(), /format version/);
	});
});

describe("snapshot reader", () => {
	it("reads what the verification snapshot store wrote, and refuses malformed hashes", async () => {
		const { createSnapshotStore } = await import("../src/store/ext/snapshot-store.ts");
		const { createSnapshotReader } = await import("../src/store/ext/snapshot-reader.ts");
		const dir = tmp();
		const hash = createSnapshotStore(dir).put("solution text");
		const reader = createSnapshotReader(dir);
		assert.equal(reader.get(hash), "solution text");
		assert.equal(reader.get("../../x"), null);
		assert.equal(reader.get("a".repeat(64)), null);
	});
});
