// tests/ext-fetch-capture.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { captureFetches } from "../src/agent/ext/fetch-capture.ts";
import { toToolResult } from "../src/agent/tool-execute.ts";

const tool = (name: string, run: (p: any) => unknown): AgentTool<any> => ({
	name,
	label: name,
	description: name,
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params) => toToolResult(run(params)),
});

const base = {
	web_fetch: tool("web_fetch", (p) => (p.url.includes("bad") ? `web_fetch failed for ${p.url}: HTTP 404` : `# Title of ${p.url}\n\nSource: ${p.url} (HTTP 200)\n\nBody.`)),
	web_fetch_pdf: tool("web_fetch_pdf", (p) => ({ path: "/tmp/x/paper-ab12.pdf", url: p.url, page_count: 3 })),
	pdf_extract: tool("pdf_extract", (p) => (p.path === "/tmp/x/paper-ab12.pdf" ? `--- Page ${p.pages} ---\ntext of page ${p.pages}` : "pdf_extract failed: nope")),
	web_search: tool("web_search", () => []),
};

describe("captureFetches", () => {
	it("records the text of a successful web_fetch under the normalised URL, with its title", async () => {
		const cap = captureFetches(base);
		await cap.tools.web_fetch!.execute!("c1", { url: "https://A.org/x/#frag" });
		await cap.tools.web_fetch!.execute!("c2", { url: "https://bad.org/y" });
		assert.deepEqual(cap.pages().map((p) => [p.locator, p.title]), [["https://a.org/x", "Title of https://A.org/x/#frag"]]);
		assert.match(cap.pages()[0]!.text, /Body\./);
	});

	it("maps a PDF's extracted pages back to its URL and concatenates them", async () => {
		const cap = captureFetches(base);
		await cap.tools.web_fetch_pdf!.execute!("c1", { url: "https://arxiv.org/pdf/1706.03762" });
		await cap.tools.pdf_extract!.execute!("c2", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		await cap.tools.pdf_extract!.execute!("c3", { path: "/tmp/x/paper-ab12.pdf", pages: "2" });
		await cap.tools.pdf_extract!.execute!("c4", { path: "/elsewhere.pdf", pages: "1" });
		const [page] = cap.pages();
		assert.equal(cap.pages().length, 1);
		assert.equal(page!.locator, "https://arxiv.org/pdf/1706.03762");
		assert.match(page!.text, /text of page 1[\s\S]*text of page 2/);
	});

	it("records a fetched text under the requested locator AND the final Source URL when a redirect changed it", async () => {
		const redirected = tool("web_fetch", () => "# Final\n\nSource: https://a.org/final/page (HTTP 200)\n\nBody here.");
		const cap = captureFetches({ web_fetch: redirected });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/short" });
		const locators = cap.pages().map((p) => p.locator).sort();
		assert.deepEqual(locators, ["https://a.org/final/page", "https://a.org/short"]);
		assert.ok(cap.pages().every((p) => /Body here\./.test(p.text)));
	});

	it("takes the title only from the FIRST line, never from a heading later in the body", async () => {
		const later = tool("web_fetch", () => "plain first line\n\n# Hidden heading\n\nSource: https://a.org/x (HTTP 200)\n\nBody.");
		const cap = captureFetches({ web_fetch: later });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x" });
		assert.equal(cap.pages()[0]!.title, "");
	});

	it("a refetch in replace mode takes the NEW title, not the one it replaced", async () => {
		let n = 0;
		const retitled = tool("web_fetch", () => (++n === 1 ? "# Old\n\nBody one." : "# New\n\nBody two."));
		const cap = captureFetches({ web_fetch: retitled });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x" });
		assert.deepEqual(cap.pages().map((p) => [p.title, p.text]), [["New", "# New\n\nBody two."]]);
	});

	it("a page cut by web_fetch at 40 000 characters is not capturable and is reported as oversized", async () => {
		const cut = `# Long\n\nSource: https://a.org/long (HTTP 200)\n\n---\n\n${"w ".repeat(20_000)}\n\n[Truncated at 40000 characters]`;
		const longTool = tool("web_fetch", (p) => (p.url.endsWith("long") ? cut : "# Short\n\nSource: x\n\nshort text"));
		const cap = captureFetches({ web_fetch: longTool });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/long" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/short" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/short"]);
		assert.deepEqual(cap.oversized(), ["https://a.org/long"]);
	});

	it("a page that merely mentions the truncation marker mid-text is still capturable", async () => {
		const mentions = tool("web_fetch", () => "# Doc\n\nSource: x\n\nThe tool prints [Truncated at 40000 characters] when cut.\n\nMore text after.");
		const cap = captureFetches({ web_fetch: mentions });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/doc" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/doc"]);
		assert.deepEqual(cap.oversized(), []);
	});

	it("leaves every other tool untouched and tolerates a missing tool", () => {
		const cap = captureFetches({ web_search: base.web_search });
		assert.equal(cap.tools.web_search, base.web_search);
		assert.equal(cap.tools.web_fetch, undefined);
	});

	it("returns the tool's result unchanged and never records pointers, error results or error strings", async () => {
		const results: Record<string, unknown> = {
			"https://p.org/pdf": "web_fetch: this URL is a PDF document — call web_fetch_pdf on it to download and read it.",
			"https://e.org/x": "web_fetch failed: invalid URL \"x\"",
		};
		const errTool: AgentTool<any> = { ...base.web_fetch!, execute: async (_i, p: any) => ({ ...toToolResult(results[p.url] ?? "# T\n\nSource: x\n\nreal text"), isError: p.url === "https://iserr.org/" }) };
		const cap = captureFetches({ web_fetch: errTool });
		const direct = await errTool.execute("c", { url: "https://p.org/pdf" });
		const wrapped = await cap.tools.web_fetch!.execute!("c", { url: "https://p.org/pdf" });
		assert.deepEqual(wrapped, direct);
		await cap.tools.web_fetch!.execute!("c", { url: "https://e.org/x" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://iserr.org/" });
		assert.deepEqual(cap.pages(), []);
	});

	it("never records anything the model supplied: unknown pdf paths, failed extracts, a failed pdf download", async () => {
		const failPdf = tool("web_fetch_pdf", (p) => `web_fetch_pdf failed for ${p.url}: HTTP 500`);
		const cap = captureFetches({ ...base, web_fetch_pdf: failPdf });
		await cap.tools.web_fetch_pdf!.execute!("c1", { url: "https://x.org/a.pdf" });
		await cap.tools.pdf_extract!.execute!("c2", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		assert.deepEqual(cap.pages(), []);
		const cap2 = captureFetches(base);
		await cap2.tools.web_fetch_pdf!.execute!("c1", { url: "https://x.org/a.pdf" });
		await cap2.tools.pdf_extract!.execute!("c2", { path: "/nowhere.pdf", pages: "1" });
		assert.deepEqual(cap2.pages(), []);
	});

	it("a malformed call (no string url) neither throws from the wrapper nor records", async () => {
		const cap = captureFetches(base);
		const r = await cap.tools.web_fetch!.execute!("c", { url: 42 }).catch((e: unknown) => e);
		assert.ok(!(r instanceof TypeError && /locator|trim/.test(String(r))));
		assert.deepEqual(cap.pages(), []);
	});

	it("a refetch replaces the page, re-extracting the same pages does not duplicate them", async () => {
		const cap = captureFetches(base);
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x/" });
		assert.equal(cap.pages().length, 1);
		assert.equal(cap.pages()[0]!.text.match(/Body\./g)!.length, 1);
		await cap.tools.web_fetch_pdf!.execute!("c", { url: "https://a.org/p.pdf" });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		const pdf = cap.pages().find((p) => p.locator === "https://a.org/p.pdf")!;
		assert.equal(pdf.text.match(/text of page 1/g)!.length, 1);
	});

	it("marks an oversized text not capturable instead of truncating it, and it stays that way", async () => {
		const big = tool("web_fetch", (p) => (p.url.endsWith("big") ? `# Big\n\n${"é".repeat(600)}` : "# Small\n\nok"));
		const cap = captureFetches({ web_fetch: big, web_fetch_pdf: base.web_fetch_pdf, pdf_extract: base.pdf_extract }, { maxTextBytes: 1000 });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/big" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/small" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/small"]);
		assert.deepEqual(cap.oversized(), ["https://a.org/big"]);
		// a PDF that grows past the cap page by page is dropped whole, and a later small page does not resurrect it
		const pages = tool("pdf_extract", (p) => `p${p.pages} ${"x".repeat(p.pages === "2" ? 900 : 100)}`);
		const cap2 = captureFetches({ web_fetch_pdf: base.web_fetch_pdf, pdf_extract: pages }, { maxTextBytes: 1000 });
		await cap2.tools.web_fetch_pdf!.execute!("c", { url: "https://a.org/p.pdf" });
		await cap2.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		await cap2.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "2" });
		await cap2.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "3" });
		assert.deepEqual(cap2.pages(), []);
		assert.deepEqual(cap2.oversized(), ["https://a.org/p.pdf"]);
	});

	it("caps the number of captured texts per capture", async () => {
		const cap = captureFetches(base, { maxTexts: 2 });
		for (const n of [1, 2, 3]) await cap.tools.web_fetch!.execute!("c", { url: `https://a.org/${n}` });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/1", "https://a.org/2"]);
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/1" }); // an already captured page may still be refreshed
		assert.equal(cap.pages().length, 2);
	});

	it("keeps state per capture: two gaps interleaved over the same tools do not leak", async () => {
		const a = captureFetches(base);
		const b = captureFetches(base);
		await a.tools.web_fetch!.execute!("c", { url: "https://a.org/only-a" });
		await b.tools.web_fetch_pdf!.execute!("c", { url: "https://b.org/p.pdf" });
		await a.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1" }); // a never downloaded it
		await b.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1" });
		await b.tools.web_fetch!.execute!("c", { url: "https://b.org/only-b" });
		assert.deepEqual(a.pages().map((p) => p.locator), ["https://a.org/only-a"]);
		assert.deepEqual(b.pages().map((p) => p.locator).sort(), ["https://b.org/only-b", "https://b.org/p.pdf"]);
	});

	it("pages() hands out copies: editing them does not change the capture", async () => {
		const cap = captureFetches(base);
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/x" });
		cap.pages()[0]!.text = "forged";
		assert.match(cap.pages()[0]!.text, /Body\./);
	});
});
