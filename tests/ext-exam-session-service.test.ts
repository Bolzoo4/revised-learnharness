// The exam session service (REQ-ex-03 reviewed-only, REQ-ex-07, REQ-ex-12) and the session kind's filter.
// Adversarial: forged ids, unreviewed exams, cross-collection binding, unbound chats.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Exercise, SearchHit } from "../src/core/ext/exams/types.ts";
import { isPracticeLike, sessionMatchesFilter } from "../src/core/ext/practice/session-kind.ts";
import { createExamSessionService, ExamSessionError, parseExamBinding, type ExamBinding } from "../src/server/ext/exam-session.ts";

const EX: Exercise = { id: "ex1", examId: "exam1", order: 2, pageStart: 1, pageEnd: 1, text: "Statement" };

function fixture(opts: { reviewed?: boolean; search?: (c: string, q: string) => SearchHit[] } = {}) {
	const bindings: ExamBinding[] = [];
	const sessions: string[] = [];
	const located: Array<[string, string]> = [];
	const service = createExamSessionService({
		locate: (c, e) => {
			located.push([c, e]);
			return c === "col1" && e === "ex1" ? { exercise: EX, reviewed: opts.reviewed ?? true } : null;
		},
		search: (c, q) => (opts.search ? opts.search(c, q) : []),
		bindings: { append: (b) => void bindings.push(b), readAll: () => [...bindings] },
		createSession: (title) => (sessions.push(title), { id: `chat_${sessions.length}` }),
		now: () => "2026-11-07T00:00:00.000Z",
	});
	return { service, bindings, sessions, located };
}

const expectError = (fn: () => unknown, status: number, message: string) => {
	try {
		fn();
	} catch (e) {
		assert.ok(e instanceof ExamSessionError, "a typed error");
		assert.equal(e.status, status);
		assert.equal(e.message, message);
		return;
	}
	assert.fail("expected a throw");
};

describe("start (REQ-ex-07, REQ-ex-03)", () => {
	it("creates a session on a reviewed exercise and binds it once", () => {
		const { service, bindings, sessions } = fixture();
		const r = service.start({ collectionId: "col1", exerciseId: "ex1" });
		assert.deepEqual(r, { chatId: "chat_1" });
		assert.deepEqual(sessions, ["Exam, exercise 2"]);
		assert.deepEqual(bindings, [{ chatId: "chat_1", collectionId: "col1", exerciseId: "ex1", examId: "exam1", at: "2026-11-07T00:00:00.000Z" }]);
	});
	it("refuses an exercise of an exam the learner has not reviewed, and creates nothing", () => {
		const { service, bindings, sessions } = fixture({ reviewed: false });
		expectError(() => service.start({ collectionId: "col1", exerciseId: "ex1" }), 409, "review the exercises of this exam before practising them");
		assert.equal(bindings.length, 0);
		assert.equal(sessions.length, 0);
	});
	it("a forged or unknown exercise, or an exercise named under another collection, is not found", () => {
		const { service } = fixture();
		expectError(() => service.start({ collectionId: "col1", exerciseId: "nope" }), 404, "the exercise was not found");
		expectError(() => service.start({ collectionId: "other", exerciseId: "ex1" }), 404, "the exercise was not found");
	});
	it("refuses a missing, empty, non-string or oversized id with a fixed message", () => {
		const { service } = fixture();
		const msg = "collectionId and exerciseId are required";
		expectError(() => service.start({}), 400, msg);
		expectError(() => service.start({ collectionId: "  ", exerciseId: "ex1" }), 400, msg);
		expectError(() => service.start({ collectionId: 7, exerciseId: "ex1" }), 400, msg);
		expectError(() => service.start({ collectionId: "col1", exerciseId: "x".repeat(201) }), 400, msg);
		expectError(() => service.start(null), 400, msg);
	});
});

describe("toolContext: the bound session only (REQ-ex-06)", () => {
	it("an unbound chat has no exercise and searches nothing", () => {
		const { service } = fixture({ search: () => [{ materialId: "m", title: "t", page: 1, text: "leak", score: 1 }] });
		const ctx = service.toolContext("chat_unknown", { getChat: () => null });
		assert.equal(ctx.exercise, null);
		assert.deepEqual(ctx.search("anything", { k: 5, maxTokens: 1500 }), []);
	});
	it("a bound chat gets its exercise and searches only its own collection, whatever the caller passes", () => {
		const seen: string[] = [];
		const { service } = fixture({ search: (c) => (seen.push(c), []) });
		service.start({ collectionId: "col1", exerciseId: "ex1" });
		const ctx = service.toolContext("chat_1", { getChat: () => null });
		assert.equal(ctx.exercise?.id, "ex1");
		ctx.search("power rule", { k: 5, maxTokens: 1500 });
		assert.deepEqual(seen, ["col1"]);
	});
	it("the newest binding of a chat wins, and a parse rejects a torn or forged line", () => {
		assert.equal(parseExamBinding({ chatId: "c", collectionId: "x", exerciseId: "e", examId: "m", at: "t" })?.chatId, "c");
		assert.equal(parseExamBinding({ chatId: "c" }), null);
		assert.equal(parseExamBinding("not an object"), null);
		assert.equal(parseExamBinding({ chatId: "", collectionId: "x", exerciseId: "e", examId: "m", at: "t" }), null);
	});
});

describe("session kind `exam` (REQ-ex-12)", () => {
	it("is practice-like (no graph writes, compacts like practice)", () => {
		assert.equal(isPracticeLike("exam"), true);
	});
	it("lists under All only, like study", () => {
		assert.equal(sessionMatchesFilter("exam", "all"), true);
		assert.equal(sessionMatchesFilter("exam", "practice"), false);
		assert.equal(sessionMatchesFilter("exam", "teach"), false);
		assert.equal(sessionMatchesFilter("study", "practice"), false);
	});
});
