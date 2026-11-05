// tests/ext-review-kind.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind review", () => {
	it("createChat(kind: 'review') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Daily review", "review");
		assert.equal(chat.kind, "review");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "review");
	});
	it("practice and the default are unchanged", () => {
		assert.equal(chatStore.createChat("p", "practice").kind, "practice");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
});
