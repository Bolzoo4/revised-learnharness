import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-oh-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind office_hours", () => {
	it("createChat(kind: 'office_hours') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Office hours: proof", "office_hours");
		assert.equal(chat.kind, "office_hours");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "office_hours");
	});
	it("the other kinds are unchanged", () => {
		assert.equal(chatStore.createChat("r", "review").kind, "review");
		assert.equal(chatStore.createChat("p", "practice").kind, "practice");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
});
