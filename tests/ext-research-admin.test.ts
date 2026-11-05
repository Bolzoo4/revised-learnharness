// tests/ext-research-admin.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResearchAdmin } from "../src/server/ext/research-admin.ts";
import { ResearchInputError } from "../src/server/ext/research-errors.ts";
import type { FrontierEvent } from "../src/core/ext/frontier.ts";
import type { InboxEvent } from "../src/core/ext/inbox.ts";
import type { CycleLogEntry } from "../src/core/ext/research-log.ts";
import type { RadarEvent, WatchEntry } from "../src/core/ext/watch.ts";
import { memLog } from "./helpers/research-fakes.ts";

const NOW = "2026-11-04T12:00:00.000Z";

function make() {
	let n = 0;
	let watch: WatchEntry[] = [];
	const inbox = memLog<InboxEvent>([
		{ type: "proposed", locator: "https://a.org/x", title: "X", gapId: "g", foundBy: "cycle", cycleId: "c", snapshot: "h1", at: "2026-11-04T11:00:00.000Z" },
	]);
	const calls = { activated: [] as unknown[], ingested: [] as string[] };
	const admin = createResearchAdmin({
		frontier: memLog<FrontierEvent>(),
		log: memLog<CycleLogEntry>(),
		radar: memLog<RadarEvent>(),
		watchlist: { read: () => watch, write: (e) => void (watch = [...e]) },
		inboxService: {
			inbox,
			snapshots: { get: (h) => (h === "h1" ? "text" : null) },
			library: { activate: (e) => void calls.activated.push(e) },
			ingest: async (src) => (calls.ingested.push(src.locator), 2),
			now: () => new Date(NOW),
		},
		newId: (p) => `${p}_${++n}`,
		now: () => new Date(NOW),
	});
	return { admin, inbox, calls };
}

const goodMark = { scope: { kind: "node" as const, id: "n1" }, mark: "expand" as const, maxDepth: 3, budgetUsd: 1, note: "go deep" };

describe("research admin: marks", () => {
	it("the learner's marks are always author user; clear removes them", () => {
		const { admin } = make();
		const m = admin.setMark({ scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 1, maxDepth: 3, note: "go deep" });
		assert.deepEqual([m.author, m.mark, m.budgetUsd, m.maxDepth, m.note], ["user", "expand", 1, 3, "go deep"]);
		assert.equal(admin.listMarks().length, 1);
		admin.clearMark(m.id);
		assert.deepEqual(admin.listMarks(), []);
		assert.throws(() => admin.clearMark("mark_x"), ResearchInputError);
	});

	it("the agent's marks are author agent, through the same validation", () => {
		const { admin } = make();
		const m = admin.agent.setMark(goodMark);
		assert.equal(m.author, "agent");
		assert.equal(admin.listMarks()[0]!.author, "agent");
	});

	it("both paths refuse the same bad input before any append", () => {
		const bad: Array<[string, Record<string, unknown>]> = [
			["depth above the limit", { maxDepth: 11 }],
			["fractional depth", { maxDepth: 1.5 }],
			["budget of zero", { budgetUsd: 0 }],
			["budget above the limit", { budgetUsd: 101 }],
			["infinite budget", { budgetUsd: Number.POSITIVE_INFINITY }],
			["note too long", { note: "x".repeat(2001) }],
			["empty scope id", { scope: { kind: "node", id: "" } }],
			["scope id too long", { scope: { kind: "node", id: "x".repeat(201) } }],
			["unknown scope kind", { scope: { kind: "edge", id: "n1" } }],
			["unknown mark", { mark: "boom" }],
		];
		for (const [label, over] of bad) {
			const { admin } = make();
			const input = { ...goodMark, ...over } as Parameters<typeof admin.setMark>[0];
			assert.throws(() => admin.setMark(input), ResearchInputError, `user path: ${label}`);
			assert.throws(() => admin.agent.setMark(input), ResearchInputError, `agent path: ${label}`);
			assert.deepEqual(admin.listMarks(), [], `nothing written: ${label}`);
		}
	});

	it("clear: the agent cannot clear a learner's mark, but may clear its own; unknown ids are refused", () => {
		const { admin } = make();
		const user = admin.setMark(goodMark);
		const agent = admin.agent.setMark({ ...goodMark, scope: { kind: "node", id: "n2" } });
		assert.throws(() => admin.agent.clearMark(user.id), ResearchInputError);
		assert.equal(admin.listMarks().length, 2);
		admin.agent.clearMark(agent.id);
		assert.deepEqual(admin.listMarks().map((m) => m.id), [user.id]);
		assert.throws(() => admin.agent.clearMark("mark_none"), ResearchInputError);
		assert.throws(() => admin.clearMark("x".repeat(201)), ResearchInputError);
	});
});

describe("research admin: inbox", () => {
	it("lists by status", () => {
		const { admin } = make();
		assert.equal(admin.listInbox("pending").length, 1);
		assert.throws(() => admin.listInbox("bogus" as never), ResearchInputError);
	});

	it("approval goes through the inbox service; a normalized locator matches the pending item", async () => {
		const { admin, calls, inbox } = make();
		assert.deepEqual(await admin.decideInbox("https://A.org/x/#top", "approved"), { decision: "approved", nodesAdded: 2 });
		assert.deepEqual(calls.ingested, ["https://a.org/x"]);
		assert.deepEqual(calls.activated, []);
		assert.equal(admin.listInbox("approved").length, 1);
		assert.equal(inbox.readAll().length, 3);
	});

	it("activation happens only through the inbox service (the library gets one entry, once)", async () => {
		const { admin, calls } = make();
		assert.deepEqual(await admin.decideInbox("https://a.org/x", "activated", "primary"), { decision: "activated", nodesAdded: 2 });
		assert.equal(calls.activated.length, 1);
		assert.deepEqual(calls.activated[0], { locator: "https://a.org/x", kind: "url-prefix", label: "X", tier: "primary" });
		assert.equal(calls.ingested.length, 1);
	});

	it("refuses any locator that is not a pending inbox item, without ingesting", async () => {
		const { admin, calls } = make();
		await assert.rejects(admin.decideInbox("https://evil.example/", "approved"), ResearchInputError);
		await assert.rejects(admin.decideInbox("", "approved"), ResearchInputError);
		await assert.rejects(admin.decideInbox("x".repeat(2049), "approved"), ResearchInputError);
		assert.deepEqual(calls.ingested, []);
		await admin.decideInbox("https://a.org/x", "rejected");
		await assert.rejects(admin.decideInbox("https://a.org/x", "approved"), ResearchInputError);
		assert.deepEqual(calls.ingested, []);
	});

	it("refuses a bad decision or tier with a fixed message", async () => {
		const { admin, calls } = make();
		await assert.rejects(admin.decideInbox("https://a.org/x", "maybe" as never), ResearchInputError);
		await assert.rejects(admin.decideInbox("https://a.org/x", "approved", "gold" as never), ResearchInputError);
		assert.deepEqual([calls.ingested, calls.activated], [[], []]);
	});

	it("the agent path can approve or reject, never activate", async () => {
		const { admin, calls } = make();
		await assert.rejects(admin.agent.decideInbox("https://a.org/x", "activated" as never), ResearchInputError);
		assert.deepEqual([calls.ingested, calls.activated], [[], []]);
		assert.deepEqual(await admin.agent.decideInbox("https://a.org/x", "approved"), { decision: "approved", nodesAdded: 2 });
		assert.equal(calls.ingested.length, 1);
	});
});

describe("research admin: watchlist and log", () => {
	it("add validates the target and the bounds; cadence defaults to 24 hours", () => {
		const { admin } = make();
		const e = admin.addWatch({ kind: "arxiv-query", query: "all:gradient AND cat:cs.LG" });
		assert.deepEqual([e.id, e.cadenceHours], ["watch_1", 24]);
		assert.deepEqual(admin.listWatchlist().map((w) => w.id), ["watch_1"]);
		assert.throws(() => admin.addWatch({ kind: "repo", query: "not a repo" }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "feed", query: "ftp://x" }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "feed", query: "http://localhost/feed.xml" }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "feed", query: "http://10.0.0.5/feed.xml" }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "arxiv-query", query: "x".repeat(2049) }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "arxiv-query", query: "a", cadenceHours: 0.5 }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "arxiv-query", query: "a", cadenceHours: 8761 }), ResearchInputError);
		assert.throws(() => admin.addWatch({ kind: "arxiv-query", query: "a", goalId: "g".repeat(201) }), ResearchInputError);
		assert.equal(admin.listWatchlist().length, 1);
	});

	it("remove refuses an unknown id", () => {
		const { admin } = make();
		admin.addWatch({ kind: "repo", query: "owner/name" });
		admin.removeWatch("watch_1");
		assert.deepEqual(admin.listWatchlist(), []);
		assert.throws(() => admin.removeWatch("watch_1"), ResearchInputError);
	});

	it("readLog takes a limit from 1 to 20", () => {
		const { admin } = make();
		assert.deepEqual(admin.readLog(), []);
		assert.throws(() => admin.readLog(0), ResearchInputError);
		assert.throws(() => admin.readLog(21), ResearchInputError);
	});
});
