// tests/ext-debrief-live.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-debrief-live-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
process.env.LH_EXT_DAILY_CEILING_USD = "1";

const { debriefService } = await import("../src/server/index.ts");
const { stores } = await import("../src/server/stores.ts");
const { extStores } = await import("../src/server/ext/stores.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("the live debrief service over the real stores", () => {
	const chat = stores.chatStore.createChat("Daily review", "review");
	stores.graphStore.appendNode({ id: "n_live1", name: "Live node", statement: "Live holds.", aliases: [], createdAt: "2026-11-04T00:00:00.000Z", provenance: [] });
	const at = chat.createdAt; // the window start belongs to the session
	extStores.reviewStore.appendEvent({ type: "review", nodeId: "n_live1", channel: "fixed", rating: 1, durationSec: 12, at });
	extStores.reviewStore.appendEvent({ type: "review", nodeId: "n_gone", channel: "fixed", rating: 3, durationSec: 12, at });

	it("lists the review chat as a running session", () => {
		assert.deepEqual(debriefService.openSessions().map((s) => [s.sessionId, s.kind]), [[chat.id, "review"]]);
	});
	it("with no model configured, ending the session records the end and defers; nothing is stored", async () => {
		const out = await debriefService.endSession(chat.id);
		assert.deepEqual(out, { status: "deferred", reason: "unavailable" });
		assert.equal(extStores.journalLedger.readAll().length, 0);
		assert.deepEqual(extStores.activityLedger.readAll().map((e) => e.type), ["end"]);
		assert.deepEqual(debriefService.openSessions(), [], "an ended session is no longer running");
	});
	it("at the ceiling, the real facts are stored with a null commentary, once", async () => {
		extStores.costStore.appendEvent({ type: "spend", usd: 5, source: "verification", at: new Date().toISOString() });
		const first = await debriefService.endSession(chat.id);
		assert.equal(first.status, "created");
		const e = extStores.journalLedger.readAll()[0]!;
		assert.equal(e.commentary, null);
		assert.equal(e.nullReason, "ceiling");
		assert.equal(e.facts.kind, "review");
		assert.equal((e.facts as { reviews?: number }).reviews, 1, "the review of the deleted node is not counted");
		assert.equal((e.facts as { lapses?: number }).lapses, 1);
		assert.equal((await debriefService.endSession(chat.id)).status, "exists");
		assert.equal(extStores.journalLedger.readAll().length, 1);
		assert.equal(debriefService.list().entries[0]?.id, e.id);
	});
	it("the journal and activity files carry the extension's format stamp and are plain JSON lines", () => {
		const raw = fs.readFileSync(path.join(TMP_DATA, "ext", "journal.jsonl"), "utf-8").trim().split("\n");
		assert.equal(raw.length, 1);
		assert.equal(JSON.parse(raw[0]!).author, "agent");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP_DATA, "ext", "format.json"), "utf-8")), { version: 1 });
	});
});
