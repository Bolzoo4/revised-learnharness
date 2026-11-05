// tests/ext-watch.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_FEED_BYTES,
	MAX_FEED_CHARS,
	dueEntries,
	feedUrl,
	parseFeed,
	parseRadarEvent,
	parseWatchEntry,
	parseWatchlist,
	rankNodesByOverlap,
	seenItemIds,
	validateWatchTarget,
	type RadarEvent,
	type WatchEntry,
} from "../src/core/ext/watch.ts";
import { WEAK_WINDOW_DAYS, weakPremiseNodeIds } from "../src/core/ext/weak-premises.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const ARXIV = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2401.00001v1</id><updated>2024-01-02T00:00:00Z</updated><published>2024-01-01T00:00:00Z</published>
<title>Attention &amp; Memory
 in Transformers</title><summary>We show that attention   extends memory.</summary>
<link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf"/></entry>
<entry><id>x</id><title>No link</title></entry></feed>`;
const RSS = `<rss><channel><item><title><![CDATA[Release 2.0]]></title><link>https://example.org/r2</link><guid>g-2</guid><description>&lt;p&gt;Big &lt;b&gt;change&lt;/b&gt;&lt;/p&gt;</description><pubDate>Mon, 01 Jan 2024</pubDate></item></channel></rss>`;

describe("watchlist", () => {
	it("parses entries, defaults the cadence and rejects unusable targets", () => {
		assert.deepEqual(parseWatchEntry({ id: "w1", kind: "arxiv-query", query: " cat:cs.LG attention " }), { id: "w1", kind: "arxiv-query", query: "cat:cs.LG attention", cadenceHours: 24 });
		assert.equal(parseWatchEntry({ id: "w1", kind: "repo", query: "not-a-repo" }), null);
		assert.equal(parseWatchEntry({ id: "w1", kind: "feed", query: "ftp://x" }), null);
		assert.equal(parseWatchEntry({ id: "w1", kind: "feed", query: "https://x.org/f", cadenceHours: 0 }), null);
		assert.equal(parseWatchEntry({ id: "w1", kind: "blog", query: "q" }), null);
		assert.deepEqual(
			parseWatchlist({ entries: [{ id: "a", kind: "repo", query: "o/n", goalId: "goal_1" }, { id: "a", kind: "repo", query: "o/m" }, { nope: 1 }] }).map((e) => e.id),
			["a"],
		);
		assert.deepEqual(parseWatchlist("x"), []);
	});

	it("builds the fetch URL per kind (arXiv public API only)", () => {
		assert.equal(feedUrl({ id: "1", kind: "arxiv-query", query: "all:attention AND cat:cs.LG", cadenceHours: 24 }), "https://export.arxiv.org/api/query?search_query=all%3Aattention%20AND%20cat%3Acs.LG&sortBy=submittedDate&sortOrder=descending&max_results=10");
		assert.equal(feedUrl({ id: "1", kind: "repo", query: "o/n", cadenceHours: 24 }), "https://github.com/o/n/releases.atom");
		assert.equal(feedUrl({ id: "1", kind: "feed", query: "https://x.org/f.xml", cadenceHours: 24 }), "https://x.org/f.xml");
	});
});

describe("feed parser", () => {
	it("reads Atom entries (alternate link, not the pdf link) and drops entries without a link", () => {
		const items = parseFeed(ARXIV);
		assert.equal(items.length, 1);
		assert.deepEqual(items[0], {
			id: "http://arxiv.org/abs/2401.00001v1",
			title: "Attention & Memory in Transformers",
			link: "http://arxiv.org/abs/2401.00001v1",
			summary: "We show that attention extends memory.",
		});
	});

	it("reads RSS items with CDATA and escaped markup", () => {
		assert.deepEqual(parseFeed(RSS), [{ id: "g-2", title: "Release 2.0", link: "https://example.org/r2", summary: "Big change" }]);
	});

	it("returns [] for text that is not a feed", () => {
		assert.deepEqual(parseFeed("<html>nope</html>"), []);
	});
});

describe("radar", () => {
	const classified = (itemId: string): RadarEvent => ({ type: "classified", entryId: "w1", itemId, title: "t", link: "l", nearestNodeIds: ["n1"], relation: "extends", action: "ingest", rationale: "r", at: "2026-11-04T10:00:00.000Z" });

	it("round-trips events and rejects bad relations", () => {
		assert.deepEqual(parseRadarEvent(classified("i1")), classified("i1"));
		assert.equal(parseRadarEvent({ ...classified("i1"), relation: "similar" }), null);
		assert.equal(parseRadarEvent({ ...classified("i1"), action: "maybe" }), null);
		assert.deepEqual(parseRadarEvent({ type: "checked", entryId: "w1", ok: true, items: 3, at: "2026-11-04T10:00:00.000Z" }), { type: "checked", entryId: "w1", ok: true, items: 3, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(parseRadarEvent({ type: "checked", entryId: "w1", ok: true, items: -1, at: "2026-11-04T10:00:00.000Z" }), null);
	});

	it("tracks seen items and due entries by cadence", () => {
		assert.deepEqual([...seenItemIds([classified("i1"), { type: "checked", entryId: "w1", ok: true, items: 0, at: "2026-11-04T10:00:00.000Z" }])], ["i1"]);
		const entries: WatchEntry[] = [
			{ id: "w1", kind: "repo", query: "o/n", cadenceHours: 24 },
			{ id: "w2", kind: "repo", query: "o/m", cadenceHours: 1 },
			{ id: "w3", kind: "repo", query: "o/k", cadenceHours: 24 },
		];
		const radar: RadarEvent[] = [
			{ type: "checked", entryId: "w1", ok: true, items: 0, at: "2026-11-04T00:00:00.000Z" },
			{ type: "checked", entryId: "w2", ok: false, items: 0, at: "2026-11-04T10:30:00.000Z" },
		];
		assert.deepEqual(dueEntries(entries, radar, "2026-11-04T11:00:00.000Z").map((e) => e.id), ["w3"]);
		assert.deepEqual(dueEntries(entries, radar, "2026-11-05T00:00:00.000Z").map((e) => e.id), ["w1", "w2", "w3"]);
	});
});

describe("candidate ranking", () => {
	const nodes = [
		{ id: "n1", name: "Attention", statement: "Attention weights tokens by relevance." },
		{ id: "n2", name: "Memory", statement: "Memory stores past tokens." },
		{ id: "n3", name: "Gradient", statement: "Gradients flow backwards." },
	];
	it("ranks by shared words and never returns a node sharing none", () => {
		assert.deepEqual(rankNodesByOverlap("Attention extends memory of tokens", nodes, 5).map((n) => n.id), ["n1", "n2"]);
		assert.deepEqual(rankNodesByOverlap("Attention extends memory of tokens", nodes, 1).map((n) => n.id), ["n1"]);
		assert.deepEqual(rankNodesByOverlap("quantum chromodynamics", nodes, 5), []);
	});
});

describe("weak premises", () => {
	const review = (over: Partial<Extract<ReviewEvent, { type: "review" }>>): ReviewEvent => ({ type: "review", nodeId: "n9", channel: "dialogic", rating: 2, durationSec: 30, at: "2026-11-01T10:00:00.000Z", ...over });

	it("lists premises flagged in the window until a later good review of them", () => {
		const now = "2026-11-04T00:00:00.000Z";
		assert.deepEqual(weakPremiseNodeIds([review({ weakPremises: ["a", "b"] })], now), ["a", "b"]);
		assert.deepEqual(weakPremiseNodeIds([review({ weakPremises: ["a", "b"] }), review({ nodeId: "a", channel: "fixed", rating: 3, at: "2026-11-02T00:00:00.000Z" })], now), ["b"]);
		assert.deepEqual(weakPremiseNodeIds([review({ weakPremises: ["a"] }), review({ nodeId: "a", channel: "fixed", rating: 2, at: "2026-11-02T00:00:00.000Z" })], now), ["a"]);
		assert.deepEqual(weakPremiseNodeIds([review({ weakPremises: ["a"], at: "2026-09-01T00:00:00.000Z" })], now), []);
		assert.deepEqual(weakPremiseNodeIds([review({ weakPremises: ["a"], at: "2026-11-03T00:00:00.000Z" }), review({ nodeId: "a", channel: "fixed", rating: 4, at: "2026-11-02T00:00:00.000Z" })], now), ["a"]);
	});
});

describe("hardening: watchlist", () => {
	it("rejects unsafe or malformed targets and ids", () => {
		assert.equal(parseWatchEntry({ id: "", kind: "repo", query: "o/n" }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "../.." }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "./.." }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "o/n/extra" }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "feed", query: "https://user:pw@x.org/f" }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "feed", query: "file:///etc/passwd" }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "arxiv-query", query: "   " }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "o/n", cadenceHours: Number.NaN }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "o/n", cadenceHours: Number.POSITIVE_INFINITY }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "o/n", cadenceHours: -1 }), null);
		assert.equal(parseWatchEntry({ id: "w", kind: "repo", query: "o/n", goalId: "" }), null);
		assert.equal(parseWatchEntry(null), null);
		assert.equal(parseWatchEntry([]), null);
	});

	it("keeps the goal id and a valid explicit cadence; the first of a repeated id wins", () => {
		assert.deepEqual(parseWatchEntry({ id: "w", kind: "repo", query: "o/n", cadenceHours: 0.5, goalId: "g" }), { id: "w", kind: "repo", query: "o/n", cadenceHours: 0.5, goalId: "g" });
		const list = parseWatchlist({ entries: [{ id: "a", kind: "repo", query: "o/first" }, { id: "a", kind: "repo", query: "o/second" }] });
		assert.equal(list.length, 1);
		assert.equal(list[0]!.query, "o/first");
		assert.deepEqual(parseWatchlist({}), []);
		assert.deepEqual(parseWatchlist(null), []);
		assert.deepEqual(parseWatchlist({ entries: "x" }), []);
	});

	it("validateWatchTarget names the reason", () => {
		assert.equal(validateWatchTarget({ kind: "repo", query: "o/n" }), null);
		assert.match(validateWatchTarget({ kind: "repo", query: "bad" }) ?? "", /owner\/name/);
		assert.match(validateWatchTarget({ kind: "feed", query: "ftp://x" }) ?? "", /http/);
		assert.equal(validateWatchTarget({ kind: "arxiv-query", query: "" }) !== null, true);
	});
});

describe("hardening: feed parser", () => {
	it("drops non-http(s) links and duplicate ids, accepts single-quoted hrefs", () => {
		const xml = `<feed>
<entry><id>a</id><title>Bad</title><link href="javascript:alert(1)"/></entry>
<entry><id>b</id><title>File</title><link href="file:///etc/passwd"/></entry>
<entry><id>c</id><title>Ok</title><link href='https://x.org/c' rel='alternate'/></entry>
<entry><id>c</id><title>Dup</title><link href="https://x.org/dup"/></entry>
</feed>`;
		const items = parseFeed(xml);
		assert.deepEqual(items.map((i) => [i.id, i.link]), [["c", "https://x.org/c"]]);
	});

	it("falls back to the link when the id is empty, and decodes numeric entities", () => {
		const items = parseFeed(`<feed><entry><id> </id><title>It&#8217;s &#x41;</title><link href="https://x.org/z"/></entry></feed>`);
		assert.equal(items[0]!.id, "https://x.org/z");
		assert.equal(items[0]!.title, "It’s A");
	});

	it("drops items with an empty title and caps the number of items", () => {
		assert.deepEqual(parseFeed(`<feed><entry><id>1</id><title> </title><link href="https://x.org/1"/></entry></feed>`), []);
		let xml = "<feed>";
		for (let i = 0; i < 120; i++) xml += `<entry><id>i${i}</id><title>T${i}</title><link href="https://x.org/${i}"/></entry>`;
		const items = parseFeed(`${xml}</feed>`);
		assert.equal(items.length, 50);
		assert.equal(items[0]!.id, "i0");
	});

	it("keeps summary empty when absent and has no publishedAt", () => {
		const a = parseFeed(`<feed><entry><id>1</id><title>T</title><link href="https://x.org/1"/></entry></feed>`)[0]!;
		assert.deepEqual(a, { id: "1", title: "T", link: "https://x.org/1", summary: "" });
	});

	it("does not double decode and returns [] for empty input", () => {
		const items = parseFeed(`<feed><entry><id>1</id><title>a &amp;lt; b</title><link href="https://x.org/1"/></entry></feed>`);
		assert.equal(items[0]!.title, "a &lt; b");
		assert.deepEqual(parseFeed(""), []);
	});
});

describe("hardening: radar", () => {
	const base = { type: "classified", entryId: "w1", itemId: "i1", title: "t", link: "l", nearestNodeIds: ["n1"], relation: "extends", action: "ingest", rationale: "r", at: "2026-11-04T10:00:00.000Z" };
	it("rejects malformed events", () => {
		assert.equal(parseRadarEvent({ ...base, at: "not a date" }), null);
		assert.equal(parseRadarEvent({ ...base, itemId: "" }), null);
		assert.equal(parseRadarEvent({ ...base, entryId: "" }), null);
		assert.equal(parseRadarEvent({ ...base, nearestNodeIds: [""] }), null);
		assert.equal(parseRadarEvent({ ...base, nearestNodeIds: "n1" }), null);
		assert.equal(parseRadarEvent({ ...base, rationale: 3 }), null);
		assert.equal(parseRadarEvent({ type: "checked", entryId: "w1", ok: true, items: 1.5, at: "2026-11-04T10:00:00.000Z" }), null);
		assert.equal(parseRadarEvent({ type: "checked", entryId: "w1", ok: "yes", items: 1, at: "2026-11-04T10:00:00.000Z" }), null);
		assert.equal(parseRadarEvent({ type: "other", entryId: "w1", at: "2026-11-04T10:00:00.000Z" }), null);
		assert.equal(parseRadarEvent(null), null);
		assert.equal(parseRadarEvent("x"), null);
	});
	it("accepts each relation and both actions", () => {
		for (const relation of ["extends", "contradicts", "applies", "unrelated"]) assert.equal(parseRadarEvent({ ...base, relation })?.type, "classified");
		assert.equal(parseRadarEvent({ ...base, action: "ignore" })?.type, "classified");
	});
	it("copies nearestNodeIds", () => {
		const ids = ["n1"];
		const ev = parseRadarEvent({ ...base, nearestNodeIds: ids }) as Extract<RadarEvent, { type: "classified" }>;
		ids.push("x");
		assert.deepEqual(ev.nearestNodeIds, ["n1"]);
	});
	it("scopes seen items to an entry when asked, so equal ids in different feeds do not collide", () => {
		const ev = (entryId: string, itemId: string): RadarEvent => ({ type: "classified", entryId, itemId, title: "t", link: "l", nearestNodeIds: [], relation: "unrelated", action: "ignore", rationale: "r", at: "2026-11-04T10:00:00.000Z" });
		const radar = [ev("w1", "1"), ev("w2", "2")];
		assert.deepEqual([...seenItemIds(radar, "w1")], ["1"]);
		assert.deepEqual([...seenItemIds(radar)].sort(), ["1", "2"]);
	});
	it("due: exact cadence boundary is due, one ms short is not; latest check wins; mixed date formats; bad dates", () => {
		const entries: WatchEntry[] = [{ id: "w1", kind: "repo", query: "o/n", cadenceHours: 2 }];
		const chk = (at: string): RadarEvent => ({ type: "checked", entryId: "w1", ok: true, items: 0, at });
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T10:00:00.000Z")], "2026-11-04T12:00:00.000Z").length, 1);
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T10:00:00.001Z")], "2026-11-04T12:00:00.000Z").length, 0);
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T09:00:00.000Z"), chk("2026-11-04T11:30:00.000Z")], "2026-11-04T12:00:00.000Z").length, 0);
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T11:30:00.000Z"), chk("2026-11-04T09:00:00.000Z")], "2026-11-04T12:00:00.000Z").length, 0);
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T11:30:00Z")], "2026-11-04T12:00:00.000Z").length, 0);
		assert.deepEqual(dueEntries(entries, [chk("2026-11-04T10:00:00+00:00"), chk("2026-11-04T11:59:00.000Z")], "2026-11-04T12:00:00.000Z").length, 0);
		assert.deepEqual(dueEntries(entries, [], "garbage"), []);
		assert.deepEqual(dueEntries(entries, [chk("garbage")], "2026-11-04T12:00:00.000Z").length, 1);
	});
});

describe("hardening: candidate ranking", () => {
	const nodes = [
		{ id: "b", name: "Alpha", statement: "alpha beta" },
		{ id: "a", name: "Alpha", statement: "alpha beta" },
		{ id: "c", name: "Gamma", statement: "gamma delta alpha" },
	];
	it("breaks ties by id and ranks higher overlap first", () => {
		assert.deepEqual(rankNodesByOverlap("alpha beta gamma delta", nodes, 3).map((n) => n.id), ["c", "a", "b"]);
		assert.deepEqual(rankNodesByOverlap("alpha beta", nodes, 3).map((n) => n.id), ["a", "b", "c"]);
	});
	it("counts only words of 4+ letters (3 letters and bare numbers do not match)", () => {
		const n = [{ id: "n", name: "ABC", statement: "2024 xyz" }];
		assert.deepEqual(rankNodesByOverlap("abc 2024 xyz", n, 5), []);
		assert.equal(rankNodesByOverlap("abcd", [{ id: "n", name: "abcd", statement: "" }], 5).length, 1);
		assert.equal(rankNodesByOverlap("ABCD", [{ id: "n", name: "abcd", statement: "" }], 5).length, 1);
	});
	it("handles bad k, empty text and duplicate ids", () => {
		assert.deepEqual(rankNodesByOverlap("alpha", nodes, 0), []);
		assert.deepEqual(rankNodesByOverlap("alpha", nodes, -1), []);
		assert.deepEqual(rankNodesByOverlap("alpha", nodes, Number.NaN), []);
		assert.deepEqual(rankNodesByOverlap("alpha", nodes, 1.9).map((n) => n.id), ["a"]);
		assert.deepEqual(rankNodesByOverlap("", nodes, 3), []);
		assert.deepEqual(rankNodesByOverlap("alpha", [nodes[1]!, nodes[1]!], 3).map((n) => n.id), ["a"]);
	});
});

describe("hardening: weak premises", () => {
	const rv = (over: Partial<Extract<ReviewEvent, { type: "review" }>>): ReviewEvent => ({ type: "review", nodeId: "n9", channel: "dialogic", rating: 2, durationSec: 30, at: "2026-11-01T10:00:00.000Z", ...over });
	const now = "2026-11-04T00:00:00.000Z";
	it("window boundary is inclusive; one ms before is out", () => {
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"], at: "2026-10-05T00:00:00.000Z" })], now), ["a"]);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"], at: "2026-10-04T23:59:59.999Z" })], now), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"], at: "2026-10-30T00:00:00.000Z" })], now, 3), []);
	});
	it("a good review at the same instant does not clear; ratings 3 and 4 clear, 1 and 2 do not", () => {
		const weak = rv({ weakPremises: ["a"] });
		const good = (rating: 1 | 2 | 3 | 4, at: string): ReviewEvent => rv({ nodeId: "a", channel: "fixed", rating, at });
		assert.deepEqual(weakPremiseNodeIds([weak, good(3, "2026-11-01T10:00:00.000Z")], now), ["a"]);
		assert.deepEqual(weakPremiseNodeIds([weak, good(3, "2026-11-01T10:00:00.001Z")], now), []);
		assert.deepEqual(weakPremiseNodeIds([weak, good(4, "2026-11-02T00:00:00.000Z")], now), []);
		assert.deepEqual(weakPremiseNodeIds([weak, good(1, "2026-11-02T00:00:00.000Z")], now), ["a"]);
	});
	it("ignores non-dialogic flags, bad dates, bad ids, non-review events, bad now and bad window; output is sorted and unique", () => {
		assert.deepEqual(weakPremiseNodeIds([rv({ channel: "fixed", weakPremises: ["a"] })], now), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"], at: "garbage" })], now), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["", "a"] })], now), ["a"]);
		assert.deepEqual(weakPremiseNodeIds([{ type: "pin", nodeId: "a", pinned: true, at: "2026-11-01T10:00:00.000Z" }], now), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"] })], "garbage"), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"] })], now, Number.NaN), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["a"] })], now, 0), []);
		assert.deepEqual(weakPremiseNodeIds([rv({ weakPremises: ["b", "a", "b"] }), rv({ weakPremises: ["a"], at: "2026-11-02T00:00:00.000Z" })], now), ["a", "b"]);
	});
	it("a flag newer than a good review stays weak; the window default is 30 days", () => {
		const events = [rv({ nodeId: "a", channel: "fixed", rating: 3, at: "2026-11-01T00:00:00.000Z" }), rv({ weakPremises: ["a"], at: "2026-11-02T00:00:00.000Z" })];
		assert.deepEqual(weakPremiseNodeIds(events, now), ["a"]);
		assert.equal(WEAK_WINDOW_DAYS, 30);
	});
});

const entryWith = (links: string, extra = "") => `<feed><entry><id>1</id><title>T</title>${links}${extra}</entry></feed>`;
const ALT = `<link href="https://x.org/alt" rel="alternate"/>`;

describe("hardening 2: feed parser limits and exclusions", () => {
	it("exports the size caps", () => {
		assert.equal(MAX_FEED_CHARS, 512_000);
		assert.ok(MAX_FEED_BYTES >= MAX_FEED_CHARS);
	});

	it("parses a hostile feed of 200k unclosed <entry> in well under a second", () => {
		const t0 = performance.now();
		assert.deepEqual(parseFeed("<entry>".repeat(200_000)), []);
		assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
	});

	it("parses 100k unclosed <link  in one block in well under a second", () => {
		const t0 = performance.now();
		assert.deepEqual(parseFeed(`<entry><title>T</title>${"<link ".repeat(100_000)}</entry>`), []);
		assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
	});

	it("parses many unclosed tags inside a block under the size limit quickly", () => {
		const t0 = performance.now();
		parseFeed(`<entry><title>T</title>${"<link ".repeat(3000)}${"<title ".repeat(1000)}${"<".repeat(5000)}</entry>`);
		assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
	});

	it("ignores input beyond MAX_FEED_CHARS and entry blocks longer than 20000 chars", () => {
		const one = (i: number) => `<entry><id>i${i}</id><title>T${i}</title><link href="https://x.org/${i}"/></entry>`;
		const pad = `<!--${"x".repeat(MAX_FEED_CHARS)}-->`;
		assert.deepEqual(parseFeed(one(1) + pad + one(2)).map((i) => i.id), ["i1"]);
		const big = `<entry><id>big</id><title>Big</title><link href="https://x.org/big"/><summary>${"a".repeat(20_001)}</summary></entry>`;
		assert.deepEqual(parseFeed(big + one(3)).map((i) => i.id), ["i3"]);
		const ok = `<entry><id>ok</id><title>Ok</title><link href="https://x.org/ok"/><summary>${"a".repeat(19_000)}</summary></entry>`;
		assert.deepEqual(parseFeed(ok).map((i) => i.id), ["ok"]);
	});

	for (const rel of ["related", "enclosure", "self"]) {
		it(`skips a link with rel="${rel}"`, () => {
			assert.equal(parseFeed(entryWith(`<link href="https://x.org/${rel}" rel="${rel}"/>${ALT}`))[0]!.link, "https://x.org/alt");
			assert.deepEqual(parseFeed(entryWith(`<link href="https://x.org/${rel}" rel="${rel}"/>`)), []);
		});
	}

	it("skips a link titled pdf", () => {
		assert.equal(parseFeed(entryWith(`<link title="pdf" href="https://x.org/p.pdf"/>${ALT}`))[0]!.link, "https://x.org/alt");
	});

	it("decodes &quot; and &apos;, trims the link and falls back to <content>", () => {
		const item = parseFeed(entryWith(`<link href=" https://x.org/a "/>`, `<content type="html">Body</content>`).replace("<title>T</title>", "<title>&quot;q&quot; &apos;a&apos;</title>"))[0]!;
		assert.equal(item.title, `"q" 'a'`);
		assert.equal(item.link, "https://x.org/a");
		assert.equal(item.summary, "Body");
	});

	it("decodes numeric references only inside the Unicode scalar range", () => {
		const title = (ref: string) => parseFeed(entryWith(ALT).replace("<title>T</title>", `<title>[${ref}]</title>`))[0]!.title;
		assert.equal(title("&#xD7FF;"), "[\ud7ff]");
		assert.equal(title("&#xD800;"), "[]");
		assert.equal(title("&#xDFFF;"), "[]");
		assert.equal(title("&#xE000;"), "[\ue000]");
		assert.equal(title("&#x10FFFF;"), "[\u{10ffff}]");
		assert.equal(title("&#x110000;"), "[]");
		assert.equal(title("&#0;"), "[]");
	});

	it("strips tags before decoding, and never decodes entities inside CDATA", () => {
		const title = (t: string) => parseFeed(entryWith(ALT).replace("<title>T</title>", `<title>${t}</title>`))[0]!.title;
		assert.equal(title("x<b>y</b>"), "x y");
		assert.equal(title("a &lt;b&gt; c"), "a <b> c");
		assert.equal(title("<![CDATA[A &amp; B]]>"), "A &amp; B");
		assert.equal(title("<![CDATA[A]]> &amp; <![CDATA[&lt;]]>"), "A & &lt;");
		const summary = parseFeed(entryWith(ALT, "<summary><![CDATA[<p>Hi &amp; bye</p>]]></summary>"))[0]!.summary;
		assert.equal(summary, "Hi &amp; bye");
	});

	it("ignores <source> metadata and commented-out entries", () => {
		const xml = `<feed><!-- <entry><id>c</id><title>Commented</title><link href="https://x.org/c"/></entry> -->
<entry><source><id>s</id><title>Source feed</title></source><id>e</id><title>Real</title><link href="https://x.org/e"/></entry></feed>`;
		const items = parseFeed(xml);
		assert.deepEqual(items.map((i) => [i.id, i.title]), [["e", "Real"]]);
		assert.deepEqual(parseFeed(`<feed><!-- unclosed <entry><id>c</id><title>T</title><link href="https://x.org/c"/></entry>`), []);
	});
});

describe("hardening 2: watch targets (SSRF)", () => {
	const feed = (query: string) => validateWatchTarget({ kind: "feed", query });
	it("accepts public http(s) feeds", () => {
		assert.equal(feed("https://x.org/f"), null);
		assert.equal(feed("http://example.com:8080/f.xml"), null);
		assert.equal(feed("https://8.8.8.8/f"), null);
		assert.equal(feed("https://172.32.0.1/f"), null);
		assert.equal(feed("https://[2606:4700::1111]/f"), null);
		assert.equal(feed("https://localhost.example.org/f"), null);
	});
	it("rejects password-only credentials", () => {
		assert.match(feed("https://:pw@x.org/f") ?? "", /credentials/);
	});
	it("rejects local and internal host names", () => {
		for (const h of ["localhost", "LOCALHOST", "localhost.", "a.localhost", "printer.local", "db.internal", "a.b.internal"]) {
			assert.notEqual(feed(`http://${h}/f`), null, h);
		}
	});
	it("rejects loopback, link-local and private IPv4, including encoded forms", () => {
		for (const h of ["127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "169.254.169.254", "169.254.0.1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "2130706433", "0x7f000001", "0x7f.1", "017700000001", "127.1", "127.0.0.1.", "3232235777"]) {
			assert.notEqual(feed(`http://${h}/f`), null, h);
		}
	});
	it("rejects loopback, unique-local, link-local and IPv4-mapped IPv6", () => {
		for (const h of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:169.254.169.254]", "[::ffff:c0a8:101]", "[::127.0.0.1]", "[64:ff9b::7f00:1]", "[0:0:0:0:0:0:0:1]"]) {
			assert.notEqual(feed(`http://${h}/f`), null, h);
		}
	});
	it("rejects shared (CGN), IETF-reserved, benchmarking, multicast and reserved IPv4 ranges", () => {
		for (const h of ["100.64.0.1", "100.100.100.200", "100.127.255.255", "192.0.0.1", "192.0.0.170", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) {
			assert.notEqual(feed(`https://${h}/f`), null, h);
		}
	});
	it("keeps the public neighbours of those ranges allowed", () => {
		for (const h of ["100.63.255.255", "100.128.0.1", "192.0.1.1", "198.17.255.255", "198.20.0.1", "223.255.255.255"]) {
			assert.equal(feed(`https://${h}/f`), null, h);
		}
	});
	it("rejects multicast, site-local and 6to4 IPv6 that embeds a private address", () => {
		for (const h of ["[ff02::1]", "[ff00::1]", "[fec0::1]", "[feff::1]", "[2002:7f00:1::1]", "[2002:0a00:1::1]", "[::ffff:100.64.0.1]", "[2002:a9fe:a9fe::1]"]) {
			assert.notEqual(feed(`http://${h}/f`), null, h);
		}
	});
	it("keeps a 6to4 address that embeds a public IPv4 allowed", () => {
		assert.equal(feed("https://[2002:0808:0808::1]/f"), null);
	});
	it("rejects the remaining listed hosts", () => {
		for (const u of ["http://0.0.0.0/f", "http://[::ffff:127.0.0.1]/f", "http://127.1/f", "http://[fe80::1]/f", "http://[fd00::1]/f", "http://x.localhost/f", "http://x.internal/f"]) {
			assert.notEqual(feed(u), null, u);
		}
	});
	it("rejects repo names made of dots", () => {
		assert.notEqual(validateWatchTarget({ kind: "repo", query: "o/.." }), null);
		assert.notEqual(validateWatchTarget({ kind: "repo", query: "../n" }), null);
		assert.equal(validateWatchTarget({ kind: "repo", query: "o/.n" }), null);
	});
	it("parseWatchEntry applies the same rules", () => {
		assert.equal(parseWatchEntry({ id: "w", kind: "feed", query: "http://169.254.169.254/latest/meta-data" }), null);
		assert.notEqual(parseWatchEntry({ id: "w", kind: "feed", query: "https://x.org/f" }), null);
	});
});

describe("hardening 2: weak premises and radar types", () => {
	it("keeps the latest flag even when events arrive newest first", () => {
		const rv = (over: Partial<Extract<ReviewEvent, { type: "review" }>>): ReviewEvent => ({ type: "review", nodeId: "n9", channel: "dialogic", rating: 2, durationSec: 30, at: "2026-11-01T10:00:00.000Z", ...over });
		const events = [rv({ weakPremises: ["a"], at: "2026-11-03T00:00:00.000Z" }), rv({ weakPremises: ["a"], at: "2026-11-01T00:00:00.000Z" }), rv({ nodeId: "a", channel: "fixed", rating: 3, at: "2026-11-02T00:00:00.000Z" })];
		assert.deepEqual(weakPremiseNodeIds(events, "2026-11-04T00:00:00.000Z"), ["a"]);
	});
	it("a zero-day window lists nothing, even for a flag at the current instant", () => {
		const flag: ReviewEvent = { type: "review", nodeId: "n9", channel: "dialogic", rating: 2, durationSec: 30, at: "2026-11-04T00:00:00.000Z", weakPremises: ["a"] };
		assert.deepEqual(weakPremiseNodeIds([flag], "2026-11-04T00:00:00.000Z", 0), []);
	});
	it("stops at exactly MAX_FEED_ITEMS entries (the 51st is never returned)", () => {
		let xml = "<feed>";
		for (let i = 0; i < 51; i++) xml += `<entry><id>i${i}</id><title>T${i}</title><link href="https://x.org/${i}"/></entry>`;
		assert.deepEqual(parseFeed(`${xml}</feed>`).map((i) => i.id).slice(-2), ["i48", "i49"]);
	});
	it("rejects a classified event whose title or link is not a string", () => {
		const base = { type: "classified", entryId: "w1", itemId: "i1", title: "t", link: "l", nearestNodeIds: [], relation: "extends", action: "ingest", rationale: "r", at: "2026-11-04T10:00:00.000Z" };
		assert.equal(parseRadarEvent({ ...base, title: 3 }), null);
		assert.equal(parseRadarEvent({ ...base, link: 3 }), null);
		assert.notEqual(parseRadarEvent({ ...base, title: "", link: "" }), null);
	});
});
