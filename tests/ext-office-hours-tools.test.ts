import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOfficeHoursAgent } from "../src/agent/ext/practice/office-hours-agent.ts";
import { OFFICE_HOURS_INSTRUCTIONS } from "../src/agent/ext/practice/office-hours-instructions.ts";
import { learnerTexts, officeHoursTools, verdictRequested, type OfficeHoursToolContext } from "../src/agent/ext/practice/office-hours-tools.ts";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const msgs = (...texts: string[]): LhMessage[] => texts.map((t) => newUserMessage(t));

function ctxFor(messages: LhMessage[], source: { label: string; text: string } | null) {
	const submitted: Array<{ items: VerdictItem[]; work: string }> = [];
	const ctx: OfficeHoursToolContext = {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages }) },
		source: () => source,
		submitVerdict: (items, work) => {
			submitted.push({ items, work });
			return { text: `checked ${items.length}` };
		},
	};
	return { ctx, submitted };
}

describe("verdict gating (REQ-lec-14)", () => {
	it("detects the command only as the newest user message", () => {
		assert.equal(verdictRequested(msgs("hello", "/verdict")), true);
		assert.equal(verdictRequested(msgs("/verdict", "but wait, one more thing")), false);
		assert.equal(verdictRequested(msgs("  /verdict please")), true);
		assert.equal(verdictRequested([]), false);
	});
	it("registers the verdict tool only on the command", () => {
		const plain = officeHoursTools(ctxFor(msgs("here is my proof"), null).ctx);
		assert.deepEqual(Object.keys(plain).sort(), ["ask_user_question", "read_source"]);
		const asked = officeHoursTools(ctxFor(msgs("here is my proof", "/verdict"), null).ctx);
		assert.deepEqual(Object.keys(asked).sort(), ["ask_user_question", "read_source", "verdict"]);
	});
	it("excludes command messages from the work", () => {
		assert.deepEqual(learnerTexts(msgs("my proof", "/verdict", "more")), ["my proof", "more"]);
	});
});

describe("tools", () => {
	it("read_source returns the designated source or says there is none", async () => {
		const withSource = officeHoursTools(ctxFor(msgs("x"), { label: "Manual ch.3", text: "Step one is trivial." }).ctx);
		const r1 = await withSource.read_source!.execute("t", {} as never);
		assert.match(JSON.stringify(r1), /DESIGNATED SOURCE: Manual ch\.3[\s\S]*Step one is trivial\./);
		const none = officeHoursTools(ctxFor(msgs("x"), null).ctx);
		assert.match(JSON.stringify(await none.read_source!.execute("t", {} as never)), /No source is designated/);
	});
	it("verdict passes the items and the learner's work (never the command) to the service", async () => {
		const { ctx, submitted } = ctxFor(msgs("Let a=2k.", "Then a+b=2(k+m).", "/verdict"), { label: "S", text: "t" });
		const tools = officeHoursTools(ctx);
		const item = { stepRef: "s1", sourceQuote: "each is twice an integer", workQuote: "Let a=2k.", stance: "matches" as const };
		const res = await tools.verdict!.execute("t", { items: [item] } as never);
		assert.match(JSON.stringify(res), /checked 1/);
		assert.equal(submitted[0]!.work, "Let a=2k.\n\nThen a+b=2(k+m).");
		assert.deepEqual(submitted[0]!.items, [item]);
	});
	it("verdict records only once: a second call is refused and not submitted", async () => {
		const { ctx, submitted } = ctxFor(msgs("Let a=2k.", "/verdict"), { label: "S", text: "t" });
		const tools = officeHoursTools(ctx);
		const item = { stepRef: "s1", sourceQuote: "each is twice an integer", workQuote: "Let a=2k.", stance: "matches" as const };
		await tools.verdict!.execute("t1", { items: [item] } as never);
		const second = await tools.verdict!.execute("t2", { items: [item] } as never);
		assert.equal((second as { isError?: boolean }).isError, true);
		assert.equal(submitted.length, 1);
	});
	it("a service error becomes a retryable error result", async () => {
		const { ctx } = ctxFor(msgs("/verdict"), null);
		ctx.submitVerdict = () => {
			throw new Error("no source is designated");
		};
		const res = await officeHoursTools(ctx).verdict!.execute("t", { items: [] } as never);
		assert.equal((res as { isError?: boolean }).isError, true);
	});
});

describe("agent", () => {
	it("is built with its own tools and instructions naming them", () => {
		const agent = createOfficeHoursAgent(ctxFor(msgs("x"), null).ctx, {
			engine: { model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never, streamFn: (async () => { throw new Error("not streamed"); }) as never },
		});
		assert.equal(typeof agent.prompt, "function");
		for (const name of ["read_source", "verdict", "ask_user_question"]) assert.match(OFFICE_HOURS_INSTRUCTIONS, new RegExp(name));
		assert.match(OFFICE_HOURS_INSTRUCTIONS, /\/verdict/);
	});
});
