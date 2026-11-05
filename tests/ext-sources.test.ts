// tests/ext-sources.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourcesStore } from "../src/core/ext/ports.ts";
import {
	createSourceLibrary,
	hostOfEntry,
	matchSource,
	parseSourceEntry,
	parseSourceLibrary,
	type SourceEntry,
} from "../src/core/ext/sources.ts";

function entry(over: Partial<SourceEntry> = {}): SourceEntry {
	return { id: "lib_a", kind: "url-prefix", locator: "https://en.wikipedia.org/", tier: "secondary", label: "Wikipedia", status: "active", addedBy: "user", ...over };
}
function memStore(initial: SourceEntry[] = []): SourcesStore {
	let entries = initial.map((e) => ({ ...e }));
	return { read: () => entries.map((e) => ({ ...e })), write: (next) => void (entries = next.map((e) => ({ ...e }))) };
}

describe("parseSourceEntry", () => {
	it("accepts a full entry and trims the optional author", () => {
		assert.deepEqual(parseSourceEntry({ ...entry(), author: " Rudin " }), { ...entry(), author: "Rudin" });
	});
	it("rejects bad shapes", () => {
		assert.equal(parseSourceEntry({ ...entry(), kind: "ftp" }), null);
		assert.equal(parseSourceEntry({ ...entry(), tier: "tertiary" }), null);
		assert.equal(parseSourceEntry({ ...entry(), status: "pending" }), null);
		assert.equal(parseSourceEntry({ ...entry(), label: " " }), null);
		assert.equal(parseSourceEntry({ ...entry(), locator: "" }), null);
		assert.equal(parseSourceEntry(null), null);
	});
	it("parseSourceLibrary keeps valid entries, drops invalid ones and duplicate ids", () => {
		const out = parseSourceLibrary({ entries: [entry(), { nope: 1 }, entry({ label: "dup" })] });
		assert.equal(out.length, 1);
		assert.equal(out[0]!.label, "Wikipedia");
		assert.deepEqual(parseSourceLibrary("garbage"), []);
	});
});

describe("matchSource (REQ-src-03, REQ-src-11)", () => {
	const book = entry({ id: "lib_book", kind: "pdf", locator: "/books/rudin.pdf", tier: "primary", label: "Rudin" });
	const wiki = entry();
	const wikiMath = entry({ id: "lib_wm", locator: "https://en.wikipedia.org/wiki/Mathematics", label: "Wiki Math", tier: "primary" });
	const arxiv = entry({ id: "lib_ax", locator: "arxiv.org", label: "arXiv" });
	const repo = entry({ id: "lib_repo", kind: "repo", locator: "owner/proj", label: "Proj" });
	const all = [book, wiki, wikiMath, arxiv, repo];

	it("the longest matching URL prefix wins", () => {
		assert.equal(matchSource("https://en.wikipedia.org/wiki/Mathematics/History", all)?.id, "lib_wm");
		assert.equal(matchSource("https://en.wikipedia.org/wiki/Physics", all)?.id, "lib_a");
	});
	it("a bare domain matches the host and its subdomains", () => {
		assert.equal(matchSource("https://arxiv.org/abs/1234.5678", all)?.id, "lib_ax");
		assert.equal(matchSource("https://export.arxiv.org/abs/1", all)?.id, "lib_ax");
		assert.equal(matchSource("https://notarxiv.org/abs/1", all), null);
	});
	it("a local PDF matches by path; an entry id also resolves", () => {
		assert.equal(matchSource("/books/rudin.pdf", all)?.id, "lib_book");
		assert.equal(matchSource("lib_book", all)?.id, "lib_book");
		assert.equal(matchSource("/books/other.pdf", all), null);
	});
	it("a repository matches github and raw urls", () => {
		assert.equal(matchSource("https://github.com/owner/proj/blob/main/README.md", all)?.id, "lib_repo");
		assert.equal(matchSource("https://raw.githubusercontent.com/owner/proj/main/a.md", all)?.id, "lib_repo");
		assert.equal(matchSource("https://github.com/owner/project2/x", all), null);
	});
	it("anything unmatched is unvetted (null)", () => {
		assert.equal(matchSource("https://random-blog.example/post", all), null);
	});
	it("proposed entries are ignored until activated (REQ-src-02)", () => {
		const proposed = entry({ id: "lib_p", locator: "https://proposed.example/", status: "proposed", addedBy: "agent" });
		assert.equal(matchSource("https://proposed.example/x", [proposed]), null);
		assert.equal(matchSource("lib_p", [proposed]), null);
		assert.equal(matchSource("https://proposed.example/x", [{ ...proposed, status: "active" }])?.id, "lib_p");
	});
});

describe("hostOfEntry", () => {
	it("derives a host per kind", () => {
		assert.equal(hostOfEntry(entry()), "en.wikipedia.org");
		assert.equal(hostOfEntry(entry({ locator: "ArXiv.org" })), "arxiv.org");
		assert.equal(hostOfEntry(entry({ kind: "repo", locator: "o/p" })), "github.com");
		assert.equal(hostOfEntry(entry({ kind: "pdf", locator: "/a.pdf" })), "");
	});
});

describe("createSourceLibrary", () => {
	it("a user entry is active, an agent entry is proposed", () => {
		const lib = createSourceLibrary(memStore(), () => "lib_x");
		assert.equal(lib.add({ kind: "pdf", locator: "/a.pdf", tier: "primary", label: "A", addedBy: "user" }).status, "active");
		const lib2 = createSourceLibrary(memStore(), () => "lib_y");
		assert.equal(lib2.add({ kind: "pdf", locator: "/a.pdf", tier: "primary", label: "A", addedBy: "agent" }).status, "proposed");
	});
	it("rejects duplicates and invalid input", () => {
		const lib = createSourceLibrary(memStore([entry()]), () => "lib_z");
		assert.throws(() => lib.add({ kind: "url-prefix", locator: "https://en.wikipedia.org/", tier: "secondary", label: "again", addedBy: "user" }), /already/);
		assert.throws(() => lib.add({ kind: "pdf", locator: "/b.pdf", tier: "primary", label: " ", addedBy: "user" }), /invalid/);
	});
	it("setStatus activates, optionally re-tiers, and rejects unknown ids", () => {
		const store = memStore([entry({ id: "lib_p", status: "proposed", addedBy: "agent" })]);
		const lib = createSourceLibrary(store);
		const out = lib.setStatus("lib_p", "active", "primary");
		assert.equal(out.status, "active");
		assert.equal(out.tier, "primary");
		assert.equal(store.read()[0]!.status, "active");
		assert.throws(() => lib.setStatus("nope", "active"), /unknown/);
	});
	it("propose adds proposed secondary entries, skipping known locators (agents never promote)", () => {
		const ids = ["lib_1", "lib_2"];
		const store = memStore([entry()]);
		const lib = createSourceLibrary(store, () => ids.shift()!);
		const added = lib.propose([
			{ kind: "url-prefix", locator: "https://en.wikipedia.org/", label: "dup" },
			{ kind: "url-prefix", locator: "https://mathworld.wolfram.com/", label: "MathWorld" },
		]);
		assert.equal(added.length, 1);
		assert.equal(added[0]!.status, "proposed");
		assert.equal(added[0]!.addedBy, "agent");
		assert.equal(added[0]!.tier, "secondary");
		assert.equal(store.read().length, 2);
	});
});
