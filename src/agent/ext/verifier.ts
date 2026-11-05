// src/agent/ext/verifier.ts
/**
 * The verifier sub-agent: runs on upstream's shared runner (runSubagent) in
 * the researcher role, with the researcher's web and PDF tools plus two tools
 * over the user's library PDFs. It only CLAIMS evidence; verify.ts turns
 * claims into facts (REQ-src-05, 06). It never assigns tiers and never
 * writes anything.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Verifier, VerifierInput } from "../../core/ext/ports.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { SourceEntry } from "../../core/ext/sources.ts";
import { parseVerifierOutput } from "../../core/ext/verifier-output.ts";
import type { PiEngine } from "../models.ts";
import { pdfExtract, pdfSearch } from "../subagents/pdf-ops.ts";
import { runSubagent } from "../subagents/pi-run.ts";
import { serverExecute } from "../tool-execute.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { createWebTools } from "../tools/web.ts";

/** Search budget per node (open item of the spec): 6 model turns each, 10 of overhead, 40 overall. */
export function verifierMaxTurns(nodeCount: number): number {
	return Math.min(40, 10 + 6 * nodeCount);
}

export const VERIFIER_INSTRUCTIONS = `You are a verification specialist inside a learning application. You are given
statements (propositions) from a learner's knowledge graph. For each one, find passages in
trustworthy sources that SUPPORT or CONTRADICT it. You do not judge truth yourself and you do not
write explanations: you return quotations.

Process:
1. Search the user's LIBRARY first. For library PDFs use library_pdf_search and library_pdf_extract
   with the library source id. For library websites, use web_fetch on pages under the listed
   locator. Only then search the open web (web_search, web_fetch, web_fetch_pdf, pdf_*).
2. For each source that bears on a statement, copy ONE passage VERBATIM from the text your tools
   returned. The quote must be contiguous text, at least one full clause (20 characters or more),
   copied character for character. Never paraphrase, never fix typos, never join separate passages.
   Code will re-fetch the source and discard any quote it cannot find, so an invented or edited
   quote is worthless.
   Formulas and symbols are the most fragile part: copy them EXACTLY as the tool text shows them,
   including odd spacing, line breaks, stray symbols and extraction artifacts. Do NOT re-space,
   tidy, normalize or "repair" math (no adding or removing spaces around =, +, sums, integrals or
   subscripts). If a passage is mostly formula and you cannot copy it exactly, quote a nearby
   plain-prose sentence instead.
3. Set stance to "supports" when the passage states the claim or directly entails it, and to
   "contradicts" when the passage states something incompatible with it. If a passage is only
   related, leave it out.
4. sourceRef: for a library PDF use its library id; for a web page or web PDF use the full URL you
   fetched. locator: the page ("p. 12"), section or anchor where the quote sits.
5. Do NOT report tiers or trust levels. Code assigns those from the library.
6. If a source you relied on is clearly authoritative but not in the library, add it to
   proposedSources (kind "url-prefix" with a domain or URL prefix, "pdf", or "repo"; plus a label).
   Proposals are suggestions only; the user decides.
7. If you find nothing for a statement, return an empty evidence list for it. Never invent sources.

Your FINAL message must end with exactly one JSON object in a fenced json block:

\`\`\`json
{
  "results": [
    { "nodeId": "n_…", "evidence": [
      { "sourceRef": "lib_… or https://…", "locator": "p. 12", "quote": "verbatim passage", "stance": "supports" }
    ] }
  ],
  "proposedSources": [ { "kind": "url-prefix", "locator": "https://example.org/", "label": "Example" } ]
}
\`\`\`
Include every nodeId you were given.`;

export function buildVerifierPrompt(input: VerifierInput): string {
	const nodes = input.nodes.map((n) => `- ${n.id}: ${n.statement}`).join("\n");
	const library =
		input.library.length === 0
			? "(the library is empty: search the open web)"
			: input.library.map((e) => `- ${e.id} (${e.kind}, ${e.tier}) ${e.label}: ${e.locator}`).join("\n");
	return `Statements to verify:\n${nodes}\n\nLibrary sources (search these first):\n${library}`;
}

export function createLibraryPdfTools(library: readonly SourceEntry[]): Record<string, AgentTool<any>> {
	const pdfs = new Map(library.filter((e) => e.kind === "pdf" && e.status === "active").map((e) => [e.id, e.locator]));
	const searchInput = Type.Object({
		source_id: Type.String({ description: "A library PDF id from the prompt" }),
		query: Type.String({ description: "Text to find (case-insensitive substring)" }),
	});
	const extractInput = Type.Object({
		source_id: Type.String({ description: "A library PDF id from the prompt" }),
		pages: Type.String({ description: "Pages to extract: 'all', '1-5', '1,3,7' or '3'. Prefer library_pdf_search first for long books." }),
	});
	return {
		library_pdf_search: {
			name: "library_pdf_search",
			label: "library_pdf_search",
			description: "Find text in one of the user's library PDFs. Returns the pages and context lines that hit.",
			parameters: searchInput,
			execute: serverExecute("library_pdf_search", searchInput, async ({ source_id, query }) => {
				const file = pdfs.get(source_id);
				if (file === undefined) return `library_pdf_search failed: unknown library PDF "${source_id}"`;
				try {
					const { hits } = await pdfSearch(file, query, { literal: true });
					return { hits: hits.slice(0, 20) };
				} catch (err) {
					return `library_pdf_search failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
		library_pdf_extract: {
			name: "library_pdf_extract",
			label: "library_pdf_extract",
			description: "Extract the text of pages of one of the user's library PDFs (Markdown, '--- Page N ---' headed).",
			parameters: extractInput,
			execute: serverExecute("library_pdf_extract", extractInput, async ({ source_id, pages }) => {
				const file = pdfs.get(source_id);
				if (file === undefined) return `library_pdf_extract failed: unknown library PDF "${source_id}"`;
				try {
					return await pdfExtract(file, pages);
				} catch (err) {
					return `library_pdf_extract failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
	};
}

export interface VerifierDeps {
	/** Throws when no model is configured; the verify service turns that into check_failed. */
	engine: () => PiEngine;
	search: () => SearchProvider | null;
}

export function createVerifier(deps: VerifierDeps): Verifier {
	return {
		async run(input, hooks) {
			const engine = deps.engine();
			const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-verifier-"));
			try {
				const tools: AgentTool<any>[] = [
					...Object.values(createWebTools(deps.search)),
					...Object.values(createPdfReadTools(pdfDir)),
					...Object.values(createLibraryPdfTools(input.library)),
				];
				const { text } = await runSubagent(tools, {
					role: "researcher",
					engine,
					systemPrompt: VERIFIER_INSTRUCTIONS,
					prompt: buildVerifierPrompt(input),
					maxTurns: verifierMaxTurns(input.nodes.length),
					abortSignal: hooks.signal,
					onUsage: (usage) => hooks.onCostUsd(usage.cost.total),
				});
				return { output: parseVerifierOutput(text), checker: `${engine.model.provider}:${engine.model.id}` };
			} finally {
				await fs.rm(pdfDir, { recursive: true, force: true });
			}
		},
	};
}
