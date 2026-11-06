// tests/ext-debrief-sources.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "../src/core/ext/debrief/activity.ts";
import type { ExerciseEvent } from "../src/core/ext/practice/exercises.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";
import { weeklyWindow } from "../src/core/ext/debrief/weekly.ts";
import { createDebriefSources, transcriptOf, type SourcesDeps, type StudyFeed } from "../src/server/ext/debrief-sources.ts";
import { makeLecture, NODE_A } from "./helpers/lecture-fixture.ts";

const iso = (min: number) => new Date(Date.parse("2026-11-04T10:00:00.000Z") + min * 60_000).toISOString();
const ms = (min: number) => Date.parse(iso(min));
const rv = (nodeId: string, min: number, over: Partial<Extract<ReviewEvent, { type: "review" }>> = {}): ReviewEvent => ({ type: "review", nodeId, channel: "fixed", rating: 3, durationSec: 20, at: iso(min), ...over });

function deps(over: Partial<SourcesDeps> = {}): SourcesDeps {
	return {
		chats: { list: () => [], messages: () => [] },
		reviewEvents: () => [], officeHoursEvents: () => [], exerciseEvents: () => [], cardEvents: () => [], goalEvents: () => [],
		activityEvents: () => [], journal: () => [],
		graph: () => ({ nodes: [{ id: "n_a", name: "Alpha" }, { id: "n_b", name: "Beta" }], chains: [] }),
		lecture: () => null, trustLevels: () => new Map(),
		now: () => new Date(iso(600)), idleMs: 30 * 60_000, budgetSec: 1500,
		...over,
	};
}
const chat = (id: string, kind: string, startMin: number, endMin: number, title = id) => ({ id, title, kind, createdAt: iso(startMin), updatedAt: iso(endMin) });

describe("transcriptOf", () => {
	it("flattens string and block content and skips everything that is not a timestamped user or assistant text", () => {
		const out = transcriptOf([
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", name: "x" }, { type: "text", text: "b" }], timestamp: 2 },
			{ role: "toolResult", content: "x", timestamp: 3 },
			{ role: "user", content: "no time" },
			{ role: "user", content: "bad time", timestamp: Number.NaN },
			{ role: "assistant", content: 7, timestamp: 4 },
			null, "str", 5,
		]);
		assert.deepEqual(out, [{ role: "user", at: 1, text: "hello" }, { role: "assistant", at: 2, text: "a\nb" }, { role: "assistant", at: 4, text: "" }]);
	});
});

describe("sessions()", () => {
	it("lists review, office-hours and study chats, exercise sets and lecture sessions; not plain teaching or practice", () => {
		const lecture = makeLecture();
		const d = deps({
			chats: {
				list: () => [chat("c_rev", "review", 0, 20), chat("c_oh", "office_hours", 0, 20), chat("c_st", "study", 0, 20), chat("c_t", "teach", 0, 20), chat("c_p", "practice", 0, 20)],
				messages: () => [],
			},
			exerciseEvents: () => [{ type: "set_created", setId: "set_1", goalId: "g1", exercises: [{ id: "e1", prompt: "p", nodeIds: ["n_a", "n_b"], steps: [] }], at: iso(0) }, { type: "graded", setId: "set_1", exerciseId: "e1", outcome: "consistent", nodeOutcomes: [], lowConfidence: false, at: iso(15) }],
			activityEvents: () => [{ type: "lecture_view", sessionId: "lecs_abcdefgh12", lectureId: lecture.id, slideId: "s1", at: iso(3) }],
			lecture: (id) => (id === lecture.id ? lecture : null),
		});
		const refs = createDebriefSources(d).sessions();
		assert.deepEqual(refs.map((r) => [r.sessionId, r.kind]).sort(), [["c_oh", "office_hours"], ["c_rev", "review"], ["c_st", "study"], ["lecs_abcdefgh12", "lecture"], ["set_1", "exercises"]]);
		assert.equal(refs.find((r) => r.sessionId === "set_1")?.lastActivityAt, iso(15));
		assert.equal(refs.find((r) => r.sessionId === "lecs_abcdefgh12")?.title, "Sigma algebras");
	});
	it("a study session's last activity includes the reading ledger", () => {
		const study: StudyFeed = { documentOfChat: () => ({ documentId: "d".repeat(64), title: "Book" }), pagesRead: () => [], linkedNodeIds: () => [], lastActivityAt: () => iso(90) };
		const refs = createDebriefSources(deps({ chats: { list: () => [chat("c_st", "study", 0, 20)], messages: () => [] }, study })).sessions();
		assert.equal(refs[0]?.lastActivityAt, iso(90));
	});
});

describe("sessionFacts", () => {
	it("two overlapping review sessions never count the same review twice", () => {
		const d = deps({
			chats: { list: () => [chat("c1", "review", 0, 60), chat("c2", "review", 30, 90)], messages: () => [] },
			reviewEvents: () => [rv("n_a", 10), rv("n_a", 40), rv("n_b", 50), rv("n_b", 80)],
		});
		const s = createDebriefSources(d);
		const [c1, c2] = s.sessions();
		const f1 = s.sessionFacts(c1!, iso(60));
		const f2 = s.sessionFacts(c2!, iso(90));
		assert.equal(f1.kind === "review" && f1.reviews, 1); // only the review at minute 10
		assert.equal(f2.kind === "review" && f2.reviews, 3); // 40, 50, 80
	});
	it("office-hours facts use the chat's verdicts and its transcript", () => {
		const d = deps({
			chats: { list: () => [chat("c_oh", "office_hours", 0, 30)], messages: () => [{ role: "user", content: "my proof", timestamp: ms(1) }, { role: "assistant", content: "Why does step 2 hold?", timestamp: ms(2) }] },
			officeHoursEvents: () => [{ type: "verdict", chatId: "c_oh", outcome: "differs", discarded: 0, at: iso(5), items: [{ stepRef: "s1", sourceQuote: "q".repeat(25), workQuote: "w", stance: "differs" }] }],
		});
		const s = createDebriefSources(d);
		const f = s.sessionFacts(s.sessions()[0]!, iso(30));
		assert.ok(f.kind === "office_hours");
		assert.equal(f.verdicts.differs, 1);
		assert.equal(f.stepsQuestioned, 1);
		assert.equal(f.learnerMessages, 1);
		assert.equal(f.unansweredQuestions, 1);
	});
	it("lecture facts count the session's distinct slides against the lecture", () => {
		const lecture = makeLecture();
		const ev = (slideId: string, min: number): ActivityEvent => ({ type: "lecture_view", sessionId: "lecs_abcdefgh12", lectureId: lecture.id, slideId, at: iso(min) });
		const s = createDebriefSources(deps({ activityEvents: () => [ev("s1", 1), ev("s1", 2), ev("s2", 3), { type: "concept_open", sessionId: "lecs_abcdefgh12", lectureId: lecture.id, nodeId: NODE_A, at: iso(4) }], lecture: () => lecture }));
		const f = s.sessionFacts(s.sessions()[0]!, iso(5));
		assert.ok(f.kind === "lecture");
		assert.deepEqual([f.slidesViewed, f.slidesTotal, f.conceptsOpened, f.exercisesTotal], [2, 2, 1, 1]);
	});
	it("exercise facts fail loudly if the set vanished between listing and facts", () => {
		let events: ExerciseEvent[] = [{ type: "set_created", setId: "set_1", goalId: "g", exercises: [{ id: "e1", prompt: "p", nodeIds: ["n_a", "n_b"], steps: [] }], at: iso(0) }];
		const s = createDebriefSources(deps({ exerciseEvents: () => events }));
		const r = s.sessions()[0]!;
		events = [];
		assert.throws(() => s.sessionFacts(r, iso(5)), /no longer exists/);
	});
	it("study facts use the feed when present and degrade to message counts without it", () => {
		const doc = { documentId: "d".repeat(64), title: "Book" };
		const feed: StudyFeed = { documentOfChat: () => doc, pagesRead: () => [1, 2, 2], linkedNodeIds: () => ["n_a"], lastActivityAt: () => null };
		const base = { chats: { list: () => [chat("c_st", "study", 0, 30)], messages: () => [{ role: "user", content: "q", timestamp: ms(1) }] }, cardEvents: () => [{ type: "created" as const, cardId: "k", nodeId: "n_a", question: "q", answer: "a", author: "user" as const, status: "active" as const, at: iso(3) }] };
		const withFeed = createDebriefSources(deps({ ...base, study: feed }));
		const f = withFeed.sessionFacts(withFeed.sessions()[0]!, iso(30));
		assert.ok(f.kind === "study");
		assert.deepEqual([f.pagesRead, f.learnerMessages, f.nodesLinked, f.cardsCreated, f.title], [2, 1, 1, 1, "Book"]);
		const without = createDebriefSources(deps(base));
		const g = without.sessionFacts(without.sessions()[0]!, iso(30));
		assert.ok(g.kind === "study");
		assert.deepEqual([g.pagesRead, g.learnerMessages, g.nodesLinked, g.title], [0, 1, 0, null]);
	});
});

describe("weeklyFacts and read-only behaviour (REQ-deb-07)", () => {
	it("reports trust and goal progress from the ledgers", () => {
		const w = weeklyWindow(new Date(2026, 10, 4, 12), 0, 18);
		const s = createDebriefSources(deps({
			goalEvents: () => [{ type: "created", goalId: "g1", title: "Goal", origin: "user", originRef: "", targetNodeIds: ["n_b"], priority: 3, at: new Date(2026, 9, 1).toISOString() }],
			graph: () => ({ nodes: [{ id: "n_a", name: "A" }, { id: "n_b", name: "B" }], chains: [{ id: "c", premises: ["n_a"], conclusion: "n_b", provenance: [], createdAt: "" }] }),
			trustLevels: () => new Map([["n_a", "sourced" as const]]),
		}));
		const f = s.weeklyFacts(w);
		assert.equal(f.kind, "weekly");
		assert.deepEqual(f.trust, { total: 2, sourced: 1, contested: 0, refuted: 0, unverified: 1 });
		assert.equal(f.goals[0]?.total, 2);
	});
	it("never mutates what it reads", () => {
		const reviews = Object.freeze([Object.freeze(rv("n_a", 10))]) as unknown as ReviewEvent[];
		const s = createDebriefSources(deps({ chats: { list: () => [chat("c1", "review", 0, 60)], messages: () => [] }, reviewEvents: () => reviews }));
		assert.doesNotThrow(() => s.sessionFacts(s.sessions()[0]!, iso(60)));
		assert.doesNotThrow(() => s.weeklyFacts(weeklyWindow(new Date(2026, 10, 4, 12), 0, 18)));
	});
});
