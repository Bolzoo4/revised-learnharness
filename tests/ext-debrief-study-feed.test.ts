// tests/ext-debrief-study-feed.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStudyFeed } from "../src/server/ext/debrief-study.ts";

const D1 = "d".repeat(64);
const D2 = "e".repeat(64);
const at = (min: number) => new Date(Date.parse("2026-11-04T10:00:00.000Z") + min * 60_000).toISOString();
const reading = [
	{ documentId: D1, at: at(1), page: 3 }, { documentId: D1, at: at(5), page: 4 }, { documentId: D2, at: at(2), page: 1 }, { documentId: D1, at: at(90), page: 9 },
];
const links = [{ nodeId: "n_a", documentId: D1, at: at(3) }, { nodeId: "n_a", documentId: D1, at: at(4) }, { nodeId: "n_b", documentId: D2, at: at(3) }, { nodeId: "n_c", documentId: D1, at: at(200) }];
const feed = (docs = [{ id: D1, title: "Book", chatId: "chat_1" as string | null }]) =>
	createStudyFeed({ documents: () => docs, reading: () => reading, links: () => links, readPages: (events) => events.map((e) => (e as unknown as { page: number }).page) });

describe("createStudyFeed", () => {
	it("binds a chat to its document and returns null for an unbound chat", () => {
		assert.deepEqual(feed().documentOfChat("chat_1"), { documentId: D1, title: "Book" });
		assert.equal(feed().documentOfChat("chat_2"), null);
		assert.equal(feed([{ id: D1, title: "Book", chatId: null }]).documentOfChat("chat_1"), null);
	});
	it("passes only this document's events inside the window to the reading rule", () => {
		assert.deepEqual(feed().pagesRead(D1, at(0), at(10)), [3, 4]);
		assert.deepEqual(feed().pagesRead(D1, at(5), at(5)), [4]); // edges belong to the window
		assert.deepEqual(feed().pagesRead(D1, at(20), at(30)), []);
	});
	it("lists the distinct nodes linked in the window for this document", () => {
		assert.deepEqual(feed().linkedNodeIds(D1, at(0), at(10)), ["n_a"]);
		assert.deepEqual(feed().linkedNodeIds(D2, at(0), at(10)), ["n_b"]);
		assert.deepEqual(feed().linkedNodeIds(D1, at(0), at(300)), ["n_a", "n_c"]);
	});
	it("reports the newest reading or link event of the document", () => {
		assert.equal(feed().lastActivityAt(D1), at(200));
		assert.equal(feed().lastActivityAt(D2), at(3));
		assert.equal(feed().lastActivityAt("f".repeat(64)), null);
	});
	it("ignores events with an unparseable timestamp", () => {
		const f = createStudyFeed({ documents: () => [], reading: () => [{ documentId: D1, at: "bad" }], links: () => [{ nodeId: "n", documentId: D1, at: "bad" }], readPages: (e) => e.map(() => 1) });
		assert.deepEqual(f.pagesRead(D1, at(0), at(10)), []);
		assert.deepEqual(f.linkedNodeIds(D1, at(0), at(10)), []);
		assert.equal(f.lastActivityAt(D1), null);
	});
});
