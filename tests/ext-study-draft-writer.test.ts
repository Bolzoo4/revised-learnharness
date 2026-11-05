// tests/ext-study-draft-writer.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { cardPrompt, draftCard, MAX_PROPOSITION_CHARS, pagesPrompt, proposePageDrafts } from "../src/agent/ext/study/draft-writer.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (name: string, input: unknown): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall(name, input as never, { id: `${name}-1` })], { stopReason: "toolUse" });
function gate(blocked = false): CostGate & { recorded: { usd: number; source: string }[] } {
	const g = { recorded: [] as { usd: number; source: string }[], allowed: () => !blocked, record: (usd: number, source: string) => void g.recorded.push({ usd, source }) };
	return g;
}
const priceStep = () => 0.25;
const card = { proposition: " A sigma algebra is closed under complement. ", question: "What is a sigma algebra closed under?", answer: "Complement and countable unions." };

describe("draftCard (REQ-study-08)", () => {
	it("returns the trimmed proposition and the question/answer, and bills source 'study'", async () => {
		const g = gate();
		const out = await draftCard({ engine: fauxEngine([submit("submit_card", card)]), gate: g, priceStep }, { title: "Prob", page: 3, from: "selection", text: "sigma algebra" });
		assert.deepEqual(out, { ...card, proposition: "A sigma algebra is closed under complement." });
		assert.deepEqual(g.recorded[0], { usd: 0.25, source: "study" });
	});
	it("makes the model retry an empty field or an over-long proposition inside its turn budget", async () => {
		const engine = fauxEngine([
			submit("submit_card", { ...card, answer: "  " }),
			submit("submit_card", { ...card, proposition: "x".repeat(MAX_PROPOSITION_CHARS + 1) }),
			submit("submit_card", card),
		]);
		const out = await draftCard({ engine, gate: gate(), priceStep }, { title: "Prob", page: 3, from: "page", text: "t" });
		assert.equal(out.answer, card.answer);
	});
	it("refuses to call the model when the gate is closed", async () => {
		await assert.rejects(draftCard({ engine: fauxEngine([submit("submit_card", card)]), gate: gate(true), priceStep }, { title: "T", page: 1, from: "page", text: "t" }), (e: unknown) => e instanceof CostCeilingError);
	});
	it("the prompt names the document, the page and whether the text is a selection", () => {
		assert.match(cardPrompt({ title: "Prob", page: 3, from: "selection", text: "abc" }), /Prob, page 3\.\nThe learner selected this passage:\n<<<TEXT\nabc\nTEXT>>>/);
		assert.match(cardPrompt({ title: "Prob", page: 3, from: "page", text: "abc" }), /asked for a card from this page/);
	});
});

describe("proposePageDrafts (REQ-study-11)", () => {
	const input = { title: "Prob", pages: [{ page: 4, text: "four" }, { page: 5, text: "five" }], known: [{ page: 4, statement: "Already here." }] };
	it("returns drafts with their pages", async () => {
		const drafts = [{ page: 5, ...card }];
		const out = await proposePageDrafts({ engine: fauxEngine([submit("submit_drafts", { drafts })]), gate: gate(), priceStep }, input);
		assert.deepEqual(out, [{ page: 5, ...card, proposition: "A sigma algebra is closed under complement." }]);
	});
	it("allows an empty list", async () => {
		assert.deepEqual(await proposePageDrafts({ engine: fauxEngine([submit("submit_drafts", { drafts: [] })]), gate: gate(), priceStep }, input), []);
	});
	it("makes the model retry a page that was not given", async () => {
		const engine = fauxEngine([submit("submit_drafts", { drafts: [{ page: 9, ...card }] }), submit("submit_drafts", { drafts: [{ page: 4, ...card }] })]);
		const out = await proposePageDrafts({ engine, gate: gate(), priceStep }, input);
		assert.equal(out[0]!.page, 4);
	});
	it("the prompt lists what is already known and each page between markers", () => {
		const p = pagesPrompt(input);
		assert.match(p, /Already known \(do not repeat\):\n- \(p\. 4\) Already here\./);
		assert.match(p, /<<<PAGE 4\nfour\nPAGE 4>>>\n<<<PAGE 5\nfive\nPAGE 5>>>/);
	});
	it("refuses to call the model when the gate is closed", async () => {
		await assert.rejects(proposePageDrafts({ engine: fauxEngine([]), gate: gate(true), priceStep }, input), (e: unknown) => e instanceof CostCeilingError);
	});
});
