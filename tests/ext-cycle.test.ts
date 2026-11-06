// tests/ext-cycle.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CycleBusyError, CycleClockError, runCycle, type CycleDeps } from "../src/core/ext/cycle.ts";
import { deriveMarks, parseFrontierEvent, type FrontierEvent } from "../src/core/ext/frontier.ts";
import { deriveInbox, parseInboxEvent } from "../src/core/ext/inbox.ts";
import { markSpendUsd, parseCycleLogEntry, type CycleLogEntry } from "../src/core/ext/research-log.ts";
import { parseRadarEvent } from "../src/core/ext/watch.ts";
import { DEFAULT_RESEARCH_CONFIG } from "../src/core/ext/research-config.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";
import { fakeDeps, finding, goal, memLog, nodes, chains } from "./helpers/research-fakes.ts";

const src = (locator: string, text = "page text") => ({ locator, title: `T ${locator}`, text });

describe("runCycle", () => {
	it("researches the best gaps, logs one entry with questions, confidence, sources and cost (REQ-rs-10)", async () => {
		const log = memLog<import("../src/core/ext/research-log.ts").CycleLogEntry>();
		const { deps, calls } = fakeDeps({
			log,
			researchGap: async (gap) => (calls0.push(gap.id), finding({ sources: [src("https://a.org/x")], costUsd: 0.2 })),
		});
		const calls0: string[] = [];
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(log.events, [entry]);
		assert.equal(entry.stoppedBy, "completed");
		assert.deepEqual(calls0, ["no-premises:p1", "no-premises:p2"]);
		const g = entry.gaps[0]!;
		assert.deepEqual([g.questions, g.confidence, g.rationale, g.stoppedBy], [["what?"], 0.9, "enough", "confidence"]);
		assert.equal(g.costUsd, 0.2);
		assert.equal(g.sources[0]!.outcome, "inbox"); // not an active source
		assert.equal(entry.costUsd, 0.2 * entry.gaps.length);
		assert.equal(calls.ingested.length, 0);
	});

	it("an active library source is ingested through the notes path and recorded; an unvetted one goes to the inbox (REQ-rs-07, REQ-rs-08)", async () => {
		const inbox = memLog<import("../src/core/ext/inbox.ts").InboxEvent>();
		const { deps, calls } = fakeDeps({
			inbox,
			library: { isActive: (l) => l.startsWith("https://active.org"), activeLocators: () => [], activate: () => {} },
			researchGap: async () => finding({ sources: [src("https://active.org/a"), src("https://other.org/b", "other text")] }),
		});
		const entry = await runCycle(deps, "schedule");
		const gap = entry.gaps[0]!;
		assert.deepEqual(gap.sources.map((s) => [s.locator, s.outcome]), [["https://active.org/a", "ingested"], ["https://other.org/b", "inbox"]]);
		assert.equal(gap.nodesAdded, 3);
		assert.deepEqual(calls.ingested.slice(0, 1), ["https://active.org/a"]);
		const items = deriveInbox(inbox.events);
		assert.deepEqual(items.map((i) => [i.locator, i.status, i.snapshot]), [["https://other.org/b", "pending", "hash:10"]]);
		assert.equal(inbox.events.some((e) => e.type === "ingested" && e.locator === "https://active.org/a" && e.nodesAdded === 3), true);
	});

	it("a rejected source is not proposed again and an ingested one is not ingested twice", async () => {
		const inbox = memLog<import("../src/core/ext/inbox.ts").InboxEvent>([
			{ type: "proposed", locator: "https://bad.org/x", title: "t", gapId: "g", foundBy: "cycle", cycleId: "c", snapshot: "h", at: "t" },
			{ type: "decided", locator: "https://bad.org/x", decision: "rejected", at: "t" },
			{ type: "ingested", locator: "https://active.org/a", nodesAdded: 1, at: "t" },
		]);
		const { deps } = fakeDeps({
			inbox,
			library: { isActive: () => true, activeLocators: () => [], activate: () => {} },
			researchGap: async () => finding({ sources: [src("https://bad.org/x"), src("https://active.org/a")], unfetched: ["https://ghost.org"] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources.map((s) => s.outcome), ["not-fetched", "skipped-rejected", "skipped-seen"]);
		assert.equal(inbox.events.length, 3);
	});

	it("a fetched page whose text is not capturable is logged as not-capturable and never ingested (review rule 3)", async () => {
		const { deps, calls } = fakeDeps({
			researchGap: async () => finding({ notCapturable: ["https://long.org/paper"] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources.map((s) => [s.locator, s.outcome]), [["https://long.org/paper", "not-capturable"]]);
		assert.deepEqual(calls.ingested, []);
		assert.equal(entry.gaps[0]!.nodesAdded, 0);
	});

	it("sources fetched but dropped by the source cap are logged as over-cap, never ingested and never lost (review item 5)", async () => {
		const { deps, calls } = fakeDeps({
			researchGap: async () => finding({ capped: ["https://a.org/2"] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources.map((s) => [s.locator, s.outcome]), [["https://a.org/2", "over-cap"]]);
		assert.deepEqual(calls.ingested, []);
	});

	it("a stop mark excludes its region; a hold mark keeps only verification (REQ-rs-03, REQ-res-02)", async () => {
		const stop: FrontierEvent = { type: "set", markId: "m1", scope: { kind: "goal", id: "goal_1" }, mark: "stop", note: "", author: "user", at: "t" };
		const stopped = fakeDeps({ frontier: memLog([stop]) });
		const e1 = await runCycle(stopped.deps, "manual");
		assert.equal(e1.stoppedBy, "no-gaps");
		assert.deepEqual(stopped.calls.research, []);
		const hold: FrontierEvent = { ...stop, mark: "hold" };
		const trustNone = { trustOf: () => new Map(), verifyNodes: async (ids: readonly string[]) => void held.calls.verified.push([...ids]) };
		const held = fakeDeps({ frontier: memLog([hold]) });
		held.deps.verification = trustNone;
		const e2 = await runCycle(held.deps, "manual");
		assert.deepEqual(held.calls.research, []);
		assert.equal(e2.gaps.every((g) => g.type === "unverified"), true);
		assert.equal(held.calls.verified.length, e2.gaps.length);
	});

	it("the cycle checks the daily ceiling before each ingest: a source that arrives after the ceiling closed is not ingested (REQ-cost-01)", async () => {
		let open = true;
		const { deps, calls } = fakeDeps({
			costGate: { allowed: () => open, record: () => {} },
			library: { isActive: (l) => l.startsWith("https://active.org"), activeLocators: () => [], activate: () => {} },
			researchGap: async () => ((open = false), finding({ sources: [src("https://active.org/late")] })),
		});
		const entry = await runCycle(deps, "schedule");
		assert.deepEqual(calls.ingested, [], "no ingest after the ceiling closed");
		assert.equal(entry.gaps[0]!.sources[0]!.outcome, "failed");
	});

	it("saturation: ingesting fewer than 2 new nodes holds the node, authored by the agent (REQ-rs-06)", async () => {
		const frontier = memLog<FrontierEvent>();
		const { deps } = fakeDeps({
			frontier,
			library: { isActive: () => true, activeLocators: () => [], activate: () => {} },
			ingest: async () => 1,
			researchGap: async () => finding({ sources: [src("https://a.org/x")] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.gaps[0]!.saturated, true);
		const mark = deriveMarks(frontier.events).find((m) => m.scope.id === entry.gaps[0]!.nodeId)!;
		assert.deepEqual([mark.mark, mark.note, mark.author, mark.scope.kind], ["hold", "saturated", "agent", "node"]);
	});

	it("saturation is not declared when enough nodes were added, when nothing was ingested, or over a user mark", async () => {
		const rich = fakeDeps({ library: { isActive: () => true, activeLocators: () => [], activate: () => {} }, ingest: async () => 2, researchGap: async () => finding({ sources: [src("https://a.org/x")] }) });
		assert.equal((await runCycle(rich.deps, "manual")).gaps.some((g) => g.saturated), false);
		const inboxOnly = fakeDeps({ researchGap: async () => finding({ sources: [src("https://a.org/x")] }) });
		assert.equal((await runCycle(inboxOnly.deps, "manual")).gaps.some((g) => g.saturated), false);
		const userMark: FrontierEvent = { type: "set", markId: "mu", scope: { kind: "goal", id: "goal_1" }, mark: "expand", note: "", author: "user", at: "t" };
		const frontier = memLog<FrontierEvent>([userMark]);
		const owned = fakeDeps({ frontier, library: { isActive: () => true, activeLocators: () => [], activate: () => {} }, ingest: async () => 0, researchGap: async () => finding({ sources: [src("https://a.org/x")] }) });
		await runCycle(owned.deps, "manual");
		assert.equal(frontier.events.length, 1);
	});

	it("a source hunt (contested without a primary) never ingests; unvetted sources go to the inbox", async () => {
		const inbox = memLog<import("../src/core/ext/inbox.ts").InboxEvent>();
		const { deps, calls } = fakeDeps({
			inbox,
			graph: () => ({ nodes: [...nodes, { id: "p3", name: "name-p3", statement: "p3" }], chains: [...chains, { premises: ["p3"], conclusion: "p2" }] }),
			verification: { trustOf: () => new Map([["p2", { trust: "contested" as const, hasPrimarySupport: false }]]), verifyNodes: async () => {} },
			library: { isActive: (l) => l === "https://active.org/a", activeLocators: () => [], activate: () => {} },
			researchGap: async (_g, opts) => (assert.equal(opts.sourceHunt, true), finding({ sources: [src("https://active.org/a"), src("https://new.org/b")] })),
		});
		const hunt = (await runCycle({ ...deps, config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 50 } }, "manual")).gaps.find((g) => g.type === "contested-no-primary")!;
		assert.deepEqual(hunt.sources.map((s) => s.outcome), ["skipped-active", "inbox"]);
		assert.equal(calls.ingested.length, 0);
	});

	it("stops at the cost ceiling: before the cycle, and between gaps (REQ-rs-05, REQ-cost-01)", async () => {
		const closed = fakeDeps({ costGate: { allowed: () => false, record: () => {} } });
		const e1 = await runCycle(closed.deps, "manual");
		assert.deepEqual([e1.stoppedBy, e1.gaps.length], ["ceiling", 0]);
		let open = true;
		const mid = fakeDeps({ costGate: { allowed: () => open, record: () => {} }, researchGap: async () => ((open = false), finding()) });
		const e2 = await runCycle(mid.deps, "manual");
		assert.deepEqual([e2.stoppedBy, e2.gaps.length], ["ceiling", 1]);
	});

	it("never plans more than maxGapsPerCycle gaps", async () => {
		const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 } });
		assert.equal((await runCycle(deps, "manual")).gaps.length, 1);
	});

	it("an abort stops before the next gap and is logged", async () => {
		let aborted = false;
		const { deps } = fakeDeps({ isAborted: () => aborted, researchGap: async () => ((aborted = true), finding()) });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.stoppedBy, entry.gaps.length], ["aborted", 1]);
	});

	it("steering: queued messages are handed to the next gap and logged", async () => {
		const queue = ["focus on proofs"];
		const seen: string[][] = [];
		const { deps } = fakeDeps({
			takeSteers: () => queue.splice(0),
			allSteers: () => ["focus on proofs"],
			researchGap: async (_g, opts) => (seen.push(opts.steers), finding()),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(seen[0], ["focus on proofs"]);
		assert.deepEqual(entry.steers, ["focus on proofs"]);
	});

	it("an unconfigured model ends the cycle with an error entry, not a crash", async () => {
		const { deps } = fakeDeps({ researchGap: async () => { throw new ModelsNotConfiguredError(["cheap"]); } });
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "error");
		assert.equal(entry.gaps[0]!.error, "the gap failed");
	});

	it("any other gap error is logged and the cycle continues", async () => {
		let first = true;
		const { deps } = fakeDeps({ researchGap: async () => { if (first) { first = false; throw new Error("boom"); } return finding(); } });
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.gaps[0]!.error, "the gap failed");
		assert.equal(entry.gaps.length > 1, true);
		assert.equal(entry.stoppedBy, "completed");
	});

	it("an uncovered chat is flushed through the extraction pipeline", async () => {
		const { deps, calls } = fakeDeps({ goals: () => [], uncovered: () => [{ chatId: "chat_1", title: "Lesson", messages: 3 }] });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(calls.extracted, ["chat_1"]);
		assert.equal(entry.gaps[0]!.nodesAdded, 2);
		assert.equal(entry.nodesAdded, 2);
	});

	it("the budget spent under a mark is read back from the log: an exhausted budget excludes expansion next cycle", async () => {
		const mark: FrontierEvent = { type: "set", markId: "mb", scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 0.1, note: "", author: "user", at: "t" };
		const log = memLog<import("../src/core/ext/research-log.ts").CycleLogEntry>();
		const first = fakeDeps({ log, frontier: memLog([mark]), researchGap: async () => finding({ costUsd: 0.1 }), config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 } });
		await runCycle(first.deps, "manual");
		const second = fakeDeps({ log, frontier: memLog([mark]) });
		const e2 = await runCycle(second.deps, "manual");
		assert.deepEqual(second.calls.research, []);
		assert.equal(e2.stoppedBy, "no-gaps");
	});
});

describe("runCycle watch", () => {
	const entryDef = { id: "w1", kind: "arxiv-query" as const, query: "gradients", cadenceHours: 24 };
	const item = (id: string, summary = "gradients explained") => ({ id, title: `Paper ${id}`, link: `https://arxiv.org/abs/${id}`, summary });

	it("classifies new items against scope nodes, records the proposal, ingests active sources and inboxes the rest (REQ-rs-12, REQ-rs-13)", async () => {
		const radar = memLog<import("../src/core/ext/watch.ts").RadarEvent>();
		const inbox = memLog<import("../src/core/ext/inbox.ts").InboxEvent>();
		const { deps, calls } = fakeDeps({
			radar,
			inbox,
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1"), item("2")],
			library: { isActive: (l) => l.endsWith("/1"), activeLocators: () => [], activate: () => {} },
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(calls.classified, ["1", "2"]);
		assert.deepEqual(entry.watch, { entries: 1, items: 2, ingested: 1, inbox: 1 });
		const classified = radar.events.filter((e) => e.type === "classified");
		assert.equal(classified.length, 2);
		assert.equal(radar.events.some((e) => e.type === "checked" && e.ok && e.items === 2), true);
		assert.deepEqual(calls.ingested, ["https://arxiv.org/abs/1"]);
		assert.equal(deriveInbox(inbox.events)[0]!.foundBy, "watch");
		assert.equal(entry.nodesAdded, 3);
	});

	it("does not re-classify seen items, and skips entries that are not due", async () => {
		const radar = memLog<import("../src/core/ext/watch.ts").RadarEvent>();
		const { deps, calls } = fakeDeps({ radar, watchlist: { read: () => [entryDef] }, fetchItems: async () => [item("1")] });
		await runCycle(deps, "manual");
		assert.deepEqual(calls.classified, ["1"]);
		await runCycle(deps, "manual"); // just checked: not due again for 24 h
		assert.deepEqual(calls.classified, ["1"]);
	});

	it("an item with no word overlap is ignored without a model call; a failing fetch is recorded", async () => {
		const radar = memLog<import("../src/core/ext/watch.ts").RadarEvent>();
		const { deps, calls } = fakeDeps({ radar, watchlist: { read: () => [entryDef] }, fetchItems: async () => [item("9", "quantum chromodynamics lattices")] });
		await runCycle(deps, "manual");
		assert.deepEqual(calls.classified, []);
		const c = radar.events.find((e) => e.type === "classified")!;
		assert.equal(c.type === "classified" && c.action, "ignore");
		const bad = memLog<import("../src/core/ext/watch.ts").RadarEvent>();
		const failing = fakeDeps({ radar: bad, watchlist: { read: () => [entryDef] }, fetchItems: async () => { throw new Error("offline"); } });
		await runCycle(failing.deps, "manual");
		assert.deepEqual(bad.events.map((e) => e.type === "checked" && e.ok), [false]);
	});

	it("an item the model marks ignore creates neither ingestion nor inbox entry", async () => {
		const { deps, calls } = fakeDeps({
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("3")],
			classify: async () => ({ relation: "unrelated", action: "ignore", rationale: "off topic", nearestNodeIds: [] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.watch.ingested, entry.watch.inbox, calls.ingested.length], [0, 0, 0]);
	});
});

const active = { isActive: () => true, activeLocators: () => [] as string[], activate: () => {} };
type Inbox = import("../src/core/ext/inbox.ts").InboxEvent;
type Radar = import("../src/core/ext/watch.ts").RadarEvent;
const manyNodes = (n: number) => ({
	nodes: [...nodes, ...Array.from({ length: n }, (_, i) => ({ id: `x${i}`, name: `name-x${i}`, statement: `x${i}` }))],
	chains: [{ premises: ["p1", "p2", ...Array.from({ length: n }, (_, i) => `x${i}`)], conclusion: "t" }],
});
const trustAll = (ids: readonly string[]) => new Map(ids.map((id) => [id, { trust: "sourced" as const, hasPrimarySupport: true }]));

describe("runCycle hardening: inbox events", () => {
	it("appends only normalized locators and integer counts, all parseable", async () => {
		const inbox = memLog<Inbox>();
		const { deps } = fakeDeps({
			inbox,
			library: active,
			ingest: async () => 2.7,
			researchGap: async () => finding({ sources: [src("HTTPS://Active.org/a/#frag")] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources, [{ locator: "https://active.org/a", outcome: "ingested", nodesAdded: 0 }]);
		const ev = inbox.events.find((e) => e.type === "ingested")!;
		assert.deepEqual([ev.locator, ev.type === "ingested" && ev.nodesAdded], ["https://active.org/a", 0]);
		for (const e of inbox.events) assert.notEqual(parseInboxEvent(e), null);
	});

	it("a proposal stores a normalized locator; a duplicate spelling in one finding is skipped", async () => {
		const inbox = memLog<Inbox>();
		const { deps } = fakeDeps({ inbox, researchGap: async () => finding({ sources: [src("https://A.org/x"), src("https://a.org/x/")] }) });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources.map((s) => [s.locator, s.outcome]), [["https://a.org/x", "inbox"], ["https://a.org/x", "skipped-seen"]]);
		assert.deepEqual(inbox.events.map((e) => e.locator), ["https://a.org/x"]);
	});

	it("blank locators are dropped and blank text is never ingested nor proposed (the log would reject them)", async () => {
		const { deps, calls } = fakeDeps({
			library: { ...active, isActive: (l) => l.startsWith("https://active") },
			researchGap: async () => finding({ sources: [src(""), src("https://active.org/e", "  "), src("https://other.org/e", ""), src("https://active.org/ok")], unfetched: ["", "https://ghost.org"] }),
		});
		const log = memLog<CycleLogEntry>();
		deps.log = log;
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps[0]!.sources.map((s) => [s.locator, s.outcome]), [
			["https://ghost.org", "not-fetched"],
			["https://active.org/e", "failed"],
			["https://other.org/e", "failed"],
			["https://active.org/ok", "ingested"],
		]);
		assert.deepEqual(calls.ingested, ["https://active.org/ok"]);
		assert.notEqual(parseCycleLogEntry(JSON.parse(JSON.stringify(log.events[0]))), null);
	});

	it("an ingest failure is a failed source and the gap goes on; a snapshot failure is a failed source", async () => {
		let n = 0;
		const { deps } = fakeDeps({
			library: { ...active, isActive: (l) => l.includes("active") },
			ingest: async () => { if (++n === 1) throw new Error("extract failed"); return 3; },
			snapshots: { put: () => { throw new Error("disk"); } },
			researchGap: async () => finding({ sources: [src("https://active.org/1"), src("https://active.org/2"), src("https://other.org/3")] }),
		});
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual(g.sources.map((s) => s.outcome), ["failed", "ingested", "failed"]);
		assert.equal(g.error, undefined);
	});

	it("an ingested-event append failure keeps the gap's nodes and cost; a proposal append failure is a failed source", async () => {
		const inbox = memLog<Inbox>();
		const append = inbox.append;
		inbox.append = (e) => { if (e.type === "proposed") throw new Error("rejected"); append(e); };
		const { deps } = fakeDeps({
			inbox,
			library: { ...active, isActive: (l) => l.includes("active") },
			researchGap: async () => finding({ costUsd: 0.4, sources: [src("https://active.org/1"), src("https://other.org/2")] }),
		});
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual(g.sources.map((s) => s.outcome), ["ingested", "failed"]);
		assert.equal(g.costUsd, 0.4);
	});

	it("never activates a source, never decides, and never ingests model prose", async () => {
		const inbox = memLog<Inbox>();
		const ingestedTexts: string[] = [];
		const snaps: string[] = [];
		let activated = 0;
		const { deps } = fakeDeps({
			inbox,
			library: { isActive: (l) => l.includes("active"), activeLocators: () => [], activate: () => void activated++ },
			ingest: async (s) => (ingestedTexts.push(s.text), 3),
			snapshots: { put: (t) => (snaps.push(t), `h${snaps.length}`) },
			researchGap: async () => finding({ rationale: "MODEL-PROSE", questions: ["MODEL-PROSE?"], sources: [src("https://active.org/1", "fetched A"), src("https://other.org/2", "fetched B")] }),
		});
		await runCycle(deps, "manual");
		assert.equal(activated, 0);
		assert.equal(inbox.events.some((e) => e.type === "decided"), false);
		assert.equal([...ingestedTexts, ...snaps].some((t) => t.includes("MODEL-PROSE")), false);
		assert.deepEqual(ingestedTexts.slice(0, 1), ["fetched A"]);
		assert.equal(snaps[0], "fetched B");
	});
});

describe("runCycle hardening: the log never loses cost", () => {
	it("omits an invalid confidence and zeroes invalid costs; the entry parses and the valid cost survives", async () => {
		const cases: Array<[number, number | undefined]> = [[Number.NaN, undefined], [1.5, undefined], [-0.1, undefined], [Infinity, undefined], [0, 0], [1, 1]];
		for (const [confidence, expected] of cases) {
			const log = memLog<CycleLogEntry>();
			const { deps } = fakeDeps({ log, researchGap: async () => finding({ confidence, costUsd: 0.3 }) });
			const entry = await runCycle(deps, "manual");
			assert.equal(entry.gaps[0]!.confidence, expected, String(confidence));
			assert.equal(entry.gaps[0]!.costUsd, 0.3);
			assert.notEqual(parseCycleLogEntry(JSON.parse(JSON.stringify(log.events[0]))), null);
		}
		for (const bad of [Number.NaN, -1, Infinity, "3" as unknown as number]) {
			const { deps } = fakeDeps({ researchGap: async () => finding({ costUsd: bad }) });
			const e = await runCycle(deps, "manual");
			assert.equal(e.costUsd, 0);
			assert.equal(e.gaps[0]!.costUsd, 0);
		}
	});

	it("drops invalid optional text fields (non-string questions, rationale, stoppedBy) instead of failing", async () => {
		const log = memLog<CycleLogEntry>();
		const { deps } = fakeDeps({
			log,
			researchGap: async () => finding({ questions: ["ok", 3 as unknown as string], rationale: 7 as unknown as string, stoppedBy: "weird" as never, costUsd: 0.5 }),
		});
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual([g.questions, g.rationale, g.stoppedBy, g.costUsd], [["ok"], undefined, undefined, 0.5]);
		assert.notEqual(parseCycleLogEntry(JSON.parse(JSON.stringify(log.events[0]))), null);
	});

	it("a log append that throws is retried with the cost and counts; a log that always throws does not throw out of the cycle", async () => {
		const real = memLog<CycleLogEntry>();
		let tries = 0;
		const flaky = { readAll: real.readAll, append: (e: CycleLogEntry) => { if (++tries === 1) throw new Error("rejected"); real.append(e); } };
		const { deps } = fakeDeps({ log: flaky, researchGap: async () => finding({ costUsd: 0.25 }) });
		const entry = await runCycle(deps, "manual");
		assert.equal(tries, 2);
		assert.equal(real.events[0]!.costUsd, entry.costUsd);
		assert.equal(real.events[0]!.costUsd, 0.5);
		const dead = fakeDeps({ log: { readAll: () => [], append: () => { throw new Error("disk full"); } } });
		assert.equal((await runCycle(dead.deps, "manual")).type, "cycle");
	});

	it("a throw after the finding keeps that gap's cost in the log with the error", async () => {
		const { deps } = fakeDeps({
			library: { ...active, isActive: () => true },
			ingest: async () => { throw new ModelsNotConfiguredError(["cheap"]); },
			researchGap: async () => finding({ costUsd: 0.6, sources: [src("https://a.org/x")] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "error");
		assert.equal(entry.gaps[0]!.costUsd, 0.6);
		assert.equal(entry.gaps[0]!.error, "the gap failed");
		assert.equal(entry.costUsd, 0.6);
	});

	it("a failed research call is logged with the gap's mark and zero cost (documented: the failure's spend is not attributed)", async () => {
		const mark: FrontierEvent = { type: "set", markId: "mx", scope: { kind: "goal", id: "goal_1" }, mark: "expand", note: "", author: "user", at: "t" };
		const { deps } = fakeDeps({ frontier: memLog([mark]), config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => { throw new Error("boom"); } });
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual([g.error, g.costUsd, g.markId], ["the gap failed", 0, "mx"]);
	});

	it("GapLog.stoppedBy and the cycle's stoppedBy are separate: a turn-limit gap does not end the cycle", async () => {
		const { deps } = fakeDeps({ researchGap: async () => finding({ stoppedBy: "turn-limit", confidence: 0 }) });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.stoppedBy, entry.gaps[0]!.stoppedBy], ["completed", "turn-limit"]);
		const failed = fakeDeps({ researchGap: async () => { throw new Error("x"); } });
		const e2 = await runCycle(failed.deps, "manual");
		assert.deepEqual([e2.stoppedBy, e2.gaps[0]!.stoppedBy], ["completed", undefined]);
	});

	it("endedAt is never before startedAt, even when the clock runs backwards or breaks", async () => {
		const times = [new Date("2026-11-04T12:00:00.000Z"), new Date("2026-11-04T11:00:00.000Z"), new Date(Number.NaN)];
		let i = 0;
		const { deps } = fakeDeps({ now: () => times[Math.min(i++, times.length - 1)]! });
		const entry = await runCycle(deps, "manual");
		assert.equal(Date.parse(entry.endedAt) >= Date.parse(entry.startedAt), true);
		assert.notEqual(parseCycleLogEntry(JSON.parse(JSON.stringify(entry))), null);
	});

	it("a broken clock at the start fails closed: nothing runs, nothing is logged", async () => {
		const log = memLog<CycleLogEntry>();
		const { deps, calls } = fakeDeps({ log, now: () => new Date(Number.NaN) });
		await assert.rejects(runCycle(deps, "manual"), CycleClockError);
		assert.deepEqual([log.events.length, calls.research.length], [0, 0]);
	});
});

describe("runCycle hardening: bounds, gate and concurrency", () => {
	it("passes maxTurnsPerGap to the researcher and falls back to the default for an invalid one", async () => {
		const seen: number[] = [];
		const run = (maxTurnsPerGap: number) => fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1, maxTurnsPerGap }, researchGap: async (_g, o) => (seen.push(o.maxTurns), finding()) }).deps;
		await runCycle(run(7), "manual");
		await runCycle(run(Number.NaN), "manual");
		await runCycle(run(0), "manual");
		assert.deepEqual(seen, [7, 20, 20]);
	});

	it("an invalid maxGapsPerCycle never means unbounded", async () => {
		for (const bad of [Number.NaN, Infinity, 1.5, -1]) {
			const { deps } = fakeDeps({ graph: () => manyNodes(12), verification: { trustOf: trustAll, verifyNodes: async () => {} }, config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: bad } });
			const n = (await runCycle(deps, "manual")).gaps.length;
			assert.equal(n <= DEFAULT_RESEARCH_CONFIG.maxGapsPerCycle, true, String(bad));
		}
	});

	it("looks at no more than 10 new items per watch entry", async () => {
		const items = Array.from({ length: 15 }, (_, i) => ({ id: `i${i}`, title: `Paper ${i}`, link: `https://arxiv.org/abs/${i}`, summary: "gradients explained" }));
		const { deps, calls } = fakeDeps({ watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "q", cadenceHours: 24 }] }, fetchItems: async () => items });
		const entry = await runCycle(deps, "manual");
		assert.equal(calls.classified.length, 10);
		assert.equal(entry.watch.items, 10);
	});

	it("a cost gate that throws counts as closed; an abort check that throws counts as aborted", async () => {
		const gate = fakeDeps({ costGate: { allowed: () => { throw new Error("db"); }, record: () => {} } });
		const e1 = await runCycle(gate.deps, "manual");
		assert.deepEqual([e1.stoppedBy, e1.gaps.length], ["ceiling", 0]);
		const ab = fakeDeps({ isAborted: () => { throw new Error("x"); } });
		assert.equal((await runCycle(ab.deps, "manual")).stoppedBy, "aborted");
	});

	it("a gate that closes ends the watch phase too, and no model call is made", async () => {
		let open = true;
		const { deps, calls } = fakeDeps({
			goals: () => [],
			uncovered: () => [],
			costGate: { allowed: () => open, record: () => {} },
			watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "q", cadenceHours: 24 }] },
			fetchItems: async () => (open = false, [{ id: "1", title: "t", link: "https://arxiv.org/abs/1", summary: "gradients" }]),
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "ceiling");
		assert.deepEqual(calls.classified, []);
	});

	it("two overlapping cycles on one log do not both run; the guard is released afterwards and after a failure", async () => {
		const log = memLog<CycleLogEntry>();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = fakeDeps({ log, researchGap: async () => (await gate, finding()) });
		const p1 = runCycle(first.deps, "manual");
		const second = fakeDeps({ log });
		await assert.rejects(runCycle(second.deps, "schedule"), CycleBusyError);
		assert.deepEqual(second.calls.research, []);
		release();
		await p1;
		assert.equal(log.events.length, 1);
		await runCycle(second.deps, "manual");
		assert.equal(log.events.length, 2);
		const broken = fakeDeps({ log, now: () => new Date(Number.NaN) });
		await assert.rejects(runCycle(broken.deps, "manual"), CycleClockError);
		await runCycle(second.deps, "manual"); // not stuck busy
		assert.equal(log.events.length, 3);
	});

	it("cycles on different logs may run together", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const a = fakeDeps({ researchGap: async () => (await gate, finding()) });
		const p = runCycle(a.deps, "manual");
		const b = fakeDeps();
		await runCycle(b.deps, "manual");
		release();
		await p;
	});

	it("a thrown error in a gap does not lose the log entry or abort the cycle (verification and extraction too)", async () => {
		const log = memLog<CycleLogEntry>();
		const { deps } = fakeDeps({
			log,
			goals: () => [],
			uncovered: () => [{ chatId: "c1", title: "a", messages: 1 }, { chatId: "c2", title: "b", messages: 1 }],
			extractChat: async (id) => { if (id === "c1") throw new Error("extract boom"); return 4; },
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.gaps.map((g) => [g.gapId, g.error, g.nodesAdded]), [["uncovered:c1", "the gap failed", 0], ["uncovered:c2", undefined, 4]]);
		assert.deepEqual(log.events, [entry]);
		const v = fakeDeps({ verification: { trustOf: () => new Map(), verifyNodes: async () => { throw new Error("verify boom"); } } });
		const e2 = await runCycle(v.deps, "manual");
		assert.deepEqual(e2.gaps.filter((g) => g.type === "unverified").map((g) => g.error), ["the gap failed"]);
		assert.equal(e2.gaps.length > 1, true);
	});

	it("an error before any gap (graph unreadable) still produces a logged error entry", async () => {
		const log = memLog<CycleLogEntry>();
		const { deps } = fakeDeps({ log, graph: () => { throw new Error("graph gone"); } });
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "error");
		assert.equal(entry.gaps[0]!.error, "the cycle failed");
		assert.doesNotMatch(JSON.stringify(entry), /graph gone/);
		assert.deepEqual(log.events, [entry]);
	});

	it("steering messages are drained only for gaps that actually run; invalid steers are not logged", async () => {
		const queue = ["a", "b"];
		let drains = 0;
		const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, takeSteers: () => (drains++, queue.splice(0)), allSteers: () => ["a", 3 as unknown as string] });
		const entry = await runCycle(deps, "manual");
		assert.equal(drains, 1);
		assert.deepEqual(entry.steers, ["a"]);
		let d2 = 0;
		const closed = fakeDeps({ costGate: { allowed: () => false, record: () => {} }, takeSteers: () => (d2++, []) });
		await runCycle(closed.deps, "manual");
		assert.equal(d2, 0);
	});
});

describe("runCycle hardening: marks", () => {
	it("a stop mark set by the user during the cycle excludes the remaining gaps of its region", async () => {
		const frontier = memLog<FrontierEvent>();
		const { deps, calls } = fakeDeps({
			frontier,
			researchGap: async (g) => (calls0.push(g.id), frontier.append({ type: "set", markId: "late", scope: { kind: "goal", id: "goal_1" }, mark: "stop", note: "", author: "user", at: "t" }), finding()),
		});
		const calls0: string[] = [];
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(calls0, ["no-premises:p1"]);
		assert.equal(entry.gaps.length, 1);
		assert.equal(calls.research.length, 0);
	});

	it("the budget of a mark counts the spend of earlier gaps in the same cycle", async () => {
		const mark: FrontierEvent = { type: "set", markId: "mb", scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 0.1, note: "", author: "user", at: "t" };
		const ids: string[] = [];
		const { deps } = fakeDeps({ frontier: memLog([mark]), researchGap: async (g) => (ids.push(g.id), finding({ costUsd: 0.1 })) });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(ids, ["no-premises:p1"]);
		assert.equal(entry.gaps.length, 1);
	});

	it("an exhausted budget degrades expand to hold: verification still runs, expansion does not", async () => {
		const mark: FrontierEvent = { type: "set", markId: "mb", scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 0.1, note: "", author: "user", at: "t" };
		const log = memLog<CycleLogEntry>();
		const first = fakeDeps({ log, frontier: memLog([mark]), config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => finding({ costUsd: 0.1 }) });
		await runCycle(first.deps, "manual");
		const second = fakeDeps({ log, frontier: memLog([mark]), verification: { trustOf: () => new Map(), verifyNodes: async () => {} } });
		const e2 = await runCycle(second.deps, "manual");
		assert.deepEqual(second.calls.research, []);
		assert.equal(e2.gaps.length > 0 && e2.gaps.every((g) => g.type === "unverified"), true);
	});

	it("the saturation mark is parseable, scoped to the node, and makes the next cycle skip that node", async () => {
		const frontier = memLog<FrontierEvent>();
		const log = memLog<CycleLogEntry>();
		const ids: string[] = [];
		const mk = () => fakeDeps({ frontier, log, library: active, ingest: async () => 0, researchGap: async (g) => (ids.push(g.id), finding({ sources: [src(`https://a.org/${g.id}`)] })) }).deps;
		await runCycle(mk(), "manual");
		assert.deepEqual(ids, ["no-premises:p1", "no-premises:p2"]);
		assert.deepEqual(frontier.events.map((e) => e.markId), ["mark_saturated_p1", "mark_saturated_p2"]);
		for (const e of frontier.events) assert.notEqual(parseFrontierEvent(e), null);
		await runCycle(mk(), "manual");
		assert.deepEqual(ids, ["no-premises:p1", "no-premises:p2"]); // held: nothing researched again
	});

	it("saturation does not override a user mark that governs only the node; a user hold on the node is kept", async () => {
		const userNode: FrontierEvent = { type: "set", markId: "un", scope: { kind: "node", id: "p1" }, mark: "expand", note: "", author: "user", at: "t" };
		const frontier = memLog<FrontierEvent>([userNode]);
		const { deps } = fakeDeps({ frontier, library: active, ingest: async () => 0, researchGap: async (g) => finding({ sources: [src(`https://a.org/${g.id}`)] }) });
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.gaps.find((g) => g.nodeId === "p1")!.saturated, false);
		assert.equal(entry.gaps.find((g) => g.nodeId === "p2")!.saturated, true);
		assert.deepEqual(frontier.events.map((e) => e.markId), ["un", "mark_saturated_p2"]);
	});

	it("a source hunt (contested) never saturates", async () => {
		const frontier = memLog<FrontierEvent>();
		const { deps } = fakeDeps({
			frontier,
			verification: { trustOf: () => new Map([["p2", { trust: "contested" as const, hasPrimarySupport: false }]]), verifyNodes: async () => {} },
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 50 },
			library: active,
			researchGap: async (g, o) => finding({ sources: o.sourceHunt ? [src("https://hunt.org/a")] : [] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.gaps.some((g) => g.type === "contested-no-primary" && g.saturated), false);
		assert.equal(frontier.events.length, 0);
	});

	it("watch ingestion respects marks: a stopped region is not fetched, classified or ingested", async () => {
		const stop: FrontierEvent = { type: "set", markId: "s", scope: { kind: "goal", id: "goal_1" }, mark: "stop", note: "", author: "user", at: "t" };
		let fetched = 0;
		const { deps, calls } = fakeDeps({
			frontier: memLog([stop]),
			watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "q", cadenceHours: 24 }] },
			fetchItems: async () => (fetched++, [{ id: "1", title: "gradients", link: "https://arxiv.org/abs/1", summary: "gradients" }]),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([fetched, calls.classified, calls.ingested, entry.watch.entries], [0, [], [], 0]);
	});
});

describe("runCycle hardening: watch", () => {
	const entryDef = { id: "w1", kind: "arxiv-query" as const, query: "gradients", cadenceHours: 24 };
	const item = (id: string) => ({ id, title: `Paper ${id}`, link: `https://arxiv.org/abs/${id}`, summary: "gradients explained" });

	it("seen items are scoped per watch entry: the same item id under another entry is still classified", async () => {
		const radar = memLog<Radar>([{ type: "classified", entryId: "w0", itemId: "1", title: "t", link: "https://x.org/1", nearestNodeIds: [], relation: "unrelated", action: "ignore", rationale: "", at: "2026-11-01T00:00:00.000Z" }]);
		const { deps, calls } = fakeDeps({ radar, watchlist: { read: () => [entryDef] }, fetchItems: async () => [item("1")] });
		await runCycle(deps, "manual");
		assert.deepEqual(calls.classified, ["1"]);
		await runCycle(deps, "manual");
		const again = fakeDeps({ radar, watchlist: { read: () => [{ ...entryDef, cadenceHours: 0.001 }] }, fetchItems: async () => [item("1")], now: () => new Date("2026-11-05T12:00:00.000Z") });
		await runCycle(again.deps, "manual");
		assert.deepEqual(again.calls.classified, []); // seen under w1
	});

	it("the radar uses instants, not strings: an offset timestamp inside the cadence is not due", async () => {
		const radar = memLog<Radar>([{ type: "checked", entryId: "w1", ok: true, items: 0, at: "2026-11-04T12:30:00+02:00" }]); // 10:30Z, 90 min before now
		const { deps } = fakeDeps({ radar, watchlist: { read: () => [{ ...entryDef, cadenceHours: 2 }] }, fetchItems: async () => [item("1")] });
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.watch.entries, 0);
	});

	it("a model verdict is sanitized before it is written: bad relation, action and foreign node ids", async () => {
		const radar = memLog<Radar>();
		const { deps } = fakeDeps({
			radar,
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1")],
			classify: async () => ({ relation: "bogus" as never, action: "INGEST" as never, rationale: 4 as never, nearestNodeIds: ["p1", "zzz", 3 as never] }),
		});
		const entry = await runCycle(deps, "manual");
		const c = radar.events.find((e) => e.type === "classified")!;
		assert.notEqual(parseRadarEvent(c), null);
		assert.deepEqual(c.type === "classified" && [c.relation, c.action, c.rationale, c.nearestNodeIds], ["unrelated", "ignore", "", ["p1"]]);
		assert.equal(entry.watch.ingested, 0);
	});

	it("a failing classifier call for one item is not recorded and does not stop the other items", async () => {
		const radar = memLog<Radar>();
		const { deps } = fakeDeps({
			radar,
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1"), item("2")],
			classify: async (i) => { if (i.id === "1") throw new Error("llm down"); return { relation: "extends", action: "ignore", rationale: "r", nearestNodeIds: [] }; },
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(radar.events.filter((e) => e.type === "classified").map((e) => e.type === "classified" && e.itemId), ["2"]);
		assert.equal(entry.stoppedBy, "completed");
	});

	it("a failed classification still counts the spend it carried (non-config error: the item is retried)", async () => {
		const { deps } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1")],
			classify: async () => { throw Object.assign(new Error("watch classification failed"), { costUsd: 0.5 }); },
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.costUsd, 0.5);
		assert.notEqual(entry.stoppedBy, "error");
	});

	it("a config error during classification still counts its spend before the cycle stops", async () => {
		const { deps } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1")],
			classify: async () => { throw Object.assign(new ModelsNotConfiguredError(["cheap"]), { costUsd: 0.5 }); },
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "error");
		assert.equal(entry.costUsd, 0.5);
	});

	it("a missing model during classification ends the cycle with an error entry", async () => {
		const { deps } = fakeDeps({
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [item("1")],
			classify: async () => { throw new ModelsNotConfiguredError(["cheap"]); },
		});
		assert.equal((await runCycle(deps, "manual")).stoppedBy, "error");
	});

	it("watch sources are normalized, ingested only from active libraries, and carry foundBy watch", async () => {
		const inbox = memLog<Inbox>();
		const { deps } = fakeDeps({
			inbox,
			watchlist: { read: () => [entryDef] },
			fetchItems: async () => [{ ...item("1"), link: "https://ArXiv.org/abs/1/" }],
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.watch.inbox, 1);
		const p = deriveInbox(inbox.events)[0]!;
		assert.deepEqual([p.locator, p.foundBy, p.gapId], ["https://arxiv.org/abs/1", "watch", "watch:w1"]);
	});
});

describe("runCycle review fixes: bounded work", () => {
	const wEntry = (id: string) => ({ id, kind: "arxiv-query" as const, query: "gradients", cadenceHours: 24 });
	const checked = (entryId: string, at: string): Radar => ({ type: "checked", entryId, ok: true, items: 0, at });

	it("runs at most maxWatchEntriesPerCycle due entries, oldest-checked first, ties in list order", async () => {
		const radar = memLog<Radar>([
			checked("w0", "2026-11-01T00:00:00.000Z"),
			checked("w1", "2026-11-02T00:00:00.000Z"),
			checked("w2", "2026-11-03T00:00:00.000Z"),
			checked("w4", "2026-10-31T00:00:00.000Z"),
			checked("w5", "2026-11-03T06:00:00.000Z"),
			checked("w6", "2026-10-30T00:00:00.000Z"),
			checked("w7", "2026-10-29T00:00:00.000Z"),
		]);
		const ran: string[] = [];
		const ids = ["w0", "w1", "w2", "w3", "w3b", "w4", "w5", "w6", "w7"];
		const { deps } = fakeDeps({ radar, watchlist: { read: () => ids.map(wEntry) }, fetchItems: async (e) => (ran.push(e.id), []) });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(ran, ["w3", "w3b", "w7", "w6", "w4"]);
		assert.equal(entry.watch.entries, 5);
	});

	it("an invalid maxWatchEntriesPerCycle falls back to the default; 0 runs no watch entry; skipped entries do not use the cap", async () => {
		for (const bad of [Number.NaN, Infinity, -1, 1.5]) {
			const ran: string[] = [];
			const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxWatchEntriesPerCycle: bad }, watchlist: { read: () => ["a", "b", "c", "d", "e", "f", "g"].map(wEntry) }, fetchItems: async (e) => (ran.push(e.id), []) });
			await runCycle(deps, "manual");
			assert.equal(ran.length, 5, String(bad));
		}
		const none = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxWatchEntriesPerCycle: 0 }, watchlist: { read: () => [wEntry("a")] }, fetchItems: async () => { throw new Error("must not run"); } });
		assert.equal((await runCycle(none.deps, "manual")).watch.entries, 0);
		// an entry whose region is stopped is skipped without using the cap
		const ran: string[] = [];
		const entries = [{ ...wEntry("dead"), goalId: "goal_x" }, { ...wEntry("live1") }, { ...wEntry("live2") }];
		const stop: FrontierEvent = { type: "set", markId: "sx", scope: { kind: "goal", id: "goal_x" }, mark: "stop", note: "", author: "user", at: "t" };
		const extra = [...nodes, { id: "u", name: "name-u", statement: "u" }];
		const one = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxWatchEntriesPerCycle: 2 }, frontier: memLog([stop]), graph: () => ({ nodes: extra, chains }), watchlist: { read: () => entries }, goals: () => [goal(), goal({ id: "goal_x", targetNodeIds: ["u"] })], fetchItems: async (e) => (ran.push(e.id), []) });
		await runCycle(one.deps, "manual");
		assert.deepEqual(ran, ["live1", "live2"]);
	});

	it("caps sources and unfetched locators per gap and reads the inbox once per gap (5000 sources)", async () => {
		const inbox = memLog<Inbox>();
		let reads = 0;
		const counting = { append: inbox.append, readAll: () => (reads++, inbox.readAll()) };
		let snaps = 0;
		const sources = Array.from({ length: 5000 }, (_, i) => src(`https://s${i}.org/p`));
		const unfetched = Array.from({ length: 5000 }, (_, i) => `https://u${i}.org/p`);
		const { deps } = fakeDeps({
			inbox: counting,
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 },
			snapshots: { put: (t) => (snaps++, `h${t.length}`) },
			researchGap: async () => finding({ sources, unfetched }),
		});
		const t0 = performance.now();
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.equal(performance.now() - t0 < 1000, true);
		assert.equal(snaps <= 20, true);
		assert.equal(g.sources.filter((s) => s.outcome === "inbox").length, 20);
		assert.equal(g.sources.filter((s) => s.outcome === "not-fetched").length, 20);
		assert.equal(reads <= 1, true);
	});

	it("maxSourcesPerGap is configurable; an invalid value falls back to 20", async () => {
		const many = Array.from({ length: 30 }, (_, i) => src(`https://s${i}.org/p`));
		const run = (maxSourcesPerGap: number) => fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1, maxSourcesPerGap }, researchGap: async () => finding({ sources: many }) }).deps;
		assert.equal((await runCycle(run(3), "manual")).gaps[0]!.sources.length, 3);
		assert.equal((await runCycle(run(0), "manual")).gaps[0]!.sources.length, 0);
		assert.equal((await runCycle(run(Number.NaN), "manual")).gaps[0]!.sources.length, 20);
	});

	it("the inbox decisions made earlier in the same gap still apply with one read (a proposal is not repeated)", async () => {
		const inbox = memLog<Inbox>();
		const { deps } = fakeDeps({ inbox, config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => finding({ sources: [src("https://a.org/x"), src("https://a.org/x"), src("https://b.org/y")] }) });
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual(g.sources.map((s) => s.outcome), ["inbox", "skipped-seen", "inbox"]);
		assert.equal(inbox.events.length, 2);
	});
});

describe("runCycle review fixes: cost of failures", () => {
	const failing = (costUsd: unknown) => Object.assign(new Error("research failed"), { costUsd });

	it("a failed research call keeps the cost its error carries, in the gap, the entry and the mark's spend", async () => {
		const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => { throw failing(0.3); } });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.gaps[0]!.error, entry.gaps[0]!.costUsd, entry.costUsd], ["the gap failed", 0.3, 0.3]);
		assert.equal(markSpendUsd([entry]).size, 0); // no mark in force here
		const mark: FrontierEvent = { type: "set", markId: "mf", scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 0.1, note: "", author: "user", at: "t" };
		const ids: string[] = [];
		const budget = fakeDeps({ frontier: memLog([mark]), researchGap: async (g) => (ids.push(g.id), Promise.reject(failing(0.1))) });
		const e2 = await runCycle(budget.deps, "manual");
		assert.deepEqual(ids, ["no-premises:p1"]);
		assert.equal(markSpendUsd([e2]).get("mf"), 0.1);
	});

	it("the cost an error carries is sanitized: only finite numbers >= 0 count", async () => {
		for (const bad of [Number.NaN, -1, Infinity, "3", null, undefined]) {
			const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => { throw failing(bad); } });
			const entry = await runCycle(deps, "manual");
			assert.equal(entry.costUsd, 0, String(bad));
		}
		const plain = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, researchGap: async () => { throw "just a string"; } });
		assert.equal((await runCycle(plain.deps, "manual")).costUsd, 0);
	});

	it("classify may report a cost; it is summed (sanitized) into the cycle's cost", async () => {
		const item = (id: string) => ({ id, title: `Paper ${id}`, link: `https://arxiv.org/abs/${id}`, summary: "gradients explained" });
		const costs: unknown[] = [0.25, Number.NaN, -1, 0.5];
		let i = 0;
		const { deps } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "q", cadenceHours: 24 }] },
			fetchItems: async () => ["1", "2", "3", "4"].map(item),
			classify: async () => ({ relation: "extends", action: "ignore", rationale: "r", nearestNodeIds: [], costUsd: costs[i++] as number }),
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.costUsd, 0.75);
		assert.equal(entry.gaps.length, 0);
	});
});

describe("runCycle review fixes: busy guard by lock key", () => {
	it("two cycles with different log objects but the same lockKey do not both run; different keys may; released afterwards", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = fakeDeps({ researchGap: async () => (await gate, finding()) });
		first.deps.lockKey = "/data/ext";
		const p1 = runCycle(first.deps, "manual");
		const same = fakeDeps();
		same.deps.lockKey = "/data/ext";
		await assert.rejects(runCycle(same.deps, "schedule"), CycleBusyError);
		assert.deepEqual(same.calls.research, []);
		const other = fakeDeps();
		other.deps.lockKey = "/data/other";
		await runCycle(other.deps, "manual");
		const nokey = fakeDeps();
		await runCycle(nokey.deps, "manual");
		release();
		await p1;
		await runCycle(same.deps, "manual"); // released
	});

	it("the lock key is released after a failure too", async () => {
		const broken = fakeDeps({ now: () => new Date(Number.NaN) });
		broken.deps.lockKey = "k";
		await assert.rejects(runCycle(broken.deps, "manual"), CycleClockError);
		const ok = fakeDeps();
		ok.deps.lockKey = "k";
		await runCycle(ok.deps, "manual");
	});
});

describe("runCycle review fixes: minor", () => {
	it("steers are taken only for research gaps, not for extraction or verification", async () => {
		let drains = 0;
		const { deps, calls } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 50 },
			verification: { trustOf: () => new Map(), verifyNodes: async () => {} },
			uncovered: () => [{ chatId: "c1", title: "a", messages: 1 }],
			takeSteers: () => (drains++, []),
			researchGap: async (g) => (calls.research.push(g.id), finding()),
		});
		const entry = await runCycle(deps, "manual");
		const types = new Set(entry.gaps.map((g) => g.type));
		assert.equal(types.has("uncovered") && types.has("unverified"), true);
		assert.equal(calls.research.length > 0, true);
		assert.equal(drains, calls.research.length);
	});

	it("an active source met in a source hunt is skipped-active, not skipped-seen", async () => {
		const { deps } = fakeDeps({
			graph: () => ({ nodes: [...nodes, { id: "p3", name: "name-p3", statement: "p3" }], chains: [...chains, { premises: ["p3"], conclusion: "p2" }] }),
			verification: { trustOf: () => new Map([["p2", { trust: "contested" as const, hasPrimarySupport: false }]]), verifyNodes: async () => {} },
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 50 },
			library: { isActive: (l) => l === "https://active.org/a", activeLocators: () => [], activate: () => {} },
			researchGap: async (_g, o) => finding({ sources: o.sourceHunt ? [src("https://active.org/a")] : [] }),
		});
		const hunt = (await runCycle(deps, "manual")).gaps.find((g) => g.type === "contested-no-primary")!;
		assert.deepEqual(hunt.sources.map((s) => s.outcome), ["skipped-active"]);
	});

	it("the watch does not run after the cycle ended with an error", async () => {
		let fetched = 0;
		const { deps } = fakeDeps({
			researchGap: async () => { throw new ModelsNotConfiguredError(["cheap"]); },
			watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "q", cadenceHours: 24 }] },
			fetchItems: async () => (fetched++, []),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.stoppedBy, fetched, entry.watch.entries], ["error", 0, 0]);
	});
});

describe("runCycle review fixes: steering close, abort and fixed labels", () => {
	const watchEntry = { id: "w1", kind: "arxiv-query" as const, query: "gradients", cadenceHours: 24 };
	const feedItem = { id: "i1", title: "Gradients paper", link: "https://arxiv.org/abs/i1", summary: "gradients explained" };
	const oneGap = { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 };

	it("onGapsDone runs once, after the last research gap and before the watch", async () => {
		const order: string[] = [];
		const { deps } = fakeDeps({
			config: oneGap,
			researchGap: async () => (order.push("gap"), finding()),
			onGapsDone: () => void order.push("gaps-done"),
			watchlist: { read: () => [watchEntry] },
			fetchItems: async () => (order.push("fetch"), []),
		});
		await runCycle(deps, "manual");
		assert.deepEqual(order, ["gap", "gaps-done", "fetch"]);
	});

	it("onGapsDone runs once even when the cycle stops before any gap", async () => {
		let calls = 0;
		const { deps } = fakeDeps({ isAborted: () => true, onGapsDone: () => void calls++ });
		assert.equal((await runCycle(deps, "manual")).stoppedBy, "aborted");
		assert.equal(calls, 1);
	});

	it("a throwing onGapsDone hook does not break the cycle", async () => {
		const { deps } = fakeDeps({
			config: oneGap,
			onGapsDone: () => {
				throw new Error("hook");
			},
		});
		assert.equal((await runCycle(deps, "manual")).stoppedBy, "completed");
	});

	it("an abort called right after the cycle starts runs no research gap (researchGap is called zero times)", async () => {
		let aborted = false;
		let calls = 0;
		const { deps } = fakeDeps({ isAborted: () => aborted, researchGap: async () => (calls++, finding()) });
		const pending = runCycle(deps, "manual");
		aborted = true;
		const entry = await pending;
		assert.deepEqual([calls, entry.stoppedBy, entry.gaps.length], [0, "aborted", 0]);
	});

	it("a gap error keeps a fixed label in the log; the raw text goes only to onError", async () => {
		const seen: unknown[] = [];
		const { deps } = fakeDeps({
			config: oneGap,
			onError: (e: unknown) => void seen.push(e),
			researchGap: async () => {
				throw new Error("secret detail");
			},
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.gaps[0]!.error, "the gap failed");
		assert.doesNotMatch(JSON.stringify(entry), /secret/);
		assert.deepEqual(seen.map((e) => (e as Error).message), ["secret detail"]);
	});

	it("a config error in the watch is logged with the fixed watch label, not the raw text", async () => {
		const { deps } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			watchlist: { read: () => [watchEntry] },
			fetchItems: async () => [feedItem],
			classify: async () => {
				throw new ModelsNotConfiguredError(["cheap"]);
			},
		});
		const entry = await runCycle(deps, "manual");
		assert.equal(entry.stoppedBy, "error");
		assert.ok(entry.gaps.some((g) => g.error === "the watch failed"));
		assert.doesNotMatch(JSON.stringify(entry), /No model configured/);
	});
});

describe("runCycle mutation survivors", () => {
	const item = (id: string) => ({ id, title: `Paper ${id}`, link: `https://arxiv.org/abs/${id}`, summary: "gradients explained" });
	const w1 = { id: "w1", kind: "arxiv-query" as const, query: "q", cadenceHours: 24 };
	const gradientNodes = (ids: string[]) => ids.map((id) => ({ id, name: `name-${id}`, statement: `Statement of ${id} about gradients.` }));

	it("maxGapsPerCycle 0 runs no gap", async () => {
		const { deps, calls } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 } });
		const entry = await runCycle(deps, "manual");
		assert.deepEqual([entry.gaps.length, calls.research.length, entry.stoppedBy], [0, 0, "no-gaps"]);
	});

	it("budget spent by earlier cycles counts together with this cycle's gaps", async () => {
		const mark: FrontierEvent = { type: "set", markId: "mb", scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 0.1, note: "", author: "user", at: "t" };
		const prior: CycleLogEntry = {
			type: "cycle", cycleId: "old", trigger: "manual", startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T00:01:00.000Z", stoppedBy: "completed",
			gaps: [{ gapId: "g", type: "no-premises", markId: "mb", questions: [], sources: [], nodesAdded: 0, costUsd: 0.06, saturated: false }],
			watch: { entries: 0, items: 0, ingested: 0, inbox: 0 }, nodesAdded: 0, costUsd: 0.06, steers: [],
		};
		const ids: string[] = [];
		const { deps } = fakeDeps({ log: memLog([prior]), frontier: memLog([mark]), researchGap: async (g) => (ids.push(g.id), finding({ costUsd: 0.05 })) });
		await runCycle(deps, "manual");
		assert.deepEqual(ids, ["no-premises:p1"]); // 0.06 + 0.05 >= 0.1: the second gap is excluded
	});

	it("an active check accepts the raw locator or the normalized one", async () => {
		const { deps, calls } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 },
			library: { isActive: (l) => l === "HTTPS://Active.org/a/#frag" || l === "https://active.org/b", activeLocators: () => [], activate: () => {} },
			researchGap: async () => finding({ sources: [src("HTTPS://Active.org/a/#frag"), src("HTTPS://Active.org/b/")] }),
		});
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual(g.sources.map((s) => s.outcome), ["ingested", "ingested"]);
		assert.deepEqual(calls.ingested, ["https://active.org/a", "https://active.org/b"]);
	});

	it("non-string steers are filtered before they reach the researcher", async () => {
		const seen: string[][] = [];
		const { deps } = fakeDeps({ config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, takeSteers: () => ["a", 3, null] as unknown as string[], researchGap: async (_g, o) => (seen.push(o.steers), finding()) });
		await runCycle(deps, "manual");
		assert.deepEqual(seen, [["a"]]);
	});

	it("when the first log append throws, the retry carries no steers or optional text but keeps cost, counts and sources", async () => {
		const real = memLog<CycleLogEntry>();
		let tries = 0;
		const flaky = { readAll: real.readAll, append: (e: CycleLogEntry) => { if (++tries === 1) throw new Error("rejected"); real.append(e); } };
		const { deps } = fakeDeps({
			log: flaky,
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 },
			allSteers: () => ["steer me"],
			researchGap: async () => finding({ costUsd: 0.25, questions: ["q?"], sources: [src("https://a.org/x")] }),
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(entry.steers, ["steer me"]);
		const saved = real.events[0]!;
		assert.deepEqual([saved.steers, saved.costUsd, saved.gaps[0]!.questions, saved.gaps[0]!.costUsd], [[], 0.25, [], 0.25]);
		assert.deepEqual([saved.gaps[0]!.confidence, saved.gaps[0]!.rationale, saved.gaps[0]!.sources.length], [undefined, undefined, 1]);
	});

	it("watch scope: only active goals count, and an entry's goalId narrows it to that goal", async () => {
		const gnodes = gradientNodes(["t", "p1", "p2", "u", "u1"]);
		const gchains = [{ premises: ["p1", "p2"], conclusion: "t" }, { premises: ["u1"], conclusion: "u" }];
		const cand: string[][] = [];
		const base = {
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			graph: () => ({ nodes: gnodes, chains: gchains }),
			fetchItems: async () => [item("1")],
			classify: async (_i: unknown, c: Array<{ id: string }>) => (cand.push(c.map((n) => n.id).sort()), { relation: "extends" as const, action: "ignore" as const, rationale: "", nearestNodeIds: [] }),
		};
		// goal_2 is paused: its nodes are not in scope
		await runCycle(fakeDeps({ ...base, goals: () => [goal(), goal({ id: "goal_2", status: "paused", targetNodeIds: ["u"] })], watchlist: { read: () => [w1] } }).deps, "manual");
		assert.deepEqual(cand, [["p1", "p2", "t"]]);
		// a goal-scoped entry only compares against that goal
		cand.length = 0;
		await runCycle(fakeDeps({ ...base, goals: () => [goal(), goal({ id: "goal_2", targetNodeIds: ["u"] })], watchlist: { read: () => [{ ...w1, goalId: "goal_2" }] } }).deps, "manual");
		assert.deepEqual(cand, [["u", "u1"]]);
		// a goal-scoped entry whose goal is paused has nothing to compare against: no model call
		cand.length = 0;
		await runCycle(fakeDeps({ ...base, goals: () => [goal(), goal({ id: "goal_2", status: "paused", targetNodeIds: ["u"] })], watchlist: { read: () => [{ ...w1, goalId: "goal_2" }] } }).deps, "manual");
		assert.deepEqual(cand, []);
	});

	it("at most 30 candidate nodes are handed to the classifier", async () => {
		const ids = Array.from({ length: 45 }, (_, i) => `n${i}`);
		let seen = -1;
		const { deps } = fakeDeps({
			config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 0 },
			graph: () => ({ nodes: [...gradientNodes(["t"]), ...gradientNodes(ids)], chains: [{ premises: ids, conclusion: "t" }] }),
			watchlist: { read: () => [w1] },
			fetchItems: async () => [item("1")],
			classify: async (_i, c) => (seen = c.length, { relation: "extends", action: "ignore", rationale: "", nearestNodeIds: [] }),
		});
		await runCycle(deps, "manual");
		assert.equal(seen, 30);
	});

	it("a failed classification is not recorded as seen: the item is classified again at the next check", async () => {
		const radar = memLog<Radar>();
		let failOnce = true;
		const mk = (now: string) => fakeDeps({
			radar,
			watchlist: { read: () => [w1] },
			fetchItems: async () => [item("1")],
			now: () => new Date(now),
			classify: async (i) => { if (failOnce) { failOnce = false; throw new Error("llm down"); } return { relation: "extends", action: "ignore", rationale: i.id, nearestNodeIds: [] }; },
		}).deps;
		await runCycle(mk("2026-11-04T12:00:00.000Z"), "manual");
		assert.equal(radar.events.some((e) => e.type === "classified"), false);
		await runCycle(mk("2026-11-06T12:00:00.000Z"), "manual");
		assert.deepEqual(radar.events.filter((e) => e.type === "classified").map((e) => e.type === "classified" && e.itemId), ["1"]);
	});

	it("a snapshot port that returns an empty string makes the source failed, with no inbox event", async () => {
		const inbox = memLog<Inbox>();
		const { deps } = fakeDeps({ inbox, config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 }, snapshots: { put: () => "" }, researchGap: async () => finding({ sources: [src("https://a.org/x")] }) });
		const g = (await runCycle(deps, "manual")).gaps[0]!;
		assert.deepEqual(g.sources.map((s) => s.outcome), ["failed"]);
		assert.equal(inbox.events.length, 0);
	});

	it("with the gate closed the graph, goals and trust are never read and nothing is researched", async () => {
		const reads = { graph: 0, goals: 0, uncovered: 0, weak: 0, trust: 0, watch: 0 };
		const { deps, calls } = fakeDeps({
			costGate: { allowed: () => false, record: () => {} },
			graph: () => (reads.graph++, { nodes, chains }),
			goals: () => (reads.goals++, [goal()]),
			uncovered: () => (reads.uncovered++, []),
			weakNodeIds: () => (reads.weak++, []),
			verification: { trustOf: () => (reads.trust++, new Map()), verifyNodes: async () => {} },
			watchlist: { read: () => (reads.watch++, []) },
		});
		const entry = await runCycle(deps, "manual");
		assert.deepEqual(reads, { graph: 0, goals: 0, uncovered: 0, weak: 0, trust: 0, watch: 0 });
		assert.deepEqual([entry.stoppedBy, calls.research.length], ["ceiling", 0]);
	});
});

void ((): CycleDeps | undefined => undefined);
