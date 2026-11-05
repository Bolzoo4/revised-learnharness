// tests/ext-research-tools.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { researchTools, type ResearchToolContext } from "../src/agent/ext/research-tools.ts";
import { RESEARCH_INSTRUCTIONS } from "../src/agent/ext/research-instructions.ts";
import { createResearchAgent, gateResearchEngine, researchOnUsage } from "../src/agent/ext/research-agent.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";

const NINE = ["control_cycle", "decide_inbox", "edit_mark", "edit_watchlist", "list_inbox", "list_marks", "list_watchlist", "read_log", "run_cycle"];
const SECRET = "SECRET internal detail";
const boom = (): never => {
	throw new Error(SECRET);
};

function ctx(over: Partial<ResearchToolContext> = {}): { c: ResearchToolContext; calls: unknown[] } {
	const calls: unknown[] = [];
	const c: ResearchToolContext = {
		chatId: "chat_1",
		chatStore: { getChat: () => null },
		listMarks: () => [],
		setMark: (i) => (calls.push(["setMark", i]), { id: "mark_1", scope: i.scope, mark: i.mark, note: i.note ?? "", author: "user", at: "t" }),
		clearMark: (id) => void calls.push(["clearMark", id]),
		runCycle: () => ({ started: true }),
		status: () => ({ running: true, steers: [] }),
		steer: (m) => (calls.push(["steer", m]), "delivered"),
		abort: () => (calls.push(["abort"]), true),
		listInbox: (s) => (calls.push(["listInbox", s]), []),
		decideInbox: async (l, d) => (calls.push(["decide", l, d]), { decision: d, nodesAdded: 2 }),
		listWatchlist: () => [],
		addWatch: (i) => (calls.push(["addWatch", i]), { id: "watch_1", kind: i.kind, query: i.query, cadenceHours: 24 }),
		removeWatch: (id) => void calls.push(["removeWatch", id]),
		readLog: (n) => (calls.push(["readLog", n]), []),
		...over,
	};
	return { c, calls };
}
const run = async (tools: ReturnType<typeof researchTools>, name: string, input: unknown): Promise<string> => {
	const r = await tools[name]!.execute!("t1", input as never);
	return r.content.map((p) => (p.type === "text" ? p.text : "")).join("");
};

describe("research tools", () => {
	it("exposes exactly the nine tools of REQ-rs-15/16 and no way to activate a library source", () => {
		const names = Object.keys(researchTools(ctx().c)).sort();
		assert.deepEqual(names, NINE);
		assert.match(RESEARCH_INSTRUCTIONS, /Activating|activating/);
	});

	it("decide_inbox only offers approved and rejected", () => {
		const schema = JSON.stringify(researchTools(ctx().c).decide_inbox!.parameters);
		assert.doesNotMatch(schema, /activated/);
	});

	it("edit_mark: set, clear, and missing fields come back as text", async () => {
		const { c, calls } = ctx();
		const t = researchTools(c);
		assert.match(await run(t, "edit_mark", { action: "set", scopeKind: "goal", scopeId: "goal_1", mark: "expand", budgetUsd: 1 }), /mark_1/);
		assert.deepEqual(calls[0], ["setMark", { scope: { kind: "goal", id: "goal_1" }, mark: "expand", budgetUsd: 1 }]);
		assert.match(await run(t, "edit_mark", { action: "set", mark: "stop" }), /set needs scopeKind/);
		await run(t, "edit_mark", { action: "clear", markId: "mark_1" });
		assert.deepEqual(calls[1], ["clearMark", "mark_1"]);
	});

	it("control_cycle steers or aborts; steer text is trimmed and bounded", async () => {
		const { c, calls } = ctx();
		const t = researchTools(c);
		assert.match(await run(t, "control_cycle", { action: "steer", message: " proofs first " }), /Delivered/);
		assert.deepEqual(calls[0], ["steer", "proofs first"]);
		assert.match(await run(t, "control_cycle", { action: "steer" }), /needs a message/);
		assert.match(await run(t, "control_cycle", { action: "abort" }), /Abort requested/);
	});

	it("steer text beyond 2000 characters is cut before it reaches the loop", async () => {
		const { c, calls } = ctx();
		await run(researchTools(c), "control_cycle", { action: "steer", message: "x".repeat(5000) });
		const sent = calls[0] as [string, string];
		assert.equal(sent[0], "steer");
		assert.equal(sent[1].length, 2000);
	});

	it("decide_inbox failures are generic: no internal message reaches the model", async () => {
		const { c } = ctx({ decideInbox: async () => { throw new Error(SECRET); } });
		const text = await run(researchTools(c), "decide_inbox", { locator: "https://example.org/x", decision: "approved" });
		assert.equal(text, "decide_inbox failed.");
		assert.doesNotMatch(text, /SECRET/);
	});

	it("decide_inbox normalizes the locator the way the inbox keys it, and refuses an oversized one", async () => {
		const { c, calls } = ctx();
		const t = researchTools(c);
		await run(t, "decide_inbox", { locator: " https://Example.org/a/ ", decision: "rejected" });
		assert.deepEqual(calls[0], ["decide", "https://example.org/a", "rejected"]);
		const long = `https://example.org/${"a".repeat(2100)}`;
		assert.match(await run(t, "decide_inbox", { locator: long, decision: "approved" }), /too long/);
		assert.equal(calls.length, 1);
	});

	it("list_inbox defaults to pending; edit_watchlist adds and removes; read_log defaults to 5", async () => {
		const { c, calls } = ctx();
		const t = researchTools(c);
		await run(t, "list_inbox", {});
		assert.deepEqual(calls[0], ["listInbox", "pending"]);
		assert.match(await run(t, "edit_watchlist", { action: "add", kind: "arxiv-query", query: "gradients" }), /watch_1/);
		await run(t, "edit_watchlist", { action: "remove", id: "watch_1" });
		await run(t, "read_log", {});
		assert.deepEqual(calls.slice(-1)[0], ["readLog", 5]);
	});

	it("edit_watchlist refuses a feed aimed at a private or local address, an empty query and a bad repo", async () => {
		const { c, calls } = ctx();
		const t = researchTools(c);
		assert.match(await run(t, "edit_watchlist", { action: "add", kind: "feed", query: "http://127.0.0.1/feed.xml" }), /private|local/);
		assert.match(await run(t, "edit_watchlist", { action: "add", kind: "arxiv-query", query: "   " }), /must not be empty/);
		assert.match(await run(t, "edit_watchlist", { action: "add", kind: "repo", query: "not-a-repo" }), /owner\/name/);
		assert.equal(calls.filter((x) => (x as string[])[0] === "addWatch").length, 0);
	});

	it("every tool returns a text result instead of throwing into the loop, with no internal message", async () => {
		const cases: Array<[string, unknown, Partial<ResearchToolContext>]> = [
			["read_log", {}, { readLog: boom }],
			["list_marks", {}, { listMarks: boom }],
			["edit_mark", { action: "set", scopeKind: "node", scopeId: "n1", mark: "hold" }, { setMark: boom }],
			["edit_mark", { action: "clear", markId: "m1" }, { clearMark: boom }],
			["run_cycle", {}, { runCycle: boom }],
			["control_cycle", { action: "steer", message: "go" }, { steer: boom }],
			["control_cycle", { action: "abort" }, { abort: boom }],
			["list_inbox", {}, { listInbox: boom }],
			["decide_inbox", { locator: "https://example.org/x", decision: "approved" }, { decideInbox: async () => boom() }],
			["list_watchlist", {}, { listWatchlist: boom }],
			["edit_watchlist", { action: "add", kind: "arxiv-query", query: "q" }, { addWatch: boom }],
			["edit_watchlist", { action: "remove", id: "w1" }, { removeWatch: boom }],
		];
		for (const [name, input, over] of cases) {
			const { c } = ctx(over);
			const text = await run(researchTools(c), name, input);
			assert.match(text, new RegExp(`^${name} failed\\.?|^(Cleared|Removed|Abort requested|Delivered|Queued|No cycle)`), `${name} did not come back as text: ${text}`);
			assert.doesNotMatch(text, /SECRET/, `${name} leaked an internal message`);
		}
	});

	it("read_log results are bounded, so a long log cannot flood the model's context", async () => {
		const big = Array.from({ length: 200 }, (_, i) => ({ cycleId: `c${i}`, note: "y".repeat(500) }));
		const { c } = ctx({ readLog: () => big as never });
		const text = await run(researchTools(c), "read_log", { limit: 20 });
		assert.ok(text.length <= 20_100, `result is ${text.length} characters`);
		assert.match(text, /\[truncated\]$/);
	});
});

describe("research agent", () => {
	const fakeEngine = (streamFn: unknown = async () => { throw new Error("not streamed"); }) => ({
		model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
		streamFn: streamFn as never,
	});
	const gateOf = (open: boolean, record: (usd: number, source: string) => void = () => undefined): CostGate => ({
		allowed: () => open,
		record,
	});

	it("is built with the nine tools and the research instructions as its system prompt", () => {
		const { c } = ctx();
		const agent = createResearchAgent(c, { engine: fakeEngine() as never }, { costGate: gateOf(true) });
		const names = agent.state.tools.map((t) => t.name);
		for (const name of NINE) assert.ok(names.includes(name), `missing ${name}`);
		assert.ok(agent.state.systemPrompt.startsWith(RESEARCH_INSTRUCTIONS));
	});

	it("a closed cost gate refuses the model call before it reaches the provider", async () => {
		let reached = 0;
		const engine = fakeEngine(async () => {
			reached++;
			throw new Error("should not run");
		}) as never;
		const gated = gateResearchEngine(engine, gateOf(false));
		assert.throws(() => (gated.streamFn as never as (...a: unknown[]) => unknown)({}, {}, {}), /daily research ceiling/);
		assert.equal(reached, 0);
	});

	it("a gate that cannot answer counts as closed", async () => {
		const gate: CostGate = { allowed: () => { throw new Error(SECRET); }, record: () => undefined };
		let reached = 0;
		const gated = gateResearchEngine(fakeEngine(async () => { reached++; return "ok"; }) as never, gate);
		assert.throws(() => (gated.streamFn as never as (...a: unknown[]) => unknown)({}, {}, {}), /daily research ceiling/);
		assert.equal(reached, 0);
	});

	it("an open gate lets the call through to the provider", async () => {
		const gated = gateResearchEngine(fakeEngine(async () => "answer") as never, gateOf(true));
		assert.equal(await (gated.streamFn as never as (...a: unknown[]) => unknown)({}, {}, {}), "answer");
	});

	it("each admitted call's spend is recorded once on the shared gate as research, and still reaches the chat's own collector", () => {
		const recorded: Array<[number, string]> = [];
		const chat: unknown[] = [];
		const onUsage = researchOnUsage(gateOf(true, (u, s) => recorded.push([u, s])), (u) => chat.push(u));
		onUsage({ cost: { total: 0.02 } } as never);
		assert.deepEqual(recorded, [[0.02, "research"]]);
		assert.equal(chat.length, 1);
	});

	it("spend that is not a finite non-negative number is not recorded, and a failing gate does not throw", () => {
		const recorded: number[] = [];
		const onUsage = researchOnUsage(gateOf(true, (u) => recorded.push(u)));
		onUsage({ cost: { total: Number.NaN } } as never);
		onUsage({ cost: { total: -1 } } as never);
		onUsage({} as never);
		assert.deepEqual(recorded, []);
		const failing = researchOnUsage(gateOf(true, () => { throw new Error(SECRET); }));
		assert.doesNotThrow(() => failing({ cost: { total: 0.5 } } as never));
	});
});
