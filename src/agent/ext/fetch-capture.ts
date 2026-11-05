// src/agent/ext/fetch-capture.ts
/**
 * Records what the research agent's fetch tools actually returned, so the text
 * that gets ingested is the tool's text and never something the model wrote
 * (REQ-rs-07: provenance = the source; REQ-rs-09: the model's prose is never
 * ingested). Wraps the researcher's own web_fetch, web_fetch_pdf and pdf_extract;
 * nothing else about them changes, and a tool's result is returned as it came.
 *
 * One capture holds the state of ONE gap: create one per gap, never share it.
 * Texts are keyed by the normalized locator. Nothing is truncated: a page the
 * tool itself cut (its "[Truncated at N characters]" end marker), or a text that
 * would take the capture past `maxTotalBytes`, is marked not capturable and is
 * reported by `oversized()`, so a partial source is never ingested as whole.
 * A PDF's extracts are appended once per page-range string, and an extract of
 * "all" supersedes the partial ones; the download-path map is bounded.
 *
 * Egress: web_fetch and web_fetch_pdf are refused with an error result, before the
 * base tool runs, when the URL is not a public http(s) URL (watch.ts isPublicHttpUrl:
 * loopback, link-local, private and internal hosts, other schemes, credentials).
 * Known residual risks, out of scope here: the upstream web_fetch follows redirects
 * itself, so a public URL that redirects to a private host is fetched; DNS rebinding
 * is not checked; the Jina reader fallback fetches the URL through a third party.
 *
 * Provenance of a redirect: the tool writes `Source: <final URL> (HTTP nnn)` in its
 * own header, at the very start of the text (after an optional `# title` line). Only
 * that header is read. A Source-like line anywhere else, or in a headerless text (the
 * reader fallback has no header), is page content and is ignored. The final URL gets
 * the text only when nothing is recorded under it yet: a forged header can never
 * replace or remove a genuine capture of another locator.
 * Residual risk: the reader fallback returns a headerless body, and a body that
 * itself begins with a full header line can still create a redirect-derived record,
 * but only under a locator that has none yet. Closing that needs a header marker
 * from upstream web.ts, which is out of scope here.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolResult } from "../tool-execute.ts";
import { isPublicHttpUrl } from "../../core/ext/watch.ts";
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
	/** Locators whose text is not capturable: cut by the tool, or past the total byte budget. */
	oversized(): string[];
}

export interface CaptureLimits {
	/** Most UTF-8 bytes of recorded text one capture may hold in total. A text that would exceed it is refused. */
	maxTotalBytes?: number;
	/** Most distinct locators (capturable or oversized) one capture tracks; later ones are ignored. */
	maxTexts?: number;
}

export const MAX_CAPTURED_TOTAL_BYTES = 64 * 1_048_576;
export const MAX_CAPTURED_TEXTS = 50;
/** Most PDF download paths remembered; the oldest is forgotten first. */
export const MAX_PDF_PATHS = 100;
/** The truncation marker web_fetch appends to a page it cut (upstream web.ts, MAX_CONTENT_CHARS). */
const TRUNCATED = /\n\n\[Truncated at \d+ characters\]\s*$/;
/** The header web_fetch writes (upstream web.ts): an optional `# title` line, then the Source line, at the very start. */
const SOURCE_HEADER = /^(?:# [^\n]*\n\n)?Source: (\S+) \(HTTP \d{3}\)(?:\n|$)/;
/** The tools whose URL argument is fetched over the network, and so pass the egress guard. */
const FETCHING = new Set(["web_fetch", "web_fetch_pdf"]);

interface Entry {
	title: string;
	chunks: string[];
	/** Total UTF-8 bytes of `chunks`. */
	bytes: number;
	/** PDF page-range strings already extracted into `chunks`. */
	ranges: Set<string>;
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

export function captureFetches(base: Record<string, AgentTool<any>>, limits: CaptureLimits = {}): FetchCapture {
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_CAPTURED_TOTAL_BYTES;
	const maxTexts = limits.maxTexts ?? MAX_CAPTURED_TEXTS;
	const pages = new Map<string, Entry>();
	const tooBig = new Set<string>();
	const pdfUrlByPath = new Map<string, string>();
	let total = 0;

	/** Marks a locator not capturable: its text is dropped (and its bytes freed) and it is reported by oversized(). */
	const refuse = (rawLocator: string): void => {
		const locator = normalizeLocator(rawLocator);
		if (!/^https?:\/\//.test(locator)) return;
		const prev = pages.get(locator);
		if (prev !== undefined) {
			total -= prev.bytes;
			pages.delete(locator);
		}
		tooBig.add(locator);
	};

	const store = (rawLocator: string, title: string, chunks: string[], ranges: Set<string>): void => {
		const locator = normalizeLocator(rawLocator);
		if (!/^https?:\/\//.test(locator) || tooBig.has(locator)) return;
		const prev = pages.get(locator);
		if (prev === undefined && pages.size + tooBig.size >= maxTexts) return;
		const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
		if (total - (prev?.bytes ?? 0) + bytes > maxTotalBytes) {
			refuse(locator);
			return;
		}
		total += bytes - (prev?.bytes ?? 0);
		pages.set(locator, { title, chunks, bytes, ranges });
	};

	/** A redirect's final URL gets the text only when nothing is recorded or refused under it, and never past the budgets. */
	const addIfAbsent = (rawLocator: string, title: string, text: string): void => {
		const locator = normalizeLocator(rawLocator);
		if (pages.has(locator) || tooBig.has(locator)) return;
		const bytes = Buffer.byteLength(text, "utf8");
		if (pages.size + tooBig.size >= maxTexts || total + bytes > maxTotalBytes) return; // silently skipped: it marks nothing
		total += bytes;
		pages.set(locator, { title, chunks: [text], bytes, ranges: new Set() });
	};

	/** A fetched web page replaces whatever was captured under the locator, title included. */
	const setPage = (rawLocator: string, title: string, text: string): void => store(rawLocator, title, [text], new Set());

	/** One PDF extract. Each page-range string is appended once; an "all" extract replaces the partial ones and blocks later ranges. */
	const addPdfPart = (rawLocator: string, range: string, text: string): void => {
		const prev = pages.get(normalizeLocator(rawLocator));
		if (prev !== undefined && (prev.ranges.has("all") || prev.ranges.has(range))) return;
		if (range === "all") {
			store(rawLocator, prev?.title ?? "", [text], new Set(["all"]));
			return;
		}
		store(rawLocator, prev?.title ?? "", [...(prev?.chunks ?? []), text], new Set([...(prev?.ranges ?? []), range]));
	};

	/** A URL argument that is a string must be public; a non-string one is left to the base tool, which rejects it itself. */
	const egressRefused = (name: string, params: any): ReturnType<typeof toToolResult> | null => {
		if (!FETCHING.has(name) || typeof params?.url !== "string" || isPublicHttpUrl(params.url)) return null;
		return { ...toToolResult(`${name} refused: only public http(s) URLs can be fetched (no local, private or internal host, no other scheme, no credentials).`), isError: true };
	};

	const wrap = (name: string, after: (params: any, result: Awaited<ReturnType<NonNullable<AgentTool<any>["execute"]>>>) => void): AgentTool<any> | undefined => {
		const tool = base[name];
		if (tool === undefined) return undefined;
		return {
			...tool,
			async execute(id, params, signal, onUpdate) {
				const refusal = egressRefused(name, params);
				if (refusal !== null) return refusal;
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
		if (TRUNCATED.test(text)) {
			// The tool cut the page: a partial text is never capturable, under the requested locator.
			refuse(params.url);
			return;
		}
		setPage(params.url, title, text);
		// After redirects the tool names the final URL in its header: the same text is also recorded under it, but only
		// when the requested page itself was recorded (not refused by the budget), that URL is public, and it holds nothing yet.
		const final = SOURCE_HEADER.exec(text)?.[1];
		if (final !== undefined && pages.has(normalizeLocator(params.url)) && normalizeLocator(final) !== normalizeLocator(params.url) && isPublicHttpUrl(final)) {
			addIfAbsent(final, title, text);
		}
	});
	if (webFetch) wrapped.web_fetch = webFetch;
	const pdfFetch = wrap("web_fetch_pdf", (_params, result) => {
		const d = result.details as { path?: unknown; url?: unknown } | null;
		if (d === null || typeof d !== "object" || typeof d.path !== "string" || typeof d.url !== "string") return;
		pdfUrlByPath.delete(d.path); // re-inserted below, so it counts as the newest
		pdfUrlByPath.set(d.path, d.url);
		if (pdfUrlByPath.size > MAX_PDF_PATHS) pdfUrlByPath.delete(pdfUrlByPath.keys().next().value as string);
	});
	if (pdfFetch) wrapped.web_fetch_pdf = pdfFetch;
	const pdfExtract = wrap("pdf_extract", (params, result) => {
		const url = typeof params?.path === "string" ? pdfUrlByPath.get(params.path) : undefined;
		const text = textOf(result);
		if (url === undefined || text.startsWith("pdf_extract failed")) return;
		addPdfPart(url, typeof params?.pages === "string" ? params.pages.trim() : "", text);
	});
	if (pdfExtract) wrapped.pdf_extract = pdfExtract;

	return {
		tools: wrapped,
		pages: () => [...pages].map(([locator, e]) => ({ locator, title: e.title, text: e.chunks.join("\n\n") })),
		oversized: () => [...tooBig],
	};
}
