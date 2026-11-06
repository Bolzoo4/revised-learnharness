// tests/ext-research-live.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as ext-review-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-research-live-"));
process.env.LH_DATA_DIR = TMP_DATA;

const server = await import("../src/server/ext/index.ts");
const live = await import("../src/server/ext/research-live.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createCycleControl } = await import("../src/core/ext/cycle-control.ts");
const { researchConfigFromEnv } = await import("../src/core/ext/research-config.ts");
import type { GapBrief, GapResearchHooks } from "../src/agent/ext/gap-research.ts";
import type { Gap } from "../src/core/ext/gaps.ts";
import type { FeedItem } from "../src/core/ext/watch.ts";
import type { GraphNodeLite } from "../src/core/ext/research-ports.ts";
import type { WatchClassifyHooks, WatchClassifyResult } from "../src/agent/ext/watch-classify.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const config = researchConfigFromEnv({});

const gap: Gap = { id: "no-premises:n1", type: "no-premises", class: "expansion", nodeId: "n1", label: "n1", distance: 0, score: 1 };
const brief: GapBrief = { type: "no-premises", label: "n1", statement: "A statement.", premises: [], activeLocators: [] };
const finding = { questions: ["q"], confidence: 0.9, rationale: "r", stoppedBy: "confidence" as const, sources: [], unfetched: [] };

function recordingGate(): { gate: CostGate; recorded: number[] } {
	const recorded: number[] = [];
	return { gate: { allowed: () => true, record: (usd: number) => void recorded.push(usd) }, recorded };
}

describe("research wiring", () => {
	it("the server barrel exports what the routes, the page and instrumentation use", () => {
		assert.equal(typeof server.startResearchScheduler, "function");
		assert.equal(typeof server.startResearchSession, "function");
		assert.equal(typeof server.researchService.start, "function");
		assert.equal(typeof server.researchAdmin.setMark, "function");
		assert.equal(typeof server.ResearchInputError, "function");
		assert.equal(typeof server.InboxError, "function");
	});

	it("without a configured model a cycle does not start and the scheduler stays quiet (REQ-rs-01)", () => {
		assert.deepEqual(server.researchService.start("manual"), { started: false, reason: "not-configured" });
		assert.equal(server.researchService.tick(), null);
		assert.doesNotThrow(() => server.startResearchScheduler()); // inert under NODE_ENV=test
	});

	it("marks, watchlist and log go through the real ext files", () => {
		const mark = server.researchAdmin.setMark({ scope: { kind: "goal", id: "goal_1" }, mark: "stop", note: "later" });
		assert.equal(mark.author, "user");
		assert.match(fs.readFileSync(path.join(TMP_DATA, "ext", "frontier.jsonl"), "utf-8"), /"mark":"stop"/);
		const watch = server.researchAdmin.addWatch({ kind: "arxiv-query", query: "gradient descent" });
		assert.equal(JSON.parse(fs.readFileSync(path.join(TMP_DATA, "ext", "watchlist.json"), "utf-8")).entries[0].id, watch.id);
		assert.deepEqual(server.researchAdmin.readLog(), []);
		server.researchAdmin.clearMark(mark.id);
		server.researchAdmin.removeWatch(watch.id);
		assert.deepEqual([server.researchAdmin.listMarks(), server.researchAdmin.listWatchlist()], [[], []]);
	});

	it("a research session is a chat of kind research", () => {
		const { chatId } = server.startResearchSession();
		assert.equal(chatStore.getChat(chatId)?.kind, "research");
	});
});

describe("the agent's tool context (REQ-rs-15, REQ-src-02)", () => {
	it("marks the agent sets are authored by the agent, and it cannot clear a learner's mark", () => {
		const { chatId } = server.startResearchSession();
		const ctx = server.researchToolContext(chatId);
		const userMark = server.researchAdmin.setMark({ scope: { kind: "node", id: "n_user" }, mark: "hold", note: "mine" });
		const agentMark = ctx.setMark({ scope: { kind: "node", id: "n_agent" }, mark: "expand" });
		assert.equal(agentMark.author, "agent");
		assert.throws(() => ctx.clearMark(userMark.id), server.ResearchInputError);
		ctx.clearMark(agentMark.id);
		server.researchAdmin.clearMark(userMark.id);
	});

	it("the agent may only approve or reject an inbox source; activation is refused", async () => {
		const { chatId } = server.startResearchSession();
		const ctx = server.researchToolContext(chatId);
		await assert.rejects(() => ctx.decideInbox("https://a.org/x", "activated" as never), /approve or reject/);
	});

	it("a refused cycle start answers with a fixed phrase, never the internal reason", () => {
		const { chatId } = server.startResearchSession();
		assert.deepEqual(server.researchToolContext(chatId).runCycle(), { started: false, reason: live.CYCLE_REFUSALS["not-configured"] });
		assert.equal(live.CYCLE_REFUSALS["not-configured"], "no research model is configured");
		assert.ok(Object.values(live.CYCLE_REFUSALS).every((p) => !/[a-z]+-[a-z]+/.test(p)), "phrases are prose, not codes");
	});
});

describe("the gap adapter (REQ-rs-04, REQ-cost-01, REQ-rs-16)", () => {
	it("passes the shared gate and the live steering, and records no spend itself", async () => {
		const control = createCycleControl();
		const { gate, recorded } = recordingGate();
		const calls: Array<{ steers: string[]; hooks: GapResearchHooks }> = [];
		const researcher = {
			run: async (_b: GapBrief, steers: string[], hooks: GapResearchHooks) => {
				calls.push({ steers, hooks });
				return { ...finding, costUsd: 0.25 };
			},
		};
		const adapter = live.makeResearchGap({ researcher, briefFor: () => brief, costGate: gate, control, config });
		const out = await adapter(gap, { steers: ["focus"], sourceHunt: false, ref: "c:g", maxTurns: 7 });
		assert.equal(out.costUsd, 0.25);
		assert.deepEqual(recorded, [], "the researcher records its own spend; the adapter must not");
		assert.deepEqual(calls[0]!.steers, ["focus"]);
		assert.equal(calls[0]!.hooks.costGate, gate);
		assert.equal(calls[0]!.hooks.maxTurns, 7);
		assert.equal(calls[0]!.hooks.maxSources, config.maxSourcesPerGap);
		assert.equal(calls[0]!.hooks.confidenceThreshold, config.confidenceThreshold);
		control.steer("queued between gaps");
		assert.deepEqual(calls[0]!.hooks.takeSteers?.(), ["queued between gaps"]);
	});

	it("attaches the live agent while the gap runs and detaches it when the gap settles", async () => {
		const control = createCycleControl();
		const { gate } = recordingGate();
		const delivered: string[] = [];
		const agent = { steer: (m: { content: string }) => void delivered.push(m.content) };
		const researcher = {
			run: async (_b: GapBrief, _s: string[], hooks: GapResearchHooks) => {
				hooks.onAgent?.(agent as never);
				return { ...finding, costUsd: 0 };
			},
		};
		const adapter = live.makeResearchGap({ researcher, briefFor: () => brief, costGate: gate, control, config });
		await adapter(gap, { steers: [], sourceHunt: false, ref: "c:g", maxTurns: 3 });
		assert.equal(control.steer("after the gap"), "queued", "after the gap no live agent is attached");
		assert.deepEqual(delivered, []);
	});

	it("a failed gap rethrows its error with the spend so far, and records nothing itself", async () => {
		const control = createCycleControl();
		const { gate, recorded } = recordingGate();
		const researcher = {
			run: async () => {
				throw Object.assign(new Error("gap research failed"), { costUsd: 0.4 });
			},
		};
		const adapter = live.makeResearchGap({ researcher, briefFor: () => brief, costGate: gate, control, config });
		await assert.rejects(adapter(gap, { steers: [], sourceHunt: false, ref: "c:g", maxTurns: 3 }), (e: unknown) => (e as { costUsd?: number }).costUsd === 0.4);
		assert.deepEqual(recorded, []);
	});

	it("refuses a gap that is not a research gap", async () => {
		const control = createCycleControl();
		const { gate } = recordingGate();
		const adapter = live.makeResearchGap({ researcher: { run: async () => Promise.reject(new Error("unused")) }, briefFor: () => brief, costGate: gate, control, config });
		await assert.rejects(adapter({ ...gap, type: "uncovered" }, { steers: [], sourceHunt: false, ref: "c:g", maxTurns: 3 }));
	});
});

describe("the classify adapter (REQ-rs-12, REQ-cost-01)", () => {
	it("hands the classifier the shared gate and the cycle's signal, and records no spend itself", async () => {
		const control = createCycleControl();
		const { gate, recorded } = recordingGate();
		const seen: Array<{ hooks: WatchClassifyHooks }> = [];
		const classifier = {
			classify: async (_i: FeedItem, _c: readonly GraphNodeLite[], hooks: WatchClassifyHooks): Promise<WatchClassifyResult> => {
				seen.push({ hooks });
				return { relation: "extends", action: "ingest", rationale: "", nearestNodeIds: [], costUsd: 0.01 };
			},
		};
		const classify = live.makeClassify({ classifier, costGate: gate, control });
		const item: FeedItem = { id: "i1", title: "T", link: "https://a.org/i1", summary: "S" };
		const out = await classify(item, [{ id: "n1", name: "n", statement: "s" }], "ignored-ref");
		assert.equal(out.costUsd, 0.01);
		assert.equal(seen[0]!.hooks.costGate, gate);
		assert.equal(seen[0]!.hooks.signal, control.signal);
		assert.deepEqual(recorded, []);
	});
});

describe("the notes ingest (REQ-rs-07, REQ-res-03)", () => {
	it("registers the deterministic research path, then imports that same file with the source text", async () => {
		const { sourceFilePath } = await import("../src/core/ext/inbox.ts");
		const registered: string[] = [];
		let imported: { filePath: string; text: string } | null = null;
		let changed = 0;
		const ingest = live.makeIngest({
			registerImport: (p: string) => void registered.push(p),
			importNotes: async (input: { filePath: string; text: string }) => {
				imported = input;
				return { nodes: 3 };
			},
			emitChanged: () => void (changed += 1),
		});
		const nodes = await ingest({ locator: "https://arxiv.org/abs/1234.5678", title: "T", text: "body" });
		const expected = sourceFilePath("https://arxiv.org/abs/1234.5678");
		assert.match(expected, /^research\//);
		assert.equal(nodes, 3);
		assert.deepEqual(registered, [expected]);
		assert.deepEqual(imported, { filePath: expected, text: "body" });
		assert.equal(changed, 1);
	});

	it("still announces the change when the import fails, and the failure propagates", async () => {
		let changed = 0;
		const ingest = live.makeIngest({
			registerImport: () => undefined,
			importNotes: async () => {
				throw new Error("pipeline down");
			},
			emitChanged: () => void (changed += 1),
		});
		await assert.rejects(ingest({ locator: "https://a.org/x", title: "T", text: "body" }), /pipeline down/);
		assert.equal(changed, 1);
	});
});

describe("scheduler and session wiring", () => {
	it("the research session's chat is not a teach chat and the scheduler hook is idempotent", () => {
		const { chatId } = server.startResearchSession();
		assert.notEqual(chatStore.getChat(chatId)?.kind, "teach");
		assert.doesNotThrow(() => {
			server.startResearchScheduler();
			server.startResearchScheduler();
		});
	});
});
