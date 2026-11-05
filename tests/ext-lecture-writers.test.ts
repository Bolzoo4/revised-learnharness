import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../src/agent/ext/lecture/writers.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { lecturePrompt } from "../src/agent/ext/lecture/prompts.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (name: string, input: unknown): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall(name, input as never, { id: `${name}-1` })], { stopReason: "toolUse" });

function gate(blocked = false): CostGate & { recorded: { usd: number; source: string }[] } {
	const g = {
		recorded: [] as { usd: number; source: string }[],
		allowed: () => !blocked,
		record: (usd: number, source: string) => void g.recorded.push({ usd, source }),
	};
	return g;
}
const priceStep = () => 0.5;
const chapter = { index: 1, title: "One", pageStart: 1, pageEnd: 9 };

describe("writers", () => {
	it("writeOutline returns the submitted blocks and records usage on the gate", async () => {
		const blocks = [{ title: "Sigma algebra", kind: "definition", summary: "s" }];
		const g = gate();
		const out = await writeOutline({ engine: fauxEngine([submit("submit_outline", { blocks })]), gate: g, priceStep }, chapter, "text");
		assert.deepEqual(out, blocks);
		assert.deepEqual(g.recorded[0], { usd: 0.5, source: "lecture" });
	});
	it("writeLectureDraft returns the draft", async () => {
		const l = makeLecture();
		const draft = { title: l.title, summary: l.summary, slides: l.slides, blocks: l.blocks };
		const out = await writeLectureDraft(
			{ engine: fauxEngine([submit("submit_lecture", draft)]), gate: gate(), priceStep },
			{ bookTitle: "B", chapter, order: 1, lectureCount: 1, blocks: [], nodes: [], previousSummary: null, chapterText: "t", feedback: null },
		);
		assert.equal(out.title, l.title);
		assert.equal(out.blocks.length, 4);
	});
	it("refuses to call the model once the cost ceiling is reached", async () => {
		const engine = fauxEngine([submit("submit_outline", { blocks: [{ title: "a", kind: "remark", summary: "s" }] })]);
		await assert.rejects(writeOutline({ engine, gate: gate(true), priceStep }, chapter, "t"), (e: unknown) => e instanceof CostCeilingError);
	});
	it("chapter detection retries inside the model turn when the proposal is invalid", async () => {
		const engine = fauxEngine([
			submit("submit_chapters", { chapters: [{ title: "A", page: 99 }] }),
			submit("submit_chapters", { chapters: [{ title: "A", page: 1 }, { title: "B", page: 5 }] }),
		]);
		const out = await detectChaptersWithLlm({ engine, gate: gate(), priceStep }, "excerpt", 10);
		assert.deepEqual(out, [{ title: "A", page: 1 }, { title: "B", page: 5 }]);
	});
});

describe("lecturePrompt", () => {
	it("carries the node ids, the previous summary, the outline and the feedback", () => {
		const p = lecturePrompt({
			bookTitle: "Book", chapter, order: 2, lectureCount: 3,
			blocks: [{ title: "T", kind: "theorem", summary: "S" }],
			nodes: [{ id: "n_abc123", name: "Name", statement: "Stmt" }],
			previousSummary: "Earlier we saw X.", chapterText: "SOURCE", feedback: "FIX THIS",
		});
		for (const needle of ["lecture 2 of 3", "[n_abc123] Name: Stmt", "Earlier we saw X.", "(theorem) T: S", "SOURCE", "FIX THIS"]) assert.ok(p.includes(needle), needle);
	});
	it("says the first lecture has no previous summary", () => {
		const p = lecturePrompt({ bookTitle: "B", chapter, order: 1, lectureCount: 1, blocks: [], nodes: [], previousSummary: null, chapterText: "t", feedback: null });
		assert.match(p, /this is the first lecture/);
	});
});
