// tests/ext-research-goal.test.ts
// Research goals and progress reports (REQ-rs-19, REQ-rs-20): the goal input, the bounded
// progress handle, the goal gap of a goal cycle, the log format, and the service status.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanGoal, createCycleControl, MAX_GOAL_CHARS, MAX_REPORTS, MAX_REPORT_CHARS, type CycleControl } from "../src/core/ext/cycle-control.ts";
import { goalGap } from "../src/core/ext/gaps.ts";
import { runCycle } from "../src/core/ext/cycle.ts";
import { parseCycleLogEntry, type CycleLogEntry } from "../src/core/ext/research-log.ts";
import { createResearchService } from "../src/server/ext/research-service.ts";
import { ResearchInputError } from "../src/server/ext/research-errors.ts";
import { fakeDeps, finding, memLog } from "./helpers/research-fakes.ts";

type GapFn = (control: CycleControl, opts: { steers: string[] }) => Promise<ReturnType<typeof finding>>;

describe("goal input (REQ-rs-19)", () => {
	it("absent or blank is no goal; a goal is trimmed; a non-string or a goal over 500 characters is refused", () => {
		assert.equal(MAX_GOAL_CHARS, 500);
		assert.deepEqual(cleanGoal(undefined), { ok: true, goal: undefined });
		assert.deepEqual(cleanGoal("   "), { ok: true, goal: undefined });
		assert.deepEqual(cleanGoal("  Quantum error correction  "), { ok: true, goal: "Quantum error correction" });
		assert.deepEqual(cleanGoal("x".repeat(500)), { ok: true, goal: "x".repeat(500) });
		assert.deepEqual(cleanGoal(" ".repeat(600)), { ok: true, goal: undefined }, "the length is checked after trimming");
		assert.deepEqual(cleanGoal("x".repeat(501)), { ok: false });
		assert.deepEqual(cleanGoal(42), { ok: false });
		assert.deepEqual(cleanGoal(null), { ok: false });
		assert.deepEqual(cleanGoal(["goal"]), { ok: false });
	});
});

describe("progress handle (REQ-rs-20)", () => {
	it("keeps trimmed reports in order, refuses empty, over-long and non-string ones, and keeps the newest 50", () => {
		assert.equal(MAX_REPORTS, 50);
		assert.equal(MAX_REPORT_CHARS, 400);
		const c = createCycleControl();
		assert.equal(c.progress("  looking at a survey  "), true);
		assert.equal(c.progress("   "), false);
		assert.equal(c.progress("x".repeat(MAX_REPORT_CHARS + 1)), false);
		assert.equal(c.progress(42 as unknown as string), false);
		assert.deepEqual(c.reports(), ["looking at a survey"]);
		for (let i = 0; i < 60; i++) c.progress(`report ${i}`);
		const kept = c.reports();
		assert.equal(kept.length, MAX_REPORTS);
		assert.equal(kept[0], "report 10");
		assert.equal(kept[MAX_REPORTS - 1], "report 59");
	});

	it("reports() returns a copy: changing it does not change the handle", () => {
		const c = createCycleControl();
		c.progress("one");
		c.reports().push("forged");
		assert.deepEqual(c.reports(), ["one"]);
	});
});

describe("goal gap (REQ-rs-19)", () => {
	it("is one expansion gap whose label is the goal and that has no node", () => {
		assert.deepEqual(goalGap("Renormalisation", "goal:cyc_1"), {
			id: "goal:cyc_1",
			type: "goal",
			class: "expansion",
			label: "Renormalisation",
			distance: 0,
			score: 0,
		});
	});
});

describe("goal cycle (REQ-rs-19, REQ-rs-20)", () => {
	it("researches one synthetic goal gap, skips the graph watch, and logs the goal and the reports", async () => {
		const log = memLog<CycleLogEntry>();
		const asked: string[] = [];
		let watched = false;
		const reports = ["looking at a survey", "checking arXiv"];
		const { deps } = fakeDeps({
			log,
			watchlist: { read: () => [{ id: "w1", kind: "arxiv-query", query: "anything", cadenceHours: 1 }] },
			fetchItems: async () => {
				watched = true;
				return [];
			},
			researchGap: async (gap) => (asked.push(`${gap.type}:${gap.label}`), finding()),
			allReports: () => reports,
		});
		const entry = await runCycle(deps, "manual", { goal: "Renormalisation" });
		assert.deepEqual(asked, ["goal:Renormalisation"], "exactly one gap, built from the goal");
		assert.equal(entry.goal, "Renormalisation");
		assert.deepEqual(entry.reports, reports);
		assert.equal(entry.gaps.length, 1);
		assert.equal(entry.gaps[0]!.type, "goal");
		assert.equal(watched, false, "a goal cycle does not run the watch");
		assert.deepEqual(entry.watch, { entries: 0, items: 0, ingested: 0, inbox: 0 });
		assert.equal(entry.stoppedBy, "completed");
		assert.deepEqual(log.events, [entry]);
	});

	it("a graph cycle has no goal and no reports field, so its log line is unchanged", async () => {
		const { deps, calls } = fakeDeps();
		const entry = await runCycle(deps, "schedule");
		assert.equal("goal" in entry, false);
		assert.equal("reports" in entry, false);
		assert.ok(calls.research.length > 0, "the graph's gaps are still chosen");
	});
});

describe("research-log goal and reports fields", () => {
	const old = {
		type: "cycle",
		cycleId: "c1",
		trigger: "manual",
		startedAt: "2026-11-04T12:00:00.000Z",
		endedAt: "2026-11-04T12:10:00.000Z",
		stoppedBy: "completed",
		gaps: [],
		watch: { entries: 0, items: 0, ingested: 0, inbox: 0 },
		nodesAdded: 0,
		costUsd: 0,
		steers: [],
	};

	it("an entry written before the fields existed stays valid and has neither field", () => {
		const parsed = parseCycleLogEntry(old);
		assert.ok(parsed !== null);
		assert.equal("goal" in parsed, false);
		assert.equal("reports" in parsed, false);
	});

	it("keeps a goal and its reports; a bad goal or bad reports are dropped without losing the entry", () => {
		const kept = parseCycleLogEntry({ ...old, goal: "Renormalisation", reports: ["a", "b"] });
		assert.equal(kept?.goal, "Renormalisation");
		assert.deepEqual(kept?.reports, ["a", "b"]);

		const bad = parseCycleLogEntry({ ...old, goal: 7, reports: ["ok", 3, "", "x".repeat(MAX_REPORT_CHARS + 1)] });
		assert.ok(bad !== null, "the entry itself is still valid");
		assert.equal("goal" in bad, false);
		assert.deepEqual(bad.reports, ["ok"]);
	});

	it("a gap of type goal is a valid gap line", () => {
		const parsed = parseCycleLogEntry({
			...old,
			gaps: [{ gapId: "goal:c1", type: "goal", questions: [], sources: [], nodesAdded: 0, costUsd: 0.1, saturated: false }],
		});
		assert.equal(parsed?.gaps[0]?.type, "goal");
	});
});

describe("service: goal and progress in the status", () => {
	function harness(gap: GapFn) {
		const f = fakeDeps();
		const service = createResearchService({
			store: { log: f.deps.log, lockKey: `goal-lock-${Math.random()}` },
			buildCycleDeps: (control) => ({ ...f.deps, researchGap: async (_g, o) => gap(control, o) }),
			cycleHours: 6,
			canRun: () => true,
			now: () => new Date("2026-11-07T09:00:00.000Z"),
		});
		return { service, log: f.deps.log };
	}

	it("a goal cycle shows its goal and reports while it runs, and the log keeps both", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		let reached!: () => void;
		const inGap = new Promise<void>((r) => (reached = r));
		const { service, log } = harness(async (control) => {
			control.progress("first look");
			reached();
			await hold;
			return finding();
		});
		assert.deepEqual(service.start("manual", "  Quantum error correction "), { started: true });
		await inGap;
		const during = service.status();
		assert.equal(during.goal, "Quantum error correction");
		assert.deepEqual(during.reports, ["first look"]);
		release();
		await service.idle();
		const idle = service.status();
		assert.equal(idle.goal, undefined);
		assert.deepEqual(idle.reports, []);
		const entry = log.readAll()[0]!;
		assert.equal(entry.goal, "Quantum error correction");
		assert.deepEqual(entry.reports, ["first look"]);
	});

	it("a blank goal starts an ordinary cycle; an invalid goal is refused before anything starts", async () => {
		const { service, log } = harness(async () => finding());
		assert.throws(() => service.start("manual", 42), ResearchInputError);
		assert.throws(() => service.start("manual", "x".repeat(MAX_GOAL_CHARS + 1)), ResearchInputError);
		assert.equal(service.status().running, false);
		assert.deepEqual(service.start("manual", "   "), { started: true });
		await service.idle();
		assert.equal(service.status().goal, undefined);
		assert.equal(log.readAll()[0]!.goal, undefined);
	});

	it("status always carries reports, and an idle service has none", () => {
		const { service } = harness(async () => finding());
		assert.deepEqual(service.status().reports, []);
	});
});
