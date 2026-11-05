// tests/ext-review-tools.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { REVIEW_INSTRUCTIONS } from "../src/agent/ext/review-instructions.ts";
import { createReviewAgent } from "../src/agent/ext/review-agent.ts";
import { reviewTools, type ReviewToolContext } from "../src/agent/ext/review-tools.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import type { NextItem } from "../src/core/ext/review-queries.ts";
import type { RecordReviewInput } from "../src/core/ext/review-service.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const ITEM = (nodeId: string, channel: "fixed" | "dialogic"): NextItem => ({
	kind: "item", nodeId, name: nodeId, statement: `${nodeId} holds.`, trust: "unverified", channel, reason: "due",
	premises: [], recentQuestions: [], remainingItems: 1,
});

function fixture(over: { next?: NextItem; messages?: LhMessage[]; recordThrows?: string } = {}) {
	let clock = 1_000_000;
	const recorded: RecordReviewInput[] = [];
	const drafts: Array<{ nodeId: string; question: string; answer: string }> = [];
	const ctx: ReviewToolContext = {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages: over.messages ?? [], kind: "review" }) },
		nextItem: () => over.next ?? ITEM("n_1", "fixed"),
		record: (input) => {
			if (over.recordThrows) throw new Error(over.recordThrows);
			recorded.push(input);
			return { dueAt: "2026-11-09T10:00:00.000Z", credited: ["n_2"], penalised: [] };
		},
		proposeCard: (input) => (drafts.push(input), "card_x"),
		nowMs: () => clock,
	};
	return { tools: reviewTools(ctx), recorded, drafts, advance: (ms: number) => (clock += ms), ctx };
}
const run = (t: { execute: (...a: any[]) => Promise<any> } | undefined, input: unknown) => t!.execute("call_1", input);
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("review tools registry", () => {
	it("has exactly next_item, record_review, propose_card and upstream's ask_user_question", () => {
		assert.deepEqual(Object.keys(fixture().tools).sort(), ["ask_user_question", "next_item", "propose_card", "record_review"]);
	});
});

describe("record_review", () => {
	it("records with the channel next_item presented and the measured duration (REQ-pl-04)", async () => {
		const f = fixture({ next: ITEM("n_1", "dialogic") });
		await run(f.tools.next_item, {});
		f.advance(95_400);
		const res = await run(f.tools.record_review, { nodeId: "n_1", rating: 3, question: "Why?", weakPremises: ["n_2"] });
		assert.equal(res.isError, undefined);
		assert.deepEqual(f.recorded, [{ nodeId: "n_1", channel: "dialogic", rating: 3, durationSec: 95, question: "Why?", weakPremises: ["n_2"] }]);
		assert.match(text(res), /Next review 2026-11-09/);
	});

	it("clamps the duration to [1, 900] seconds", async () => {
		const f = fixture();
		await run(f.tools.next_item, {});
		f.advance(10);
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		await run(f.tools.next_item, {});
		f.advance(99_999_000);
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		assert.deepEqual(f.recorded.map((r) => r.durationSec), [1, 900]);
	});

	it("refuses a node that next_item did not present, and writes nothing", async () => {
		const f = fixture();
		const res = await run(f.tools.record_review, { nodeId: "n_9", rating: 3 });
		assert.equal(res.isError, true);
		assert.equal(f.recorded.length, 0);
	});

	it("refuses to record the same presentation twice in a turn", async () => {
		const f = fixture();
		await run(f.tools.next_item, {});
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		const again = await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		assert.equal(again.isError, true);
		assert.equal(f.recorded.length, 1);
	});

	it("finds a presentation from an earlier turn in the stored record, once", async () => {
		const result = (toolName: string, details: unknown, timestamp: number): LhMessage & ToolResultMessage => ({
			id: `m_${toolName}_${timestamp}`, role: "toolResult", toolCallId: "x", toolName,
			content: [{ type: "text", text: "" }], details: details as never, isError: false, timestamp,
		});
		const messages: LhMessage[] = [result("next_item", { kind: "item", nodeId: "n_1", channel: "fixed" }, 1_000_000 - 30_000)];
		const f = fixture({ messages });
		const ok = await run(f.tools.record_review, { nodeId: "n_1", rating: 4 });
		assert.equal(ok.isError, undefined);
		assert.equal(f.recorded[0]?.durationSec, 30);
		const used = fixture({ messages: [...messages, result("record_review", { nodeId: "n_1" }, 1_000_000 - 1000)] });
		const second = await run(used.tools.record_review, { nodeId: "n_1", rating: 4 });
		assert.equal(second.isError, true);
	});

	it("turns a service rejection into a retryable error result", async () => {
		const f = fixture({ recordThrows: "weak premise zzz is not a premise of n_1" });
		await run(f.tools.next_item, {});
		const res = await run(f.tools.record_review, { nodeId: "n_1", rating: 2, weakPremises: ["zzz"] });
		assert.equal(res.isError, true);
		assert.match(text(res), /not a premise/);
	});
});

describe("next_item and propose_card", () => {
	it("next_item returns the plan head as data (details carry kind, nodeId, channel)", async () => {
		const res = await run(fixture({ next: ITEM("n_7", "dialogic") }).tools.next_item, {});
		assert.deepEqual({ k: res.details.kind, n: res.details.nodeId, c: res.details.channel }, { k: "item", n: "n_7", c: "dialogic" });
	});
	it("next_item passes an empty plan through", async () => {
		const res = await run(fixture({ next: { kind: "empty", deferred: 2, needsCard: ["n_3"] } }).tools.next_item, {});
		assert.equal(res.details.kind, "empty");
	});
	it("propose_card drafts through the context and says it is inactive (REQ-pl-03)", async () => {
		const f = fixture();
		const res = await run(f.tools.propose_card, { nodeId: "n_1", question: "Q?", answer: "A." });
		assert.deepEqual(f.drafts, [{ nodeId: "n_1", question: "Q?", answer: "A." }]);
		assert.match(text(res), /inactive/);
	});
});

describe("review agent", () => {
	it("constructs with the review instructions and does not touch the composed practice prompt", () => {
		const agent = createReviewAgent(fixture().ctx, {
			engine: {
				model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		});
		assert.equal(typeof agent.prompt, "function");
		assert.notEqual(composeInstructions("practice"), REVIEW_INSTRUCTIONS);
	});

	it("the instructions name every tool the agent has and the three channels' rules (REQ-pl-07)", () => {
		for (const name of ["next_item", "record_review", "propose_card", "ask_user_question"]) assert.match(REVIEW_INSTRUCTIONS, new RegExp(name));
		assert.match(REVIEW_INSTRUCTIONS, /recentQuestions/);
		assert.match(REVIEW_INSTRUCTIONS, /weakPremises/);
		assert.match(REVIEW_INSTRUCTIONS, /Agree/);
	});
});
