// src/agent/ext/fetch-capture.ts
/**
 * Records what the research agent's fetch tools actually returned, so the text
 * that gets ingested is the tool's text and never something the model wrote
 * (REQ-rs-07: provenance = the source; REQ-rs-09: the model's prose is never
 * ingested). Wraps the researcher's own web_fetch, web_fetch_pdf and pdf_extract;
 * nothing else about them changes, and a tool's result is returned as it came.
 *
 * One capture holds the state of ONE gap: create one per gap, never share it.
 * Texts are keyed by the normalized locator. A text over `maxTextBytes` is never
 * truncated: it is marked not capturable (`oversized()`), so a partial source
 * can not be ingested as if it were whole.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeLocator } from "../../core/ext/inbox.ts";

export interface CapturedPage {
	locator: string;
	title: string;
	text: string;
}

export interface FetchCapture {
	tools: Record<string, AgentTool<any>>;
	/** Capturable pages, in first-seen order (copies). */
	pages(): CapturedPage[];
	/** Locators whose text exceeded the cap: not capturable. */
	oversized(): string[];
}

export interface CaptureLimits {
	/** Largest text (UTF-8 bytes) one locator may hold. Mirrors the store's MAX_SNAPSHOT_BYTES (the agent layer can not import the store). */
	maxTextBytes?: number;
	/** Most distinct locators (capturable or oversized) one capture tracks; later ones are ignored. */
	maxTexts?: number;
}

export const MAX_CAPTURED_TEXT_BYTES = 2 * 1_048_576;
export const MAX_CAPTURED_TEXTS = 50;

interface Entry {
	title: string;
	chunks: string[];
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

export function captureFetches(base: Record<string, AgentTool<any>>, limits: CaptureLimits = {}): FetchCapture {
	const maxBytes = limits.maxTextBytes ?? MAX_CAPTURED_TEXT_BYTES;
	const maxTexts = limits.maxTexts ?? MAX_CAPTURED_TEXTS;
	const pages = new Map<string, Entry>();
	const tooBig = new Set<string>();
	const pdfUrlByPath = new Map<string, string>();

	const add = (rawLocator: string, title: string, text: string, mode: "replace" | "append"): void => {
		const locator = normalizeLocator(rawLocator);
		if (!/^https?:\/\//.test(locator) || tooBig.has(locator)) return;
		const prev = pages.get(locator);
		if (prev === undefined && pages.size + tooBig.size >= maxTexts) return;
		let chunks: string[];
		if (prev === undefined || mode === "replace") chunks = [text];
		else chunks = prev.chunks.includes(text) ? prev.chunks : [...prev.chunks, text];
		const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
		if (bytes > maxBytes) {
			pages.delete(locator);
			tooBig.add(locator);
			return;
		}
		pages.set(locator, { title: mode === "replace" ? title : prev?.title || title, chunks });
	};

	const wrap = (name: string, after: (params: any, result: Awaited<ReturnType<NonNullable<AgentTool<any>["execute"]>>>) => void): AgentTool<any> | undefined => {
		const tool = base[name];
		if (tool === undefined) return undefined;
		return {
			...tool,
			async execute(id, params, signal, onUpdate) {
				const result = await tool.execute(id, params, signal, onUpdate);
				if (result.isError !== true) {
					try {
						after(params, result);
					} catch {
						/* capture is best-effort: it must never change what the tool returned */
					}
				}
				return result;
			},
		};
	};

	const wrapped: Record<string, AgentTool<any>> = { ...base };
	const webFetch = wrap("web_fetch", (params, result) => {
		if (typeof params?.url !== "string") return;
		const text = textOf(result);
		if (text.startsWith("web_fetch failed") || text.startsWith("web_fetch: this URL is a PDF")) return;
		const title = /^# (.+)$/.exec(text.split("\n", 1)[0] ?? "")?.[1] ?? "";
		add(params.url, title, text, "replace");
		// After redirects the tool names the final URL on its Source line: the same text is also recorded under it.
		const source = /^Source: (\S+)/m.exec(text)?.[1];
		if (source !== undefined && normalizeLocator(source) !== normalizeLocator(params.url)) add(source, title, text, "replace");
	});
	if (webFetch) wrapped.web_fetch = webFetch;
	const pdfFetch = wrap("web_fetch_pdf", (_params, result) => {
		const d = result.details as { path?: unknown; url?: unknown } | null;
		if (d !== null && typeof d === "object" && typeof d.path === "string" && typeof d.url === "string") pdfUrlByPath.set(d.path, d.url);
	});
	if (pdfFetch) wrapped.web_fetch_pdf = pdfFetch;
	const pdfExtract = wrap("pdf_extract", (params, result) => {
		const url = typeof params?.path === "string" ? pdfUrlByPath.get(params.path) : undefined;
		const text = textOf(result);
		if (url === undefined || text.startsWith("pdf_extract failed")) return;
		add(url, "", text, "append");
	});
	if (pdfExtract) wrapped.pdf_extract = pdfExtract;

	return {
		tools: wrapped,
		pages: () => [...pages].map(([locator, e]) => ({ locator, title: e.title, text: e.chunks.join("\n\n") })),
		oversized: () => [...tooBig],
	};
}
