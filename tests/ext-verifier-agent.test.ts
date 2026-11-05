// tests/ext-verifier-agent.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { buildVerifierPrompt, createLibraryPdfTools, createVerifier, verifierMaxTurns } from "../src/agent/ext/verifier.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-verifier-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pdfPath = path.join(dir, "book.pdf");
fs.writeFileSync(pdfPath, tinyPdf([{ runs: [{ text: "Every bounded monotone sequence of reals converges.", x: 72, y: 700 }] }]));

const book: SourceEntry = { id: "lib_book", kind: "pdf", locator: pdfPath, tier: "primary", label: "Analysis", status: "active", addedBy: "user" };
const input = { nodes: [{ id: "n1", statement: "Every bounded monotone sequence of reals converges." }], library: [book] };

describe("verifier prompt and budget", () => {
	it("lists the nodes and the library ids, and tells the agent not to assign tiers", () => {
		const prompt = buildVerifierPrompt(input);
		assert.match(prompt, /n1/);
		assert.match(prompt, /lib_book/);
		assert.match(prompt, /Analysis/);
	});
	it("scales the turn budget with the batch and caps it", () => {
		assert.equal(verifierMaxTurns(1), 16);
		assert.equal(verifierMaxTurns(5), 40);
		assert.equal(verifierMaxTurns(50), 40);
	});
});

describe("library PDF tools", () => {
	it("search and extract only the active library PDFs by id", async () => {
		const tools = createLibraryPdfTools([book]);
		const hit = await tools.library_pdf_search!.execute!("t1", { source_id: "lib_book", query: "monotone" });
		assert.match(JSON.stringify(hit.details), /monotone/);
		const page = await tools.library_pdf_extract!.execute!("t2", { source_id: "lib_book", pages: "1" });
		assert.match(String(page.details), /converges/);
		const unknown = await tools.library_pdf_search!.execute!("t3", { source_id: "lib_other", query: "x" });
		assert.match(String(unknown.details), /unknown library PDF/);
	});
});

describe("createVerifier", () => {
	it("runs the researcher-role loop with the library tools and parses the final JSON", async () => {
		const faux = createFauxCore({});
		const finalJson = JSON.stringify({
			results: [{ nodeId: "n1", evidence: [{ sourceRef: "lib_book", locator: "p. 1", quote: "Every bounded monotone sequence of reals converges.", stance: "supports" }] }],
			proposedSources: [],
		});
		faux.setResponses([
			(context) => {
				const system = context.messages.find((m) => m.role === "system");
				assert.ok(system && system.role === "system");
				assert.match(String(system.content), /verbatim/i);
				assert.match(String(system.content), /Do NOT re-space/);
				assert.ok(system.toolsAdded?.some((t) => t.name === "library_pdf_search"));
				assert.ok(system.toolsAdded?.some((t) => t.name === "web_fetch"));
				return fauxAssistantMessage([fauxToolCall("library_pdf_search", { source_id: "lib_book", query: "monotone" }, { id: "s1" })], { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "s1");
				assert.ok(result && result.role === "toolResult");
				assert.match(JSON.stringify(result.content), /monotone/);
				return fauxAssistantMessage([fauxText("```json\n" + finalJson + "\n```")]);
			},
		]);
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		const costs: number[] = [];
		const run = await verifier.run(input, { signal: new AbortController().signal, onCostUsd: (usd) => costs.push(usd) });
		assert.equal(run.output?.results[0]?.evidence[0]?.sourceRef, "lib_book");
		assert.match(run.checker, /:/);
		assert.ok(costs.length >= 1, "usage is reported to the cost hook");
	});

	it("returns a null output when the final message has no JSON", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxText("I could not find anything.")])]);
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		const run = await verifier.run(input, { signal: new AbortController().signal, onCostUsd: () => {} });
		assert.equal(run.output, null);
	});

	it("propagates an abort as a rejection", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxText("{}")])]);
		const controller = new AbortController();
		controller.abort();
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		await assert.rejects(verifier.run(input, { signal: controller.signal, onCostUsd: () => {} }));
	});
});
