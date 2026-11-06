// tests/ext-study-kind.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { isPracticeLike } from "../src/core/index.ts";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind study (REQ-mode-01, REQ-study-04, REQ-study-12)", () => {
	it("createChat(kind: 'study') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Study: Probability", "study");
		assert.equal(chat.kind, "study");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "study");
	});
	it("the other kinds are unchanged", () => {
		assert.equal(chatStore.createChat("o", "office_hours").kind, "office_hours");
		assert.equal(chatStore.createChat("r", "review").kind, "review");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
	it("a study session is practice-like: the chat-level extraction never runs on it, so only confirmed propositions reach the graph", () => {
		assert.equal(isPracticeLike("study"), true);
		for (const k of ["teach", undefined, "other"]) assert.equal(isPracticeLike(k), false, String(k));
	});
});
