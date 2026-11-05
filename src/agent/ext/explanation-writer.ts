// src/agent/ext/explanation-writer.ts
/**
 * The explanation writer (agent layer): one submit call per batch through
 * the shared runSubmitAgent seam. It knows nothing about storage or cost
 * policy: the engine and the call pricing arrive as arguments (the agent
 * layer may not import server or store). Link and placeholder validation is
 * NOT done here: the core service owns the deterministic checks and the
 * "regenerate at most twice" rule (REQ-node-08); this module only refuses a
 * submit that does not cover exactly the requested nodes.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../../config.ts";
import type { CallUsage } from "../../core/contracts.ts";
import type { ExplanationWriter, WriterRequest } from "../../core/ext/node-knowledge-ports.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "../subagents/submit-agent.ts";

const DEFAULT_STYLE_FILE = path.join(PATHS.root, "src", "agent", "ext", "prompts", "explanation-style.md");
/** The user's editable copy; present and non-blank means it replaces the default. */
const OVERRIDE_STYLE_FILE = path.join(PROMPTS_OVERRIDE_DIR, "ext", "explanation-style.md");

/** First non-blank file wins; read fresh on every call so edits land immediately. */
export function loadStyleGuide(files: readonly string[] = [OVERRIDE_STYLE_FILE, DEFAULT_STYLE_FILE]): string {
	for (const file of files) {
		try {
			const text = fs.readFileSync(file, "utf-8");
			if (text.trim() !== "") return text;
		} catch {
			// missing file: try the next
		}
	}
	throw new Error("explanation style guide is missing: expected src/agent/ext/prompts/explanation-style.md");
}

/** Structure and link rules; code, not the editable style guide (the checks depend on them). */
export const STRUCTURE_RULES = [
	"STRUCTURE. Write each explanation in Markdown with these parts, in this order:",
	"1. Optionally, a short intuition (two or three sentences, labelled as an intuition).",
	"2. The precise explanation of the statement.",
	"3. Why it holds: tie it to the premises of the arguments you are given.",
	"4. An example.",
	"5. Common confusions.",
	"Use the SHORT form (about one paragraph per part) or the LONG form (several paragraphs per part, including every premise of every argument) as each node says.",
	"LINKS. When you mention another node of the graph, write its id between double square brackets, for example [[n_abc123def456]], and only use ids from that node's LINKABLE list. Never write any other id.",
	"Never leave placeholders such as TODO, TBD or [...]. Submit exactly one explanation for every requested node with submit_explanations.",
].join("\n");

const submitSchema = Type.Object({
	explanations: Type.Array(
		Type.Object({
			nodeId: Type.String({ description: "The id of the node, exactly as given after NODE." }),
			body: Type.String({ description: "The explanation in Markdown." }),
		}),
	),
});
type Submit = Static<typeof submitSchema>;

export function buildWriterPrompt(request: WriterRequest): string {
	const parts: string[] = [];
	if (request.source === null) {
		parts.push("No source text is available. Explain from the statements and arguments below only.");
	} else {
		parts.push("SOURCE TEXT. Ground every explanation in this text and stay inside it:", request.source.text);
	}
	parts.push("");
	for (const n of request.nodes) {
		parts.push(`NODE ${n.id}: ${n.name}`);
		parts.push(`Statement: ${n.statement}`);
		if (n.aliases.length > 0) parts.push(`Other phrasings: ${n.aliases.join(" | ")}`);
		parts.push(n.form === "long" ? "Write the long form." : "Write the short form.");
		n.arguments.forEach((premises, i) => {
			parts.push(`Argument ${i + 1}: ${premises.map((p) => `${p.name} [${p.id}] (${p.statement})`).join("; ")} together imply this node.`);
		});
		const linkable = [...n.arguments.flat().map((p) => ({ id: p.id, name: p.name })), ...n.usedIn];
		const unique = [...new Map(linkable.map((l) => [l.id, l])).values()];
		if (unique.length > 0) parts.push(`LINKABLE: ${unique.map((l) => `[[${l.id}]] ${l.name}`).join("; ")}`);
		const problems = request.feedback[n.id];
		if (problems !== undefined && problems.length > 0) {
			parts.push(`Your previous attempt was refused. Fix: ${problems.join("; ")}`);
		}
		parts.push("");
	}
	return parts.join("\n");
}

export function createExplanationWriter(opts: {
	engine: PiEngine;
	/** Prices one model call; null = unknown (counted as zero). server/pricing.ts callCost fits. */
	priceCall: (call: Partial<CallUsage>, modelId: string) => number | null;
	/** Test seam; defaults to loadStyleGuide. */
	styleGuide?: () => string;
	signal?: AbortSignal;
}): ExplanationWriter {
	return {
		async write(request) {
			const style = (opts.styleGuide ?? (() => loadStyleGuide()))();
			const wanted = new Set(request.nodes.map((n) => n.id));
			let costUsd = 0;
			const submitted = await runSubmitAgent<Submit>({
				role: "teacher",
				toolName: "submit_explanations",
				toolDescription: "Submit one explanation per requested node.",
				parameters: submitSchema,
				fill: (input) => input as Submit,
				systemPrompt: `${style.trim()}\n\n${STRUCTURE_RULES}`,
				prompt: buildWriterPrompt(request),
				engine: opts.engine,
				signal: opts.signal,
				onStep: (usage, model) => {
					costUsd +=
						opts.priceCall(
							{
								inputTokens: usage.input,
								outputTokens: usage.output,
								cacheReadTokens: usage.cacheRead,
								cacheWriteTokens: usage.cacheWrite,
								cacheWrite1hTokens: usage.cacheWrite1h,
								reasoningTokens: usage.reasoning,
							},
							model,
						) ?? 0;
				},
				neverSubmitted: "The explanation writer ended without submitting explanations.",
				validate: (value) => {
					const ids = value.explanations.map((e) => e.nodeId);
					const unknown = ids.find((id) => !wanted.has(id));
					if (unknown !== undefined) return `explanations: "${unknown}" is not one of the requested nodes.`;
					const missing = [...wanted].find((id) => !ids.includes(id));
					if (missing !== undefined) return `explanations: the requested node "${missing}" has no explanation.`;
					if (new Set(ids).size !== ids.length) return "explanations: each node must appear exactly once.";
					return null;
				},
			});
			const bodies: Record<string, string> = {};
			for (const e of submitted.explanations) bodies[e.nodeId] = e.body;
			return {
				bodies,
				costUsd,
				styleVersion: createHash("sha256").update(style).digest("hex").slice(0, 12),
			};
		},
	};
}
