import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-live-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { lectureService } = await import("../src/server/ext/lecture-live.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("live composition of the lecture stage", () => {
	it("starts empty and reads nothing from outside the data folder", () => {
		assert.deepEqual(lectureService.listLectures(), []);
		assert.deepEqual(lectureService.runStatuses(), []);
		assert.deepEqual(lectureService.overlay(), { nodes: [], edges: [] });
	});
	it("refuses an ingest of a relative or missing PDF before any model call", () => {
		assert.throws(() => lectureService.startBookIngest({ pdfPath: "book.pdf" }), /absolute path/);
		assert.throws(() => lectureService.startBookIngest({ pdfPath: path.join(TMP_DATA, "none.pdf") }), /does not exist/);
	});
});
