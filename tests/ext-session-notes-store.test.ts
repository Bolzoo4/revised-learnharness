// tests/ext-session-notes-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createSessionNotesStore } from "../src/store/ext/session-notes-store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-notes-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("session notes store (REQ-sn-01)", () => {
	it("reads no notes when the file does not exist", () => {
		const store = createSessionNotesStore(path.join(dir, "empty"));
		assert.deepEqual(store.read(), {});
	});

	it("round-trips the map through session-notes.json", () => {
		const store = createSessionNotesStore(dir);
		const notes = { chat_1: { text: "Intuition first.", updatedAt: "2026-11-07T10:00:00.000Z", edited: true } };
		store.write(notes);
		assert.deepEqual(store.read(), notes);
		const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "session-notes.json"), "utf-8")) as unknown;
		assert.deepEqual(onDisk, notes);
	});

	it("loads a corrupt file as no notes instead of crashing", () => {
		fs.writeFileSync(path.join(dir, "session-notes.json"), "{ not json");
		assert.deepEqual(createSessionNotesStore(dir).read(), {});
	});

	it("drops invalid entries on read", () => {
		fs.writeFileSync(
			path.join(dir, "session-notes.json"),
			JSON.stringify({ chat_ok: { text: "fine", updatedAt: "2026-11-07T10:00:00.000Z", edited: false }, chat_bad: { text: 3 } }),
		);
		assert.deepEqual(Object.keys(createSessionNotesStore(dir).read()), ["chat_ok"]);
	});
});
