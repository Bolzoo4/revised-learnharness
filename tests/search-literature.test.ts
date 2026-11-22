/**
 * The keyless literature and encyclopaedia adapters (search spec REQ-search-03):
 * OpenAlex (works search) and Wikipedia (REST search, language by query).
 * Stub fetch only; no network. Requests carry the query and nothing about the
 * learner (no mailto, no cookies, no identifying headers beyond a generic UA).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openAlexProvider, wikipediaProvider } from "../src/server/search.ts";
import { SEARCH_ENGINES } from "../src/core/search.ts";

type Seen = Array<{ url: string; init: RequestInit }>;

function stub(body: unknown, seen: Seen = [], status = 200) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		seen.push({ url, init });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
}

describe("openAlexProvider (REQ-search-03)", () => {
	it("is a keyless catalog engine", () => {
		const entry = SEARCH_ENGINES.find((e) => e.id === "openalex");
		assert.ok(entry);
		assert.equal("envVar" in entry, false);
	});

	it("GETs api.openalex.org/works with only the query and page size", async () => {
		const seen: Seen = [];
		await openAlexProvider(stub({ results: [] }, seen)).search("quantum error correction", 7);
		const url = new URL(seen[0]!.url);
		assert.equal(url.origin + url.pathname, "https://api.openalex.org/works");
		assert.equal(url.searchParams.get("search"), "quantum error correction");
		assert.equal(url.searchParams.get("per-page"), "7");
		assert.deepEqual([...url.searchParams.keys()].sort(), ["per-page", "search"], "no mailto or other identifying parameter");
	});

	it("clamps the page size to OpenAlex's range", async () => {
		const sizes: string[] = [];
		const provider = openAlexProvider(async (url) => {
			sizes.push(new URL(url).searchParams.get("per-page")!);
			return new Response(JSON.stringify({ results: [] }));
		});
		for (const count of [0, 500, 3.9]) await provider.search("q", count);
		assert.deepEqual(sizes, ["1", "200", "3"]);
	});

	it("maps title, DOI url, and an abstract rebuilt from the inverted index", async () => {
		const provider = openAlexProvider(stub({
			results: [{
				id: "https://openalex.org/W1",
				doi: "https://doi.org/10.1/abc",
				display_name: "A paper",
				abstract_inverted_index: { learning: [1, 3], Deep: [0], works: [2] },
			}],
		}));
		assert.deepEqual(await provider.search("q", 5), [{
			title: "A paper",
			url: "https://doi.org/10.1/abc",
			snippet: "Deep learning works learning",
			sourceId: "https://openalex.org/W1",
		}]);
	});

	it("falls back to the OpenAlex id as url, the url as title, and an empty snippet without an abstract", async () => {
		const provider = openAlexProvider(stub({ results: [{ id: "https://openalex.org/W2" }] }));
		assert.deepEqual(await provider.search("q", 5), [{
			title: "https://openalex.org/W2",
			url: "https://openalex.org/W2",
			snippet: "",
			sourceId: "https://openalex.org/W2",
		}]);
	});

	it("drops rows that have neither a DOI nor an id", async () => {
		const provider = openAlexProvider(stub({ results: [{ display_name: "orphan" }, null] }));
		assert.deepEqual(await provider.search("q", 5), []);
	});

	it("truncates the rebuilt abstract to 400 characters", async () => {
		const words = Array.from({ length: 300 }, () => "lunga");
		const index: Record<string, number[]> = { lunga: words.map((_, i) => i) };
		const [hit] = await openAlexProvider(stub({
			results: [{ id: "https://openalex.org/W3", display_name: "Long", abstract_inverted_index: index }],
		})).search("q", 5);
		assert.ok(hit);
		assert.equal(hit.snippet.length, 400);
	});

	it("maps HTTP and malformed responses to clear messages without echoing bodies", async () => {
		await assert.rejects(openAlexProvider(stub("secret-body", [], 503)).search("q", 5), { message: "OpenAlex search API 503" });
		await assert.rejects(openAlexProvider(stub("not json secret")).search("q", 5), {
			message: "OpenAlex search API returned an invalid response",
		});
		await assert.rejects(openAlexProvider(stub({ no: "results" })).search("q", 5), {
			message: "OpenAlex search API returned an invalid response",
		});
	});
});

describe("wikipediaProvider (REQ-search-03)", () => {
	it("is a keyless catalog engine", () => {
		const entry = SEARCH_ENGINES.find((e) => e.id === "wikipedia");
		assert.ok(entry);
		assert.equal("envVar" in entry, false);
	});

	it("searches the Italian wikipedia for an Italian query", async () => {
		const seen: Seen = [];
		await wikipediaProvider(stub({ pages: [] }, seen)).search("il metodo della storia di una teoria è per la fisica", 4);
		const url = new URL(seen[0]!.url);
		assert.equal(url.origin + url.pathname, "https://it.wikipedia.org/w/rest.php/v1/search/page");
		assert.equal(url.searchParams.get("q"), "il metodo della storia di una teoria è per la fisica");
		assert.equal(url.searchParams.get("limit"), "4");
	});

	it("searches the English wikipedia for an English query and for an undecided one", async () => {
		const seen: Seen = [];
		const provider = wikipediaProvider(stub({ pages: [] }, seen));
		await provider.search("the history of the theory is not what we know and the rest", 3);
		await provider.search("kubernetes", 3);
		assert.equal(new URL(seen[0]!.url).host, "en.wikipedia.org");
		assert.equal(new URL(seen[1]!.url).host, "en.wikipedia.org");
	});

	it("maps title, a tag-free excerpt, and the article url", async () => {
		const provider = wikipediaProvider(stub({
			pages: [{ key: "Fisica_quantistica", title: "Fisica quantistica", excerpt: '<span class="searchmatch">Fisica</span> studia i quanti' }],
		}));
		assert.deepEqual(await provider.search("il metodo della storia di una teoria è per la fisica", 5), [{
			title: "Fisica quantistica",
			url: "https://it.wikipedia.org/wiki/Fisica_quantistica",
			snippet: "Fisica studia i quanti",
			sourceId: "Fisica_quantistica",
		}]);
	});

	it("encodes the article key in the url and keeps at most count hits", async () => {
		const provider = wikipediaProvider(stub({
			pages: [
				{ key: "C++", title: "C++", excerpt: "" },
				{ key: "B", title: "B", excerpt: "" },
			],
		}));
		const hits = await provider.search("kubernetes", 1);
		assert.deepEqual(hits.map((h) => h.url), ["https://en.wikipedia.org/wiki/C%2B%2B"]);
	});

	it("maps HTTP and malformed responses to clear messages without echoing bodies", async () => {
		await assert.rejects(wikipediaProvider(stub("secret", [], 429)).search("q", 5), { message: "Wikipedia search API 429" });
		await assert.rejects(wikipediaProvider(stub("not json secret")).search("q", 5), {
			message: "Wikipedia search API returned an invalid response",
		});
	});
});
