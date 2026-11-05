// tests/ext-gap-research.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessageEventStream, type StreamFunction } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import type { GapError } from "../src/core/ext/research-ports.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";
import { buildGapPrompt, createGapResearcher, GAP_RESEARCH_INSTRUCTIONS, type GapBrief, type GapResearchHooks } from "../src/agent/ext/gap-research.ts";
import { toToolResult } from "../src/agent/tool-execute.ts";

const brief: GapBrief = { type: "no-premises", label: "Backpropagation", statement: "Gradients flow backwards.", premises: ["The chain rule holds."], activeLocators: ["https://docs.org/"] };

const fetchInput = Type.Object({ url: Type.String() });

/** A web_fetch stand-in: a page's text is what it returns, per URL; unknown URLs get a normal page. */
function fetchTool(pages: Record<string, string> = {}): AgentTool<typeof fetchInput> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "fetch",
		parameters: fetchInput,
		execute: async (_id, p) => {
			const url = p.url;
			return toToolResult(pages[url] ?? `# Page ${url}\n\nSource: ${url} (HTTP 200)\n\nBody of ${url}.`);
		},
	};
}

const writeTool: AgentTool<any> = {
	name: "write_file",
	label: "write_file",
	description: "must never be offered to the research agent",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => toToolResult("written"),
};

/** A cost gate with a daily ceiling: spend is summed, and the gate closes at the ceiling. */
function gate(ceiling = 100) {
	const records: Array<{ usd: number; source: string }> = [];
	let total = 0;
	const g = {
		records,
		allowed: () => total < ceiling,
		record(usd: number, source: string) {
			records.push({ usd, source });
			total += usd;
		},
	};
	return g as CostGate & { records: typeof records };
}

function hooks(over: Partial<GapResearchHooks> = {}): GapResearchHooks & { costGate: ReturnType<typeof gate> } {
	return {
		signal: new AbortController().signal,
		costGate: gate(),
		confidenceThreshold: 0.8,
		maxTurns: 6,
		maxSources: 20,
		...over,
	} as GapResearchHooks & { costGate: ReturnType<typeof gate> };
}

/**
 * The faux provider always reports zero cost, so the stream is wrapped: the i-th model call of a run
 * reports prices[i] (USD) in its done event, as a priced provider would.
 */
function pricedStream(base: StreamFunction<any>, prices: number[]): StreamFunction<any> {
	let call = 0;
	return (model, context, options) => {
		const usd = prices[call++] ?? 0;
		const inner = base(model, context, options);
		const out: AssistantMessageEventStream = createAssistantMessageEventStream();
		(async () => {
			for await (const event of inner) {
				if (event.type === "done") event.message.usage.cost.total = usd;
				out.push(event);
			}
		})()
			.catch(() => undefined)
			.finally(() => out.end());
		return out;
	};
}

function setup(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], tools: AgentTool<any>[] = [fetchTool()], prices: number[] = []) {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	const researcher = createGapResearcher({
		engine: () => ({ model: faux.getModel(), streamFn: pricedStream(faux.streamSimple, prices) as never }),
		search: () => null,
		baseTools: () => Object.fromEntries(tools.map((t) => [t.name, t])),
	});
	return { faux, researcher };
}

const report = (over: Record<string, unknown> = {}) =>
	fauxToolCall("report_findings", { questions: ["why?"], confidence: 0.9, rationale: "clear", stopped_by: "confidence", sources: ["https://docs.org/bp"], ...over }, { id: "r1" });

function userTexts(messages: readonly unknown[]): string[] {
	return messages
		.filter((m): m is { role: string; content: unknown } => typeof m === "object" && m !== null && (m as { role?: unknown }).role === "user")
		.map((m) => JSON.stringify(m.content));
}

describe("prompt", () => {
	it("carries the brief, the library and the steering; the instructions demand reading what is cited", () => {
		const p = buildGapPrompt(brief, 0.8, ["focus on proofs"]);
		for (const needle of ["Backpropagation", "The chain rule holds.", "https://docs.org/", "0.8", "focus on proofs"]) assert.ok(p.includes(needle), needle);
		assert.match(GAP_RESEARCH_INSTRUCTIONS, /A source you did not fetch cannot be used/);
	});

	it("states that fetched page content is untrusted data, never instructions (prompt-injection hardening)", () => {
		assert.match(GAP_RESEARCH_INSTRUCTIONS, /untrusted data/i);
		assert.match(GAP_RESEARCH_INSTRUCTIONS, /never instructions/i);
		assert.match(GAP_RESEARCH_INSTRUCTIONS, /do not follow/i);
		assert.match(GAP_RESEARCH_INSTRUCTIONS, /fetched pages?/i);
	});
});

describe("createGapResearcher", () => {
	it("returns the report, with the text the fetch tool returned for each cited and fetched URL", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([report({ sources: ["https://docs.org/bp", "https://ghost.org/never-fetched"] })], { stopReason: "toolUse" }),
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual([f.confidence, f.stoppedBy, f.questions, f.rationale], [0.9, "confidence", ["why?"], "clear"]);
		assert.deepEqual(f.sources.map((s) => [s.locator, s.title]), [["https://docs.org/bp", "Page https://docs.org/bp"]]);
		assert.match(f.sources[0]!.text, /Body of https:\/\/docs\.org\/bp\./);
		assert.deepEqual(f.unfetched, ["https://ghost.org/never-fetched"]);
		assert.deepEqual(f.notCapturable, []);
	});

	it("ingests only tool text: prose the model wrote is never a source text (REQ-rs-09)", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([fauxText("INVENTED PROSE the model wrote"), fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([report({ rationale: "INVENTED RATIONALE" })], { stopReason: "toolUse" }),
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.equal(f.sources.length, 1);
		assert.equal(f.sources[0]!.text.includes("INVENTED PROSE"), false);
		assert.equal(f.sources[0]!.text.includes("INVENTED RATIONALE"), false);
		assert.equal(f.sources[0]!.text.includes("Body of https://docs.org/bp."), true);
	});

	it("a cited URL whose fetch failed is unfetched, not a source", async () => {
		const failing = fetchTool({ "https://broken.org/x": "web_fetch failed: HTTP 500" });
		const { researcher } = setup(
			[
				() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://broken.org/x" }, { id: "f1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([report({ sources: ["https://broken.org/x"] })], { stopReason: "toolUse" }),
			],
			[failing],
		);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual(f.sources, []);
		assert.deepEqual(f.unfetched, ["https://broken.org/x"]);
	});

	it("a page the tool truncated is not capturable: reported as notCapturable, never unfetched and never ingested", async () => {
		const truncated = `# Long\n\nSource: https://long.org/paper (HTTP 200)\n\n${"x".repeat(50)}\n\n[Truncated at 40000 characters]`;
		const { researcher } = setup(
			[
				() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://long.org/paper" }, { id: "f1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([report({ sources: ["https://long.org/paper"] })], { stopReason: "toolUse" }),
			],
			[fetchTool({ "https://long.org/paper": truncated })],
		);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual(f.sources, []);
		assert.deepEqual(f.unfetched, []);
		assert.deepEqual(f.notCapturable, ["https://long.org/paper"]);
	});

	it("matches cited locators to captured pages by normalized locator and dedupes them", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([report({ sources: ["https://docs.org/bp", "https://docs.org/bp/", "  https://docs.org/bp  "] })], { stopReason: "toolUse" }),
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual(f.sources.map((s) => s.locator), ["https://docs.org/bp"]);
		assert.deepEqual(f.unfetched, []);
	});

	it("caps the sources of a finding at maxSources", async () => {
		const urls = ["https://a.org/1", "https://a.org/2", "https://a.org/3"];
		const { researcher } = setup([
			() => fauxAssistantMessage(urls.map((u, i) => fauxToolCall("web_fetch", { url: u }, { id: `f${i}` })), { stopReason: "toolUse" }),
			() => fauxAssistantMessage([report({ sources: urls })], { stopReason: "toolUse" }),
		]);
		const f = await researcher.run(brief, [], hooks({ maxSources: 2 }));
		assert.deepEqual(f.sources.map((s) => s.locator), ["https://a.org/1", "https://a.org/2"]);
	});

	it("refuses confidence below the threshold, so the agent keeps going or reports no-more-sources (REQ-rs-04)", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([report({ confidence: 0.4 })], { stopReason: "toolUse" }),
			(ctx) => {
				const err = ctx.messages.find((m) => m.role === "toolResult" && m.toolCallId === "r1");
				assert.ok(err && err.role === "toolResult" && err.isError);
				assert.match(JSON.stringify(err.content), /below the threshold/);
				return fauxAssistantMessage([report({ confidence: 0.4, stopped_by: "no-more-sources", sources: [] })], { stopReason: "toolUse" });
			},
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual([f.confidence, f.stoppedBy], [0.4, "no-more-sources"]);
	});

	it("a confidence exactly at the threshold is accepted", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([report({ confidence: 0.8, sources: [] })], { stopReason: "toolUse" })]);
		const f = await researcher.run(brief, [], hooks());
		assert.deepEqual([f.confidence, f.stoppedBy], [0.8, "confidence"]);
	});

	it("an invalid report is an input error the model can retry, not a throw (review rule 6)", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([report({ confidence: "high" })], { stopReason: "toolUse" }),
			(ctx) => {
				const err = ctx.messages.find((m) => m.role === "toolResult" && m.toolCallId === "r1");
				assert.ok(err && err.role === "toolResult" && err.isError, "the invalid report comes back as an error result");
				return fauxAssistantMessage([report()], { stopReason: "toolUse" });
			},
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.equal(f.stoppedBy, "confidence");
	});

	it("a non-http source in a report is refused as input, and the run goes on", async () => {
		const { researcher } = setup([
			() => fauxAssistantMessage([report({ sources: ["javascript:alert(1)"] })], { stopReason: "toolUse" }),
			(ctx) => {
				const err = ctx.messages.find((m) => m.role === "toolResult" && m.toolCallId === "r1");
				assert.ok(err && err.role === "toolResult" && err.isError);
				assert.match(JSON.stringify(err.content), /http/);
				return fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" });
			},
		]);
		const f = await researcher.run(brief, [], hooks());
		assert.equal(f.stoppedBy, "confidence");
	});

	it("an agent that never reports ends as turn-limit with no sources", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/a" }, { id: "f1" })], { stopReason: "toolUse" })]);
		const f = await researcher.run(brief, [], hooks({ maxTurns: 1 }));
		assert.deepEqual([f.stoppedBy, f.sources, f.confidence], ["turn-limit", [], 0]);
	});

	it("a run that ends with no report before the turn limit throws a GapError with the spend (review rule 1)", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([fauxText("I am done, no report.")])], [fetchTool()], [0.03]);
		const err = (await researcher.run(brief, [], hooks()).then(
			() => null,
			(e: unknown) => e,
		)) as GapError | null;
		assert.ok(err instanceof Error);
		assert.equal(err.costUsd, 0.03);
		assert.match(err.message, /without a report/);
	});

	it("records every model call's spend through the shared cost gate and reports the total (REQ-cost-01)", async () => {
		const { researcher } = setup(
			[
				() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" }),
			],
			[fetchTool()],
			[0.02, 0.05],
		);
		const g = gate();
		const f = await researcher.run(brief, [], hooks({ costGate: g }));
		assert.deepEqual(g.records, [
			{ usd: 0.02, source: "research" },
			{ usd: 0.05, source: "research" },
		]);
		assert.equal(f.costUsd, 0.07);
	});

	it("a closed daily ceiling refuses before any model call", async () => {
		const { researcher, faux } = setup([() => fauxAssistantMessage([report()], { stopReason: "toolUse" })]);
		const err = (await researcher.run(brief, [], hooks({ costGate: gate(0) })).then(
			() => null,
			(e: unknown) => e,
		)) as GapError | null;
		assert.ok(err instanceof Error);
		assert.equal(err.costUsd, 0);
		assert.equal(faux.state.callCount, 0);
	});

	it("the ceiling reached mid-run stops the loop after the call that crossed it (REQ-cost-01)", async () => {
		const { researcher, faux } = setup(
			[
				() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" }),
			],
			[fetchTool()],
			[0.5],
		);
		const err = (await researcher.run(brief, [], hooks({ costGate: gate(0.4) })).then(
			() => null,
			(e: unknown) => e,
		)) as GapError | null;
		assert.ok(err instanceof Error);
		assert.equal(err.costUsd, 0.5);
		assert.equal(faux.state.callCount, 1);
	});

	it("propagates an abort as an AbortError carrying the spend", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([report()], { stopReason: "toolUse" })], [fetchTool()], [0.01]);
		const c = new AbortController();
		c.abort();
		const err = (await researcher.run(brief, [], hooks({ signal: c.signal })).then(
			() => null,
			(e: unknown) => e,
		)) as (GapError & { name: string }) | null;
		assert.ok(err instanceof Error);
		assert.match(`${err.name} ${err.message}`, /abort/i);
		assert.equal(typeof err.costUsd, "number");
	});

	it("a provider error's text never reaches the thrown message (review rule 7)", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom https://secret.example/?key=TOPSECRET" })]);
		const err = (await researcher.run(brief, [], hooks()).then(
			() => null,
			(e: unknown) => e,
		)) as GapError | null;
		assert.ok(err instanceof Error);
		assert.equal(err.message.includes("TOPSECRET"), false);
		assert.equal(err.message.includes("http"), false);
		assert.equal(err.costUsd, 0);
	});

	it("a missing model configuration is rethrown as the same error class, so the cycle can stop (review rule 1)", async () => {
		const researcher = createGapResearcher({
			engine: () => {
				throw new ModelsNotConfiguredError([] as never);
			},
			search: () => null,
			baseTools: () => ({}),
		});
		await assert.rejects(researcher.run(brief, [], hooks()), (e: unknown) => e instanceof ModelsNotConfiguredError && (e as GapError).costUsd === 0);
	});

	it("hands the live agent to the caller (steering seam, REQ-rs-16)", async () => {
		const { researcher } = setup([() => fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" })]);
		let agent: unknown = null;
		await researcher.run(brief, [], hooks({ onAgent: (a) => (agent = a) }));
		assert.equal(typeof (agent as { steer?: unknown }).steer, "function");
	});

	it("a steering message drained mid-run reaches the agent on its next turn; non-string steers are ignored", async () => {
		let drained = false;
		const { researcher } = setup([
			() => fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.org/bp" }, { id: "f1" })], { stopReason: "toolUse" }),
			(ctx) => {
				const seen = userTexts(ctx.messages);
				assert.ok(seen.some((t) => t.includes("stick to proofs")), "the steer is in the transcript");
				assert.equal(seen.some((t) => t.includes("42")), false, "a non-string steer is never delivered");
				return fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" });
			},
		]);
		await researcher.run(brief, [], hooks({
			takeSteers: () => {
				if (drained) return [];
				drained = true;
				return [42 as unknown as string, "stick to proofs"];
			},
		}));
	});

	it("initial steers that are not strings are dropped from the prompt", async () => {
		const { researcher } = setup([
			(ctx) => {
				const seen = userTexts(ctx.messages);
				assert.ok(seen.some((t) => t.includes("focus on proofs")));
				assert.equal(seen.some((t) => t.includes("- 42")), false);
				return fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" });
			},
		]);
		await researcher.run(brief, [42 as unknown as string, "focus on proofs"], hooks());
	});

	it("only the research tools are offered: a write tool supplied by the base set is not callable (least privilege)", async () => {
		const { researcher } = setup(
			[
				() => fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/x" }, { id: "w1" })], { stopReason: "toolUse" }),
				(ctx) => {
					const result = ctx.messages.find((m) => m.role === "toolResult" && m.toolCallId === "w1");
					assert.ok(result && result.role === "toolResult" && result.isError, "the write tool is not offered, so the call fails");
					assert.equal(JSON.stringify(result.content).includes("written"), false);
					return fauxAssistantMessage([report({ sources: [] })], { stopReason: "toolUse" });
				},
			],
			[fetchTool(), writeTool],
		);
		const f = await researcher.run(brief, [], hooks());
		assert.equal(f.stoppedBy, "confidence");
	});
});
