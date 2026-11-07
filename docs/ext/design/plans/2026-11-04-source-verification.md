# Source-of-Truth Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every graph proposition a derived trust level (`unverified` / `sourced` / `contested` / `refuted`), where `sourced` rests on a quotation that code (not the model) confirmed to occur in a stored snapshot of a user-curated source.

**Architecture:** A separate stage after the merge, never touching the extractor schema or any upstream ledger. Pure core (`src/core/ext/`) holds the source library, quote normalization, the outcome function, the verify service and the triggers, all against ports. A researcher-role sub-agent (`src/agent/ext/`) returns raw `{sourceRef, locator, quote, stance}` evidence; code re-reads the source itself, snapshots it, checks the quote, assigns the tier from the library, and appends one event per node to `data/ext/verification.jsonl`. The server composes everything in `src/server/ext/`; the only upstream edits are four one-line touchpoints.

**Tech Stack:** TypeScript (Node 26, ESM, `.ts` import extensions), Next.js route handlers, React (functional badge only), `node:test` via `tsx`, `@earendil-works/pi-agent-core` / `pi-ai` (existing sub-agent runner and faux engine), existing `pdf-ops`.

**Conventions for every task**
- Work on branch `ext` in `<repo>`.
- Test command (`T`): `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test <file>`
- Code style: tabs, double quotes, `import type` for types (`verbatimModuleSyntax`), `.ts` extensions in imports, `noUncheckedIndexedAccess` (use `!` on indexed reads in tests).
- Every commit message ends with a second `-m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`.
- Layer law: `src/core` never imports `agent`/`server`/`store`; `src/agent` never imports `server`/`store`; `app/` imports only `@/src/core` and `@/src/server` barrels; `components/` imports only `@/src/core` (so the badge defines its own response type and uses `fetch`).

**Spec:** `docs/superpowers/specs/2026-11-04-source-verification-design.md` (REQ-src-01 to 17; parent REQ-ver-01 to 03, REQ-cost-01, REQ-port-01).

## Discovered facts that shape the plan

- `src/agent/subagents/headless.ts` (named in the spec) is the **browser/PDF-render harness**, not an LLM runner. The LLM sub-agent runner is `runSubagent` in `src/agent/subagents/pi-run.ts` (used by the researcher). The verifier uses `runSubagent` with role `"researcher"` (reuses the researcher model slot; no new `ModelRole`, so `config.ts` stays untouched).
- `web_fetch` truncates pages at 40,000 characters; the verifier sees the same text our reader re-fetches, so quotes beyond that are unverifiable by design (stated in Risks of the spec as a known limit of exact matching).
- The post-merge hook cannot be added without an upstream edit. The least invasive spot is wrapping the exported `extraction` pipeline instance in `src/server/chat-handler.ts` (both front doors, chat runs and notes imports, go through it).
- `app/**` may import only the barrels `@/src/core` and `@/src/server`; routes therefore need one barrel line in `src/server/index.ts`.
- Node ids use `n_…`, notes sources use `src_…`; library entries use `lib_…` to avoid confusion.

## Assumed interface (shared with sibling plans, written in parallel)

REQ-cost-01 is a parent-level ceiling that the research-loop plan also consumes. This plan needs only:

```ts
// src/core/ext/cost-gate.ts
export interface CostGate {
	/** True while today's recorded spend is below the ceiling. */
	allowed(): boolean;
	/** Record spend in USD for a source ("verification" | "research"). Ignores non-finite or negative values. */
	record(usd: number, source: string): void;
}
```

Task 6 creates `src/core/ext/cost-gate.ts`, its ledger `cost.jsonl`, and the store adapter **only if the file does not already exist on `ext`** (check first; if a sibling plan landed it, reuse it and skip to the verification that its exports match the interface above: `CostGate`, `createCostGate`, `CostStore`).

## Upstream touchpoints added by this plan (add to `docs/ext/TOUCHPOINTS.md` in Task 15)

| File | Change |
|---|---|
| `src/server/chat-handler.ts` | wrap the exported `extraction` with `withPostMerge(..., verifyAfterMerge)` (one import line, one wrapping expression) |
| `src/server/index.ts` | one barrel line `export * from "./ext/index.ts";` |
| `app/api/chats/route.ts` | tag picked propositions with their trust level before building the graph-context message |
| `components/graph-view.tsx` | mount `<TrustBadge nodeId=... />` under the node statement in the detail card |

## File structure

Create:
- `src/core/ext/sources.ts` — library entry types, parse, `matchSource`, `hostOfEntry`, `createSourceLibrary`.
- `src/core/ext/quote.ts` — `normalizeForMatch`, `checkQuote`.
- `src/core/ext/trust.ts` — `Evidence`, `outcomeOf`, verification events, `deriveTrustMap`, `trustTag`.
- `src/core/ext/verifier-output.ts` — `parseVerifierOutput`.
- `src/core/ext/cost-gate.ts` — assumed interface + minimal implementation (Task 6).
- `src/core/ext/verify.ts` — `buildEvidence`, `verifyNodes`.
- `src/core/ext/verify-targets.ts` — `postMergeTargets`, `activationTargets`.
- `src/core/ext/verification-service.ts` — `createVerificationService` (single-flight, triggers, trust views).
- `src/store/ext/sources-store.ts`, `snapshot-store.ts`, `verification-store.ts`, `cost-store.ts`.
- `src/agent/ext/source-reader.ts` — re-reads a source for the snapshot (URL, remote PDF, allowed local PDF).
- `src/agent/ext/verifier.ts` — prompt, library PDF tools, `createVerifier`.
- `src/server/ext/verification.ts` — wiring; `src/server/ext/post-merge.ts` — `withPostMerge`; `src/server/ext/index.ts` — barrel.
- `app/api/ext/verification/route.ts`, `app/api/ext/sources/route.ts`, `app/api/ext/sources/[id]/route.ts`.
- `components/ext/trust-badge.tsx`.
- `scripts/ext-measure-quotes.ts`, `tests/fixtures/ext/quote-corpus.json` (generated).
- Tests: `tests/ext-sources.test.ts`, `ext-quote.test.ts`, `ext-quote-corpus.test.ts`, `ext-trust.test.ts`, `ext-verifier-output.test.ts`, `ext-cost-gate.test.ts`, `ext-verify-stores.test.ts`, `ext-verify.test.ts`, `ext-verification-service.test.ts`, `ext-source-reader.test.ts`, `ext-verifier-agent.test.ts`, `ext-post-merge.test.ts`, `ext-trust-badge.test.tsx`; helper `tests/helpers/ext-fakes.ts`.

Modify: `src/store/ext/paths.ts`, `tests/ext-paths.test.ts`, `src/server/ext/stores.ts`, `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md`, plus the four touchpoints.

---

### Task 1: Environment check (first, as the spec requires a measurement on a real PDF)

**Files:** none modified.

- [ ] **Step 1: Confirm Node, branch and baseline**

Run:
```bash
cd <repo>
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && node -v && git branch --show-current
NODE_ENV=test npx tsx --test tests/ext-*.test.ts 2>&1 | tail -8
```
Expected: `v26.…`, `ext`, and the Foundation ext tests end with `# fail 0`. If not, stop and fix the Foundation first.

- [ ] **Step 2: Confirm the real math PDF is extractable with upstream's own tool**

The measurement in Task 3 needs a real, mathematical PDF. Use `<local>/dispense_Prob_1.pdf` (or any other the user prefers; export it as `LH_MEASURE_PDF`).

Run:
```bash
export LH_MEASURE_PDF="<local>/dispense_Prob_1.pdf"
test -f "$LH_MEASURE_PDF" && echo "pdf present"
cat > "$(mktemp -d)/smoke.ts" <<'EOF'
import { pdfExtract } from "src/agent/subagents/pdf-ops.ts";
const text = await pdfExtract(process.env.LH_MEASURE_PDF!, "3");
console.log(text.slice(0, 600));
EOF
```
Then run the generated file with `npx tsx <that path>` (the `mktemp -d` path printed by `ls -d /var/folders/*/*/T/tmp.* | tail -1`; or simply `cd` into the temp dir first). Expected: `--- Page 3 ---` followed by readable Markdown text. Note in the PR description whether formulas look damaged; this informs the Task 3 gate.

- [ ] **Step 3: Record the two facts that later tasks rely on**

Run:
```bash
grep -n "registerFauxProvider\|createFauxCore" node_modules/@earendil-works/pi-ai/dist/index.d.ts | head -3
grep -rn "listLibrarySources\|addLibrarySource\|verifyNodesNow" src app components | head
```
Expected: the first prints a faux export (the tests use `createFauxCore`); the second prints nothing (no name collisions).

(No commit: nothing changed.)

---

### Task 2: Quote normalization and check (REQ-src-05)

**Files:**
- Create: `src/core/ext/quote.ts`
- Test: `tests/ext-quote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-quote.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkQuote, normalizeForMatch } from "../src/core/ext/quote.ts";

const SNAP = "The sum of the angles of a triangle in the Euclidean plane\nis equal to one hundred and eighty degrees.";

describe("normalizeForMatch", () => {
	it("collapses whitespace and lowercases", () => {
		assert.equal(normalizeForMatch("  The  Sum\n\tof  ", "join"), "the sum of");
	});
	it("joins a hyphenated line break in join mode and keeps the hyphen in keep mode", () => {
		assert.equal(normalizeForMatch("a well-\nknown fact", "join"), "a wellknown fact");
		assert.equal(normalizeForMatch("a well-\nknown fact", "keep"), "a well-known fact");
	});
	it("folds unicode forms: ligatures, typographic quotes and dashes, soft hyphen", () => {
		assert.equal(normalizeForMatch("ﬁnite ‘x’ “y” a–b co­op", "join"), "finite 'x' \"y\" a-b coop");
	});
});

describe("checkQuote", () => {
	it("accepts an exact substring", () => {
		assert.equal(checkQuote(SNAP, "sum of the angles of a triangle"), "ok");
	});
	it("accepts across a line break, case and spacing differences", () => {
		assert.equal(checkQuote(SNAP, "EUCLIDEAN  plane is equal to one hundred"), "ok");
	});
	it("accepts a compound word whose hyphen fell on a line break", () => {
		assert.equal(checkQuote("this is a well-\nknown theorem of analysis", "a well-known theorem of analysis"), "ok");
		assert.equal(checkQuote("this is an interna-\ntional theorem of analysis", "an international theorem of analysis"), "ok");
	});
	it("rejects text that is not in the snapshot", () => {
		assert.equal(checkQuote(SNAP, "the sum of the angles of a triangle is two hundred degrees"), "quote_not_found");
	});
	it("rejects a quote that is too short to mean anything", () => {
		assert.equal(checkQuote(SNAP, "the sum"), "quote_too_short");
		assert.equal(checkQuote(SNAP, "   "), "quote_too_short");
	});
	it("does not accept a reordered or paraphrased quote (exact match only)", () => {
		assert.equal(checkQuote(SNAP, "equal to one hundred and eighty degrees the sum of the angles"), "quote_not_found");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `T tests/ext-quote.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/quote.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/quote.ts
/**
 * Quote check (REQ-src-05). A quotation counts only if, after NORMALIZATION,
 * it occurs verbatim in the stored snapshot. Normalization covers exactly:
 * whitespace, hyphenation at line breaks, case and unicode form (NFKC, plus
 * folding of typographic quotes, dashes and the soft hyphen). No fuzzy
 * matching. Hyphenation is ambiguous ("well-\nknown" vs "interna-\ntional"),
 * so both readings are tried: hyphen dropped ("join") and hyphen kept ("keep").
 */

/** A quote shorter than this (after normalization) is evidence of nothing. */
export const MIN_QUOTE_CHARS = 20;

export type HyphenMode = "join" | "keep";
export type QuoteCheck = "ok" | "quote_too_short" | "quote_not_found";

export function normalizeForMatch(text: string, hyphen: HyphenMode): string {
	let s = text.normalize("NFKC");
	s = s.replace(/­/g, "");
	s = s.replace(/[‘’‚‛′]/g, "'");
	s = s.replace(/[“”„‟″]/g, '"');
	s = s.replace(/[‐‑‒–—―−]/g, "-");
	s = s.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, hyphen === "join" ? "$1$2" : "$1-$2");
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pure and deterministic: the same snapshot and quote always give the same verdict. */
export function checkQuote(snapshot: string, quote: string): QuoteCheck {
	const joined = normalizeForMatch(quote, "join");
	if (joined.length < MIN_QUOTE_CHARS) return "quote_too_short";
	if (normalizeForMatch(snapshot, "join").includes(joined)) return "ok";
	const kept = normalizeForMatch(quote, "keep");
	return normalizeForMatch(snapshot, "keep").includes(kept) ? "ok" : "quote_not_found";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `T tests/ext-quote.test.ts`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/quote.ts tests/ext-quote.test.ts
git commit -m "feat(ext): add quote normalization and exact-match check" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Measure exact-match loss on the real PDF and build the regression corpus (spec Risk gate)

**Files:**
- Create: `scripts/ext-measure-quotes.ts`
- Create (generated): `tests/fixtures/ext/quote-corpus.json`
- Test: `tests/ext-quote-corpus.test.ts`

The spec says: measure on a real PDF at the start; move to approximate matching only if the loss is material. The proxy: take 8-word windows from an **independent** extraction (raw pdfjs text items, which is what a model that cleaned or re-typed text would roughly produce) and check them against the snapshot text produced by upstream's `pdfExtract`. Windows taken from the snapshot itself must match 100% (self-consistency).

- [ ] **Step 1: Write the script**

```ts
// scripts/ext-measure-quotes.ts
/**
 * Usage: npx tsx scripts/ext-measure-quotes.ts <pdf> [--samples 300] [--write-corpus tests/fixtures/ext/quote-corpus.json]
 * Prints the share of independent 8-word windows that the exact-match check finds in the snapshot.
 */
import * as fs from "node:fs";
import { pdfExtract } from "../src/agent/subagents/pdf-ops.ts";
import { checkQuote } from "../src/core/ext/quote.ts";

const args = process.argv.slice(2);
const pdf = args[0];
if (pdf === undefined) throw new Error("usage: ext-measure-quotes.ts <pdf> [--samples N] [--write-corpus file]");
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const samples = Number(flag("--samples") ?? 300);
const corpusFile = flag("--write-corpus");

const snapshot = (await pdfExtract(pdf, "all")).replace(/^--- Page \d+ ---$/gm, "");

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), verbosity: 0 }).promise;
let raw = "";
for (let p = 1; p <= doc.numPages; p++) {
	const content = await (await doc.getPage(p)).getTextContent();
	for (const item of content.items) if ("str" in item) raw += item.str + (item.hasEOL ? "\n" : " ");
}

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function windows(text: string, n: number): string[] {
	const words = text.split(/\s+/).filter((w) => w !== "");
	const out: string[] = [];
	for (let i = 0; i < n && words.length > 8; i++) {
		const start = Math.floor(rand() * (words.length - 8));
		out.push(words.slice(start, start + 8).join(" "));
	}
	return out;
}
function rate(quotes: string[]): { ok: number; considered: number; misses: string[] } {
	let ok = 0;
	let considered = 0;
	const misses: string[] = [];
	for (const q of quotes) {
		const r = checkQuote(snapshot, q);
		if (r === "quote_too_short") continue;
		considered++;
		if (r === "ok") ok++;
		else misses.push(q);
	}
	return { ok, considered, misses };
}

const self = rate(windows(snapshot, samples));
const independent = rate(windows(raw, samples));
console.log(`self-consistency: ${self.ok}/${self.considered}`);
console.log(`independent extraction: ${independent.ok}/${independent.considered} = ${(independent.ok / Math.max(1, independent.considered)).toFixed(3)}`);
console.log("sample misses:");
for (const m of independent.misses.slice(0, 10)) console.log(`  - ${m}`);

if (corpusFile !== undefined) {
	// Passing pairs that needed normalization (raw substring absent) are the interesting regression cases.
	const normalizedOnly: { quote: string; snapshot: string }[] = [];
	const plain: { quote: string; snapshot: string }[] = [];
	for (const q of windows(raw, samples * 3)) {
		if (checkQuote(snapshot, q) !== "ok") continue;
		const words = snapshot.split(/\s+/);
		const anchor = q.split(/\s+/)[0]!;
		const at = Math.max(0, snapshot.toLowerCase().indexOf(anchor.toLowerCase()));
		const excerpt = snapshot.slice(Math.max(0, at - 200), at + 600);
		void words;
		if (checkQuote(excerpt, q) !== "ok") continue;
		(snapshot.includes(q) ? plain : normalizedOnly).push({ quote: q, snapshot: excerpt });
	}
	const pairs = [...normalizedOnly.slice(0, 15), ...plain.slice(0, 5)];
	fs.mkdirSync(corpusFile.replace(/\/[^/]+$/, ""), { recursive: true });
	fs.writeFileSync(corpusFile, JSON.stringify(pairs, null, "\t") + "\n");
	console.log(`wrote ${pairs.length} corpus pairs (${Math.min(15, normalizedOnly.length)} needed normalization) to ${corpusFile}`);
}
```

- [ ] **Step 2: Run it on the real PDF**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npx tsx scripts/ext-measure-quotes.ts "$LH_MEASURE_PDF" --samples 300 --write-corpus tests/fixtures/ext/quote-corpus.json
```
Expected: `self-consistency: N/N` (all) and an `independent extraction` ratio plus sample misses; then `wrote … corpus pairs`.

- [ ] **Step 3: Decision gate (stop and report)**

- Ratio >= 0.90: proceed with exact matching only (the spec default). Record the number in the commit message.
- Ratio < 0.90: **stop and ask the user** whether to add approximate matching (the spec allows it only when loss is material). Do not add it on your own; the rest of the plan assumes exact matching.

- [ ] **Step 4: Write the corpus regression test**

```ts
// tests/ext-quote-corpus.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkQuote } from "../src/core/ext/quote.ts";

const file = path.join(import.meta.dirname, "fixtures", "ext", "quote-corpus.json");

describe("quote corpus built from a real PDF", () => {
	const pairs = JSON.parse(fs.readFileSync(file, "utf-8")) as { quote: string; snapshot: string }[];
	it("has enough cases", () => {
		assert.ok(pairs.length >= 10, `expected at least 10 corpus pairs, got ${pairs.length}`);
	});
	it("every recorded quote still matches its excerpt", () => {
		for (const p of pairs) assert.equal(checkQuote(p.snapshot, p.quote), "ok", p.quote);
	});
	it("a perturbed quote does not match", () => {
		for (const p of pairs.slice(0, 5)) assert.notEqual(checkQuote(p.snapshot, `${p.quote} and a sentence that is not there`), "ok");
	});
});
```

- [ ] **Step 5: Run and commit**

Run: `T tests/ext-quote-corpus.test.ts` → PASS.
```bash
git add scripts/ext-measure-quotes.ts tests/fixtures/ext/quote-corpus.json tests/ext-quote-corpus.test.ts
git commit -m "test(ext): measure exact quote matching on a real PDF and add regression corpus" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(The corpus contains short excerpts of the user's own PDF; it lives in a private repo. If the user objects, drop the fixture and keep the script.)

---

### Task 4: Source library core (REQ-src-01, 02, 03, 10 host helper, 11)

**Files:**
- Modify: `src/core/ext/ports.ts`
- Create: `src/core/ext/sources.ts`
- Test: `tests/ext-sources.test.ts`

- [ ] **Step 1: Add the ports used by the library** — append to `src/core/ext/ports.ts`:

```ts
import type { SourceEntry } from "./sources.ts";

/** The source library: a configuration file, read-modify-write (not an event ledger). */
export interface SourcesStore {
	/** Valid entries only; [] when the file is absent or unreadable. Throws on a newer stamp. */
	read(): SourceEntry[];
	write(entries: SourceEntry[]): void;
}
```

- [ ] **Step 2: Write the failing test**

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `T tests/ext-sources.test.ts` → FAIL `Cannot find module '../src/core/ext/sources.ts'`.

- [ ] **Step 4: Implement**

```ts
// src/core/ext/sources.ts
/**
 * The source library (REQ-src-01..03, 11). A source not matched by an ACTIVE
 * entry is "unvetted" and never counts as evidence. Agent-proposed entries
 * are `proposed` and invisible to matching until the user activates them.
 * Tiers come from here, never from the model (REQ-src-06).
 */

import { randomBytes } from "node:crypto";
import type { SourcesStore } from "./ports.ts";

export type SourceKind = "pdf" | "url-prefix" | "repo";
export type SourceTier = "primary" | "secondary";
export type SourceStatus = "active" | "proposed";
export type SourceAddedBy = "user" | "agent";

export interface SourceEntry {
	id: string;
	kind: SourceKind;
	/** pdf: absolute path. url-prefix: a URL prefix ("https://…") or a bare domain ("arxiv.org"). repo: "owner/name". */
	locator: string;
	tier: SourceTier;
	label: string;
	/** Optional author label, used for the independence check (REQ-src-10). */
	author?: string;
	status: SourceStatus;
	addedBy: SourceAddedBy;
}

const KINDS = new Set<string>(["pdf", "url-prefix", "repo"]);

export function parseSourceEntry(raw: unknown): SourceEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
	if (typeof r.locator !== "string" || r.locator.trim() === "") return null;
	if (r.tier !== "primary" && r.tier !== "secondary") return null;
	if (typeof r.label !== "string" || r.label.trim() === "") return null;
	if (r.status !== "active" && r.status !== "proposed") return null;
	if (r.addedBy !== "user" && r.addedBy !== "agent") return null;
	if (r.author !== undefined && typeof r.author !== "string") return null;
	const entry: SourceEntry = {
		id: r.id,
		kind: r.kind as SourceKind,
		locator: r.locator.trim(),
		tier: r.tier,
		label: r.label.trim(),
		status: r.status,
		addedBy: r.addedBy,
	};
	if (typeof r.author === "string" && r.author.trim() !== "") entry.author = r.author.trim();
	return entry;
}

/** The sources.json document is `{ "entries": [...] }`. Invalid entries and repeated ids are dropped. */
export function parseSourceLibrary(raw: unknown): SourceEntry[] {
	if (typeof raw !== "object" || raw === null) return [];
	const list = (raw as { entries?: unknown }).entries;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: SourceEntry[] = [];
	for (const item of list) {
		const e = parseSourceEntry(item);
		if (e === null || seen.has(e.id)) continue;
		seen.add(e.id);
		out.push(e);
	}
	return out;
}

function parseUrl(s: string): URL | null {
	try {
		const u = new URL(s);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/** Score of a URL against an entry: the length of the matched prefix, 0 for no match. */
function matchScore(entry: SourceEntry, url: URL): number {
	if (entry.kind === "url-prefix") {
		const prefix = parseUrl(entry.locator);
		if (prefix !== null) return url.href.startsWith(prefix.href) ? prefix.href.length : 0;
		const host = entry.locator.toLowerCase();
		return url.hostname === host || url.hostname.endsWith(`.${host}`) ? host.length : 0;
	}
	if (entry.kind === "repo") {
		const repo = entry.locator.replace(/^\/+|\/+$/g, "");
		for (const base of [`https://github.com/${repo}`, `https://raw.githubusercontent.com/${repo}`]) {
			if (url.href === base || url.href.startsWith(`${base}/`)) return base.length;
		}
	}
	return 0;
}

/**
 * The ACTIVE entry a source reference belongs to, or null (= unvetted).
 * `ref` is an entry id, a local PDF path, or a URL. URLs match the entry with
 * the longest matching prefix (REQ-src-03); PDFs match by path.
 */
export function matchSource(ref: string, entries: readonly SourceEntry[]): SourceEntry | null {
	const active = entries.filter((e) => e.status === "active");
	const byId = active.find((e) => e.id === ref);
	if (byId !== undefined) return byId;
	const url = parseUrl(ref);
	if (url === null) return active.find((e) => e.kind === "pdf" && e.locator === ref) ?? null;
	let best: SourceEntry | null = null;
	let bestScore = 0;
	for (const e of active) {
		const score = matchScore(e, url);
		if (score > bestScore) {
			best = e;
			bestScore = score;
		}
	}
	return best;
}

/** Host used by the independence rule; "" for a local PDF. */
export function hostOfEntry(entry: SourceEntry): string {
	if (entry.kind === "pdf") return "";
	if (entry.kind === "repo") return "github.com";
	const u = parseUrl(entry.locator);
	return u !== null ? u.hostname : entry.locator.toLowerCase();
}

export interface NewSourceInput {
	kind: SourceKind;
	locator: string;
	tier: SourceTier;
	label: string;
	author?: string;
	addedBy: SourceAddedBy;
}

export interface SourceProposal {
	kind: SourceKind;
	locator: string;
	label: string;
}

export interface SourceLibrary {
	list(): SourceEntry[];
	/** User entries are active; agent entries are proposed. Throws on invalid input or a repeated (kind, locator). */
	add(input: NewSourceInput): SourceEntry;
	/** The only way a proposed entry becomes active. Throws on an unknown id. */
	setStatus(id: string, status: SourceStatus, tier?: SourceTier): SourceEntry;
	/** Adds proposed secondary entries for locators not yet in the library. Never activates. */
	propose(proposals: readonly SourceProposal[]): SourceEntry[];
}

function defaultSourceId(): string {
	return `lib_${randomBytes(4).toString("hex")}`;
}

export function createSourceLibrary(store: SourcesStore, newId: () => string = defaultSourceId): SourceLibrary {
	return {
		list: () => store.read(),
		add(input) {
			const entries = store.read();
			if (entries.some((e) => e.kind === input.kind && e.locator === input.locator.trim())) {
				throw new Error(`source library: ${input.locator} is already in the library`);
			}
			const entry = parseSourceEntry({ id: newId(), ...input, status: input.addedBy === "user" ? "active" : "proposed" });
			if (entry === null) throw new Error("source library: invalid entry (kind, locator, tier and label are required)");
			store.write([...entries, entry]);
			return entry;
		},
		setStatus(id, status, tier) {
			const entries = store.read();
			const i = entries.findIndex((e) => e.id === id);
			if (i < 0) throw new Error(`source library: unknown source ${id}`);
			const next: SourceEntry = { ...entries[i]!, status, ...(tier !== undefined ? { tier } : {}) };
			entries[i] = next;
			store.write(entries);
			return next;
		},
		propose(proposals) {
			const entries = store.read();
			const added: SourceEntry[] = [];
			for (const p of proposals) {
				if (entries.some((e) => e.kind === p.kind && e.locator === p.locator.trim())) continue;
				const entry = parseSourceEntry({
					id: newId(),
					kind: p.kind,
					locator: p.locator,
					tier: "secondary",
					label: p.label,
					status: "proposed",
					addedBy: "agent",
				});
				if (entry === null) continue;
				entries.push(entry);
				added.push(entry);
			}
			if (added.length > 0) store.write(entries);
			return added;
		},
	};
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `T tests/ext-sources.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ext/ports.ts src/core/ext/sources.ts tests/ext-sources.test.ts
git commit -m "feat(ext): add source library with tiered entries and longest-prefix matching" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Evidence, outcome function, verification events, trust derivation (REQ-src-07..12, 14; REQ-ver-01)

**Files:**
- Create: `src/core/ext/trust.ts`
- Test: `tests/ext-trust.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-trust.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deriveTrustMap,
	outcomeOf,
	parseVerificationEvent,
	trustTag,
	type Evidence,
	type VerificationEvent,
} from "../src/core/ext/trust.ts";

function ev(over: Partial<Evidence> = {}): Evidence {
	return {
		sourceRef: "https://a.org/x",
		sourceId: "lib_a",
		locator: "p. 1",
		quote: "a quote of sufficient length",
		snapshot: "h1",
		stance: "supports",
		tier: "primary",
		host: "a.org",
		...over,
	};
}
const secA = ev({ tier: "secondary", sourceId: "lib_a", host: "a.org" });
const secB = ev({ tier: "secondary", sourceId: "lib_b", host: "b.org" });

describe("outcomeOf (REQ-src-07..11)", () => {
	it("no evidence is unverified", () => assert.equal(outcomeOf([]), "unverified"));
	it("one supporting primary is sourced", () => assert.equal(outcomeOf([ev()]), "sourced"));
	it("one supporting secondary is not enough", () => assert.equal(outcomeOf([secA]), "unverified"));
	it("two independent supporting secondaries are sourced", () => assert.equal(outcomeOf([secA, secB]), "sourced"));
	it("two secondaries on the same host without author labels are not independent", () => {
		assert.equal(outcomeOf([secA, { ...secB, host: "a.org" }]), "unverified");
	});
	it("same host but different author labels are independent", () => {
		assert.equal(outcomeOf([{ ...secA, author: "Rudin" }, { ...secB, host: "a.org", author: "Tao" }]), "sourced");
	});
	it("same host with only one author label is not provably independent", () => {
		assert.equal(outcomeOf([{ ...secA, author: "Rudin" }, { ...secB, host: "a.org" }]), "unverified");
	});
	it("the same library entry twice is never independent", () => {
		assert.equal(outcomeOf([secA, { ...secA, host: "other.org" }]), "unverified");
	});
	it("unvetted evidence never qualifies, for or against", () => {
		const unv = ev({ tier: "unvetted", sourceId: null });
		assert.equal(outcomeOf([unv]), "unverified");
		assert.equal(outcomeOf([ev(), { ...unv, stance: "contradicts" }]), "sourced");
	});
	it("a supporting primary with a contradicting primary is contested", () => {
		assert.equal(outcomeOf([ev(), ev({ stance: "contradicts", sourceId: "lib_c", host: "c.org" })]), "contested");
	});
	it("a contradicting secondary does not block a supporting primary", () => {
		assert.equal(outcomeOf([ev(), { ...secB, stance: "contradicts" }]), "sourced");
	});
	it("a supporting secondary against a contradicting secondary is contested", () => {
		assert.equal(outcomeOf([secA, { ...secB, stance: "contradicts" }]), "contested");
	});
	it("only contradicting qualified evidence is refuted", () => {
		assert.equal(outcomeOf([{ ...secB, stance: "contradicts" }]), "refuted");
	});
	it("is order independent (deterministic)", () => {
		const items = [ev({ stance: "contradicts", sourceId: "lib_c", host: "c.org" }), secA, secB, ev()];
		const expected = outcomeOf(items);
		for (let i = 0; i < items.length; i++) assert.equal(outcomeOf([...items.slice(i), ...items.slice(0, i)]), expected);
	});
});

function checkedEvent(nodeId: string, outcome: "unverified" | "sourced" | "contested" | "refuted", at: string): VerificationEvent {
	return { type: "checked", nodeId, outcome, evidence: outcome === "sourced" ? [ev()] : [], discarded: [], checker: "m:1", at };
}

describe("deriveTrustMap (REQ-ver-01, REQ-src-12)", () => {
	it("defaults are absent (callers read unverified) and the latest checked event wins", () => {
		const map = deriveTrustMap([checkedEvent("n1", "sourced", "t1"), checkedEvent("n1", "contested", "t2")]);
		assert.equal(map.get("n1")?.level, "contested");
		assert.equal(map.get("n2"), undefined);
	});
	it("a failed check never changes the level", () => {
		const map = deriveTrustMap([
			checkedEvent("n1", "sourced", "t1"),
			{ type: "check_failed", nodeId: "n1", reason: "boom", at: "t2" },
		]);
		assert.equal(map.get("n1")?.level, "sourced");
	});
	it("a failed check alone leaves the node without a level", () => {
		assert.equal(deriveTrustMap([{ type: "check_failed", nodeId: "n1", reason: "x", at: "t" }]).get("n1"), undefined);
	});
	it("exposes the evidence of the latest checked event", () => {
		assert.equal(deriveTrustMap([checkedEvent("n1", "sourced", "t")]).get("n1")?.evidence.length, 1);
	});
});

describe("parseVerificationEvent", () => {
	it("round-trips a valid checked event and a check_failed event", () => {
		const e = checkedEvent("n1", "sourced", "2026-11-04T10:00:00.000Z");
		assert.deepEqual(parseVerificationEvent(JSON.parse(JSON.stringify(e))), e);
		const f: VerificationEvent = { type: "check_failed", nodeId: "n1", reason: "x", at: "t" };
		assert.deepEqual(parseVerificationEvent(f), f);
	});
	it("rejects bad outcome, bad evidence and unknown types", () => {
		assert.equal(parseVerificationEvent({ ...checkedEvent("n1", "sourced", "t"), outcome: "maybe" }), null);
		assert.equal(parseVerificationEvent({ ...checkedEvent("n1", "sourced", "t"), evidence: [{ quote: "x" }] }), null);
		assert.equal(parseVerificationEvent({ type: "other", nodeId: "n1", at: "t" }), null);
		assert.equal(parseVerificationEvent({ ...checkedEvent("", "sourced", "t") }), null);
	});
});

describe("trustTag", () => {
	it("is self-explanatory for each level", () => {
		assert.match(trustTag("unverified"), /not checked/);
		assert.match(trustTag("sourced"), /sourced/);
		assert.match(trustTag("contested"), /disagree/);
		assert.match(trustTag("refuted"), /contradict/);
	});
});
```


- [ ] **Step 2: Run to verify it fails**

Run: `T tests/ext-trust.test.ts` → FAIL `Cannot find module '../src/core/ext/trust.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/trust.ts
/**
 * Trust (REQ-src-06..12, 14; REQ-ver-01). Evidence stored in an event has
 * already passed the quote check; its tier was assigned by code from the
 * library at check time ("unvetted" when no ACTIVE entry matched). The
 * outcome function is pure and order independent.
 */

export type Stance = "supports" | "contradicts";
export type EvidenceTier = "primary" | "secondary" | "unvetted";
export type TrustLevel = "unverified" | "sourced" | "contested" | "refuted";
export type DiscardReason = "quote_not_found" | "quote_too_short" | "source_unreadable";

export interface Evidence {
	/** What the verifier cited: a library entry id, a local PDF path, or a URL. */
	sourceRef: string;
	/** The ACTIVE library entry it matched, or null (unvetted). */
	sourceId: string | null;
	locator: string;
	quote: string;
	/** sha256 of the snapshot the quote was checked against. */
	snapshot: string;
	stance: Stance;
	/** Tier at the time of the check (REQ-src-14). */
	tier: EvidenceTier;
	host: string;
	author?: string;
}

export interface Discarded {
	sourceRef: string;
	reason: DiscardReason;
}

export type VerificationEvent =
	| {
			type: "checked";
			nodeId: string;
			outcome: TrustLevel;
			evidence: Evidence[];
			discarded: Discarded[];
			checker: string;
			at: string;
	  }
	| { type: "check_failed"; nodeId: string; reason: string; at: string };

const LEVELS = new Set<string>(["unverified", "sourced", "contested", "refuted"]);
const TIERS = new Set<string>(["primary", "secondary", "unvetted"]);
const REASONS = new Set<string>(["quote_not_found", "quote_too_short", "source_unreadable"]);

function sameAuthor(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** REQ-src-10: distinct library entries AND (different hosts OR provably different author labels). */
export function independent(a: Evidence, b: Evidence): boolean {
	if (a.sourceId === null || b.sourceId === null || a.sourceId === b.sourceId) return false;
	if (a.host !== b.host) return true;
	return a.author !== undefined && b.author !== undefined && !sameAuthor(a.author, b.author);
}

function hasIndependentPair(items: readonly Evidence[]): boolean {
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) if (independent(items[i]!, items[j]!)) return true;
	}
	return false;
}

/** REQ-src-07..09, 11. Precedence: sourced, contested, refuted, unverified. */
export function outcomeOf(evidence: readonly Evidence[]): TrustLevel {
	const qualified = evidence.filter((e) => e.tier !== "unvetted");
	const supporting = qualified.filter((e) => e.stance === "supports");
	const against = qualified.filter((e) => e.stance === "contradicts");
	const supportedByPrimary = supporting.some((e) => e.tier === "primary");
	const contradictedByPrimary = against.some((e) => e.tier === "primary");
	const secondaries = supporting.filter((e) => e.tier === "secondary");
	if ((supportedByPrimary || hasIndependentPair(secondaries)) && !contradictedByPrimary) return "sourced";
	if (supporting.length > 0 && against.length > 0) return "contested";
	if (against.length > 0) return "refuted";
	return "unverified";
}

function parseEvidence(raw: unknown): Evidence | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.sourceRef !== "string" || r.sourceRef === "") return null;
	if (r.sourceId !== null && typeof r.sourceId !== "string") return null;
	if (typeof r.locator !== "string" || typeof r.quote !== "string" || r.quote === "") return null;
	if (typeof r.snapshot !== "string" || r.snapshot === "") return null;
	if (r.stance !== "supports" && r.stance !== "contradicts") return null;
	if (typeof r.tier !== "string" || !TIERS.has(r.tier)) return null;
	if (typeof r.host !== "string") return null;
	if (r.author !== undefined && typeof r.author !== "string") return null;
	const e: Evidence = {
		sourceRef: r.sourceRef,
		sourceId: r.sourceId as string | null,
		locator: r.locator,
		quote: r.quote,
		snapshot: r.snapshot,
		stance: r.stance,
		tier: r.tier as EvidenceTier,
		host: r.host,
	};
	if (typeof r.author === "string") e.author = r.author;
	return e;
}

export function parseVerificationEvent(raw: unknown): VerificationEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.nodeId !== "string" || r.nodeId === "" || typeof r.at !== "string") return null;
	if (r.type === "check_failed") {
		if (typeof r.reason !== "string") return null;
		return { type: "check_failed", nodeId: r.nodeId, reason: r.reason, at: r.at };
	}
	if (r.type !== "checked") return null;
	if (typeof r.outcome !== "string" || !LEVELS.has(r.outcome)) return null;
	if (typeof r.checker !== "string" || !Array.isArray(r.evidence) || !Array.isArray(r.discarded)) return null;
	const evidence: Evidence[] = [];
	for (const item of r.evidence) {
		const e = parseEvidence(item);
		if (e === null) return null;
		evidence.push(e);
	}
	const discarded: Discarded[] = [];
	for (const item of r.discarded) {
		const d = item as { sourceRef?: unknown; reason?: unknown };
		if (typeof d?.sourceRef !== "string" || typeof d.reason !== "string" || !REASONS.has(d.reason)) return null;
		discarded.push({ sourceRef: d.sourceRef, reason: d.reason as DiscardReason });
	}
	return { type: "checked", nodeId: r.nodeId, outcome: r.outcome as TrustLevel, evidence, discarded, checker: r.checker, at: r.at };
}

export interface TrustState {
	level: TrustLevel;
	at: string;
	evidence: Evidence[];
}

/**
 * Latest `checked` event per node. `check_failed` events are ignored here
 * (REQ-src-12): a failed or aborted run never changes the level. A node
 * absent from the map is `unverified`.
 */
export function deriveTrustMap(events: readonly VerificationEvent[]): Map<string, TrustState> {
	const map = new Map<string, TrustState>();
	for (const e of events) {
		if (e.type === "checked") map.set(e.nodeId, { level: e.outcome, at: e.at, evidence: e.evidence });
	}
	return map;
}

/** One self-explanatory line for the teacher's context (REQ-src-15). */
export function trustTag(level: TrustLevel): string {
	switch (level) {
		case "sourced":
			return "[trust: sourced — a quotation was confirmed in a vetted source]";
		case "contested":
			return "[trust: contested — vetted sources disagree]";
		case "refuted":
			return "[trust: refuted — a vetted source contradicts this]";
		default:
			return "[trust: unverified — not checked against any vetted source]";
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `T tests/ext-trust.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/trust.ts tests/ext-trust.test.ts
git commit -m "feat(ext): add pure outcome function, verification events and trust derivation" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Verifier output parser and cost gate (assumed interface)

**Files:**
- Create: `src/core/ext/verifier-output.ts`, `src/core/ext/cost-gate.ts`
- Modify: `src/core/ext/ports.ts`
- Test: `tests/ext-verifier-output.test.ts`, `tests/ext-cost-gate.test.ts`

- [ ] **Step 1: Check whether the cost gate already exists**

Run: `ls src/core/ext/cost-gate.ts 2>&1`
If it exists (a sibling plan landed it), verify it exports `CostGate`, `createCostGate`, `CostStore`, then skip the cost-gate parts of Steps 4 and 5 and only write the parser. Otherwise continue.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/ext-verifier-output.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVerifierOutput } from "../src/core/ext/verifier-output.ts";

const good = {
	results: [
		{ nodeId: "n1", evidence: [{ sourceRef: "lib_a", locator: "p. 4", quote: "a verbatim passage here", stance: "supports" }] },
		{ nodeId: "n2", evidence: [] },
	],
	proposedSources: [{ kind: "url-prefix", locator: "https://mathworld.wolfram.com/", label: "MathWorld" }],
};

describe("parseVerifierOutput", () => {
	it("parses a fenced json block after prose", () => {
		const out = parseVerifierOutput("I checked.\n```json\n" + JSON.stringify(good) + "\n```\nDone.");
		assert.equal(out?.results.length, 2);
		assert.equal(out?.results[0]?.evidence[0]?.stance, "supports");
		assert.equal(out?.proposedSources[0]?.label, "MathWorld");
	});
	it("parses bare json and uses the LAST fenced block when several exist", () => {
		assert.equal(parseVerifierOutput(JSON.stringify(good))?.results.length, 2);
		const two = "```json\n{\"results\":[]}\n```\ntext\n```json\n" + JSON.stringify(good) + "\n```";
		assert.equal(parseVerifierOutput(two)?.results.length, 2);
	});
	it("drops invalid evidence items but keeps the rest", () => {
		const bad = { results: [{ nodeId: "n1", evidence: [
			{ sourceRef: "lib_a", locator: "p. 1", quote: "good quote text here ok", stance: "supports" },
			{ sourceRef: "lib_a", locator: "p. 1", quote: "x", stance: "maybe" },
			{ sourceRef: "", locator: "p. 1", quote: "y", stance: "supports" },
		] }] };
		assert.equal(parseVerifierOutput(JSON.stringify(bad))?.results[0]?.evidence.length, 1);
	});
	it("ignores unusable proposals", () => {
		const o = { results: [], proposedSources: [{ kind: "ftp", locator: "x", label: "y" }, { kind: "pdf", locator: "/a.pdf", label: "A" }] };
		assert.equal(parseVerifierOutput(JSON.stringify(o))?.proposedSources.length, 1);
	});
	it("returns null for no json, bad json, or a missing results array", () => {
		assert.equal(parseVerifierOutput("no json at all"), null);
		assert.equal(parseVerifierOutput("{ broken"), null);
		assert.equal(parseVerifierOutput('{"foo":1}'), null);
	});
});
```

```ts
// tests/ext-cost-gate.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCostGate, spentOnDay, type CostEvent } from "../src/core/ext/cost-gate.ts";

function mem() {
	const events: CostEvent[] = [];
	return { events, store: { appendEvent: (e: CostEvent) => void events.push(e), readEvents: () => [...events] } };
}

describe("cost gate (REQ-src-16 / REQ-cost-01)", () => {
	it("sums spend per UTC day", () => {
		const events: CostEvent[] = [
			{ type: "spend", usd: 0.5, source: "verification", at: "2026-11-04T01:00:00.000Z" },
			{ type: "spend", usd: 0.25, source: "research", at: "2026-11-04T23:00:00.000Z" },
			{ type: "spend", usd: 9, source: "verification", at: "2026-11-03T23:59:00.000Z" },
		];
		assert.equal(spentOnDay(events, "2026-11-04"), 0.75);
	});
	it("allows below the ceiling, refuses at it, and resets the next day", () => {
		const { store } = mem();
		let now = "2026-11-04T10:00:00.000Z";
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now });
		assert.equal(gate.allowed(), true);
		gate.record(0.6, "verification");
		assert.equal(gate.allowed(), true);
		gate.record(0.4, "research");
		assert.equal(gate.allowed(), false);
		now = "2026-11-05T00:00:01.000Z";
		assert.equal(gate.allowed(), true);
	});
	it("ignores non-finite and negative amounts", () => {
		const { store, events } = mem();
		const gate = createCostGate({ store, ceilingUsd: 1 });
		gate.record(Number.NaN, "verification");
		gate.record(-3, "verification");
		assert.equal(events.length, 0);
	});
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `T tests/ext-verifier-output.test.ts tests/ext-cost-gate.test.ts` → FAIL (modules not found).

- [ ] **Step 4: Implement the parser**

```ts
// src/core/ext/verifier-output.ts
/**
 * The verifier agent's deliverable: one JSON object in its final message.
 * Only the RAW claims are trusted as claims; every field that matters
 * (tier, snapshot, quote existence) is recomputed by code (verify.ts).
 */

import type { SourceKind, SourceProposal } from "./sources.ts";
import type { Stance } from "./trust.ts";

export interface RawEvidence {
	sourceRef: string;
	locator: string;
	quote: string;
	stance: Stance;
}

export interface VerifierOutput {
	results: { nodeId: string; evidence: RawEvidence[] }[];
	proposedSources: SourceProposal[];
}

const KINDS = new Set<string>(["pdf", "url-prefix", "repo"]);

function extractJson(text: string): string | null {
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
	const last = fences[fences.length - 1];
	if (last !== undefined) return last[1]!.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parseVerifierOutput(text: string): VerifierOutput | null {
	const json = extractJson(text);
	if (json === null) return null;
	let root: unknown;
	try {
		root = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof root !== "object" || root === null) return null;
	const r = root as { results?: unknown; proposedSources?: unknown };
	if (!Array.isArray(r.results)) return null;
	const results: VerifierOutput["results"] = [];
	for (const item of r.results) {
		const it = item as { nodeId?: unknown; evidence?: unknown };
		if (typeof it?.nodeId !== "string" || it.nodeId === "" || !Array.isArray(it.evidence)) continue;
		const evidence: RawEvidence[] = [];
		for (const raw of it.evidence) {
			const e = raw as Record<string, unknown>;
			if (typeof e?.sourceRef !== "string" || e.sourceRef === "") continue;
			if (typeof e.quote !== "string" || e.quote === "") continue;
			if (e.stance !== "supports" && e.stance !== "contradicts") continue;
			evidence.push({ sourceRef: e.sourceRef, locator: typeof e.locator === "string" ? e.locator : "", quote: e.quote, stance: e.stance });
		}
		results.push({ nodeId: it.nodeId, evidence });
	}
	const proposedSources: SourceProposal[] = [];
	if (Array.isArray(r.proposedSources)) {
		for (const raw of r.proposedSources) {
			const p = raw as Record<string, unknown>;
			if (typeof p?.kind !== "string" || !KINDS.has(p.kind)) continue;
			if (typeof p.locator !== "string" || p.locator.trim() === "" || typeof p.label !== "string" || p.label.trim() === "") continue;
			proposedSources.push({ kind: p.kind as SourceKind, locator: p.locator, label: p.label });
		}
	}
	return { results, proposedSources };
}
```

- [ ] **Step 5: Implement the cost gate and its ports**

```ts
// src/core/ext/cost-gate.ts
/**
 * ASSUMED INTERFACE shared with the research-loop plan (REQ-cost-01): one
 * daily ceiling for verification and research. Spend is an append-only
 * ledger (cost.jsonl); the day is the UTC date of the event timestamp.
 * When the ceiling is reached the gate refuses; reading and reviewing never
 * consult it.
 */

export interface CostEvent {
	type: "spend";
	usd: number;
	/** "verification" | "research" */
	source: string;
	at: string;
}

export interface CostStore {
	appendEvent(event: CostEvent): void;
	readEvents(): CostEvent[];
}

export interface CostGate {
	allowed(): boolean;
	record(usd: number, source: string): void;
}

export function parseCostEvent(raw: unknown): CostEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "spend" || typeof r.usd !== "number" || !Number.isFinite(r.usd) || r.usd < 0) return null;
	if (typeof r.source !== "string" || r.source === "" || typeof r.at !== "string") return null;
	return { type: "spend", usd: r.usd, source: r.source, at: r.at };
}

export function spentOnDay(events: readonly CostEvent[], day: string): number {
	let total = 0;
	for (const e of events) if (e.at.slice(0, 10) === day) total += e.usd;
	return total;
}

export function createCostGate(deps: { store: CostStore; ceilingUsd: number; now?: () => string }): CostGate {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		allowed: () => spentOnDay(deps.store.readEvents(), now().slice(0, 10)) < deps.ceilingUsd,
		record(usd, source) {
			if (!Number.isFinite(usd) || usd < 0) return;
			deps.store.appendEvent({ type: "spend", usd, source, at: now() });
		},
	};
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `T tests/ext-verifier-output.test.ts tests/ext-cost-gate.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/ext/verifier-output.ts src/core/ext/cost-gate.ts tests/ext-verifier-output.test.ts tests/ext-cost-gate.test.ts
git commit -m "feat(ext): add verifier output parser and daily cost gate" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Stores, paths and composition (REQ-src-01, 04; REQ-src-17 by construction)

**Files:**
- Modify: `src/core/ext/ports.ts`, `src/store/ext/paths.ts`, `tests/ext-paths.test.ts`, `src/server/ext/stores.ts`
- Create: `src/store/ext/sources-store.ts`, `snapshot-store.ts`, `verification-store.ts`, `cost-store.ts`
- Test: `tests/ext-verify-stores.test.ts`

- [ ] **Step 1: Extend the ports** — append to `src/core/ext/ports.ts`:

```ts
import type { VerificationEvent } from "./trust.ts";

/** Immutable text snapshots addressed by sha256 (REQ-src-04). */
export interface SnapshotStore {
	/** Stores the text (idempotent) and returns its sha256 hex. */
	put(text: string): string;
}

export interface VerificationStore {
	/** Throws if the event is invalid. */
	appendEvent(event: VerificationEvent): void;
	readEvents(): VerificationEvent[];
}
```

- [ ] **Step 2: Update the paths test first**

Replace `tests/ext-paths.test.ts` body with:

```ts
// tests/ext-paths.test.ts
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { extPathsFor } from "../src/store/ext/paths.ts";

describe("extension paths", () => {
	it("places everything under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		const dir = path.join("/tmp/lh-data", "ext");
		assert.equal(p.dir, dir);
		assert.equal(p.format, path.join(dir, "format.json"));
		assert.equal(p.goals, path.join(dir, "goals.jsonl"));
		assert.equal(p.sources, path.join(dir, "sources.json"));
		assert.equal(p.snapshots, path.join(dir, "snapshots"));
		assert.equal(p.verification, path.join(dir, "verification.jsonl"));
		assert.equal(p.cost, path.join(dir, "cost.jsonl"));
	});
});
```

Run `T tests/ext-paths.test.ts` → FAIL (`p.sources` undefined).

- [ ] **Step 3: Implement paths** — in `src/store/ext/paths.ts` add the four fields to `ExtPaths` and `extPathsFor`:

```ts
export interface ExtPaths {
	dir: string;
	format: string;
	goals: string;
	sources: string;
	snapshots: string;
	verification: string;
	cost: string;
}

export function extPathsFor(dataRoot: string): ExtPaths {
	const dir = path.join(dataRoot, "ext");
	return {
		dir,
		format: path.join(dir, "format.json"),
		goals: path.join(dir, "goals.jsonl"),
		sources: path.join(dir, "sources.json"),
		snapshots: path.join(dir, "snapshots"),
		verification: path.join(dir, "verification.jsonl"),
		cost: path.join(dir, "cost.jsonl"),
	};
}
```
(Keep the `EXT_PATHS` constant and the file header as they are.) Run `T tests/ext-paths.test.ts` → PASS.

- [ ] **Step 4: Write the failing store tests**

```ts
// tests/ext-verify-stores.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCostStore } from "../src/store/ext/cost-store.ts";
import { createSnapshotStore } from "../src/store/ext/snapshot-store.ts";
import { createSourcesStore } from "../src/store/ext/sources-store.ts";
import { createVerificationStore } from "../src/store/ext/verification-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-ver-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sources store", () => {
	it("round-trips entries, creates the stamp on first write, and reads [] when absent", () => {
		const dir = tmp();
		const store = createSourcesStore(dir);
		assert.deepEqual(store.read(), []);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false, "reads never create the stamp");
		store.write([{ id: "lib_a", kind: "pdf", locator: "/a.pdf", tier: "primary", label: "A", status: "active", addedBy: "user" }]);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), true);
		assert.equal(createSourcesStore(dir).read()[0]?.id, "lib_a");
	});
	it("reads a corrupt file as empty and throws on a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "sources.json"), "{ not json");
		assert.deepEqual(createSourcesStore(dir).read(), []);
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		assert.throws(() => createSourcesStore(dir).read(), /Upgrade/);
	});
});

describe("snapshot store (REQ-src-04)", () => {
	it("stores text at snapshots/<sha256>.txt, idempotently, and returns the hash", () => {
		const dir = tmp();
		const store = createSnapshotStore(dir);
		const hash = store.put("hello snapshot");
		assert.equal(hash, createHash("sha256").update("hello snapshot", "utf8").digest("hex"));
		assert.equal(fs.readFileSync(path.join(dir, "snapshots", `${hash}.txt`), "utf-8"), "hello snapshot");
		assert.equal(store.put("hello snapshot"), hash);
		assert.notEqual(store.put("changed source"), hash, "a changed source is a different hash");
	});
});

describe("verification and cost ledgers", () => {
	it("verification events persist and invalid ones are rejected", () => {
		const dir = tmp();
		const store = createVerificationStore(dir);
		store.appendEvent({ type: "check_failed", nodeId: "n1", reason: "x", at: "t" });
		assert.equal(createVerificationStore(dir).readEvents().length, 1);
		assert.throws(() => store.appendEvent({ type: "check_failed", nodeId: "", reason: "x", at: "t" }), /rejected/);
	});
	it("cost events persist", () => {
		const dir = tmp();
		createCostStore(dir).appendEvent({ type: "spend", usd: 0.1, source: "verification", at: "2026-11-04T00:00:00.000Z" });
		assert.equal(createCostStore(dir).readEvents()[0]?.usd, 0.1);
	});
});
```

- [ ] **Step 5: Run to verify it fails**, then implement the four adapters.

Run: `T tests/ext-verify-stores.test.ts` → FAIL (modules not found).

```ts
// src/store/ext/sources-store.ts
import fs from "node:fs";
import path from "node:path";
import { parseSourceLibrary } from "../../core/ext/sources.ts";
import type { SourcesStore } from "../../core/ext/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

/** sources.json: `{ "entries": [...] }`, read-modify-write (a configuration file, not a ledger). */
export function createSourcesStore(dir: string): SourcesStore {
	const file = path.join(dir, "sources.json");
	return {
		read() {
			assertExtFormat(dir);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return [];
			}
			try {
				return parseSourceLibrary(JSON.parse(raw));
			} catch {
				return [];
			}
		},
		write(entries) {
			assertExtFormat(dir);
			ensureExtFormat(dir);
			writeFileAtomicSync(file, JSON.stringify({ entries }, null, "\t") + "\n", { allowInPlaceFallback: true });
		},
	};
}
```

```ts
// src/store/ext/snapshot-store.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SnapshotStore } from "../../core/ext/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

/** Immutable, content-addressed: snapshots/<sha256>.txt (REQ-src-04). */
export function createSnapshotStore(dir: string): SnapshotStore {
	return {
		put(text) {
			const hash = createHash("sha256").update(text, "utf8").digest("hex");
			const file = path.join(dir, "snapshots", `${hash}.txt`);
			if (fs.existsSync(file)) return hash;
			assertExtFormat(dir);
			ensureExtFormat(dir);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, text, { allowInPlaceFallback: true });
			return hash;
		},
	};
}
```

```ts
// src/store/ext/verification-store.ts
import { parseVerificationEvent } from "../../core/ext/trust.ts";
import type { VerificationStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createVerificationStore(dir: string): VerificationStore {
	const ledger = createLedger(dir, "verification.jsonl", parseVerificationEvent);
	return { appendEvent: (e) => ledger.append(e), readEvents: () => ledger.readAll() };
}
```

```ts
// src/store/ext/cost-store.ts
import { parseCostEvent, type CostStore } from "../../core/ext/cost-gate.ts";
import { createLedger } from "./ledger.ts";

export function createCostStore(dir: string): CostStore {
	const ledger = createLedger(dir, "cost.jsonl", parseCostEvent);
	return { appendEvent: (e) => ledger.append(e), readEvents: () => ledger.readAll() };
}
```

- [ ] **Step 6: Wire the composition root** — replace `src/server/ext/stores.ts`:

```ts
// src/server/ext/stores.ts
/**
 * THE COMPOSITION ROOT for the extension layer's stores — a separate file
 * from upstream's src/server/stores.ts on purpose (no upstream edit). Later
 * plans add their adapters here.
 */

import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createCostStore } from "../../store/ext/cost-store.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";
import { createSnapshotStore } from "../../store/ext/snapshot-store.ts";
import { createSourcesStore } from "../../store/ext/sources-store.ts";
import { createVerificationStore } from "../../store/ext/verification-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
	sourcesStore: createSourcesStore(EXT_PATHS.dir),
	snapshotStore: createSnapshotStore(EXT_PATHS.dir),
	verificationStore: createVerificationStore(EXT_PATHS.dir),
	costStore: createCostStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
```
If a sibling plan already added entries to this file, keep theirs and add these lines.

- [ ] **Step 7: Run and commit**

Run: `T tests/ext-verify-stores.test.ts tests/ext-paths.test.ts` and `npx tsc --noEmit 2>&1 | tail -5` → tests PASS, no type errors.
```bash
git add src/core/ext/ports.ts src/store/ext src/server/ext/stores.ts tests/ext-paths.test.ts tests/ext-verify-stores.test.ts
git commit -m "feat(ext): add sources, snapshot, verification and cost stores" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The verify service (REQ-src-04, 05, 06, 11, 12, 14, 16)

**Files:**
- Modify: `src/core/ext/ports.ts`
- Create: `src/core/ext/verify.ts`, `tests/helpers/ext-fakes.ts`
- Test: `tests/ext-verify.test.ts`

- [ ] **Step 1: Add the agent-side ports** — append to `src/core/ext/ports.ts`:

```ts
import type { VerifierOutput } from "./verifier-output.ts";

/** Re-reads a source's text for the snapshot. The model's view of a source is never trusted. */
export interface SourceTextReader {
	/** `ref` is a URL or the locator of a library PDF. null when unreadable. */
	read(ref: string): Promise<string | null>;
}

export interface VerifierInput {
	nodes: { id: string; statement: string }[];
	/** ACTIVE library entries only. */
	library: SourceEntry[];
}

export interface VerifierRun {
	/** null when the agent's final message held no usable JSON. */
	output: VerifierOutput | null;
	/** Provider-qualified model that produced it, for the event's `checker`. */
	checker: string;
}

export interface Verifier {
	run(
		input: VerifierInput,
		hooks: { signal: AbortSignal; onCostUsd(usd: number): void },
	): Promise<VerifierRun>;
}
```

- [ ] **Step 2: Write the shared fakes**

```ts
// tests/helpers/ext-fakes.ts
import type { CostGate } from "../../src/core/ext/cost-gate.ts";
import type { GoalsStore, SnapshotStore, SourcesStore, VerificationStore } from "../../src/core/ext/ports.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { SourceEntry } from "../../src/core/ext/sources.ts";
import type { VerificationEvent } from "../../src/core/ext/trust.ts";

export function memSourcesStore(initial: SourceEntry[] = []): SourcesStore {
	let entries = initial.map((e) => ({ ...e }));
	return { read: () => entries.map((e) => ({ ...e })), write: (next) => void (entries = next.map((e) => ({ ...e }))) };
}

export function memSnapshotStore(): SnapshotStore & { texts: Map<string, string> } {
	const texts = new Map<string, string>();
	return {
		texts,
		put(text) {
			for (const [h, t] of texts) if (t === text) return h;
			const h = `h${texts.size + 1}`;
			texts.set(h, text);
			return h;
		},
	};
}

export function memVerificationStore(): VerificationStore & { events: VerificationEvent[] } {
	const events: VerificationEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export function memGoalsStore(events: GoalEvent[] = []): GoalsStore {
	return { appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export function fakeGate(initiallyAllowed = true): CostGate & { open: boolean; recorded: { usd: number; source: string }[] } {
	const gate = {
		open: initiallyAllowed,
		recorded: [] as { usd: number; source: string }[],
		allowed: () => gate.open,
		record: (usd: number, source: string) => void gate.recorded.push({ usd, source }),
	};
	return gate;
}

export function node(id: string, statement = `Statement of ${id}.`) {
	return { id, name: id, statement, aliases: [], createdAt: "2026-11-04T00:00:00.000Z", provenance: [] };
}
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/ext-verify.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceTextReader, Verifier, VerifierRun } from "../src/core/ext/ports.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { deriveTrustMap } from "../src/core/ext/trust.ts";
import { verifyNodes, VERIFY_BATCH_SIZE } from "../src/core/ext/verify.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { fakeGate, memSnapshotStore, memSourcesStore, memVerificationStore, node } from "./helpers/ext-fakes.ts";

const TEXT = "The sum of the angles of a triangle in the Euclidean plane is one hundred and eighty degrees.";
const QUOTE = "sum of the angles of a triangle in the Euclidean plane";

const book: SourceEntry = { id: "lib_book", kind: "pdf", locator: "/books/geo.pdf", tier: "primary", label: "Geometry", status: "active", addedBy: "user" };
const wiki: SourceEntry = { id: "lib_wiki", kind: "url-prefix", locator: "https://en.wikipedia.org/", tier: "secondary", label: "Wikipedia", status: "active", addedBy: "user" };

function setup(opts: { sources?: SourceEntry[]; texts?: Record<string, string>; nodeIds?: string[] } = {}) {
	const graphStore = createMemoryGraphStore();
	for (const id of opts.nodeIds ?? ["n1"]) graphStore.appendNode(node(id));
	const sourcesStore = memSourcesStore(opts.sources ?? [book, wiki]);
	const snapshotStore = memSnapshotStore();
	const verificationStore = memVerificationStore();
	const costGate = fakeGate();
	const reads: string[] = [];
	const texts = opts.texts ?? { "/books/geo.pdf": TEXT, "https://en.wikipedia.org/wiki/Triangle": TEXT };
	const reader: SourceTextReader = { read: async (ref) => (reads.push(ref), texts[ref] ?? null) };
	return { graphStore, sourcesStore, snapshotStore, verificationStore, costGate, reader, reads };
}
function verifierReturning(output: VerifierRun["output"], calls: unknown[] = []): Verifier {
	return { run: async (input) => (calls.push(input), { output, checker: "test:model" }) };
}
const supports = (sourceRef: string, quote = QUOTE) => ({ sourceRef, locator: "p. 3", quote, stance: "supports" as const });

describe("verifyNodes", () => {
	it("a quote confirmed in a primary library PDF yields sourced, with snapshot hash and code-assigned tier", async () => {
		const s = setup();
		const report = await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book")] }], proposedSources: [] }), now: () => "t1" });
		assert.deepEqual(report.checked, ["n1"]);
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type, "checked");
		if (event.type !== "checked") return;
		assert.equal(event.outcome, "sourced");
		assert.equal(event.checker, "test:model");
		assert.equal(event.evidence[0]!.tier, "primary");
		assert.equal(event.evidence[0]!.sourceId, "lib_book");
		assert.equal(event.evidence[0]!.snapshot, "h1");
		assert.equal(s.snapshotStore.texts.get("h1"), TEXT);
		assert.deepEqual(s.reads, ["/books/geo.pdf"], "a library PDF is read by its locator");
	});

	it("discards a quote that is not in the re-read source (quote_not_found) and never promotes", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book", "the angles of a triangle sum to three hundred degrees")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "unverified");
		assert.deepEqual(event.type === "checked" ? event.discarded : [], [{ sourceRef: "lib_book", reason: "quote_not_found" }]);
		assert.equal(event.type === "checked" ? event.evidence.length : -1, 0);
	});

	it("an unreadable source discards the evidence with source_unreadable", async () => {
		const s = setup({ texts: {} });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.deepEqual(event.type === "checked" ? event.discarded : [], [{ sourceRef: "lib_book", reason: "source_unreadable" }]);
	});

	it("a source outside the active library is unvetted and cannot make a node sourced", async () => {
		const s = setup({ texts: { "https://blog.example/post": TEXT } });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://blog.example/post")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.evidence[0]!.tier, "unvetted");
		assert.equal(event.type === "checked" && event.outcome, "unverified");
	});

	it("a proposed library entry is ignored until activated", async () => {
		const s = setup({ sources: [{ ...wiki, status: "proposed", addedBy: "agent" }] });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://en.wikipedia.org/wiki/Triangle")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.evidence[0]!.tier, "unvetted");
	});

	it("two independent secondaries make a node sourced; the tier comes from the library, not the model", async () => {
		const s = setup({
			sources: [wiki, { id: "lib_mw", kind: "url-prefix", locator: "https://mathworld.wolfram.com/", tier: "secondary", label: "MathWorld", status: "active", addedBy: "user" }],
			texts: { "https://en.wikipedia.org/wiki/Triangle": TEXT, "https://mathworld.wolfram.com/Triangle.html": TEXT },
		});
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://en.wikipedia.org/wiki/Triangle"), supports("https://mathworld.wolfram.com/Triangle.html")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "sourced");
	});

	it("a verifier that throws appends check_failed for the batch and leaves a prior sourced level intact (REQ-src-12)", async () => {
		const s = setup();
		s.verificationStore.appendEvent({ type: "checked", nodeId: "n1", outcome: "sourced", evidence: [], discarded: [], checker: "m", at: "t0" });
		const report = await verifyNodes(["n1"], { ...s, verifier: { run: async () => { throw new Error("network down"); } } });
		assert.deepEqual(report.failed, ["n1"]);
		const last = s.verificationStore.events.at(-1)!;
		assert.equal(last.type, "check_failed");
		assert.equal(deriveTrustMap(s.verificationStore.events).get("n1")?.level, "sourced");
	});

	it("unparseable verifier output is a failed check, not an unverified result", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning(null) });
		const last = s.verificationStore.events[0]!;
		assert.equal(last.type === "check_failed" && last.reason, "unparseable_output");
	});

	it("a node the verifier returned nothing for is a completed check with no evidence", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "unverified");
	});

	it("batches nodes by VERIFY_BATCH_SIZE", async () => {
		const ids = Array.from({ length: VERIFY_BATCH_SIZE + 2 }, (_, i) => `n${i + 1}`);
		const s = setup({ nodeIds: ids });
		const calls: { nodes: unknown[] }[] = [];
		await verifyNodes(ids, { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(calls.map((c) => c.nodes.length), [VERIFY_BATCH_SIZE, 2]);
	});

	it("reports unknown node ids and does not call the verifier for them", async () => {
		const s = setup();
		const calls: unknown[] = [];
		const report = await verifyNodes(["ghost"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(report.unknown, ["ghost"]);
		assert.equal(calls.length, 0);
	});

	it("passes only ACTIVE library entries to the verifier", async () => {
		const s = setup({ sources: [book, { ...wiki, status: "proposed", addedBy: "agent" }] });
		const calls: { library: SourceEntry[] }[] = [];
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(calls[0]!.library.map((e) => e.id), ["lib_book"]);
	});

	it("records proposed sources as proposed agent entries without activating them", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [{ kind: "url-prefix", locator: "https://mathworld.wolfram.com/", label: "MathWorld" }] }) });
		const added = s.sourcesStore.read().find((e) => e.locator === "https://mathworld.wolfram.com/");
		assert.equal(added?.status, "proposed");
		assert.equal(added?.addedBy, "agent");
	});

	it("does nothing when the daily ceiling is already reached (REQ-src-16)", async () => {
		const s = setup();
		s.costGate.open = false;
		const calls: unknown[] = [];
		const report = await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(report.skippedBudget, ["n1"]);
		assert.equal(calls.length, 0);
		assert.equal(s.verificationStore.events.length, 0);
	});

	it("records spend and aborts the run when the ceiling is crossed mid-run", async () => {
		const s = setup();
		const verifier: Verifier = {
			run: async (_input, hooks) => {
				hooks.onCostUsd(5);
				s.costGate.open = false;
				hooks.onCostUsd(0.1);
				assert.equal(hooks.signal.aborted, true);
				throw new Error("aborted");
			},
		};
		const report = await verifyNodes(["n1"], { ...s, verifier });
		assert.deepEqual(s.costGate.recorded, [{ usd: 5, source: "verification" }, { usd: 0.1, source: "verification" }]);
		assert.deepEqual(report.failed, ["n1"]);
		const last = s.verificationStore.events[0]!;
		assert.equal(last.type === "check_failed" && last.reason, "budget_exhausted");
	});

	it("reads each source once per batch even when cited twice", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book"), supports("/books/geo.pdf", "the Euclidean plane is one hundred and eighty degrees")] }], proposedSources: [] }) });
		assert.deepEqual(s.reads, ["/books/geo.pdf"]);
	});
});
```

(The second quote in the last test, "the Euclidean plane is one hundred and eighty degrees", is not a contiguous substring of `TEXT`; this is fine because that test only asserts the read count.)

- [ ] **Step 4: Run to verify it fails**, then implement

Run: `T tests/ext-verify.test.ts` → FAIL `Cannot find module '../src/core/ext/verify.ts'`.

```ts
// src/core/ext/verify.ts
/**
 * The verification run for a list of nodes (REQ-src-04..06, 11, 12, 14, 16).
 * The verifier agent only CLAIMS evidence; this module is where claims become
 * facts: it re-reads each source itself, snapshots it, checks the quote
 * against the snapshot, assigns the tier from the library, and appends one
 * event per node. A failed or aborted run appends `check_failed` and never
 * touches the derived level.
 */

import type { GraphNode } from "../contracts.ts";
import type { GraphStore } from "../ports.ts";
import type { CostGate } from "./cost-gate.ts";
import type { SnapshotStore, SourcesStore, SourceTextReader, Verifier, VerificationStore } from "./ports.ts";
import { checkQuote } from "./quote.ts";
import { createSourceLibrary, hostOfEntry, matchSource, type SourceEntry } from "./sources.ts";
import { outcomeOf, type Discarded, type Evidence } from "./trust.ts";
import type { RawEvidence } from "./verifier-output.ts";

/** Nodes per verifier run (open item of the spec). */
export const VERIFY_BATCH_SIZE = 5;
/** Raw evidence items considered per node. */
export const MAX_EVIDENCE_PER_NODE = 8;

export interface VerifyDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	sourcesStore: SourcesStore;
	snapshotStore: SnapshotStore;
	verificationStore: VerificationStore;
	verifier: Verifier;
	reader: SourceTextReader;
	costGate: CostGate;
	now?: () => string;
}

export interface VerifyReport {
	checked: string[];
	failed: string[];
	skippedBudget: string[];
	unknown: string[];
}

function hostOfUrl(ref: string): string {
	try {
		return new URL(ref).hostname;
	} catch {
		return "";
	}
}

export async function buildEvidence(
	raw: readonly RawEvidence[],
	ctx: { sources: readonly SourceEntry[]; reader: SourceTextReader; snapshots: SnapshotStore; cache: Map<string, string | null> },
): Promise<{ evidence: Evidence[]; discarded: Discarded[] }> {
	const evidence: Evidence[] = [];
	const discarded: Discarded[] = [];
	for (const r of raw.slice(0, MAX_EVIDENCE_PER_NODE)) {
		const entry = matchSource(r.sourceRef, ctx.sources);
		const readRef = entry?.kind === "pdf" ? entry.locator : r.sourceRef;
		let text: string | null;
		if (ctx.cache.has(readRef)) text = ctx.cache.get(readRef) ?? null;
		else {
			try {
				text = await ctx.reader.read(readRef);
			} catch {
				text = null;
			}
			ctx.cache.set(readRef, text);
		}
		if (text === null) {
			discarded.push({ sourceRef: r.sourceRef, reason: "source_unreadable" });
			continue;
		}
		const check = checkQuote(text, r.quote);
		if (check !== "ok") {
			discarded.push({ sourceRef: r.sourceRef, reason: check });
			continue;
		}
		evidence.push({
			sourceRef: r.sourceRef,
			sourceId: entry?.id ?? null,
			locator: r.locator,
			quote: r.quote,
			snapshot: ctx.snapshots.put(text),
			stance: r.stance,
			tier: entry?.tier ?? "unvetted",
			host: entry !== null ? hostOfEntry(entry) : hostOfUrl(r.sourceRef),
			...(entry?.author !== undefined ? { author: entry.author } : {}),
		});
	}
	return { evidence, discarded };
}

export async function verifyNodes(nodeIds: readonly string[], deps: VerifyDeps): Promise<VerifyReport> {
	const now = deps.now ?? (() => new Date().toISOString());
	const report: VerifyReport = { checked: [], failed: [], skippedBudget: [], unknown: [] };
	const known = new Map<string, GraphNode>(deps.graphStore.readNodes().map((n) => [n.id, n]));
	const ids = [...new Set(nodeIds)];
	report.unknown = ids.filter((id) => !known.has(id));
	const todo = ids.filter((id) => known.has(id));

	for (let i = 0; i < todo.length; i += VERIFY_BATCH_SIZE) {
		const batch = todo.slice(i, i + VERIFY_BATCH_SIZE);
		if (!deps.costGate.allowed()) {
			report.skippedBudget.push(...batch);
			continue;
		}
		const sources = deps.sourcesStore.read();
		const controller = new AbortController();
		let run: Awaited<ReturnType<Verifier["run"]>> | null = null;
		let failure = "";
		try {
			run = await deps.verifier.run(
				{ nodes: batch.map((id) => ({ id, statement: known.get(id)!.statement })), library: sources.filter((e) => e.status === "active") },
				{
					signal: controller.signal,
					onCostUsd: (usd) => {
						deps.costGate.record(usd, "verification");
						if (!deps.costGate.allowed()) controller.abort();
					},
				},
			);
		} catch (err) {
			failure = controller.signal.aborted ? "budget_exhausted" : `error: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (run === null || run.output === null) {
			const reason = failure !== "" ? failure : "unparseable_output";
			for (const id of batch) {
				deps.verificationStore.appendEvent({ type: "check_failed", nodeId: id, reason, at: now() });
				report.failed.push(id);
			}
			continue;
		}
		const cache = new Map<string, string | null>();
		for (const id of batch) {
			const rawEvidence = run.output.results.find((r) => r.nodeId === id)?.evidence ?? [];
			const { evidence, discarded } = await buildEvidence(rawEvidence, { sources, reader: deps.reader, snapshots: deps.snapshotStore, cache });
			deps.verificationStore.appendEvent({ type: "checked", nodeId: id, outcome: outcomeOf(evidence), evidence, discarded, checker: run.checker, at: now() });
			report.checked.push(id);
		}
		if (run.output.proposedSources.length > 0) createSourceLibrary(deps.sourcesStore).propose(run.output.proposedSources);
	}
	return report;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `T tests/ext-verify.test.ts` → PASS, then `npx tsc --noEmit 2>&1 | tail -5` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/ext/ports.ts src/core/ext/verify.ts tests/helpers/ext-fakes.ts tests/ext-verify.test.ts
git commit -m "feat(ext): add verify service that turns verifier claims into code-checked evidence" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Triggers and the verification service (REQ-src-13, REQ-ver-03)

**Files:**
- Create: `src/core/ext/verify-targets.ts`, `src/core/ext/verification-service.ts`
- Test: `tests/ext-verification-service.test.ts`

Rules (documented in CONTRACTS in Task 15):
- After a merge: nodes in the scope of active goals with **no verification event at all** ("unattempted"). A node that was already checked and came back `unverified` is not re-spent on every merge.
- On activation of a library entry: nodes in scope whose level is `unverified` or `contested` (including attempted ones, since the new source may now settle them).
- On demand: any existing node.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-verification-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import type { Verifier } from "../src/core/ext/ports.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { createVerificationService } from "../src/core/ext/verification-service.ts";
import { activationTargets, postMergeTargets } from "../src/core/ext/verify-targets.ts";
import type { VerificationEvent } from "../src/core/ext/trust.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { fakeGate, memGoalsStore, memSnapshotStore, memSourcesStore, memVerificationStore, node } from "./helpers/ext-fakes.ts";

const created = (goalId: string, targets: string[]): GoalEvent => ({ type: "created", goalId, title: "G", origin: "user", originRef: "", targetNodeIds: targets, priority: 3, at: "t" });
const chain = (id: string, premises: string[], conclusion: string) => ({ id, premises, conclusion, provenance: [], createdAt: "t" });
const checked = (nodeId: string, outcome: "unverified" | "sourced" | "contested" | "refuted"): VerificationEvent => ({ type: "checked", nodeId, outcome, evidence: [], discarded: [], checker: "m", at: "t" });
const nodes = ["n1", "n2", "n3", "n4"].map((id) => node(id));

describe("trigger selection", () => {
	const goals = [{ id: "g", title: "G", origin: "user" as const, originRef: "", targetNodeIds: ["n1"], priority: 3, status: "active" as const, createdAt: "t", updatedAt: "t" }];
	const chains = [chain("c1", ["n2"], "n1")];

	it("post-merge: only in-scope nodes that were never attempted (REQ-ver-03)", () => {
		const out = postMergeTargets({ goals, nodes, chains, events: [checked("n2", "unverified")] });
		assert.deepEqual(out, ["n1"], "n2 was attempted, n3/n4 are out of scope");
	});
	it("post-merge: a failed attempt counts as attempted", () => {
		const out = postMergeTargets({ goals, nodes, chains, events: [{ type: "check_failed", nodeId: "n1", reason: "x", at: "t" }] });
		assert.deepEqual(out, ["n2"]);
	});
	it("post-merge: paused goals contribute nothing", () => {
		assert.deepEqual(postMergeTargets({ goals: [{ ...goals[0]!, status: "paused" }], nodes, chains, events: [] }), []);
	});
	it("activation: in-scope unverified and contested nodes, attempted or not, never sourced or refuted", () => {
		const events = [checked("n1", "sourced"), checked("n2", "contested")];
		assert.deepEqual(activationTargets({ goals, nodes, chains, events }), ["n2"]);
		assert.deepEqual(activationTargets({ goals, nodes, chains, events: [checked("n1", "unverified")] }).sort(), ["n1", "n2"]);
	});
	it("ignores scope ids that are no longer nodes", () => {
		assert.deepEqual(postMergeTargets({ goals, nodes: [node("n1")], chains, events: [] }), ["n1"]);
	});
});

function build(goalEvents: GoalEvent[], verifier: Verifier) {
	const graphStore = createMemoryGraphStore();
	for (const n of nodes) graphStore.appendNode(n);
	graphStore.appendChain(chain("c1", ["n2"], "n1"));
	const sourcesStore = memSourcesStore([{ id: "lib_p", kind: "url-prefix", locator: "https://x.org/", tier: "secondary", label: "X", status: "proposed", addedBy: "agent" }]);
	const verificationStore = memVerificationStore();
	const service = createVerificationService({
		graphStore, sourcesStore, snapshotStore: memSnapshotStore(), verificationStore, verifier,
		reader: { read: async () => null }, costGate: fakeGate(), goalsStore: memGoalsStore(goalEvents),
	});
	return { service, verificationStore, sourcesStore };
}

describe("verification service", () => {
	it("afterMerge verifies exactly the unattempted in-scope nodes", async () => {
		const seen: string[][] = [];
		const { service } = build([created("g", ["n1"])], { run: async (input) => (seen.push(input.nodes.map((n) => n.id)), { output: { results: [], proposedSources: [] }, checker: "m" }) });
		const report = await service.afterMerge();
		assert.deepEqual(seen, [["n1", "n2"]]);
		assert.deepEqual(report.checked.sort(), ["n1", "n2"]);
		assert.deepEqual((await service.afterMerge()).checked, [], "attempted nodes are not re-spent");
	});

	it("single-flight: a node already being verified is not started twice", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let runs = 0;
		const { service } = build([created("g", ["n1"])], { run: async () => { runs++; await gate; return { output: { results: [], proposedSources: [] }, checker: "m" }; } });
		const first = service.verify(["n3"]);
		const second = await service.verify(["n3"]);
		assert.deepEqual(second.checked, []);
		release();
		assert.deepEqual((await first).checked, ["n3"]);
		assert.equal(runs, 1);
	});

	it("on-demand verification works for any node, in scope or not", async () => {
		const { service, verificationStore } = build([], { run: async () => ({ output: { results: [], proposedSources: [] }, checker: "m" }) });
		await service.verify(["n4"]);
		assert.equal(verificationStore.events[0]?.nodeId, "n4");
	});

	it("activateSource activates the entry (user decision) and re-verifies in-scope unverified nodes", async () => {
		const seen: string[][] = [];
		const { service, sourcesStore } = build([created("g", ["n1"])], { run: async (input) => (seen.push(input.library.map((e) => e.id)), { output: { results: [], proposedSources: [] }, checker: "m" }) });
		const { entry, verification } = service.activateSource("lib_p", "primary");
		assert.equal(entry.status, "active");
		assert.equal(entry.tier, "primary");
		await verification;
		assert.deepEqual(seen, [["lib_p"]], "the activated entry is now visible to the verifier");
		assert.equal(sourcesStore.read()[0]!.status, "active");
	});

	it("trust() defaults to unverified and reflects the latest checked event", () => {
		const { service, verificationStore } = build([], { run: async () => ({ output: null, checker: "m" }) });
		verificationStore.appendEvent(checked("n1", "refuted"));
		const views = service.trust(["n1", "n2"]);
		assert.deepEqual(views.map((v) => [v.nodeId, v.level]), [["n1", "refuted"], ["n2", "unverified"]]);
		assert.equal(views[1]!.at, null);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `T tests/ext-verification-service.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

```ts
// src/core/ext/verify-targets.ts
/**
 * Which nodes the automatic triggers verify (REQ-src-13, REQ-ver-03). Pure.
 * Automatic runs are limited to the scope of ACTIVE goals; on-demand runs
 * (any node) bypass these selectors.
 */

import type { GraphChain, GraphNode } from "../contracts.ts";
import { activeScope, type Goal } from "./goals.ts";
import { deriveTrustMap, type VerificationEvent } from "./trust.ts";

export interface TargetInputs {
	goals: readonly Goal[];
	nodes: readonly Pick<GraphNode, "id">[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	events: readonly VerificationEvent[];
}

function scopeNodeIds(i: TargetInputs): string[] {
	const exists = new Set(i.nodes.map((n) => n.id));
	return activeScope(i.goals, i.chains).filter((id) => exists.has(id));
}

/** After a merge: in-scope nodes with no verification event at all (so a node that came back unverified is not re-spent on every merge). */
export function postMergeTargets(i: TargetInputs): string[] {
	const attempted = new Set(i.events.map((e) => e.nodeId));
	return scopeNodeIds(i).filter((id) => !attempted.has(id));
}

/** After a library entry is activated: in-scope nodes that are unverified or contested. */
export function activationTargets(i: TargetInputs): string[] {
	const trust = deriveTrustMap(i.events);
	return scopeNodeIds(i).filter((id) => {
		const level = trust.get(id)?.level ?? "unverified";
		return level === "unverified" || level === "contested";
	});
}
```

```ts
// src/core/ext/verification-service.ts
/**
 * The verification service: the one object the server wires. Single-flight
 * per node (the same node is never verified twice at once), trigger
 * selection, library activation, and trust views for the UI and the
 * teacher's context.
 */

import { deriveGoals } from "./goals.ts";
import type { GoalsStore } from "./ports.ts";
import { createSourceLibrary, type SourceEntry, type SourceLibrary, type SourceTier } from "./sources.ts";
import { deriveTrustMap, type Evidence, type TrustLevel } from "./trust.ts";
import { activationTargets, postMergeTargets, type TargetInputs } from "./verify-targets.ts";
import { verifyNodes, type VerifyDeps, type VerifyReport } from "./verify.ts";

export interface TrustView {
	nodeId: string;
	level: TrustLevel;
	/** Timestamp of the latest completed check, null when never checked. */
	at: string | null;
	evidence: Evidence[];
}

export interface VerificationServiceDeps extends VerifyDeps {
	goalsStore: GoalsStore;
}

export interface VerificationService {
	library: SourceLibrary;
	verify(nodeIds: readonly string[]): Promise<VerifyReport>;
	afterMerge(): Promise<VerifyReport>;
	afterActivation(): Promise<VerifyReport>;
	/** The user's decision: activate a library entry, then re-verify in-scope unverified/contested nodes. */
	activateSource(id: string, tier?: SourceTier): { entry: SourceEntry; verification: Promise<VerifyReport> };
	trust(nodeIds: readonly string[]): TrustView[];
}

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
	const inFlight = new Set<string>();
	const library = createSourceLibrary(deps.sourcesStore);

	async function verify(nodeIds: readonly string[]): Promise<VerifyReport> {
		const ids = [...new Set(nodeIds)].filter((id) => !inFlight.has(id));
		for (const id of ids) inFlight.add(id);
		try {
			return await verifyNodes(ids, deps);
		} finally {
			for (const id of ids) inFlight.delete(id);
		}
	}

	function targetInputs(): TargetInputs {
		return {
			goals: deriveGoals(deps.goalsStore.readEvents()),
			nodes: deps.graphStore.readNodes(),
			chains: deps.graphStore.readChains(),
			events: deps.verificationStore.readEvents(),
		};
	}

	return {
		library,
		verify,
		afterMerge: () => verify(postMergeTargets(targetInputs())),
		afterActivation: () => verify(activationTargets(targetInputs())),
		activateSource(id, tier) {
			const entry = library.setStatus(id, "active", tier);
			return { entry, verification: verify(activationTargets(targetInputs())) };
		},
		trust(nodeIds) {
			const map = deriveTrustMap(deps.verificationStore.readEvents());
			return nodeIds.map((nodeId) => {
				const state = map.get(nodeId);
				return { nodeId, level: state?.level ?? "unverified", at: state?.at ?? null, evidence: state?.evidence ?? [] };
			});
		},
	};
}
```

- [ ] **Step 4: Run to verify it passes** — `T tests/ext-verification-service.test.ts` → PASS; `npx tsc --noEmit 2>&1 | tail -5` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/verify-targets.ts src/core/ext/verification-service.ts tests/ext-verification-service.test.ts
git commit -m "feat(ext): add trigger selection and single-flight verification service" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Source reader (agent layer; snapshots come from code's own fetch)

**Files:**
- Create: `src/agent/ext/source-reader.ts`
- Test: `tests/ext-source-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-source-reader.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createSourceReader } from "../src/agent/ext/source-reader.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-reader-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pdfPath = path.join(dir, "book.pdf");
fs.writeFileSync(pdfPath, tinyPdf([{ runs: [{ text: "The orthogonal complement theorem holds in every Hilbert space.", x: 72, y: 700 }] }]));

describe("source reader", () => {
	it("reads a library PDF through upstream's pdf tools and strips page markers", async () => {
		const reader = createSourceReader({ allowedPdfPaths: () => [pdfPath] });
		const text = await reader.read(pdfPath);
		assert.match(text ?? "", /orthogonal complement theorem holds in every Hilbert space/);
		assert.ok(!(text ?? "").includes("--- Page"), "page markers are removed so quotes can span pages");
	});

	it("refuses a local path that is not a library PDF", async () => {
		const reader = createSourceReader({ allowedPdfPaths: () => [] });
		assert.equal(await reader.read(pdfPath), null);
		assert.equal(await reader.read("/etc/passwd"), null);
	});

	it("fetches a plain-text URL with the same web_fetch the verifier used", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("The sum of the angles of a triangle is 180 degrees.", { headers: { "content-type": "text/plain" } })) as typeof fetch;
		try {
			const text = await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/t");
			assert.match(text ?? "", /sum of the angles of a triangle is 180 degrees/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("returns null for a failed fetch", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch;
		try {
			assert.equal(await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/missing"), null);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("downloads and extracts a remote PDF when web_fetch points at one", async () => {
		const realFetch = globalThis.fetch;
		const bytes = tinyPdf([{ runs: [{ text: "A remote paper states the compactness lemma clearly.", x: 72, y: 700 }] }]);
		globalThis.fetch = (async () => new Response(bytes.slice().buffer as ArrayBuffer, { headers: { "content-type": "application/pdf" } })) as typeof fetch;
		try {
			const text = await createSourceReader({ allowedPdfPaths: () => [] }).read("https://example.org/paper.pdf");
			assert.match(text ?? "", /compactness lemma clearly/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("rejects non-http schemes", async () => {
		assert.equal(await createSourceReader({ allowedPdfPaths: () => [] }).read("ftp://example.org/x"), null);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `T tests/ext-source-reader.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/agent/ext/source-reader.ts
/**
 * Re-reads a source for the snapshot. The model's view of a source is never
 * trusted: this reader fetches again with upstream's own tools, so the text a
 * quote is checked against is text CODE obtained. Local files are read only if
 * they are active library PDFs (the caller supplies the allow-list).
 * `web_fetch` truncates pages at 40,000 characters; the verifier saw the same
 * truncation, so a quote beyond it is unverifiable by design.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceTextReader } from "../../core/ext/ports.ts";
import { pdfExtract } from "../subagents/pdf-ops.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { createWebTools } from "../tools/web.ts";

function stripPageMarkers(text: string): string {
	return text.replace(/^--- Page \d+ ---$/gm, "");
}

async function readLocalPdf(file: string): Promise<string | null> {
	try {
		return stripPageMarkers(await pdfExtract(file, "all"));
	} catch {
		return null;
	}
}

async function readRemotePdf(url: string): Promise<string | null> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-verify-pdf-"));
	try {
		const out = await createPdfReadTools(dir).web_fetch_pdf!.execute!("verify-pdf", { url });
		const details = out.details as { path?: unknown } | string | undefined;
		if (typeof details !== "object" || details === null || typeof details.path !== "string") return null;
		return await readLocalPdf(details.path);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function readUrl(url: string): Promise<string | null> {
	const out = await createWebTools(() => null).web_fetch!.execute!("verify-fetch", { url });
	const text = typeof out.details === "string" ? out.details : "";
	if (text === "" || text.startsWith("web_fetch failed")) return null;
	if (text.startsWith("web_fetch: this URL is a PDF")) return readRemotePdf(url);
	return text;
}

export function createSourceReader(deps: { allowedPdfPaths: () => string[] }): SourceTextReader {
	return {
		async read(ref) {
			if (/^https?:\/\//i.test(ref)) return readUrl(ref);
			if (deps.allowedPdfPaths().includes(ref)) return readLocalPdf(ref);
			return null;
		},
	};
}
```

- [ ] **Step 4: Run to verify it passes** — `T tests/ext-source-reader.test.ts` → PASS. If the remote-PDF case fails because the stubbed `fetch` response is consumed twice (web_fetch then web_fetch_pdf), make the stub return a fresh `Response` per call (it does: the arrow function builds a new one each call).

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/source-reader.ts tests/ext-source-reader.test.ts
git commit -m "feat(ext): add source reader that re-fetches sources for snapshots" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The verifier agent (prompt, library PDF tools, runner)

**Files:**
- Create: `src/agent/ext/verifier.ts`
- Test: `tests/ext-verifier-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-verifier-agent.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { buildVerifierPrompt, createLibraryPdfTools, createVerifier, verifierMaxTurns } from "../src/agent/ext/verifier.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-verifier-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pdfPath = path.join(dir, "book.pdf");
fs.writeFileSync(pdfPath, tinyPdf([{ runs: [{ text: "Every bounded monotone sequence of reals converges.", x: 72, y: 700 }] }]));

const book: SourceEntry = { id: "lib_book", kind: "pdf", locator: pdfPath, tier: "primary", label: "Analysis", status: "active", addedBy: "user" };
const input = { nodes: [{ id: "n1", statement: "Every bounded monotone sequence of reals converges." }], library: [book] };

describe("verifier prompt and budget", () => {
	it("lists the nodes and the library ids, and tells the agent not to assign tiers", () => {
		const prompt = buildVerifierPrompt(input);
		assert.match(prompt, /n1/);
		assert.match(prompt, /lib_book/);
		assert.match(prompt, /Analysis/);
	});
	it("scales the turn budget with the batch and caps it", () => {
		assert.equal(verifierMaxTurns(1), 16);
		assert.equal(verifierMaxTurns(5), 40);
		assert.equal(verifierMaxTurns(50), 40);
	});
});

describe("library PDF tools", () => {
	it("search and extract only the active library PDFs by id", async () => {
		const tools = createLibraryPdfTools([book]);
		const hit = await tools.library_pdf_search!.execute!("t1", { source_id: "lib_book", query: "monotone" });
		assert.match(JSON.stringify(hit.details), /monotone/);
		const page = await tools.library_pdf_extract!.execute!("t2", { source_id: "lib_book", pages: "1" });
		assert.match(String(page.details), /converges/);
		const unknown = await tools.library_pdf_search!.execute!("t3", { source_id: "lib_other", query: "x" });
		assert.match(String(unknown.details), /unknown library PDF/);
	});
});

describe("createVerifier", () => {
	it("runs the researcher-role loop with the library tools and parses the final JSON", async () => {
		const faux = createFauxCore({});
		const finalJson = JSON.stringify({
			results: [{ nodeId: "n1", evidence: [{ sourceRef: "lib_book", locator: "p. 1", quote: "Every bounded monotone sequence of reals converges.", stance: "supports" }] }],
			proposedSources: [],
		});
		faux.setResponses([
			(context) => {
				const system = context.messages.find((m) => m.role === "system");
				assert.ok(system && system.role === "system");
				assert.match(String(system.content), /verbatim/i);
				assert.ok(system.toolsAdded?.some((t) => t.name === "library_pdf_search"));
				assert.ok(system.toolsAdded?.some((t) => t.name === "web_fetch"));
				return fauxAssistantMessage([fauxToolCall("library_pdf_search", { source_id: "lib_book", query: "monotone" }, { id: "s1" })], { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "s1");
				assert.ok(result && result.role === "toolResult");
				assert.match(JSON.stringify(result.content), /monotone/);
				return fauxAssistantMessage([fauxText("```json\n" + finalJson + "\n```")]);
			},
		]);
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		const costs: number[] = [];
		const run = await verifier.run(input, { signal: new AbortController().signal, onCostUsd: (usd) => costs.push(usd) });
		assert.equal(run.output?.results[0]?.evidence[0]?.sourceRef, "lib_book");
		assert.match(run.checker, /:/);
		assert.ok(costs.length >= 1, "usage is reported to the cost hook");
	});

	it("returns a null output when the final message has no JSON", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxText("I could not find anything.")])]);
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		const run = await verifier.run(input, { signal: new AbortController().signal, onCostUsd: () => {} });
		assert.equal(run.output, null);
	});

	it("propagates an abort as a rejection", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxText("{}")])]);
		const controller = new AbortController();
		controller.abort();
		const verifier = createVerifier({ engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), search: () => null });
		await assert.rejects(verifier.run(input, { signal: controller.signal, onCostUsd: () => {} }));
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `T tests/ext-verifier-agent.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run to verify it passes** — `T tests/ext-verifier-agent.test.ts` → PASS. If the first faux step's `system.toolsAdded` assertion fails because the faux context names the field differently, mirror what `tests/web-search.test.ts` ("sends the exact approved missing-credentials guidance…") does, since that test already asserts `system.toolsAdded` for the researcher.

- [ ] **Step 5: Lint the layer law and commit**

Run: `npx eslint src/agent/ext src/core/ext src/store/ext 2>&1 | tail -10` → no errors.
```bash
git add src/agent/ext/verifier.ts tests/ext-verifier-agent.test.ts
git commit -m "feat(ext): add verifier sub-agent with library PDF tools" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Server wiring, post-merge hook and barrel (REQ-src-13, 16)

**Files:**
- Create: `src/server/ext/verification.ts`, `src/server/ext/post-merge.ts`, `src/server/ext/index.ts`
- Modify (touchpoints): `src/server/chat-handler.ts`, `src/server/index.ts`
- Test: `tests/ext-post-merge.test.ts`

- [ ] **Step 1: Write the failing test for the wrapper**

```ts
// tests/ext-post-merge.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { withPostMerge } from "../src/server/ext/post-merge.ts";

function fakePipeline(stats: { nodes: number; chains?: number }, fail = false): ExtractionPipeline {
	return {
		runExtraction: async () => { if (fail) throw new Error("extraction failed"); return stats; },
		importNotes: async () => { if (fail) throw new Error("import failed"); return stats; },
	};
}
const tick = () => new Promise((r) => setImmediate(r));

describe("withPostMerge", () => {
	it("fires the hook after a merge that added nodes, for chat runs and notes imports", async () => {
		let calls = 0;
		const p = withPostMerge(fakePipeline({ nodes: 2 }), async () => void calls++, { enabled: true });
		assert.deepEqual(await p.runExtraction("c1"), { nodes: 2 });
		await p.importNotes({ filePath: "/a.md", text: "x" });
		await tick();
		assert.equal(calls, 2);
	});
	it("does not fire when nothing new was merged or the run failed", async () => {
		let calls = 0;
		const none = withPostMerge(fakePipeline({ nodes: 0, chains: 3 }), async () => void calls++, { enabled: true });
		await none.runExtraction("c1");
		const failing = withPostMerge(fakePipeline({ nodes: 1 }, true), async () => void calls++, { enabled: true });
		await assert.rejects(failing.runExtraction("c1"));
		await tick();
		assert.equal(calls, 0);
	});
	it("a failing hook never fails the extraction", async () => {
		const p = withPostMerge(fakePipeline({ nodes: 1 }), async () => { throw new Error("hook boom"); }, { enabled: true, log: () => {} });
		assert.deepEqual(await p.runExtraction("c1"), { nodes: 1 });
		await tick();
	});
	it("is inert when disabled (tests and the master switch)", async () => {
		let calls = 0;
		const p = withPostMerge(fakePipeline({ nodes: 5 }), async () => void calls++, { enabled: false });
		await p.runExtraction("c1");
		await tick();
		assert.equal(calls, 0);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `T tests/ext-post-merge.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the wrapper**

```ts
// src/server/ext/post-merge.ts
/**
 * The post-merge hook (REQ-src-13): wraps the app's ONE extraction pipeline
 * so a successful merge that added nodes triggers automatic verification.
 * The hook is fire-and-forget: it never delays or fails the extraction.
 * Inert under NODE_ENV=test (scripted chats are fixtures, not knowledge).
 */

import type { ExtractionPipeline } from "../../agent/subagents/extraction.ts";

export interface PostMergeOptions {
	enabled?: boolean;
	log?: (message: string, err: unknown) => void;
}

export function withPostMerge(
	pipeline: ExtractionPipeline,
	onMerged: () => Promise<unknown>,
	options: PostMergeOptions = {},
): ExtractionPipeline {
	const enabled = options.enabled ?? process.env.NODE_ENV !== "test";
	const log = options.log ?? ((message, err) => console.error(message, err));
	function after<T extends { nodes: number }>(stats: T): T {
		if (enabled && stats.nodes > 0) {
			void Promise.resolve()
				.then(onMerged)
				.catch((err) => log("[ext] post-merge verification failed:", err));
		}
		return stats;
	}
	return {
		runExtraction: async (chatId) => after(await pipeline.runExtraction(chatId)),
		importNotes: async (input) => after(await pipeline.importNotes(input)),
	};
}
```

- [ ] **Step 4: Run to verify it passes** — `T tests/ext-post-merge.test.ts` → PASS.

- [ ] **Step 5: Implement the server wiring**

```ts
// src/server/ext/verification.ts
/**
 * Composition of the verification stage: real stores, the settings-resolved
 * researcher engine, the live search provider, and the daily cost ceiling.
 * Everything testable lives in src/core/ext and src/agent/ext; this file
 * only wires.
 */

import { createSourceReader } from "../../agent/ext/source-reader.ts";
import { createVerifier } from "../../agent/ext/verifier.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { createCostGate } from "../../core/ext/cost-gate.ts";
import type { SourceEntry, SourceTier } from "../../core/ext/sources.ts";
import { trustTag } from "../../core/ext/trust.ts";
import { createVerificationService, type TrustView } from "../../core/ext/verification-service.ts";
import type { VerifyReport } from "../../core/ext/verify.ts";
import { ROLE_SLOT } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { searchProvider } from "../search.ts";
import { stores } from "../stores.ts";
import { extStores } from "./stores.ts";

/** One daily ceiling for verification and research (REQ-cost-01). Override with LH_EXT_DAILY_CEILING_USD. */
const DEFAULT_DAILY_CEILING_USD = 2;
function ceilingUsd(): number {
	const raw = Number(process.env.LH_EXT_DAILY_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING_USD;
}

/** The researcher slot's engine, fresh per run (a settings change lands immediately). Throws with a readable reason. */
function researcherEngine(): PiEngine {
	const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
	if (!spec) throw new Error("verification needs a model for the researcher role: configure the models in settings");
	if (!providerKeyPresent(spec.provider)) throw new Error(`verification: no API key for provider ${spec.provider}`);
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.researcher]?.cacheRetention);
}

const service = createVerificationService({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	sourcesStore: extStores.sourcesStore,
	snapshotStore: extStores.snapshotStore,
	verificationStore: extStores.verificationStore,
	verifier: createVerifier({ engine: researcherEngine, search: searchProvider }),
	reader: createSourceReader({
		allowedPdfPaths: () => extStores.sourcesStore.read().filter((e) => e.kind === "pdf" && e.status === "active").map((e) => e.locator),
	}),
	costGate: {
		// Fresh per call so a LH_EXT_DAILY_CEILING_USD change lands without a restart.
		allowed: () => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).allowed(),
		record: (usd, source) => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).record(usd, source),
	},
});

/** On-demand verification of any nodes. */
export function verifyNodesNow(nodeIds: string[]): Promise<VerifyReport> {
	return service.verify(nodeIds);
}

/** The post-merge trigger (REQ-src-13). */
export function verifyAfterMerge(): Promise<VerifyReport> {
	return service.afterMerge();
}

export function trustViews(nodeIds: string[]): TrustView[] {
	return service.trust(nodeIds);
}

export function listLibrarySources(): SourceEntry[] {
	return service.library.list();
}

export function addLibrarySource(input: { kind: SourceEntry["kind"]; locator: string; tier: SourceTier; label: string; author?: string }): SourceEntry {
	return service.library.add({ ...input, addedBy: "user" });
}

/**
 * Only the USER activates an entry (REQ-src-02). Activation triggers the
 * background re-verification of in-scope unverified/contested nodes (REQ-src-13).
 */
export function setLibrarySourceStatus(id: string, status: SourceEntry["status"], tier?: SourceTier): SourceEntry {
	if (status === "active") {
		const { entry, verification } = service.activateSource(id, tier);
		void verification.catch((err) => console.error("[ext] activation verification failed:", err));
		return entry;
	}
	return service.library.setStatus(id, status, tier);
}

/** Tags picked propositions with their trust level for the teacher and practice context (REQ-src-15). Never throws. */
export function withTrustTags<T extends { id: string; statement: string }>(picks: readonly T[]): T[] {
	try {
		const level = new Map(service.trust(picks.map((p) => p.id)).map((v) => [v.nodeId, v.level]));
		return picks.map((p) => ({ ...p, statement: `${p.statement} ${trustTag(level.get(p.id) ?? "unverified")}` }));
	} catch (err) {
		console.error("[ext] trust tags unavailable:", err);
		return [...picks];
	}
}
```

```ts
// src/server/ext/index.ts
/** The extension layer's server barrel (re-exported by src/server/index.ts for app/ routes). */
export { withPostMerge } from "./post-merge.ts";
export {
	addLibrarySource,
	listLibrarySources,
	setLibrarySourceStatus,
	trustViews,
	verifyAfterMerge,
	verifyNodesNow,
	withTrustTags,
} from "./verification.ts";
```

- [ ] **Step 6: Apply the two upstream touchpoints**

`src/server/index.ts` — append one line at the end:
```ts
export * from "./ext/index.ts";
```

`src/server/chat-handler.ts` — add one import near the other `./` imports and wrap the exported pipeline. Use Edit with these exact replacements:

Replace
```ts
export const extraction = createExtractionPipeline({
```
with
```ts
export const extraction = withPostMerge(createExtractionPipeline({
```
and replace the closing of that call
```ts
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});


// Wake-pipeline wiring
```
with
```ts
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
}), verifyAfterMerge);


// Wake-pipeline wiring
```
(The `extraction` closing block is the SECOND `providerKeyMissing…});` in the file, the one directly above the "Wake-pipeline wiring" comment; the first belongs to `createJobRunner`.) Add the import after the `import { persistTurn, … } from "./turn-service.ts";` line:
```ts
import { verifyAfterMerge, withPostMerge } from "./ext/index.ts";
```

- [ ] **Step 7: Verify nothing else changed upstream, types, lint, and the existing suite**

Run:
```bash
git diff --stat -- src/server/chat-handler.ts src/server/index.ts
npx tsc --noEmit 2>&1 | tail -5
npx eslint src/server app 2>&1 | tail -10
NODE_ENV=test npx tsx --test tests/chat-flow.test.ts tests/extraction.test.ts tests/ext-*.test.ts 2>&1 | tail -8
```
Expected: the diff shows only 2-3 changed lines in chat-handler and 1 in index; tsc and eslint clean; `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/server/ext src/server/chat-handler.ts src/server/index.ts tests/ext-post-merge.test.ts
git commit -m "feat(ext): wire verification stage and post-merge hook" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Trust level in the teaching and practice context (REQ-src-15)

**Files:**
- Modify (touchpoint): `app/api/chats/route.ts`
- Test: extend `tests/ext-verification-service.test.ts` is not needed; the tag text is covered by `trustTag` (Task 5). Add `tests/ext-trust-tags.test.ts` for `withTrustTags` through a pure helper.

`withTrustTags` lives in the server module and is wired to real stores, so the tag logic is tested through its pure ingredients (`trustTag` in Task 5, `service.trust` in Task 9). This task adds a small test that locks the format the teacher sees.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-trust-tags.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newGraphContextMessage } from "../src/core/native-messages.ts";
import { trustTag } from "../src/core/ext/trust.ts";

describe("trust tags in the graph-context message (REQ-src-15)", () => {
	it("a tagged statement reaches the model-facing content, one tag per proposition", () => {
		const msg = newGraphContextMessage(
			[
				{ id: "n1", name: "Angle sum", statement: `Angles sum to 180. ${trustTag("sourced")}` },
				{ id: "n2", name: "Parallel", statement: `Parallels never meet. ${trustTag("unverified")}` },
			],
			[],
		);
		const content = String(msg.content);
		assert.match(content, /\[n1\] Angle sum: Angles sum to 180\. \[trust: sourced/);
		assert.match(content, /\[n2\] Parallel: Parallels never meet\. \[trust: unverified/);
	});
});
```

- [ ] **Step 2: Run to verify it passes already** (it locks existing behavior plus Task 5's tags) — `T tests/ext-trust-tags.test.ts` → PASS. (If it fails, `newGraphContextMessage`'s `content` shape changed upstream; adjust the regexes to the real lines.)

- [ ] **Step 3: Apply the touchpoint** in `app/api/chats/route.ts`

Add `withTrustTags` to the server import:
```ts
import { compactionInFlight, createChat, isTurnRunning, listChats, readSettingsRecord, stores, titleFromPrompt, withTrustTags } from "@/src/server";
```
and replace
```ts
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
```
with
```ts
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(withTrustTags(picks), chainLines)]);
```
This covers teaching and practice sessions (both start from this route).

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit 2>&1 | tail -5 && npx eslint app/api/chats 2>&1 | tail -5` → clean.
```bash
git add app/api/chats/route.ts tests/ext-trust-tags.test.ts
git commit -m "feat(ext): tag graph-context propositions with their trust level" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: API routes (functional only: library management, trust query, on-demand verification)

**Files:**
- Create: `app/api/ext/verification/route.ts`, `app/api/ext/sources/route.ts`, `app/api/ext/sources/[id]/route.ts`

Routes are thin; all logic is covered in core tests. Library management is API-only in this plan (UI is deferred; use `curl`).

- [ ] **Step 1: Write the routes**

```ts
// app/api/ext/verification/route.ts
import { trustViews, verifyNodesNow } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/ext/verification?nodeId=a&nodeId=b → { trust: TrustView[] } */
export async function GET(req: Request) {
	const ids = new URL(req.url).searchParams.getAll("nodeId").slice(0, 200);
	try {
		return Response.json({ trust: trustViews(ids) });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not read verification." }, { status: 500 });
	}
}

/** POST /api/ext/verification { nodeIds: string[] } → the run report (on-demand, any node). Runs to completion. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { nodeIds?: unknown };
	const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.filter((id): id is string => typeof id === "string" && id !== "").slice(0, 20) : [];
	if (nodeIds.length === 0) return Response.json({ error: "nodeIds must be a non-empty array of node ids (max 20)." }, { status: 400 });
	try {
		return Response.json(await verifyNodesNow(nodeIds));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Verification failed." }, { status: 500 });
	}
}
```

```ts
// app/api/ext/sources/route.ts
import { addLibrarySource, listLibrarySources } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json({ sources: listLibrarySources() });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not read the source library." }, { status: 500 });
	}
}

/** POST { kind, locator, tier, label, author? } → the new ACTIVE entry (a user-added source). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const entry = addLibrarySource({
			kind: body.kind as "pdf" | "url-prefix" | "repo",
			locator: String(body.locator ?? ""),
			tier: body.tier as "primary" | "secondary",
			label: String(body.label ?? ""),
			...(typeof body.author === "string" ? { author: body.author } : {}),
		});
		return Response.json({ source: entry }, { status: 201 });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not add the source." }, { status: 400 });
	}
}
```

```ts
// app/api/ext/sources/[id]/route.ts
import { setLibrarySourceStatus } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * PATCH { status: "active" | "proposed", tier?: "primary" | "secondary" }.
 * Activating is the user's decision (agent proposals never self-activate) and
 * starts a background re-verification of in-scope unverified/contested nodes.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { status?: unknown; tier?: unknown };
	if (body.status !== "active" && body.status !== "proposed") return Response.json({ error: 'status must be "active" or "proposed".' }, { status: 400 });
	if (body.tier !== undefined && body.tier !== "primary" && body.tier !== "secondary") return Response.json({ error: 'tier must be "primary" or "secondary".' }, { status: 400 });
	try {
		return Response.json({ source: setLibrarySourceStatus(id, body.status, body.tier) });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not update the source." }, { status: 404 });
	}
}
```

- [ ] **Step 2: Type, lint, and smoke the routes against a throwaway data dir**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -5 && npx eslint app/api/ext 2>&1 | tail -5
export LH_DATA_DIR="$(mktemp -d)"
(npm run dev -- -p 3939 >/tmp/lh-ext-dev.log 2>&1 &) ; sleep 12
curl -s -X POST localhost:3939/api/ext/sources -H 'content-type: application/json' -d '{"kind":"url-prefix","locator":"https://en.wikipedia.org/","tier":"secondary","label":"Wikipedia"}'
curl -s localhost:3939/api/ext/sources
curl -s -X POST localhost:3939/api/ext/sources -H 'content-type: application/json' -d '{"kind":"url-prefix","locator":"https://en.wikipedia.org/","tier":"secondary","label":"again"}'
curl -s "localhost:3939/api/ext/verification?nodeId=ghost"
curl -s -X POST localhost:3939/api/ext/verification -H 'content-type: application/json' -d '{"nodeIds":["ghost"]}'
```
Expected, in order: `{"source":{"id":"lib_…","kind":"url-prefix",…,"status":"active","addedBy":"user"}}`; `{"sources":[…1 entry…]}`; `{"error":"source library: https://en.wikipedia.org/ is already in the library"}`; `{"trust":[{"nodeId":"ghost","level":"unverified","at":null,"evidence":[]}]}`; `{"checked":[],"failed":[],"skippedBudget":[],"unknown":["ghost"]}`. Then `ls "$LH_DATA_DIR/ext"` shows `format.json` and `sources.json`. Stop the dev server (`pkill -f "next dev -p 3939"`) and `unset LH_DATA_DIR`.

- [ ] **Step 3: Commit**

```bash
git add app/api/ext
git commit -m "feat(ext): add library, trust and on-demand verification routes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Functional trust badge in the node detail card (REQ-src-15)

**Files:**
- Create: `components/ext/trust-badge.tsx`
- Modify (touchpoint): `components/graph-view.tsx`
- Test: `tests/ext-trust-badge.test.tsx`

Functional only: a level label, a verify button, and an evidence list. Styling is deferred to the UI session.

- [ ] **Step 1: Write the failing test** (pure view, server-rendered)

```tsx
// tests/ext-trust-badge.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustBadgeView } from "../components/ext/trust-badge.tsx";

const evidence = [
	{ sourceRef: "lib_book", locator: "p. 3", quote: "Every bounded monotone sequence converges.", stance: "supports" as const, tier: "primary" as const },
];

describe("TrustBadgeView", () => {
	it("shows the level, evidence quote, tier and locator", () => {
		const html = renderToStaticMarkup(<TrustBadgeView level="sourced" evidence={evidence} busy={false} error={null} onVerify={() => {}} />);
		assert.match(html, /sourced/);
		assert.match(html, /Every bounded monotone sequence converges\./);
		assert.match(html, /primary/);
		assert.match(html, /p\. 3/);
	});
	it("offers verification and disables it while busy", () => {
		const idle = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={false} error={null} onVerify={() => {}} />);
		assert.match(idle, /Verify/);
		assert.ok(!/disabled/.test(idle));
		const busy = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={true} error={null} onVerify={() => {}} />);
		assert.match(busy, /disabled/);
	});
	it("shows an error message", () => {
		const html = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={false} error="no model configured" onVerify={() => {}} />);
		assert.match(html, /no model configured/);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `T tests/ext-trust-badge.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement**

```tsx
// components/ext/trust-badge.tsx
"use client";

import { useCallback, useEffect, useState } from "react";

/** Local mirror of the API shape (components import only the core barrel, so no ext import). */
type Level = "unverified" | "sourced" | "contested" | "refuted";
interface EvidenceView {
	sourceRef: string;
	locator: string;
	quote: string;
	stance: "supports" | "contradicts";
	tier: "primary" | "secondary" | "unvetted";
}

export function TrustBadgeView(props: {
	level: Level;
	evidence: EvidenceView[];
	busy: boolean;
	error: string | null;
	onVerify: () => void;
}) {
	return (
		<div className="mt-2 text-xs">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Trust:</span>
				<span className="font-medium">{props.level}</span>
				<button type="button" className="ml-auto underline" disabled={props.busy} onClick={props.onVerify}>
					{props.busy ? "Verifying…" : "Verify"}
				</button>
			</div>
			{props.error !== null ? <div className="mt-1 text-destructive">{props.error}</div> : null}
			{props.evidence.length > 0 ? (
				<ul className="mt-1 flex flex-col gap-1">
					{props.evidence.map((e, i) => (
						<li key={i} className="text-muted-foreground">
							<span>{e.stance} · {e.tier} · {e.sourceRef} {e.locator}</span>
							<div>“{e.quote}”</div>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function TrustBadge({ nodeId }: { nodeId: string }) {
	const [level, setLevel] = useState<Level>("unverified");
	const [evidence, setEvidence] = useState<EvidenceView[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/ext/verification?nodeId=${encodeURIComponent(nodeId)}`);
			const body = (await res.json()) as { trust?: { level: Level; evidence: EvidenceView[] }[] };
			const view = body.trust?.[0];
			setLevel(view?.level ?? "unverified");
			setEvidence(view?.evidence ?? []);
		} catch {
			setError("Could not load verification.");
		}
	}, [nodeId]);

	useEffect(() => {
		setError(null);
		void load();
	}, [load]);

	const verify = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/ext/verification", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nodeIds: [nodeId] }),
			});
			const body = (await res.json()) as { error?: string; failed?: string[]; skippedBudget?: string[] };
			if (!res.ok) setError(body.error ?? "Verification failed.");
			else if ((body.failed?.length ?? 0) > 0) setError("The check failed; the trust level is unchanged.");
			else if ((body.skippedBudget?.length ?? 0) > 0) setError("The daily cost ceiling is reached.");
			await load();
		} catch {
			setError("Verification failed.");
		} finally {
			setBusy(false);
		}
	}, [nodeId, load]);

	return <TrustBadgeView level={level} evidence={evidence} busy={busy} error={error} onVerify={() => void verify()} />;
}
```

- [ ] **Step 4: Run to verify it passes** — `T tests/ext-trust-badge.test.tsx` → PASS.

- [ ] **Step 5: Apply the touchpoint** in `components/graph-view.tsx`

Add the import after the `ChainTableOverlay` import:
```tsx
import { TrustBadge } from "@/components/ext/trust-badge.tsx";
```
and after the statement line
```tsx
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
```
add
```tsx
					<TrustBadge nodeId={selected.node.id} />
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit 2>&1 | tail -5 && npx eslint components 2>&1 | tail -5` → clean.
```bash
git add components/ext components/graph-view.tsx tests/ext-trust-badge.test.tsx
git commit -m "feat(ext): show trust level and evidence in the node detail card" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Contracts, touchpoints, upstream-untouched check, full suite

**Files:**
- Modify: `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md`

- [ ] **Step 1: Append the language-neutral contracts (REQ-port-01)** to `docs/ext/CONTRACTS.md`

````markdown
## `sources.json` (source library, configuration file)

`{"entries": [SourceEntry, ...]}`, rewritten atomically on every change (read-modify-write, not a ledger).
Invalid entries and repeated ids are dropped on read. A corrupt file reads as empty.

`SourceEntry`: `{id, kind, locator, tier, label, author?, status, addedBy}`
- `id`: non-empty, `lib_` plus 8 hex characters for generated ids.
- `kind`: `pdf` (locator = absolute path) | `url-prefix` (locator = URL prefix with scheme, or a bare domain) | `repo` (locator = `owner/name`).
- `tier`: `primary` | `secondary`. `status`: `active` | `proposed`. `addedBy`: `user` | `agent`. `author`: optional trimmed label.

Matching `matchSource(ref, entries)`: only `active` entries participate. `ref` equal to an entry id returns that entry.
A `ref` that is not an http(s) URL matches a `pdf` entry whose locator equals it. A URL matches by score = length of the
matched prefix, highest wins, none = unvetted: `url-prefix` with scheme matches `url.href.startsWith(locator.href)`;
a bare domain matches the hostname or any subdomain (score = domain length); `repo` matches `https://github.com/<repo>` and
`https://raw.githubusercontent.com/<repo>` followed by end or `/`. `hostOfEntry`: hostname of the locator, `github.com` for repo,
`""` for pdf. User-added entries are `active`; agent-added entries are `proposed` with tier `secondary` and never become active
except by a user status change.

## `snapshots/<sha256>.txt`

The exact UTF-8 text a quote was checked against, named by the lowercase hex sha256 of that text. Immutable, written once.

## Quote check

`normalize(text, mode)`: NFKC; remove U+00AD; fold `‘’‚‛′` to `'`, `“”„‟″` to `"`, `‐‑‒–—―−` to `-`; replace
`<letter>-<spaces/tabs>\r?\n<spaces/tabs><letter>` by the two letters (mode `join`) or the letters joined by `-` (mode `keep`);
lowercase; collapse whitespace runs to one space; trim. `checkQuote(snapshot, quote)`: if `normalize(quote, join)` has fewer
than 20 characters → `quote_too_short`; else `ok` if it occurs in `normalize(snapshot, join)` or `normalize(quote, keep)`
occurs in `normalize(snapshot, keep)`; else `quote_not_found`. No fuzzy matching. Snapshots of PDFs have their
`--- Page N ---` lines removed before storage.

## `verification.jsonl`

Event `checked`: `{type:"checked", nodeId, outcome, evidence, discarded, checker, at}`
- `outcome`: `unverified` | `sourced` | `contested` | `refuted`, computed by `outcomeOf(evidence)` at write time.
- `evidence[]`: `{sourceRef, sourceId|null, locator, quote, snapshot, stance, tier, host, author?}`; `stance` `supports` | `contradicts`;
  `tier` `primary` | `secondary` | `unvetted` (tier at the time of the check; `unvetted` when no active entry matched); `snapshot` = sha256 of the snapshot.
- `discarded[]`: `{sourceRef, reason}`, reason `quote_not_found` | `quote_too_short` | `source_unreadable`.
- `checker`: `<provider>:<model id>`. `at`: ISO-8601.

Event `check_failed`: `{type:"check_failed", nodeId, reason, at}`; reasons include `budget_exhausted`, `unparseable_output`, `error: <message>`.

`outcomeOf(evidence)`: qualified = tier ≠ `unvetted`. Let S = qualified supporting, C = qualified contradicting.
Two evidence items are independent iff their `sourceId`s are non-null and different, and (their `host`s differ, or both have an `author` and the
authors differ case-insensitively after trimming). Result, first match wins: `sourced` if (S has a primary, or two independent secondaries in S) and C has no primary;
`contested` if S and C are both non-empty; `refuted` if C is non-empty; else `unverified`. The result does not depend on evidence order.

Derivation `deriveTrustMap`: replay in order; each `checked` event sets the node's level and evidence; `check_failed` is ignored. A node with no `checked`
event is `unverified`. Events for nodes that no longer exist are ignored by readers.

## Verification triggers

- After a merge that added nodes: nodes in `activeScope(goals, chains)` that exist and have **no** verification event of either type.
- On activation of a library entry: nodes in the active scope whose derived level is `unverified` or `contested`.
- On demand: any existing node ids.
- Batches of 5 nodes per verifier run; at most 8 evidence items considered per node; a run stops (all remaining nodes of the batch get `check_failed: budget_exhausted`) when the daily ceiling is crossed.

## `cost.jsonl`

Event `spend`: `{type:"spend", usd, source, at}`; `usd` finite and ≥ 0; `source` `verification` | `research`. Spend for a day = sum of `usd` of events whose
`at` begins with that UTC date `YYYY-MM-DD`. The gate allows work while spend for today < ceiling (default 2 USD; env `LH_EXT_DAILY_CEILING_USD`).

## Trust tag in session context

Picked propositions are given to the model as `<statement> <tag>` where the tag is one of
`[trust: sourced — a quotation was confirmed in a vetted source]`, `[trust: contested — vetted sources disagree]`,
`[trust: refuted — a vetted source contradicts this]`, `[trust: unverified — not checked against any vetted source]`.
````

- [ ] **Step 2: Update `docs/ext/TOUCHPOINTS.md`** — add four rows to the table and remove the matching items from the "Planned" paragraph:

```markdown
| `src/server/chat-handler.ts` | wrap the exported `extraction` pipeline with `withPostMerge(…, verifyAfterMerge)` (post-merge verification, REQ-src-13) | Source verification |
| `src/server/index.ts` | barrel line `export * from "./ext/index.ts";` so `app/` routes can reach ext server functions | Source verification |
| `app/api/chats/route.ts` | tag picked propositions with their trust level in the graph-context message (REQ-src-15) | Source verification |
| `components/graph-view.tsx` | mount `<TrustBadge />` under the node statement in the detail card (REQ-src-15) | Source verification |
```
In the "Planned (not yet touched)" paragraph, drop `src/server/chat-handler.ts (post-extraction verification hook)` and `src/server/index.ts`.

- [ ] **Step 3: Prove the closed list holds (REQ-int-04, REQ-src-17)**

Run:
```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!tests/fixtures/ext/**' ':!docs/ext/**' ':!app/api/ext/**' ':!components/ext/**' ':!scripts/ext-*'
git diff upstream/main --stat -- src/agent/subagents/extraction.ts src/core/contracts src/core/graph.ts src/store/graph.ts
```
Expected: the first lists only `package.json`, `src/server/chat-handler.ts`, `src/server/index.ts`, `app/api/chats/route.ts`, `components/graph-view.tsx` (plus anything the Foundation plan already listed); the second prints nothing (extractor schema and every upstream ledger writer untouched).

- [ ] **Step 4: Full verification**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npx tsc --noEmit 2>&1 | tail -5
npx eslint . 2>&1 | tail -10
npm test 2>&1 | tail -12
```
Expected: no type errors, no lint errors, and `# fail` equal to the upstream baseline only (the two known `claude` CLI tests fail upstream; anything else is a regression to fix before continuing).

- [ ] **Step 5: Optional end-to-end check with a real model (needs configured researcher model and key)**

With the dev server running on a throwaway `LH_DATA_DIR`: add the real PDF via `POST /api/ext/sources` (`kind: pdf`, absolute path, `tier: primary`), create a goal and node (Foundation `createGoal`), then `POST /api/ext/verification {"nodeIds":["<id>"]}`. Expected: a `checked` line in `$LH_DATA_DIR/ext/verification.jsonl` with `snapshot` hashes that exist under `ext/snapshots/`, and `cost.jsonl` gaining `spend` lines. Record the observed outcome in the PR notes.

- [ ] **Step 6: Commit**

```bash
git add docs/ext/CONTRACTS.md docs/ext/TOUCHPOINTS.md
git commit -m "docs(ext): add verification contracts and touchpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**1. Spec coverage by requirement**

| REQ | Where |
|---|---|
| REQ-src-01 library file and fields, unvetted otherwise | Task 4 (`sources.ts`, `matchSource`), Task 7 (`sources-store`, `sources.json`) |
| REQ-src-02 proposed entries ignored until user activates | Task 4 (`matchSource`, `propose`, `setStatus`), Task 8 tests, Task 9 `activateSource`, Task 14 PATCH |
| REQ-src-03 longest URL prefix; PDF by path | Task 4 tests |
| REQ-src-04 snapshots at `snapshots/<sha256>.txt`, hash in event | Task 7 (`snapshot-store`), Task 8 (`buildEvidence`) |
| REQ-src-05 quote kept only if present after normalization, else `quote_not_found` | Task 2, Task 3 (measured on a real PDF), Task 8 |
| REQ-src-06 tier by code | Task 8 (`buildEvidence` uses `matchSource`; `RawEvidence` has no tier field) |
| REQ-src-07 pure deterministic outcome | Task 5 (order-independence test) |
| REQ-src-08 sourced rule | Task 5 |
| REQ-src-09 contested / refuted | Task 5 |
| REQ-src-10 independence | Task 5 (`independent`), Task 4 (`hostOfEntry`, author from the library entry field) |
| REQ-src-11 unvetted never qualifies | Task 5, Task 8 |
| REQ-src-12 failed run appends `check_failed`, level unchanged | Task 5 (`deriveTrustMap`), Task 8 |
| REQ-src-13 triggers (post-merge, on demand, on activation) | Task 9 (selectors, service), Task 12 (`withPostMerge`, activation in `setLibrarySourceStatus`), Task 14 (on-demand route) |
| REQ-src-14 event records source id, locator, quote, snapshot hash, stance, tier | Task 5 (`Evidence`), Task 8 |
| REQ-src-15 trust in teaching/practice context and node detail | Task 13 (context tags), Task 15 (badge) |
| REQ-src-16 daily cost ceiling | Task 6 (gate, assumed interface), Task 8 (check and abort), Task 12 (wiring) |
| REQ-src-17 extractor schema and upstream ledgers untouched | Task 16 Step 3 (diff proof); the stage only reads nodes and chains |
| REQ-ver-01 latest-event derivation, default unverified | Task 5 |
| REQ-ver-02 `sourced` needs code-verified quote | Tasks 2, 8 |
| REQ-ver-03 automatic only for active-goal scope | Task 9 |
| REQ-cost-01 | Tasks 6, 8, 12 |
| REQ-port-01 contracts | Task 16 Step 1 |
| REQ-int-01 (ext stamp) / REQ-int-04 (touchpoints) | Tasks 7, 16 (ledger/stamp reuse; closed-list proof) |

No requirement is without a task. The spec's "open items for the plan" are resolved in the plan: normalization rules (Task 2) and corpus (Task 3); batch size 5 and 6 turns per node (Tasks 8, 11); `author` comes from the optional library entry field (Task 4); hook wired by wrapping `extraction` in `chat-handler.ts` (Task 12).

**2. Placeholder scan.** No TBD/TODO/"similar to". 

**3. Type consistency checked.** `SourceEntry`, `SourceTier`, `SourceProposal`, `SourceLibrary` (Task 4) are used unchanged in Tasks 8 to 12. `Evidence`, `TrustLevel`, `VerificationEvent`, `deriveTrustMap`, `trustTag` (Task 5) match their uses in Tasks 8, 9, 12, 13. `RawEvidence` / `VerifierOutput` (Task 6) match `Verifier`/`VerifierRun` (Task 8) and the agent (Task 11). `CostGate`/`CostStore`/`CostEvent` (Task 6) match the store (Task 7), fakes (Task 8) and wiring (Task 12). `VerifyDeps` (Task 8) is extended by `VerificationServiceDeps` (Task 9). `TrustView` (Task 9) matches the badge's local `EvidenceView` fields it reads (`level`, `evidence[].sourceRef|locator|quote|stance|tier`). `verifyAfterMerge`, `withPostMerge`, `withTrustTags`, `trustViews`, `verifyNodesNow`, `addLibrarySource`, `listLibrarySources`, `setLibrarySourceStatus` are defined in Task 12 and used with the same names in Tasks 12 to 14.

**Known weak points to watch during execution:** the faux `system.toolsAdded` assertion in Task 11 (mirror `tests/web-search.test.ts` if it differs); the second `providerKeyMissing…});` anchor in `chat-handler.ts` (Task 12 Step 6, edit the one directly above the "Wake-pipeline wiring" comment); the Task 3 gate may stop the plan if exact matching loses more than 10 percent on the real PDF.
