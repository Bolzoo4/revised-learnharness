/**
 * The keyless SearXNG adapter (search spec REQ-search-01, 02). Stub fetch only:
 * this file never touches the network. Failures reject with a clear reason;
 * the tool layer turns that rejection into a recoverable tool result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searxngProvider } from "../src/server/search.ts";
import { SEARCH_ENGINES } from "../src/core/search.ts";

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function stub(respond: Responder, seen: Array<{ url: string; init: RequestInit }> = []) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		seen.push({ url, init });
		return respond(url, init);
	};
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("searxngProvider (REQ-search-01, 02)", () => {
	it("is a keyless entry in the engine catalog", () => {
		const entry = SEARCH_ENGINES.find((e) => e.id === "searxng");
		assert.ok(entry, "searxng is in SEARCH_ENGINES");
		assert.equal("envVar" in entry, false, "a keyless engine has no API-key variable");
	});

	it("GETs <base>/search with q and format=json, and keeps at most count hits", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const provider = searxngProvider("http://127.0.0.1:8888/", stub(() => json({
			results: [
				{ title: "A", url: "https://a.example/x", content: "line1\nline2" },
				{ title: "B", url: "https://b.example/", content: "" },
				{ title: "C", url: "https://c.example/", content: "" },
			],
		}), seen));
		const hits = await provider.search("ciao mondo", 2);
		assert.deepEqual(hits, [
			{ title: "A", url: "https://a.example/x", snippet: "line1 line2" },
			{ title: "B", url: "https://b.example/", snippet: "" },
		]);
		const url = new URL(seen[0]!.url);
		assert.equal(url.origin + url.pathname, "http://127.0.0.1:8888/search");
		assert.equal(url.searchParams.get("q"), "ciao mondo");
		assert.equal(url.searchParams.get("format"), "json");
	});

	it("sends no credentials and carries a 30 s abort signal", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		await searxngProvider("http://127.0.0.1:8888", stub(() => json({ results: [] }), seen)).search("q", 5);
		const { init } = seen[0]!;
		const headers = (init.headers ?? {}) as Record<string, string>;
		assert.equal(headers.authorization, undefined);
		assert.equal(headers.cookie, undefined);
		assert.ok(init.signal instanceof AbortSignal, "a timeout signal is attached");
	});

	it("drops rows whose url is not http(s)", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => json({
			results: [{ title: "local", url: "file:///etc/passwd", content: "" }, { title: "ok", url: "https://ok.example/", content: "" }],
		})));
		assert.deepEqual(await provider.search("q", 5), [{ title: "ok", url: "https://ok.example/", snippet: "" }]);
	});

	it("HTTP 403 reports that JSON output is disabled and names the setting", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => new Response("forbidden", { status: 403 })));
		await assert.rejects(provider.search("q", 5), {
			message: "JSON output is disabled on the SearXNG instance (set search.formats: [html, json])",
		});
	});

	it("other HTTP errors report the status only", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => new Response("internal details", { status: 500 })));
		await assert.rejects(provider.search("q", 5), { message: "SearXNG search API 500" });
	});

	it("an empty result with unresponsive upstream engines names them", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => json({
			results: [],
			unresponsive_engines: [["google", "timeout"], ["duckduckgo", "Suspended: too many requests"]],
		})));
		await assert.rejects(provider.search("q", 5), (err: Error) => {
			assert.match(err.message, /google/);
			assert.match(err.message, /timeout/);
			assert.match(err.message, /duckduckgo/);
			return true;
		});
	});

	it("an empty result with no unresponsive engines is a plain empty search", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => json({ results: [], unresponsive_engines: [] })));
		assert.deepEqual(await provider.search("q", 5), []);
	});

	it("an unreachable instance or a timeout rejects with a clear reason", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => {
			throw new TypeError("fetch failed");
		}));
		await assert.rejects(provider.search("q", 5), { message: /SearXNG is unreachable at http:\/\/127\.0\.0\.1:8888/ });
	});

	it("a non-JSON body is an invalid response, without echoing it", async () => {
		const provider = searxngProvider("http://127.0.0.1:8888", stub(() => new Response("<html>secret-page</html>")));
		await assert.rejects(provider.search("q", 5), { message: "SearXNG search API returned an invalid response" });
	});
});
