// tests/ext-session-notes-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-notes-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const route = await import("../app/api/ext/session-notes/[chatId]/route.ts");
const { stores } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const put = (chatId: string, body: unknown) =>
	route.PUT(new Request(`http://localhost/api/ext/session-notes/${chatId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(chatId));

describe("session notes routes (REQ-sn-06)", () => {
	it("the learner saves a note for a session, and it is stored as edited", async () => {
		const chat = stores.chatStore.createChat("Kant");
		const res = await put(chat.id, { text: "  Examples before formulas.  " });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { note: { text: string; edited: boolean } };
		assert.equal(body.note.text, "Examples before formulas.");
		assert.equal(body.note.edited, true);
		const { extStores } = await import("../src/server/ext/stores.ts");
		assert.equal(extStores.sessionNotesStore.read()[chat.id]?.text, "Examples before formulas.");
	});

	it("an empty text clears the note", async () => {
		const chat = stores.chatStore.createChat("Hume");
		await put(chat.id, { text: "Worked examples." });
		const res = await put(chat.id, { text: "   " });
		assert.deepEqual(await res.json(), { note: null });
		const { extStores } = await import("../src/server/ext/stores.ts");
		assert.equal(extStores.sessionNotesStore.read()[chat.id], undefined);
	});

	it("DELETE clears the note", async () => {
		const chat = stores.chatStore.createChat("Locke");
		await put(chat.id, { text: "Short answers." });
		const res = await route.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params(chat.id));
		assert.equal(res.status, 200);
		const { extStores } = await import("../src/server/ext/stores.ts");
		assert.equal(extStores.sessionNotesStore.read()[chat.id], undefined);
	});

	it("a note over 1000 characters is a 400 with a fixed message", async () => {
		const chat = stores.chatStore.createChat("Rousseau");
		const res = await put(chat.id, { text: "x".repeat(1001) });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /1000 characters/);
	});

	it("a body that is not text is a 400", async () => {
		const chat = stores.chatStore.createChat("Mill");
		assert.equal((await put(chat.id, { text: 42 })).status, 400);
		assert.equal((await put(chat.id, { nope: true })).status, 400);
	});

	it("an unknown session is a 404", async () => {
		assert.equal((await put("chat_missing", { text: "hi" })).status, 404);
	});
});
