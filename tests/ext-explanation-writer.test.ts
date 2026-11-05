// tests/ext-explanation-writer.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import {
	buildWriterPrompt,
	createExplanationWriter,
	loadStyleGuide,
	STRUCTURE_RULES,
} from "../src/agent/ext/explanation-writer.ts";
import type { WriterRequest } from "../src/core/ext/node-knowledge-ports.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (payload: unknown, id = "submit-call"): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("submit_explanations", payload as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const request: WriterRequest = {
	nodes: [
		{
			id: "n_b", name: "Beta", statement: "Beta follows from alpha.", aliases: ["B"], form: "long",
			arguments: [[{ id: "n_a", name: "Alpha", statement: "Alpha holds." }]],
			usedIn: [{ id: "n_c", name: "Gamma" }],
		},
	],
	source: null,
	feedback: {},
};

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(text: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-style-"));
	dirs.push(d);
	const f = path.join(d, "style.md");
	fs.writeFileSync(f, text);
	return f;
}

describe("loadStyleGuide (REQ-node-07)", () => {
	it("prefers the first non-empty file, falls back past a missing or blank one", () => {
		const blank = tmpFile("   \n");
		const mine = tmpFile("MY STYLE");
		assert.equal(loadStyleGuide(["/nonexistent/x.md", blank, mine]), "MY STYLE");
	});
	it("ships a default guide with the controlled-language principles", () => {
		assert.match(loadStyleGuide(), /short sentences/i);
	});
	it("throws when no file is usable", () => {
		assert.throws(() => loadStyleGuide(["/nonexistent/x.md"]), /style guide/i);
	});
});

describe("buildWriterPrompt", () => {
	it("names each node with its statement, arguments, linkable ids and form", () => {
		const prompt = buildWriterPrompt(request);
		assert.match(prompt, /NODE n_b/);
		assert.match(prompt, /Beta follows from alpha\./);
		assert.match(prompt, /Alpha holds\./);
		assert.match(prompt, /\[\[n_a\]\]/);
		assert.match(prompt, /\[\[n_c\]\]/);
		assert.match(prompt, /long form/i);
	});

	it("says there is no source text when none is given, and quotes it when given (REQ-node-09)", () => {
		assert.match(buildWriterPrompt(request), /No source text is available/);
		assert.match(buildWriterPrompt({ ...request, source: { text: "THE CHAPTER", refs: ["h"] } }), /THE CHAPTER/);
	});

	it("repeats the previous problems of a node on a regeneration (REQ-node-08)", () => {
		const prompt = buildWriterPrompt({ ...request, feedback: { n_b: ["link [[n_x]] does not resolve to an existing node"] } });
		assert.match(prompt, /previous attempt was refused/i);
		assert.match(prompt, /n_x/);
	});
});

describe("createExplanationWriter", () => {
	it("returns the submitted bodies, the style version and the priced cost", async () => {
		const seen: { system: string; user: string }[] = [];
		const engine = fauxEngine([
			(context) => {
				const text = (m: { content: unknown } | undefined) =>
					m === undefined ? "" : typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
				seen.push({
					system: text(context.messages.find((m) => m.role === "system")),
					user: text(context.messages.find((m) => m.role === "user")),
				});
				return fauxAssistantMessage(
					[fauxToolCall("submit_explanations", { explanations: [{ nodeId: "n_b", body: "Beta holds because [[n_a]]." }] } as ToolCall["arguments"], { id: "c1" })],
					{ stopReason: "toolUse" },
				);
			},
		]);
		const writer = createExplanationWriter({ engine, priceCall: () => 0.25, styleGuide: () => "STYLE-GUIDE-TEXT" });
		const result = await writer.write(request);
		assert.deepEqual(result.bodies, { n_b: "Beta holds because [[n_a]]." });
		assert.equal(result.costUsd, 0.25);
		assert.match(result.styleVersion, /^[0-9a-f]{12}$/);
		assert.match(seen[0]?.system ?? "", /STYLE-GUIDE-TEXT/);
		assert.ok((seen[0]?.system ?? "").includes(STRUCTURE_RULES));
		assert.match(seen[0]?.user ?? "", /NODE n_b/);
	});

	it("a different style guide gives a different style version", async () => {
		const run = async (style: string) => {
			const engine = fauxEngine([submit({ explanations: [{ nodeId: "n_b", body: "Text." }] })]);
			return (await createExplanationWriter({ engine, priceCall: () => 0, styleGuide: () => style }).write(request)).styleVersion;
		};
		assert.notEqual(await run("one"), await run("two"));
	});

	it("refuses a submit that misses a requested node or names an unknown one, and the model retries", async () => {
		const engine = fauxEngine([
			submit({ explanations: [{ nodeId: "n_other", body: "Wrong." }] }, "bad"),
			submit({ explanations: [{ nodeId: "n_b", body: "Right." }] }, "good"),
		]);
		const writer = createExplanationWriter({ engine, priceCall: () => 0.1, styleGuide: () => "S" });
		const result = await writer.write(request);
		assert.deepEqual(result.bodies, { n_b: "Right." });
		assert.ok(Math.abs(result.costUsd - 0.2) < 1e-9, "both model calls are priced");
	});

	it("treats an unpriced call as zero cost", async () => {
		const engine = fauxEngine([submit({ explanations: [{ nodeId: "n_b", body: "Text." }] })]);
		const result = await createExplanationWriter({ engine, priceCall: () => null, styleGuide: () => "S" }).write(request);
		assert.equal(result.costUsd, 0);
	});
});
