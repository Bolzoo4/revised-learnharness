import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-live-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { practiceService, listActiveGoals } = await import("../src/server/ext/practice-live.ts");
const { extStores } = await import("../src/server/ext/stores.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("live composition of the practice stage", () => {
	it("starts empty", () => {
		assert.deepEqual(practiceService.listSets(), []);
		assert.deepEqual(listActiveGoals(), []);
		assert.deepEqual(extStores.officeHoursLedger.readAll(), []);
	});
	it("starts a session whose designated source is a snapshot under data/ext", () => {
		const view = practiceService.startSession({ label: "Manual", sourceText: "A passage of the solutions manual." });
		assert.equal(practiceService.sourceOf(view.chatId)?.text, "A passage of the solutions manual.");
		assert.equal(fs.existsSync(path.join(TMP_DATA, "ext", "office-hours.jsonl")), true);
		assert.equal(fs.readdirSync(path.join(TMP_DATA, "ext", "snapshots")).length, 1);
	});
	it("refuses a verdict when the session has no source", () => {
		const view = practiceService.startSession({ label: "No source" });
		assert.throws(() => practiceService.submitVerdict(view.chatId, [], "my work"), /no source is designated/);
	});
});
