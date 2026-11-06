// tests/ext-provider-limit-paths.test.ts
// Each background path under a provider usage limit: the work pauses, nothing is
// marked failed, and the limit's own text reaches no ledger, status or result.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { runCycle, type CycleDeps } from "../src/core/ext/cycle.ts";
import { buildLecture } from "../src/core/ext/lecture/build.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../src/core/ext/provider-limit.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { verifyNodes } from "../src/core/ext/verify.ts";
import { runChapter, type ChapterProgress, type ChapterRunDeps } from "../src/agent/ext/lecture/chapter-run.ts";
import { gateResearchEngine } from "../src/agent/ext/research-agent.ts";
import { createResearchService } from "../src/server/ext/research-service.ts";
import { COST_SOURCE } from "../src/server/ext/debrief-service.ts";
import { goodCommentary, harness as debriefHarness, local, ref } from "./helpers/debrief-fakes.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { fakeDeps, memLog } from "./helpers/research-fakes.ts";
import { fakeGate, memSnapshotStore, memSourcesStore, memVerificationStore, node } from "./helpers/ext-fakes.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";
import { readPages, registerA, studyHarness } from "./helpers/study-fakes.ts";

const CANARY = "CANARY-7731 sk-canary-key https://leak.example/?t=CANARY";
const LIMIT_TEXT = `Claude Code usage limit reached. Check your provider account and try again later. ${CANARY}`;
const ended = (id: string) => ref(id, local(11, 4, 10));

/** A gate that is closed by a provider limit while `paused.value` is true, and by nothing else. */
function pausedGate(initiallyPaused = false) {
	const paused = { value: initiallyPaused };
	const gate = {
		allowed: () => !paused.value,
		reason: (): "provider-limit" | null => (paused.value ? "provider-limit" : null),
		record: () => undefined,
	} satisfies CostGate;
	return { gate, paused };
}

describe("debrief under a provider limit", () => {
	it("the limit does not use an attempt or store nullReason error; the session stays pending", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		let limited = false;
		Object.assign(h.gate, { reason: () => (limited ? "provider-limit" : null) });
		h.writer.behaviour = async () => {
			limited = true;
			h.gate.open = false;
			throw new Error(LIMIT_TEXT);
		};
		for (let i = 0; i < 5; i++) {
			const out = await h.service.endSession("chat_a");
			assert.deepEqual(out, { status: "deferred", reason: "provider-limit" });
		}
		assert.equal(h.journal.events.length, 0, "nothing stored while paused");
		assert.equal(h.writer.calls.length, 1, "one call started; the gate then stays shut, no more calls");
	});
	it("after the pause, the session is debriefed with the full attempts still available", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		let limited = true;
		Object.assign(h.gate, { reason: () => (limited ? "provider-limit" : null) });
		h.gate.open = false;
		assert.equal((await h.service.endSession("chat_a")).status, "deferred");
		limited = false;
		h.gate.open = true;
		h.writer.behaviour = async () => ({ commentary: goodCommentary, costUsd: 0.05, styleVersion: "abc123abc123" });
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "created");
		assert.equal(h.journal.events.length, 1);
		assert.equal(h.journal.events[0]!.nullReason, null);
		assert.equal(h.gate.recorded.filter((r) => r.source === COST_SOURCE).length, 1);
	});
	it("a failing writer call during a limit does not count toward the three attempts", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		let limited = false;
		Object.assign(h.gate, { reason: () => (limited ? "provider-limit" : null) });
		h.writer.behaviour = async () => {
			limited = true;
			h.gate.open = false;
			throw new Error(LIMIT_TEXT);
		};
		for (let i = 0; i < 4; i++) await h.service.endSession("chat_a");
		limited = false;
		h.gate.open = true;
		h.writer.behaviour = async () => ({ commentary: goodCommentary, costUsd: 0, styleVersion: "abc123abc123" });
		assert.equal((await h.service.endSession("chat_a")).status, "created", "still retried: the limit used no attempt");
	});
	it("the sweep stops at the first limit: the next sessions wait, nothing is stored, the result says so", async () => {
		const h = debriefHarness({ refs: [ended("chat_a"), ended("chat_b"), ended("chat_c")] });
		let limited = false;
		Object.assign(h.gate, { reason: () => (limited ? "provider-limit" : null) });
		h.writer.behaviour = async () => {
			limited = true;
			h.gate.open = false;
			throw new Error(LIMIT_TEXT);
		};
		const result = await h.service.sweep();
		assert.equal(result.providerLimited, true);
		assert.equal(result.deferred, 1);
		assert.equal(result.errors, 0);
		assert.equal(h.writer.calls.length, 1, "the other sessions were not attempted");
		assert.equal(h.journal.events.length, 0);
		assert.equal(result.weekly, "not_due", "the week waits too");
	});
	it("a sweep started while paused calls no model and says it was limited", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		Object.assign(h.gate, { reason: () => "provider-limit" });
		h.gate.open = false;
		const result = await h.service.sweep();
		assert.equal(result.providerLimited, true);
		assert.equal(h.writer.calls.length, 0);
		assert.equal(h.journal.events.length, 0);
	});
	it("the limit text never reaches the journal or the sweep result", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		let limited = false;
		Object.assign(h.gate, { reason: () => (limited ? "provider-limit" : null) });
		h.writer.behaviour = async () => {
			limited = true;
			h.gate.open = false;
			throw new Error(LIMIT_TEXT);
		};
		const result = await h.service.sweep();
		const everything = JSON.stringify([result, h.journal.events, h.activity.events]);
		assert.equal(everything.includes("CANARY"), false);
		assert.equal(everything.includes("usage limit"), false);
	});
	it("regression: a closed ceiling still stores the session with nullReason ceiling", async () => {
		const h = debriefHarness({ refs: [ended("chat_a")] });
		h.gate.open = false; // no reason(): the ceiling
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "created");
		assert.equal(h.journal.events[0]!.nullReason, "ceiling");
	});
});

describe("research cycle under a provider limit", () => {
	it("a limit in a gap stops the cycle with provider-limit; the gap is not logged as failed", async () => {
		const { gate, paused } = pausedGate(false);
		const errors: unknown[] = [];
		let calls = 0;
		const { deps } = fakeDeps({
			costGate: gate,
			onError: (e) => void errors.push(e),
			researchGap: async () => {
				calls++;
				paused.value = true;
				throw Object.assign(new Error(LIMIT_TEXT), { costUsd: 0 });
			},
		});
		const log = memLog<never>();
		const entry = await runCycle({ ...deps, log: log as never }, "manual");
		assert.equal(entry.stoppedBy, "provider-limit");
		assert.equal(calls, 1, "no further gap was started");
		assert.equal(entry.gaps.some((g) => g.error !== undefined), false, "no gap carries a failure label");
		assert.equal(errors.length, 0, "the limit is not reported as an error");
		assert.equal(JSON.stringify(entry).includes("CANARY"), false);
	});
	it("a closed gate at the start starts no gap and no watch entry", async () => {
		const { gate } = pausedGate(true);
		let calls = 0;
		const { deps } = fakeDeps({
			costGate: gate,
			researchGap: async () => {
				calls++;
				throw new Error("must not run");
			},
		});
		const entry = await runCycle({ ...deps, log: memLog<never>() as never }, "schedule");
		assert.equal(entry.stoppedBy, "provider-limit");
		assert.equal(calls, 0);
		assert.equal(entry.watch.entries, 0);
	});
	it("regression: a closed ceiling is still reported as ceiling", async () => {
		const gate: CostGate = { allowed: () => false, record: () => undefined };
		const { deps } = fakeDeps({ costGate: gate });
		const entry = await runCycle({ ...deps, log: memLog<never>() as never }, "schedule");
		assert.equal(entry.stoppedBy, "ceiling");
	});
	it("tick starts nothing while paused; a manual start is refused with a fixed reason; status shows the end", () => {
		const log = memLog<never>();
		let pausedUntil: string | null = "2026-11-06T12:00:00.000Z";
		const service = createResearchService({
			store: { log: log as never, lockKey: "k-paused" },
			buildCycleDeps: () => ({}) as never,
			cycleHours: 1,
			canRun: () => true,
			providerPause: () => (pausedUntil === null ? null : { pausedUntil }),
			now: () => new Date("2026-11-06T10:00:00.000Z"),
		});
		assert.equal(service.tick(), null);
		assert.deepEqual(service.start("manual"), { started: false, reason: "provider-limit" });
		assert.equal(service.status().providerPausedUntil, "2026-11-06T12:00:00.000Z");
		assert.equal(JSON.stringify(service.status()).includes("usage limit"), false);
		pausedUntil = null;
		assert.equal(service.status().providerPausedUntil, null);
	});
});

describe("verification batch under a provider limit", () => {
	const TEXT = "The sum of the angles of a triangle in the Euclidean plane is one hundred and eighty degrees.";
	const book: SourceEntry = { id: "lib_book", kind: "pdf", locator: "/books/geo.pdf", tier: "primary", label: "Geometry", status: "active", addedBy: "user" };
	const ids = ["n1", "n2", "n3", "n4", "n5", "n6"];
	function setup() {
		const graphStore = createMemoryGraphStore();
		for (const id of ids) graphStore.appendNode(node(id));
		return {
			graphStore,
			sourcesStore: memSourcesStore([book]),
			snapshotStore: memSnapshotStore(),
			verificationStore: memVerificationStore(),
			reader: { read: async () => TEXT },
		};
	}

	it("a limit during a batch leaves that batch and the rest unverified, not failed, and writes no check_failed", async () => {
		const s = setup();
		const { gate, paused } = pausedGate(false);
		let calls = 0;
		const report = await verifyNodes(ids, {
			...s,
			costGate: gate,
			verifier: {
				run: async () => {
					calls++;
					paused.value = true;
					throw new Error(LIMIT_TEXT);
				},
			},
		});
		assert.equal(calls, 1, "the following batch is never started");
		assert.deepEqual(report.providerLimited, ids);
		assert.deepEqual(report.failed, []);
		assert.deepEqual(report.checked, []);
		assert.equal(s.verificationStore.events.length, 0, "no check_failed carrying the limit");
		assert.equal(JSON.stringify(report).includes("CANARY"), false);
	});
	it("a closed gate before any batch calls no verifier", async () => {
		const s = setup();
		const { gate } = pausedGate(true);
		let calls = 0;
		const report = await verifyNodes(ids, { ...s, costGate: gate, verifier: { run: async () => (calls++, { output: null, checker: "x" }) } });
		assert.equal(calls, 0);
		assert.deepEqual(report.providerLimited, ids);
		assert.deepEqual(report.skippedBudget, []);
	});
	it("regression: a closed ceiling still reports skippedBudget, not providerLimited", async () => {
		const s = setup();
		const report = await verifyNodes(ids, { ...s, costGate: fakeGate(false), verifier: { run: async () => ({ output: null, checker: "x" }) } });
		assert.deepEqual(report.skippedBudget, ids);
		assert.deepEqual(report.providerLimited, []);
	});
});

describe("study complete and approval under a provider limit", () => {
	const draft = (page: number, n: number) => ({ page, proposition: `Fact ${n} on page ${page}.`, question: `Q${n}?`, answer: `A${n}.` });

	it("complete stops without marking the pages processed, and does not fail with the provider text", async () => {
		const h = studyHarness({
			proposals: () => {
				h.gate.open = false;
				Object.assign(h.gate, { reason: () => "provider-limit" });
				return Promise.reject(new Error(LIMIT_TEXT));
			},
		});
		const id = await registerA(h);
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [], remaining: 1, ceilingReached: false, providerLimited: true });
		assert.equal(h.drafts.events.length, 0, "no pages_processed event");
		assert.equal(JSON.stringify(r).includes("CANARY"), false);
	});
	it("complete refuses before any call with the fixed message when the gate is paused", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		h.gate.open = false;
		Object.assign(h.gate, { reason: () => "provider-limit" });
		const r = await h.svc.complete(id);
		assert.equal(r.providerLimited, true);
		assert.equal(r.ceilingReached, false);
		assert.equal(h.drafts.events.length, 0);
	});
	it("approval refuses with the fixed message and imports nothing", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await h.svc.complete(id);
		const [d1] = h.svc.listDrafts(id);
		h.gate.open = false;
		Object.assign(h.gate, { reason: () => "provider-limit" });
		const r = await h.svc.decideDrafts({ approve: [{ draftId: d1!.id }], reject: [] });
		assert.deepEqual(r.failed, [{ draftId: d1!.id, error: PROVIDER_LIMIT_MESSAGE }]);
		assert.equal(h.imports.length, 0);
	});
});

describe("lecture generation under a provider limit", () => {
	const book = { bookId: "b0123abcd", bookTitle: "Probability 1" };
	const chapter = { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 };
	const SRC = "src_0123456789ab";
	const nodeOf = (id: string): Pick<GraphNode, "id" | "name" | "statement" | "provenance"> => ({ id, name: id, statement: `statement of ${id}`, provenance: [{ chatId: SRC, messageId: "" }] });
	const base = makeLecture();
	const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };

	function harness(gate: CostGate, over: Partial<ChapterRunDeps> = {}) {
		const store = new Map<string, Lecture>();
		const progress: ChapterProgress[] = [];
		let imported = false;
		const deps: ChapterRunDeps = {
			gate,
			lectures: { save: (l) => void store.set(l.id, l), list: () => [...store.values()], remove: (id) => void store.delete(id) },
			importChapterGraph: async () => void (imported = true),
			findSourceId: () => (imported ? SRC : null),
			readNodes: () => (imported ? [nodeOf(NODE_A), nodeOf(NODE_B)] : []),
			readChapterText: async () => "Chapter text.",
			writeOutline: async () => [{ title: "T", kind: "definition", summary: "s" }],
			writeLecture: async () => draft,
			now: () => "2026-11-04T10:00:00.000Z",
			onProgress: (p) => void progress.push(p),
			...over,
		};
		return { deps, store, progress };
	}

	it("a limit during writing ends the chapter stopped_provider with the fixed text, not failed", async () => {
		const { gate, paused } = pausedGate(false);
		const h = harness(gate, {
			writeLecture: async () => {
				paused.value = true;
				throw new Error(LIMIT_TEXT);
			},
		});
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_provider");
		assert.equal(r.error, PROVIDER_LIMIT_MESSAGE);
		assert.equal(h.store.size, 0);
		assert.equal(JSON.stringify(h.progress).includes("CANARY"), false);
	});
	it("a closed gate at the start is stopped_provider; the ceiling still stops as stopped_cost", async () => {
		const paused = await runChapter(book, chapter, harness(pausedGate(true).gate).deps);
		assert.equal(paused.state, "stopped_provider");
		const ceiling = await runChapter(book, chapter, harness({ allowed: () => false, record: () => undefined }).deps);
		assert.equal(ceiling.state, "stopped_cost");
	});
});

describe("the fixed text", () => {
	it("is the one message every refusal shows", () => {
		assert.match(PROVIDER_LIMIT_MESSAGE, /usage limit is reached/);
	});
});

describe("research console chat refusal under a provider limit", () => {
	it("a paused gate refuses the chat's model call with the fixed provider text, not the ceiling text", () => {
		let reached = false;
		const engine = { model: {} as never, streamFn: (() => (reached = true, {} as never)) as never } as never;
		const { gate } = pausedGate(true);
		const gated = gateResearchEngine(engine, gate, { refused: false });
		assert.throws(() => gated.streamFn({} as never, {} as never, {} as never), (e: unknown) => e instanceof Error && e.message === PROVIDER_LIMIT_MESSAGE);
		assert.equal(reached, false, "no provider call");
	});
	it("regression: a closed ceiling keeps the research ceiling text", () => {
		const engine = { model: {} as never, streamFn: (() => ({} as never)) as never } as never;
		const gated = gateResearchEngine(engine, fakeGate(false), { refused: false });
		assert.throws(() => gated.streamFn({} as never, {} as never, {} as never), (e: unknown) => e instanceof Error && e.message === "the daily research ceiling is reached");
	});
});
