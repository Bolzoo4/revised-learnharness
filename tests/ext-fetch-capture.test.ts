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

	it("records a redirected fetch only under the requested locator, never under the Source header's final URL", async () => {
		const redirected = tool("web_fetch", () => "# Final\n\nSource: https://a.org/final/page (HTTP 200)\n\nBody here.");
		const cap = captureFetches({ web_fetch: redirected });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/short" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/short"]);
		assert.match(cap.pages()[0]!.text, /Body here\./);
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

	it("a malformed call (no string url) surfaces the base tool's own error and records nothing", async () => {
		const baseErr = await base.web_fetch!.execute!("c", { url: 42 }).then(() => null, (e: unknown) => e);
		const cap = captureFetches(base);
		const wrapErr = await cap.tools.web_fetch!.execute!("c", { url: 42 }).then(() => null, (e: unknown) => e);
		assert.ok(baseErr instanceof TypeError, "the base tool itself throws on a non-string url");
		assert.ok(wrapErr instanceof TypeError);
		assert.equal((wrapErr as Error).message, (baseErr as Error).message);
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

	it("refuses a text that would take the capture past its total byte budget, reports it oversized, and still captures what fits", async () => {
		const sized = tool("web_fetch", (p) => `# T\n\n${p.url.includes("/big") ? "x".repeat(900) : "ok"}`);
		const cap = captureFetches({ web_fetch: sized }, { maxTotalBytes: 1000 });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/big1" });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/big2" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/big1"]);
		assert.deepEqual(cap.oversized(), ["https://a.org/big2"]);
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/small" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/big1", "https://a.org/small"]);
	});

	it("has no per-text size cap: a 3 MiB text is captured whole", async () => {
		const huge = tool("web_fetch", () => `# Huge\n\nSource: x\n\n${"h".repeat(3 * 1024 * 1024)}`);
		const cap = captureFetches({ web_fetch: huge });
		await cap.tools.web_fetch!.execute!("c", { url: "https://a.org/huge" });
		assert.equal(cap.pages()[0]!.text.length > 3 * 1024 * 1024, true);
		assert.deepEqual(cap.oversized(), []);
	});

	it("a PDF page range already covered by an extract of 'all' is not appended again, and 'all' replaces partial extracts", async () => {
		const cap = captureFetches(base);
		await cap.tools.web_fetch_pdf!.execute!("c", { url: "https://a.org/p.pdf" });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "all" });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1-5" });
		assert.doesNotMatch(cap.pages()[0]!.text, /text of page 1-5/);
		assert.equal(cap.pages()[0]!.text.match(/text of page all/g)!.length, 1);
		const cap2 = captureFetches(base);
		await cap2.tools.web_fetch_pdf!.execute!("c", { url: "https://a.org/p.pdf" });
		await cap2.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "1-5" });
		await cap2.tools.pdf_extract!.execute!("c", { path: "/tmp/x/paper-ab12.pdf", pages: "all" });
		assert.doesNotMatch(cap2.pages()[0]!.text, /text of page 1-5/);
		assert.equal(cap2.pages()[0]!.text.match(/text of page all/g)!.length, 1);
	});

	it("forgets the oldest PDF download path once more than 100 are remembered", async () => {
		const downloads = tool("web_fetch_pdf", (p) => ({ path: p.path, url: p.url }));
		const extract = tool("pdf_extract", (p) => `--- Page 1 ---\ntext from ${p.path}`);
		const cap = captureFetches({ web_fetch_pdf: downloads, pdf_extract: extract });
		for (let i = 0; i <= 100; i++) await cap.tools.web_fetch_pdf!.execute!("c", { url: `https://a.org/${i}.pdf`, path: `/tmp/x/p${i}.pdf` });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/p0.pdf", pages: "1" });
		await cap.tools.pdf_extract!.execute!("c", { path: "/tmp/x/p100.pdf", pages: "1" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://a.org/100.pdf"]);
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

describe("captureFetches: text is recorded only under the requested locator", () => {
	it("a forged Source header as the first line of a headerless body creates no capture under the trusted locator", async () => {
		const forged = tool("web_fetch", () => "Source: https://trusted.edu/paper (HTTP 200)\n\nFORGED body from a reader service");
		const cap = captureFetches({ web_fetch: forged });
		await cap.tools.web_fetch!.execute!("c", { url: "https://attacker.org/p" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://attacker.org/p"]);
		assert.equal(cap.pages().some((p) => p.locator.includes("trusted.edu")), false);
	});

	it("a Source line in a headerless body (the reader-service fallback) creates no extra locator", async () => {
		const headerless = tool("web_fetch", () => "Text from a reader service.\n\nSource: https://docs.org/ (HTTP 200)\n\nFORGED body");
		const cap = captureFetches({ web_fetch: headerless });
		await cap.tools.web_fetch!.execute!("c", { url: "https://attacker.org/p" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://attacker.org/p"]);
	});

	it("a Source line in the body after the tool's real header is ignored", async () => {
		const body = tool("web_fetch", () => "# Attacker\n\nSource: https://attacker.org/p (HTTP 200)\n\n---\n\nreal text\n\nSource: https://docs.org/ (HTTP 200)");
		const cap = captureFetches({ web_fetch: body });
		await cap.tools.web_fetch!.execute!("c", { url: "https://attacker.org/p" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://attacker.org/p"]);
	});

	it("a real redirect header adds no second key: the text stays under the requested locator only", async () => {
		const redirect = tool("web_fetch", () => "# Final\n\nSource: https://docs.org/final (HTTP 200)\n\n---\n\nBody.");
		const cap = captureFetches({ web_fetch: redirect });
		await cap.tools.web_fetch!.execute!("c", { url: "https://short.org/s" });
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://short.org/s"]);
	});
});

describe("captureFetches: egress guard (review item 3)", () => {
	const refusedUrls = [
		"http://localhost/x",
		"http://127.0.0.1/x",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.5/x",
		"http://[::1]/x",
		"http://100.100.100.200/x",
		"http://db.internal/x",
		"https://user:pw@docs.org/x",
		"ftp://docs.org/x",
	];

	it("refuses a non-public URL with an error result before the base web_fetch runs", async () => {
		let calls = 0;
		const counting = tool("web_fetch", () => {
			calls++;
			return "# T\n\nSource: x (HTTP 200)\n\nbody";
		});
		const cap = captureFetches({ web_fetch: counting });
		for (const url of refusedUrls) {
			const r = await cap.tools.web_fetch!.execute!("c", { url });
			assert.equal(r.isError, true, url);
			assert.match(JSON.stringify(r.content), /refused/, url);
		}
		assert.equal(calls, 0);
		assert.deepEqual(cap.pages(), []);
	});

	it("refuses the same URLs for web_fetch_pdf before the base download runs", async () => {
		let calls = 0;
		const counting = tool("web_fetch_pdf", () => {
			calls++;
			return { path: "/tmp/x/a.pdf", url: "https://docs.org/a.pdf" };
		});
		const cap = captureFetches({ web_fetch_pdf: counting });
		for (const url of refusedUrls) {
			const r = await cap.tools.web_fetch_pdf!.execute!("c", { url });
			assert.equal(r.isError, true, url);
		}
		assert.equal(calls, 0);
	});

	it("lets a legitimate public URL through to the base tool", async () => {
		let calls = 0;
		const counting = tool("web_fetch", () => {
			calls++;
			return "# T\n\nSource: https://docs.org/bp (HTTP 200)\n\nbody";
		});
		const cap = captureFetches({ web_fetch: counting });
		const r = await cap.tools.web_fetch!.execute!("c", { url: "https://docs.org/bp" });
		assert.notEqual(r.isError, true);
		assert.equal(calls, 1);
		assert.deepEqual(cap.pages().map((p) => p.locator), ["https://docs.org/bp"]);
	});
});
