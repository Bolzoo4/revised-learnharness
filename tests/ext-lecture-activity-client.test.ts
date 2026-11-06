// tests/ext-lecture-activity-client.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLectureActivityClient } from "../components/ext/lecture-activity.ts";

const tick = () => new Promise((r) => setImmediate(r));

describe("lecture activity client", () => {
	it("sends each event once with a lecture session id and the lecture id", async () => {
		const sent: Array<Record<string, string>> = [];
		const c = createLectureActivityClient({ lectureId: "L", post: async (b) => (sent.push(b), { status: 200 }), newId: () => "abcdefgh1234" });
		c.slide("s1"); c.slide("s1"); c.concept("n_1"); c.exercise("b2"); c.exercise("b2");
		await tick();
		assert.deepEqual(sent.map((b) => [b.type, b.slideId ?? b.nodeId ?? b.blockId]), [["lecture_view", "s1"], ["concept_open", "n_1"], ["exercise_done", "b2"]]);
		assert.ok(sent.every((b) => b.sessionId === "lecs_abcdefgh1234" && b.lectureId === "L"));
	});
	it("starts a new session when the server says the old one ended, and resends the event once", async () => {
		const sent: Array<Record<string, string>> = [];
		let ids = 0;
		let first = true;
		const c = createLectureActivityClient({
			lectureId: "L",
			newId: () => `id${++ids}aaaaaaaa`,
			post: async (b) => { sent.push(b); if (first) { first = false; return { status: 409 }; } return { status: 200 }; },
		});
		c.slide("s1");
		await tick(); await tick();
		assert.equal(sent.length, 2);
		assert.notEqual(sent[0]?.sessionId, sent[1]?.sessionId);
		c.slide("s2");
		await tick();
		assert.equal(sent[2]?.sessionId, sent[1]?.sessionId, "later events use the new session");
	});
	it("a persistent 409 does not loop", async () => {
		let calls = 0;
		const c = createLectureActivityClient({ lectureId: "L", post: async () => (calls++, { status: 409 }) });
		c.slide("s1");
		await tick(); await tick(); await tick();
		assert.equal(calls, 2);
	});
	it("a network error or a server error never throws and allows a later retry of the same event", async () => {
		let calls = 0;
		const c = createLectureActivityClient({ lectureId: "L", post: async () => { calls++; if (calls === 1) throw new Error("offline"); if (calls === 2) return { status: 500 }; return { status: 200 }; } });
		c.slide("s1"); await tick();
		c.slide("s1"); await tick();
		c.slide("s1"); await tick();
		c.slide("s1"); await tick();
		assert.equal(calls, 3);
	});
});
