// tests/ext-research-log.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleDue, lastCycleEndedAt, markSpendUsd, parseCycleLogEntry, type CycleLogEntry, type GapLog } from "../src/core/ext/research-log.ts";

const gap = (over: Partial<GapLog> = {}): GapLog => ({
	gapId: "no-premises:n1",
	type: "no-premises",
	nodeId: "n1",
	questions: ["q"],
	sources: [],
	nodesAdded: 0,
	costUsd: 0.1,
	saturated: false,
	...over,
});
const entry = (over: Partial<CycleLogEntry> = {}): CycleLogEntry => ({
	type: "cycle",
	cycleId: "cyc_1",
	trigger: "manual",
	startedAt: "2026-11-04T10:00:00.000Z",
	endedAt: "2026-11-04T10:05:00.000Z",
	stoppedBy: "completed",
	gaps: [gap()],
	watch: { entries: 0, items: 0, ingested: 0, inbox: 0 },
	nodesAdded: 0,
	costUsd: 0.1,
	steers: [],
	...over,
});
const bad = (over: Record<string, unknown>) => parseCycleLogEntry({ ...entry(), ...over });
const badGap = (over: Record<string, unknown>) => parseCycleLogEntry({ ...entry(), gaps: [{ ...gap(), ...over }] });

describe("cycle log", () => {
	it("round-trips a valid entry and rejects malformed ones", () => {
		assert.deepEqual(parseCycleLogEntry(entry()), entry());
		assert.equal(parseCycleLogEntry({ ...entry(), stoppedBy: "weird" }), null);
		assert.equal(parseCycleLogEntry({ ...entry(), gaps: [{ gapId: "x" }] }), null);
		assert.equal(parseCycleLogEntry({ ...entry(), watch: undefined }), null);
		assert.equal(parseCycleLogEntry({ ...entry(), costUsd: "1" }), null);
		assert.equal(parseCycleLogEntry(null), null);
	});

	it("round-trips a fully populated gap and drops unknown keys", () => {
		const full = gap({
			chatId: "c1",
			markId: "m1",
			confidence: 0.9,
			rationale: "r",
			stoppedBy: "confidence",
			error: "e",
			sources: [{ locator: "https://a.org/x", outcome: "ingested", nodesAdded: 2 }],
			nodesAdded: 2,
			saturated: true,
		});
		const parsed = parseCycleLogEntry({ ...entry({ gaps: [full] }), extra: 1 });
		assert.deepEqual(parsed, entry({ gaps: [full] }));
	});

	it("rejects unparseable dates, bad counts, bad costs and bad confidence", () => {
		assert.equal(bad({ startedAt: "yesterday" }), null);
		assert.equal(bad({ endedAt: "" }), null);
		assert.equal(bad({ endedAt: "2026-11-04T09:00:00.000Z" }), null, "ended before it started");
		assert.equal(bad({ costUsd: -1 }), null);
		assert.equal(bad({ costUsd: Number.NaN }), null);
		assert.equal(bad({ costUsd: Number.POSITIVE_INFINITY }), null);
		assert.equal(bad({ nodesAdded: -1 }), null);
		assert.equal(bad({ nodesAdded: 1.5 }), null);
		assert.equal(bad({ cycleId: "" }), null);
		assert.equal(bad({ trigger: "cron" }), null);
		assert.equal(bad({ steers: [1] }), null);
		assert.equal(bad({ watch: { entries: -1, items: 0, ingested: 0, inbox: 0 } }), null);
		assert.equal(bad({ watch: { entries: 0, items: 0.5, ingested: 0, inbox: 0 } }), null);
		assert.equal(bad({ gaps: "x" }), null);
		assert.equal(badGap({ confidence: 1.1 }), null);
		assert.equal(badGap({ confidence: -0.1 }), null);
		assert.equal(badGap({ confidence: Number.NaN }), null);
		assert.equal(badGap({ costUsd: -0.01 }), null);
		assert.equal(badGap({ nodesAdded: -1 }), null);
		assert.equal(badGap({ gapId: "" }), null);
		assert.equal(badGap({ type: "nope" }), null);
		assert.equal(badGap({ stoppedBy: "nope" }), null);
		assert.equal(badGap({ questions: [1] }), null);
		assert.equal(badGap({ sources: [{ locator: "u", outcome: "weird", nodesAdded: 0 }] }), null);
		assert.equal(badGap({ sources: [{ locator: "u", outcome: "ingested", nodesAdded: -1 }] }), null);
		assert.equal(badGap({ markId: 3 }), null);
		assert.equal(badGap({ rationale: 3 }), null);
		assert.equal(badGap({ saturated: "yes" }), null);
	});

	it("accepts the boundary values (confidence 0 and 1, zero cost)", () => {
		assert.ok(badGap({ confidence: 0, costUsd: 0 }));
		assert.ok(badGap({ confidence: 1 }));
		assert.ok(bad({ endedAt: "2026-11-04T10:00:00.000Z" }), "ended at the same instant");
	});

	it("sums spend per mark over all cycles", () => {
		const spend = markSpendUsd([
			entry({ gaps: [gap({ markId: "m1", costUsd: 0.25 }), gap({ markId: "m2", costUsd: 1 }), gap({ costUsd: 9 })] }),
			entry({ gaps: [gap({ markId: "m1", costUsd: 0.5 })] }),
		]);
		assert.equal(spend.get("m1"), 0.75);
		assert.equal(spend.get("m2"), 1);
		assert.equal(spend.size, 2);
		assert.equal(markSpendUsd([]).size, 0);
	});

	it("a scheduled cycle is due when none ran or the interval elapsed", () => {
		assert.equal(lastCycleEndedAt([]), null);
		assert.equal(cycleDue([], "2026-11-04T12:00:00.000Z", 6), true);
		const log = [entry({ endedAt: "2026-11-04T10:00:00.000Z" }), entry({ endedAt: "2026-11-04T06:00:00.000Z" })];
		assert.equal(lastCycleEndedAt(log), "2026-11-04T10:00:00.000Z");
		assert.equal(cycleDue(log, "2026-11-04T15:59:59.000Z", 6), false);
		assert.equal(cycleDue(log, "2026-11-04T16:00:00.000Z", 6), true);
	});

	it("compares instants, not strings (offsets, precision)", () => {
		// 12:00+02:00 is 10:00Z, later than 11:00Z although it sorts lower as a string
		const log = [entry({ endedAt: "2026-11-04T11:00:00.000Z" }), entry({ endedAt: "2026-11-04T12:00:00+02:00" })];
		assert.equal(lastCycleEndedAt(log), "2026-11-04T11:00:00.000Z");
		const log2 = [entry({ endedAt: "2026-11-04T10:30:00.000Z" }), entry({ endedAt: "2026-11-04T12:00:00+02:00" })];
		assert.equal(lastCycleEndedAt(log2), "2026-11-04T10:30:00.000Z");
		const log3 = [entry({ endedAt: "2026-11-04T10:00:00Z" }), entry({ endedAt: "2026-11-04T12:30:00+02:00" })];
		assert.equal(lastCycleEndedAt(log3), "2026-11-04T12:30:00+02:00");
		assert.equal(cycleDue(log3, "2026-11-04T16:29:00Z", 6), false);
	});

	it("a tie on the same instant keeps the first entry", () => {
		const log = [entry({ endedAt: "2026-11-04T10:00:00Z" }), entry({ endedAt: "2026-11-04T12:00:00+02:00" })];
		assert.equal(lastCycleEndedAt(log), "2026-11-04T10:00:00Z");
	});

	it("ignores entries with unparseable end times and never reports due on bad input", () => {
		const garbled = entry({ endedAt: "garbage" });
		assert.equal(lastCycleEndedAt([garbled]), null);
		assert.equal(lastCycleEndedAt([garbled, entry({ endedAt: "2026-11-04T10:00:00.000Z" })]), "2026-11-04T10:00:00.000Z");
		const log = [entry({ endedAt: "2026-11-04T10:00:00.000Z" })];
		assert.equal(cycleDue(log, "not a date", 6), false, "unparseable now: do not spend");
		assert.equal(cycleDue([], "not a date", 6), false);
		assert.equal(cycleDue(log, "2026-11-05T10:00:00.000Z", Number.NaN), false);
		assert.equal(cycleDue(log, "2026-11-05T10:00:00.000Z", 0), false);
		assert.equal(cycleDue(log, "2026-11-05T10:00:00.000Z", -1), false);
		assert.equal(cycleDue(log, "2026-11-05T10:00:00.000Z", Number.POSITIVE_INFINITY), false);
	});
});
