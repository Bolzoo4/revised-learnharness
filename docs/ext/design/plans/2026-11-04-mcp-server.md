# Read-only MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone, read-only MCP server over stdio that lets the daily-schedule agent read this system's knowledge (nodes, trust, neighbours, lectures) and study state (goals, daily plan, research status, debriefs, documents) without ever changing the data directory.

**Architecture:** Pure tool logic in `src/core/ext/mcp/` (no zod, no SDK, no filesystem) over a small dependency record (`McpDeps`); a read-only data layer `src/store/ext/readonly.ts` (its own `statSync`/`readFileSync` readers, because the app's stores create stamps and import-time purges); a composition root, the zod catalog and the SDK server object in `src/server/ext/mcp/`; and the entry `scripts/ext-mcp.ts`. The study numbers come from the app's own pure functions (`computePlan`, `snapshot`, `goalReadiness`...), so REQ-mcp-07 holds by construction. Read-only is enforced in layers and each layer has its own test: no write API in the import closure, write methods that throw, a recursive digest of the data directory around every tool call, and an `fs` write tripwire.

**Tech Stack:** TypeScript on Node (tsx, `node:test`), `@modelcontextprotocol/sdk` **1.32.1** (already an exact-pinned upstream dependency), zod 4 (already present), the fork's pure core functions.

**Specs:** `docs/superpowers/specs/2026-11-04-external-access-mcp-design.md` (REQ-mcp-01..14) and the umbrella `2026-11-04-learning-platform-integration-design.md`.

**Working directory:** every path and command below is relative to `learnharness/` (the fork checkout, its own git repository), on the branch the sibling plans use. Use Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`); the server also runs on Node 22.23 (verified).

---

## Verified facts this plan builds on

Verified on 2026-11-05 against the installed package, its type declarations, the SDK README, `npm view`, and a throw-away spike (Task 1 repeats the cheap checks):

- **Pinned SDK version: `@modelcontextprotocol/sdk` 1.32.1.** Already in `package.json` as an exact pin (`"1.32.1"`), installed in `node_modules`, and used by `src/agent/claude-code/tool-bridge.ts`. npm `latest` is 1.32.2 (informational; this plan does not bump it, which would be a `package.json` touchpoint, see decision D2). The v2 line (`@modelcontextprotocol/server`) is on the GitHub main branch only; v1.x stays supported, so v1 is the right line.
- `McpServer.registerTool(name, {title, description, inputSchema, annotations}, handler)` accepts a zod v4 object (strict objects included), annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and a result with `content`, `structuredContent` and `isError`. The deprecated `tool()` form is not used.
- A handler that throws gets its raw message copied into the `isError` text by the SDK. This is why every handler goes through one safe wrapper that returns a fixed text (Task 8, test "an unexpected internal error...").
- Unknown tool names and unknown or mistyped arguments give `isError` results, not protocol errors; their text is SDK-generated and never contains data.
- `new McpServer(info, {instructions, maxToolInputElements})` and `new StdioServerTransport(stdin, stdout, {maxBufferSize})` exist; the stream arguments are injectable, which the stdout guard relies on. When a request exceeds `maxBufferSize` the transport closes itself and the process ends (checked by a test, decision D3).
- `InMemoryTransport.createLinkedPair()` and `Client` from the same package give in-process protocol tests.
- Importing `src/store/graph.ts` **deletes** legacy ledgers (`edges.jsonl`, `events.jsonl`) at import time, and `src/store/ext/*` stores stamp `format.json` lazily on first write. A read-only process must import neither; the closure test (Task 7) enforces it.
- Node's `--permission` flag cannot be used with tsx (it needs worker threads and cache writes). Not used; decision D4.

## Design decisions (made here, with reasons)

1. **Own read layer, not the app's stores.** `readOnlyLedger`, `createGraphReader`, `createLectureReader` mirror the app's parsing (same `parse*Event` functions, same shape guards) but use only `statSync`/`readFileSync`/`readdirSync`, skip corrupt lines, enforce a size ceiling, and refuse a newer stamp without ever writing one.
2. **App types, throwing writes.** The pure functions want the app's `ReviewDeps`. The composition root gives them stores whose `appendEvent` throws, so a code path that tries to write fails loudly instead of silently.
3. **One gatekeeper in the core.** `runTool` checks, in this order: tool name (own properties only), format stamps, `--knowledge-only`, argument object shape, unknown arguments. The zod layer duplicates the shape checks at the protocol edge; neither layer is trusted alone.
4. **Fixed-text errors.** `ToolError` carries a code and a fixed message; every other error becomes `internal` with a generic text, and the real error goes to stderr.
5. **Bounds by construction.** Every list is a `Page`; text is capped with a visible marker; ids, queries and counts are validated; a response above 128 KiB is refused, never cut; a list that could exceed the response budget is fitted to a byte budget.
6. **Dates.** `get_daily_plan` takes a local calendar date. Today and up to 30 days ahead are planned (a future day as of its last millisecond, nothing spent); the past cannot be reconstructed from the ledgers and is refused. Real calendar dates only (`2026-02-30` is refused).
7. **No new upstream touchpoint.** The entry is `scripts/ext-mcp.ts` (inside the `scripts/ext-*` exclusion of the touchpoint check), the dependency is already pinned, and there is no `npm run mcp` script (that would edit `package.json`); the launch command is `npx tsx scripts/ext-mcp.ts`. The one shared helper (`startOfLocalDay`) moves to a new core file and `personal-layer.ts` (under `src/**/ext/**`, not a touchpoint) re-exports it.

## File structure

```
src/core/ext/local-day.ts              startOfLocalDay (moved), localIsoDate
src/core/ext/mcp/errors.ts             ToolError, failureOf, fixed messages
src/core/ext/mcp/limits.ts             LIMITS, Page, page, capText, clampLimit, fitToBudget, round*
src/core/ext/mcp/input.ts              argument validation (ids, queries, dates, instants, enums)
src/core/ext/mcp/ports.ts              ReadLog, LectureReader, McpDeps, RunOptions
src/core/ext/mcp/call.ts               openCall: one consistent view per tool call
src/core/ext/mcp/trust-view.ts         trust levels and allow-listed evidence
src/core/ext/mcp/search.ts             search_nodes
src/core/ext/mcp/node.ts               get_node, get_neighbors
src/core/ext/mcp/lectures.ts           list_lectures, get_lecture
src/core/ext/mcp/goals.ts              list_goals, get_goal
src/core/ext/mcp/plan.ts               get_daily_plan
src/core/ext/mcp/research.ts           research_status
src/core/ext/mcp/debriefs.ts           get_recent_debriefs        (Task 11, conditional)
src/core/ext/mcp/documents.ts          list_documents             (Task 12, conditional)
src/core/ext/mcp/tools.ts              tool table and runTool
src/store/ext/readonly.ts              read-only ledger, graph and lecture readers, stamp guard
src/server/ext/mcp/deps.ts             composition root
src/server/ext/mcp/catalog.ts          zod input contracts (the only place zod appears)
src/server/ext/mcp/server.ts           McpServer, safe wrapper, size guard
src/server/ext/mcp/stdio-guard.ts      stdout belongs to the protocol
src/server/ext/mcp/args.ts             command line and LH_DATA_DIR
scripts/ext-mcp.ts                     entry
tests/helpers/mcp-fixture.ts           learner fixture with HIDDEN markers
tests/helpers/mcp-run.ts               call / errorCode / expectError
tests/helpers/mcp-dir-hash.ts          treeDigest, fsTripwire
tests/helpers/mcp-closure.ts           static import closure
tests/helpers/mcp-client.ts            in-process SDK client
tests/ext-mcp-*.test.ts                one file per concern (see tasks)
```

Modified (no upstream touchpoint): `src/server/ext/personal-layer.ts` (re-export), `docs/ext/CONTRACTS.md` and `docs/ext/TOUCHPOINTS.md` (Task 13).

## Conventions

- Test command: `NODE_ENV=test npx tsx --test <files>`. Typecheck: `npx tsc --noEmit`. Lint: `npx eslint <paths>`.
- Imports use the `.ts` extension. `tsconfig` is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- ESLint layering: `src/core` imports no `agent`, `server` or `store`; zod only in `src/server/ext/mcp/catalog.ts`.
- Each behaviour has a test written before its code. Where a task adds a whole module together with its test file, the "run it to see it fail" step fails on the missing module, and the test file is the specification: read its test names first.
- Commit after each task. The trailer is `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

---

### Task 1: Environment checks

**Files:** none changed. Record the baseline numbers in your notes; Task 14 compares against them.

- [ ] **Step 1: Directory, branch, Node**

```bash
cd learnharness
git rev-parse --abbrev-ref HEAD
git status --short | head
source ~/.nvm/nvm.sh && nvm use 26 && node -v
```

Expected: the fork's working branch (the same one the sibling plans use); a clean tree or only files of other plans; `v26.13.x`.

- [ ] **Step 2: SDK version and API surface, against the installed package**

```bash
grep -n '"@modelcontextprotocol/sdk"\|"zod"\|"tsx"' package.json
node -p "require('./node_modules/@modelcontextprotocol/sdk/package.json').version"
grep -c "registerTool" node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts
grep -n "maxToolInputElements" node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts | head -2
grep -n "maxBufferSize" node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts
grep -n "createLinkedPair" node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts
npm view @modelcontextprotocol/sdk dist-tags --json
```

Expected: the line `@modelcontextprotocol/sdk` with the exact value `1.32.1` (no caret), `1.32.1` installed, `registerTool` count of 2 or more, one line each for `maxToolInputElements`, `maxBufferSize` and `createLinkedPair`, and `latest` of `1.32.1` or `1.32.2`. If the installed version differs from 1.32.1, stop: this plan was verified against 1.32.1 only.

- [ ] **Step 3: Confirm the two import-time hazards that shape the design**

```bash
grep -n "purged legacy ledger" src/store/graph.ts
grep -n "writeFileSync\|mkdirSync" src/store/ext/format.ts | head -3
```

Expected: the first grep prints the line that deletes legacy ledgers at import (so `src/store/graph.ts` must never be imported by the server); the second shows the stamp writer. If either is gone, the closure test in Task 7 still holds but the rationale in this plan needs updating.

- [ ] **Step 4: No file of this plan exists yet**

```bash
ls src/core/ext/mcp src/server/ext/mcp src/store/ext/readonly.ts src/core/ext/local-day.ts scripts/ext-mcp.ts 2>&1 | head
```

Expected: every path reports `No such file or directory`. Anything that exists is another plan's work: stop and reconcile before continuing.

- [ ] **Step 5: Sibling modules for Tasks 11 and 12**

```bash
ls src/core/ext/debrief/journal.ts src/core/ext/study/documents.ts src/core/ext/study/reading.ts 2>&1
```

Expected: a path listing for each module that has landed. Task 11 needs `journal.ts` (session-debriefs plan), Task 12 needs `documents.ts` and `reading.ts` (assisted-study plan). If a module is missing, skip that task for now; every other task is independent of them and the plan still delivers REQ-mcp-01..12.

- [ ] **Step 6: Baseline of tests, types and lint**

```bash
NODE_ENV=test npx tsx --test tests/*.test.ts tests/*.test.tsx 2>&1 | tail -n 12
npx tsc --noEmit 2>&1 | tail -n 3
npx eslint . 2>&1 | tail -n 3
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*' | tail -n 3
```

Expected: note the test pass/fail counts, the tsc and eslint results, and the touchpoint diff summary. Pre-existing failures are not this plan's to fix; Task 14 requires the same numbers plus the new tests, and an unchanged touchpoint summary.

No commit in this task.

---

### Task 2: Errors, limits and input validation

REQ-mcp-08, REQ-mcp-10. The vocabulary every tool uses: fixed-text errors, bounds, and argument validation that is correct on the awkward inputs (NaN, fractions, control characters, impossible dates, instants without a zone).

**Files:**
- Create: `src/core/ext/mcp/errors.ts`, `src/core/ext/mcp/limits.ts`, `src/core/ext/mcp/input.ts`
- Test: `tests/ext-mcp-input.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-mcp-input.test.ts`

```typescript
// tests/ext-mcp-input.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureOf, INTERNAL_MESSAGE, ToolError } from "../src/core/ext/mcp/errors.ts";
import {
	instantMs, optionalEnum, optionalInt, parseDepth, parseInstant, parseLocalDate, plainObject, requireId, requireQuery, requireText,
} from "../src/core/ext/mcp/input.ts";
import { capText, clampLimit, fitToBudget, page, round1, round4, textPage } from "../src/core/ext/mcp/limits.ts";

const code = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return e instanceof ToolError ? e.code : `other:${String(e)}`;
	}
	return "no error";
};

describe("limits (REQ-mcp-08)", () => {
	it("clampLimit: invalid values mean the default, big values are capped", () => {
		for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 2.5, "5", null, {}]) assert.equal(clampLimit(bad, 20, 50), 20);
		assert.equal(clampLimit(1, 20, 50), 1);
		assert.equal(clampLimit(50, 20, 50), 50);
		assert.equal(clampLimit(51, 20, 50), 50);
		assert.equal(clampLimit(1_000_000, 20, 50), 50);
	});

	it("fitToBudget drops items from the end until the serialized page fits, and says so", () => {
		const p = page(["a".repeat(100), "b".repeat(100), "c".repeat(100)], 3);
		assert.deepEqual(fitToBudget(p, 10_000), p);
		const fit = fitToBudget(p, 250);
		assert.equal(fit.count, 2);
		assert.equal(fit.truncated, true);
		assert.deepEqual(fitToBudget(p, 5), { items: [], count: 0, truncated: true });
	});

	it("capText leaves a fitting text alone and marks a cut explicitly", () => {
		assert.equal(capText("abc", 3), "abc");
		assert.equal(capText("abcd", 3), "abc… [truncated: 1 more characters]");
		assert.equal(capText("", 3), "");
	});

	it("capText never ends in half a surrogate pair", () => {
		const emoji = "a😀b"; // a, high, low, b
		assert.equal(capText(emoji, 2), "a… [truncated: 3 more characters]");
		assert.equal(capText(emoji, 3), "a😀… [truncated: 1 more characters]");
	});

	it("page reports count and truncated; a zero or negative limit yields an empty page", () => {
		assert.deepEqual(page([1, 2, 3], 2), { items: [1, 2], count: 2, truncated: true });
		assert.deepEqual(page([1, 2], 2), { items: [1, 2], count: 2, truncated: false });
		assert.deepEqual(page([], 5), { items: [], count: 0, truncated: false });
		assert.deepEqual(page([1], 0), { items: [], count: 0, truncated: true });
		assert.deepEqual(page([1], -4), { items: [], count: 0, truncated: true });
	});

	it("textPage caps every item", () => {
		const p = textPage(["abcdef", "x"], 5, 3);
		assert.equal(p.items[0], "abc… [truncated: 3 more characters]");
		assert.equal(p.items[1], "x");
	});

	it("numbers are finite or null", () => {
		assert.equal(round4(Number.NaN), null);
		assert.equal(round4(Number.POSITIVE_INFINITY), null);
		assert.equal(round4(0.123456), 0.1235);
		assert.equal(round1(Number.NaN), 0);
		assert.equal(round1(2.449), 2.4);
	});
});

describe("input validation", () => {
	it("requireId: exact, non-blank, bounded, no control characters", () => {
		assert.equal(requireId("n_1", "id"), "n_1");
		assert.equal(requireId(" n_1", "id"), " n_1"); // not trimmed: it simply will not be found
		for (const bad of [undefined, null, 5, {}, [], "", "   ", "a\nb", "a\u0000b", "x".repeat(201)]) assert.equal(code(() => requireId(bad, "id")), "invalid_input");
	});

	it("requireQuery collapses whitespace and refuses empty or oversized queries", () => {
		assert.equal(requireQuery("  sigma \t algebra\n"), "sigma algebra");
		assert.equal(requireQuery("a\u0000b"), "a b");
		for (const bad of [undefined, 5, "", "   ", "\n\t", "x".repeat(201), "a b c d e f g h i"]) assert.equal(code(() => requireQuery(bad)), "invalid_input");
		assert.equal(requireQuery("a b c d e f g h"), "a b c d e f g h");
	});

	it("optionalEnum and optionalInt are closed", () => {
		assert.equal(optionalEnum(undefined, ["a", "b"] as const, "f"), undefined);
		assert.equal(optionalEnum("a", ["a", "b"] as const, "f"), "a");
		for (const bad of ["c", "", 1, null, "A", "toString", "__proto__"]) assert.equal(code(() => optionalEnum(bad, ["a", "b"] as const, "f")), "invalid_input");
		assert.equal(optionalInt(undefined, "n", 1, 5), undefined);
		assert.equal(optionalInt(3, "n", 1, 5), 3);
		for (const bad of [0, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) assert.equal(code(() => optionalInt(bad, "n", 1, 5)), "invalid_input");
	});

	it("parseDepth is 1 or 2, default 1", () => {
		assert.equal(parseDepth(undefined), 1);
		assert.equal(parseDepth(2), 2);
		for (const bad of [0, 3, 1.5, "1", null, Number.NaN]) assert.equal(code(() => parseDepth(bad)), "invalid_input");
	});

	it("parseLocalDate accepts real calendar dates only", () => {
		assert.equal(parseLocalDate("2026-11-04", "date").iso, "2026-11-04");
		assert.equal(parseLocalDate("2028-02-29", "date").day, 29); // leap year
		for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "0050-01-01", "2026-1-4", "26-11-04", "2026-11-04T00:00:00Z", "", 20261104, null, undefined]) {
			assert.equal(code(() => parseLocalDate(bad, "date")), "invalid_input", String(bad));
		}
	});

	it("parseInstant needs an explicit zone and normalises to UTC", () => {
		assert.equal(parseInstant("2026-11-04T10:00:00Z", "since"), "2026-11-04T10:00:00.000Z");
		assert.equal(parseInstant("2026-11-04T10:00:00+01:00", "since"), "2026-11-04T09:00:00.000Z");
		assert.equal(parseInstant("2026-11-04T10:00Z", "since"), "2026-11-04T10:00:00.000Z");
		for (const bad of ["2026-11-04", "2026-11-04T10:00:00", "garbage 2026", "2026-13-04T10:00:00Z", "2026-11-04T25:00:00Z", "", 5, null]) {
			assert.equal(code(() => parseInstant(bad, "since")), "invalid_input", String(bad));
		}
	});

	it("instantMs never yields NaN", () => {
		assert.equal(instantMs("not a date"), Number.NEGATIVE_INFINITY);
		assert.equal(instantMs("2026-11-04T10:00:00.000Z"), Date.parse("2026-11-04T10:00:00.000Z"));
	});

	it("plainObject: absent is {}, arrays and primitives are refused", () => {
		assert.deepEqual(plainObject(undefined), {});
		assert.deepEqual(plainObject(null), {});
		assert.deepEqual(plainObject({ a: 1 }), { a: 1 });
		for (const bad of [[], [1], "x", 5, true]) assert.equal(code(() => plainObject(bad)), "invalid_input");
	});
});

describe("failureOf (no error leakage)", () => {
	it("keeps a ToolError's code and fixed message", () => {
		assert.deepEqual(failureOf(new ToolError("not_found", "No node.")), { error: { code: "not_found", message: "No node." } });
	});
	it("turns anything else into the generic internal failure", () => {
		const leaky = Object.assign(new Error("ENOENT: no such file /Users/secret/x"), { code: "ENOENT" });
		assert.deepEqual(failureOf(leaky), { error: { code: "internal", message: INTERNAL_MESSAGE } });
		assert.deepEqual(failureOf("a string"), { error: { code: "internal", message: INTERNAL_MESSAGE } });
		assert.deepEqual(failureOf(undefined), { error: { code: "internal", message: INTERNAL_MESSAGE } });
	});
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-input.test.ts
```

Expected: FAIL with `Cannot find module '../src/core/ext/mcp/errors.ts'`.

- [ ] **Step 3: Implement**

`src/core/ext/mcp/errors.ts`

```typescript
// src/core/ext/mcp/errors.ts
/**
 * The error vocabulary of the read-only MCP server (REQ-mcp-03, REQ-mcp-10).
 * A ToolError carries a code from a closed list and a FIXED-TEXT message: it
 * never embeds a path, a stack or a raw exception message. `failureOf` is the
 * only way an error leaves the server: a ToolError keeps its code and message,
 * anything else becomes the generic `internal` failure (the caller logs the
 * real error on stderr).
 */

export type ToolErrorCode =
	| "invalid_input"
	| "not_found"
	| "disabled"
	| "data_newer_than_build"
	| "data_too_large"
	| "data_inconsistent"
	| "response_too_large"
	| "internal";

export class ToolError extends Error {
	readonly code: ToolErrorCode;
	constructor(code: ToolErrorCode, message: string) {
		super(message);
		this.name = "ToolError";
		this.code = code;
	}
}

export interface ToolFailure {
	error: { code: ToolErrorCode; message: string };
}

export const INTERNAL_MESSAGE = "The server could not complete this request.";
export const NEWER_FORMAT_MESSAGE =
	"The learning data was written by a newer version of the app than this server understands. Update the server before reading it.";

export function failureOf(error: unknown): ToolFailure {
	if (error instanceof ToolError) return { error: { code: error.code, message: error.message } };
	return { error: { code: "internal", message: INTERNAL_MESSAGE } };
}

export const invalid = (message: string): ToolError => new ToolError("invalid_input", message);
```

`src/core/ext/mcp/limits.ts`

```typescript
// src/core/ext/mcp/limits.ts
/**
 * Every bound of the server in one place (REQ-mcp-08). Lists are wrapped in a
 * Page ({items, count, truncated}); long text is cut with an explicit marker;
 * numbers handed back are finite or null.
 */

export const LIMITS = Object.freeze({
	listDefault: 20,
	listMax: 50,
	lecturesMax: 100,
	documentsMax: 100,
	debriefsDefault: 10,
	debriefsMax: 50,
	queryMaxChars: 200,
	queryMaxTokens: 8,
	idMaxChars: 200,
	nameChars: 200,
	titleChars: 200,
	listStatementChars: 400,
	statementChars: 2000,
	explanationChars: 6000,
	quoteChars: 400,
	locatorChars: 120,
	noteChars: 200,
	summaryChars: 1500,
	promptChars: 600,
	commentaryChars: 3000,
	factsBytes: 4096,
	aliasesMax: 10,
	evidenceMax: 8,
	argumentsMax: 8,
	premisesPerArgumentMax: 12,
	conclusionsMax: 20,
	citingLecturesMax: 20,
	goalsPerNodeMax: 20,
	neighbourNodesMax: 60,
	neighbourEdgesMax: 120,
	targetsMax: 20,
	citedNodesMax: 200,
	slidesMax: 200,
	exercisesMax: 50,
	slideNodesMax: 20,
	marksMax: 20,
	pendingGoalsMax: 20,
	futureDaysMax: 30,
	/** A serialized tool result above this is refused, never cut (fail closed). */
	responseMaxBytes: 128 * 1024,
	/** The part of a response that one list may use when the response holds more than the list. */
	listBudgetBytes: 96 * 1024,
	/** A request line above this is refused by the transport. */
	requestMaxBytes: 256 * 1024,
	maxToolInputElements: 50,
	ledgerMaxBytes: 128 * 1024 * 1024,
	lectureFileMaxBytes: 4 * 1024 * 1024,
	lectureFilesMax: 1000,
});

export interface Page<T> {
	items: T[];
	count: number;
	truncated: boolean;
}

/** The first `limit` items; `truncated` says whether more existed. */
export function page<T>(all: readonly T[], limit: number): Page<T> {
	const items = all.slice(0, Math.max(0, limit));
	return { items, count: items.length, truncated: all.length > items.length };
}

/**
 * A page whose serialized items fit in `budgetBytes`: items are dropped from the
 * end until they do, and `truncated` says so. A byte budget cannot be met by
 * per-field caps alone when a page holds many large entries.
 */
export function fitToBudget<T>(p: Page<T>, budgetBytes: number): Page<T> {
	let items = p.items;
	while (items.length > 0 && Buffer.byteLength(JSON.stringify(items), "utf-8") > budgetBytes) items = items.slice(0, items.length - 1);
	return { items, count: items.length, truncated: p.truncated || items.length < p.items.length };
}

/** A page of strings, each cut to `chars`. */
export function textPage(all: readonly string[], limit: number, chars: number): Page<string> {
	const p = page(all, limit);
	return { ...p, items: p.items.map((s) => capText(s, chars)) };
}

/**
 * A caller-supplied limit: an integer >= 1, else the default (NaN, Infinity,
 * fractions, zero, negatives and non-numbers all mean the default); above the
 * maximum it is capped.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fallback;
	return Math.min(raw, max);
}

/**
 * `value` itself when it fits, else its first `max` UTF-16 units (never ending
 * in half a surrogate pair) followed by an explicit marker.
 */
export function capText(value: string, max: number): string {
	if (value.length <= max) return value;
	let cut = Math.max(0, max);
	const last = value.charCodeAt(cut - 1);
	if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
	return `${value.slice(0, cut)}… [truncated: ${value.length - cut} more characters]`;
}

/** A finite number rounded to 4 decimals, else null. */
export function round4(n: number): number | null {
	return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null;
}

/** A finite number rounded to 1 decimal, else 0. */
export function round1(n: number): number {
	return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function finiteOrNull(n: unknown): number | null {
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}
```

`src/core/ext/mcp/input.ts`

```typescript
// src/core/ext/mcp/input.ts
/**
 * Validation of tool arguments. The SDK layer validates the same shapes with
 * zod; these functions are the second, independent check (the core is called
 * directly by tests and must never trust its caller): ids and queries are
 * bounded strings without control characters, enums are closed, dates are real
 * calendar dates, instants carry an explicit zone.
 */

import { invalid } from "./errors.ts";
import { LIMITS } from "./limits.ts";

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_G = /[\u0000-\u001f\u007f]+/g;

export function requireText(value: unknown, field: string, maxChars: number): string {
	if (typeof value !== "string") throw invalid(`${field} must be a string.`);
	if (value.trim() === "") throw invalid(`${field} must not be empty.`);
	if (value.length > maxChars) throw invalid(`${field} must be at most ${maxChars} characters.`);
	if (CONTROL.test(value)) throw invalid(`${field} must not contain control characters.`);
	return value;
}

export const requireId = (value: unknown, field: string): string => requireText(value, field, LIMITS.idMaxChars);

/** A search query: control characters count as spaces, whitespace is collapsed. */
export function requireQuery(value: unknown): string {
	if (typeof value !== "string") throw invalid("query must be a string.");
	if (value.length > LIMITS.queryMaxChars) throw invalid(`query must be at most ${LIMITS.queryMaxChars} characters.`);
	const query = value.replace(CONTROL_G, " ").replace(/\s+/g, " ").trim();
	if (query === "") throw invalid("query must not be empty.");
	if (query.split(" ").length > LIMITS.queryMaxTokens) throw invalid(`query must have at most ${LIMITS.queryMaxTokens} words.`);
	return query;
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw invalid(`${field} must be one of: ${allowed.join(", ")}.`);
	}
	return value as T;
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw invalid(`${field} must be an integer from ${min} to ${max}.`);
	}
	return value;
}

export function parseDepth(value: unknown): 1 | 2 {
	if (value === undefined) return 1;
	if (value === 1 || value === 2) return value;
	throw invalid("depth must be 1 or 2.");
}

export interface LocalDate {
	year: number;
	month: number;
	day: number;
	iso: string;
}

/** YYYY-MM-DD naming a real calendar date (2026-02-30 and years below 100 are refused). */
export function parseLocalDate(value: unknown, field: string): LocalDate {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`${field} must be a date as YYYY-MM-DD.`);
	const [year, month, day] = value.split("-").map(Number) as [number, number, number];
	const probe = new Date(year, month - 1, day, 12);
	if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
		throw invalid(`${field} is not a calendar date.`);
	}
	return { year, month, day, iso: value };
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO-8601 instant WITH an explicit zone; returned normalised to UTC. */
export function parseInstant(value: unknown, field: string): string {
	if (typeof value !== "string" || !INSTANT.test(value)) throw invalid(`${field} must be an ISO-8601 instant with a zone, e.g. 2026-11-04T10:00:00Z.`);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw invalid(`${field} is not a valid instant.`);
	return new Date(ms).toISOString();
}

/** Milliseconds of an ISO string; -Infinity when unparseable (so it sorts oldest, never NaN). */
export function instantMs(iso: string): number {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The arguments object: absent means {}, anything but a plain object is refused. */
export function plainObject(input: unknown): Record<string, unknown> {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object" || Array.isArray(input)) throw invalid("The arguments must be a JSON object.");
	return input as Record<string, unknown>;
}
```

- [ ] **Step 4: Run the test, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-input.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/core/ext/mcp tests/ext-mcp-input.test.ts
```

Expected: all tests pass; no tsc lines for these files; eslint prints nothing but the harmless `Pages directory cannot be found` notice.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/mcp/errors.ts src/core/ext/mcp/limits.ts src/core/ext/mcp/input.ts tests/ext-mcp-input.test.ts
git commit -m "feat(mcp): fixed-text errors, response bounds and argument validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Read-only data layer, composition root and test fixtures

REQ-mcp-01, -02, -03. Everything the server reads goes through `src/store/ext/readonly.ts`: no `format.json` is ever written, a newer stamp refuses, a corrupt or torn line is skipped, an oversized file is refused before it is parsed, and a malformed lecture or a lecture stored under the wrong directory is ignored. The composition root builds `McpDeps` from it and gives the app's pure functions stores whose `appendEvent` throws.

**Files:**
- Create: `src/core/ext/local-day.ts`, `src/core/ext/mcp/ports.ts`, `src/store/ext/readonly.ts`, `src/server/ext/mcp/deps.ts`
- Create: `tests/helpers/mcp-fixture.ts`, `tests/helpers/mcp-dir-hash.ts`
- Modify: `src/server/ext/personal-layer.ts` (re-export `startOfLocalDay`)
- Test: `tests/ext-mcp-readonly.test.ts`, existing `tests/ext-personal-layer.test.ts` (regression)

- [ ] **Step 1: Move `startOfLocalDay` to a shared core file (refactor, covered by an existing test)**

The plan needs the same "local midnight" the app uses, from core. Create:

`src/core/ext/local-day.ts`

```typescript
// src/core/ext/local-day.ts
/** Local-time day helpers shared by the app's personal layer and the MCP server (REQ-mcp-07). */

/** Local midnight as an ISO instant: "today" for the daily budget and the dialogic cap. */
export function startOfLocalDay(now: Date = new Date()): string {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.toISOString();
}

/** The local calendar date of an instant as YYYY-MM-DD. */
export function localIsoDate(at: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
```

In `src/server/ext/personal-layer.ts` add the import next to the other `core/ext` imports and replace the function body with a re-export, so `tests/ext-personal-layer.test.ts` and every other importer keep working:

```diff
 import { deriveCards } from "../../core/ext/cards.ts";
+import { startOfLocalDay } from "../../core/ext/local-day.ts";
 import {
 	computePlan,
@@
-/** Local midnight as an ISO instant: "today" for the daily budget and the dialogic cap. */
-export function startOfLocalDay(now: Date = new Date()): string {
-	const d = new Date(now);
-	d.setHours(0, 0, 0, 0);
-	return d.toISOString();
-}
+export { startOfLocalDay };
```

```bash
NODE_ENV=test npx tsx --test tests/ext-personal-layer.test.ts
npx tsc --noEmit 2>&1 | grep personal-layer
```

Expected: the personal-layer tests still pass; no tsc output. `src/server/ext/` is under the touchpoint exclusion, so this is not a touchpoint.

- [ ] **Step 2: The dependency record**

`src/core/ext/mcp/ports.ts`

```typescript
// src/core/ext/mcp/ports.ts
/**
 * What the read-only server needs from the outside (hexagonal rule of
 * src/core/ports.ts). `review` is typed as the app's ReviewDeps so the SAME
 * pure functions (computePlan, snapshot, goalReadiness...) run unchanged
 * (REQ-mcp-07); its stores have a write method only to satisfy that type, and
 * the composition root (src/server/ext/mcp/deps.ts) makes every one refuse.
 */

import type { ExplanationEvent } from "../explanations.ts";
import type { FrontierEvent } from "../frontier.ts";
import type { InboxEvent } from "../inbox.ts";
import type { Lecture } from "../lecture/lecture.ts";
import type { ExerciseEvent } from "../practice/exercises.ts";
import type { ReviewDeps } from "../review-service.ts";
import type { CycleLogEntry } from "../research-log.ts";
import type { VerificationEvent } from "../trust.ts";

export interface ReadLog<T> {
	/** Valid events in file order; never writes. */
	readAll(): T[];
}

export interface LectureReader {
	get(id: string): Lecture | null;
	list(): Lecture[];
}

export interface McpDeps {
	review: ReviewDeps;
	verification: ReadLog<VerificationEvent>;
	explanations: ReadLog<ExplanationEvent>;
	exercises: ReadLog<ExerciseEvent>;
	frontier: ReadLog<FrontierEvent>;
	inbox: ReadLog<InboxEvent>;
	researchLog: ReadLog<CycleLogEntry>;
	lectures: LectureReader;
	/** ISO-8601 instant, called once per tool call. */
	now(): string;
	/** Throws a ToolError(data_newer_than_build) when any stamp is newer than this build. Never writes. */
	assertReadable(): void;
}

export interface RunOptions {
	/** Disable the study-state group and the learner-performance fields of get_node (REQ-mcp-06). */
	knowledgeOnly: boolean;
}
```

- [ ] **Step 3: Write the failing tests**

The test fixture seeds a whole learner (graph, goal, reviews, a card, trust, explanations, a lecture, an exercise set, research state) and plants unmistakable `HIDDEN_*` markers in every field that must never leave the server. The digest helper is the byte-for-byte oracle for Task 7.

`tests/helpers/mcp-fixture.ts`

```typescript
// tests/helpers/mcp-fixture.ts
/**
 * A real data directory on disk for the MCP server tests. Files are written
 * with plain fs calls (the test side may write; the server never does), shaped
 * by the app's own event types so a format change breaks the fixture at
 * compile time. `seedStandard` builds one small, fully populated learner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { CardEvent } from "../../src/core/ext/cards.ts";
import { concludingFingerprint } from "../../src/core/ext/explanation-rules.ts";
import type { ExplanationEvent } from "../../src/core/ext/explanations.ts";
import type { FrontierEvent } from "../../src/core/ext/frontier.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { InboxEvent } from "../../src/core/ext/inbox.ts";
import type { McpDeps } from "../../src/core/ext/mcp/ports.ts";
import type { ExerciseEvent } from "../../src/core/ext/practice/exercises.ts";
import type { CycleLogEntry } from "../../src/core/ext/research-log.ts";
import type { ReviewEvent } from "../../src/core/ext/review.ts";
import type { Evidence, VerificationEvent } from "../../src/core/ext/trust.ts";
import { createMcpDeps } from "../../src/server/ext/mcp/deps.ts";
import { makeLecture } from "./lecture-fixture.ts";

export const NOW = "2026-11-04T12:00:00.000Z";
export const GOAL_ID = "goal_aaaaaaaaaaaa";
export const N = { a: "n_aaaa1111", b: "n_bbbb2222", c: "n_cccc3333", d: "n_dddd4444", lone: "n_lone5555" } as const;

/** Strings that must NEVER appear in any tool output (they sit in fields the server does not expose). */
export const HIDDEN = {
	cardAnswer: "HIDDEN_CARD_ANSWER_91",
	reference: "HIDDEN_REFERENCE_SOLUTION_92 that is long enough to be quotable",
	narration: "family closed under complements and countable unions",
	reveal: "the four listed sets are closed under both operations",
	originRef: "HIDDEN_ORIGIN_REF_93",
	localPath: "/Users/secret-person/private-books",
	urlToken: "HIDDEN_TOKEN_94",
	researchError: "HIDDEN_RESEARCH_ERROR_95",
	locator: "https://hidden-locator.example/HIDDEN_LOCATOR_96",
	steer: "HIDDEN_STEER_97",
	rationale: "HIDDEN_RATIONALE_98",
} as const;

export interface Fixture {
	root: string;
	extDir: string;
	graphDir: string;
	deps: McpDeps;
	/** Appends one raw line (an object is JSON-encoded) to <root>/ext/<file>, creating the directory. */
	ext(file: string, line: unknown): void;
	graph(file: "nodes.jsonl" | "chains.jsonl", line: unknown): void;
	writeStamp(dir: "ext" | "graph", version: number): void;
	cleanup(): void;
}

const roots: string[] = [];

export function makeFixture(clock: () => string = () => NOW): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
	roots.push(root);
	const extDir = path.join(root, "ext");
	const graphDir = path.join(root, "graph");
	fs.mkdirSync(graphDir, { recursive: true });
	const line = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
	return {
		root,
		extDir,
		graphDir,
		deps: createMcpDeps(root, clock),
		ext(file, v) {
			fs.mkdirSync(extDir, { recursive: true });
			fs.appendFileSync(path.join(extDir, file), `${line(v)}\n`);
		},
		graph(file, v) {
			fs.appendFileSync(path.join(graphDir, file), `${line(v)}\n`);
		},
		writeStamp(dir, version) {
			const d = dir === "ext" ? extDir : graphDir;
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, "format.json"), JSON.stringify({ version }));
		},
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

export function cleanupAllFixtures(): void {
	for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}

export const node = (id: string, name: string, statement = `${name} holds.`, aliases: string[] = []): GraphNode => ({
	id, name, statement, aliases, createdAt: "2026-11-01T00:00:00.000Z", provenance: [],
});
export const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id, premises, conclusion, provenance: [], createdAt: "2026-11-01T00:00:00.000Z",
});

export const STANDARD_NODES: GraphNode[] = [
	node(N.a, "Axiom A", "Every set is a subset of itself."),
	node(N.b, "Lemma B", "The empty set is a subset of every set."),
	node(N.c, "Theorem C", "Inclusion is a partial order on sets.", ["Subset order"]),
	node(N.d, "Corollary D", "Every family of sets has a partial order by inclusion."),
	node(N.lone, "Loner", "A node no chain mentions."),
];
// C is concluded by two chains (an alternative argument); D by one.
export const STANDARD_CHAINS: GraphChain[] = [chain("ch_1", [N.a, N.b], N.c), chain("ch_2", [N.a], N.c), chain("ch_3", [N.c], N.d)];

export function seedGraph(f: Fixture, nodes: GraphNode[] = STANDARD_NODES, chains: GraphChain[] = STANDARD_CHAINS): void {
	for (const n of nodes) f.graph("nodes.jsonl", n);
	for (const c of chains) f.graph("chains.jsonl", c);
}

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
	sourceRef: "https://example.org/set-theory",
	sourceId: "lib_0000000a",
	locator: "section 2",
	quote: "every set is a subset of itself, by reflexivity of inclusion",
	snapshot: "a".repeat(64),
	stance: "supports",
	tier: "primary",
	host: "example.org",
	...over,
});

/** A learner with goals, reviews, a card, trust, explanations, a lecture, an exercise set and research state. */
export function seedStandard(f: Fixture): void {
	seedGraph(f);
	const goal: GoalEvent = {
		type: "created", goalId: GOAL_ID, title: "Learn set order", origin: "user", originRef: HIDDEN.originRef,
		targetNodeIds: [N.d], priority: 3, at: "2026-11-01T00:00:00.000Z",
	};
	f.ext("goals.jsonl", goal);

	const reviews: ReviewEvent[] = [
		{ type: "review", nodeId: N.a, channel: "fixed", rating: 3, durationSec: 20, at: "2026-11-01T09:00:00.000Z" },
		{ type: "review", nodeId: N.b, channel: "fixed", rating: 1, durationSec: 30, at: "2026-11-03T09:00:00.000Z" },
	];
	for (const r of reviews) f.ext("review.jsonl", r);

	const card: CardEvent = {
		type: "created", cardId: "card_00000001", nodeId: N.a, question: "What is reflexivity?", answer: HIDDEN.cardAnswer,
		author: "user", status: "active", at: "2026-11-01T08:00:00.000Z",
	};
	f.ext("cards.jsonl", card);

	const checked: VerificationEvent[] = [
		{
			type: "checked", nodeId: N.a, outcome: "sourced", checker: "test:model", at: "2026-11-02T10:00:00.000Z", discarded: [],
			evidence: [evidence({ sourceRef: `https://user:pw@example.org/set-theory?token=${HIDDEN.urlToken}#frag` })],
		},
		{
			type: "checked", nodeId: N.b, outcome: "unverified", checker: "test:model", at: "2026-11-02T10:00:00.000Z", discarded: [],
			evidence: [evidence({ sourceRef: `${HIDDEN.localPath}/algebra.pdf`, sourceId: null, tier: "unvetted", host: "" })],
		},
	];
	for (const v of checked) f.ext("verification.jsonl", v);

	const expl: ExplanationEvent[] = [
		{
			type: "version", nodeId: N.c, version: 1, body: `Follows from [[${N.a}]] and [[${N.b}]].`, author: "agent", sourceRefs: [],
			styleVersion: "abc123abc123", fingerprint: concludingFingerprint(N.c, STANDARD_CHAINS), noSource: false, proposed: false,
			at: "2026-11-02T11:00:00.000Z",
		},
		{
			type: "version", nodeId: N.d, version: 1, body: "Old text.", author: "agent", sourceRefs: [], styleVersion: "abc123abc123",
			fingerprint: "stale-fingerprint", noSource: true, proposed: false, at: "2026-11-02T11:00:00.000Z",
		},
	];
	for (const e of expl) f.ext("explanations.jsonl", e);

	const lecture = makeLecture({
		blocks: makeLecture().blocks.map((b) => ({ ...b, nodeIds: b.nodeIds.map(() => N.a) })),
		slides: [
			{ id: "s1", heading: "Sigma algebra", elements: [{ id: "e1", type: "text", content: `A [[${N.a}|set]] is a family of sets.` }] },
			{ id: "s2", heading: "Looking ahead", elements: [{ id: "e2", type: "list", items: ["Brownian motion", `[[${N.b}]]`] }] },
		],
	});
	fs.mkdirSync(path.join(f.extDir, "lectures", lecture.id), { recursive: true });
	fs.writeFileSync(path.join(f.extDir, "lectures", lecture.id, "lecture.json"), JSON.stringify(lecture));

	const sets: ExerciseEvent[] = [
		{
			type: "set_created", setId: "set_1", goalId: GOAL_ID, at: "2026-11-03T10:00:00.000Z",
			exercises: [{ id: "ex_1", prompt: "Show that inclusion is transitive.", nodeIds: [N.a, N.c], steps: [{ id: "s1", text: HIDDEN.reference, nodeIds: [N.a] }] }],
		},
		{ type: "graded", setId: "set_1", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [{ nodeId: N.a, outcome: "passed" }], lowConfidence: false, at: "2026-11-03T11:00:00.000Z" },
	];
	for (const e of sets) f.ext("exercises.jsonl", e);

	const frontier: FrontierEvent = {
		type: "set", markId: "mark_1", scope: { kind: "goal", id: GOAL_ID }, mark: "expand", maxDepth: 2, budgetUsd: 1.5,
		note: "grow the set theory area", author: "user", at: "2026-11-03T12:00:00.000Z",
	};
	f.ext("frontier.jsonl", frontier);
	const inbox: InboxEvent[] = [
		{ type: "proposed", locator: HIDDEN.locator, title: "A paper", gapId: "gap_1", foundBy: "cycle", cycleId: "cyc_1", snapshot: "b".repeat(64), at: "2026-11-03T13:00:00.000Z" },
		{ type: "proposed", locator: "https://other.example/paper", title: "Another", gapId: "gap_1", foundBy: "watch", cycleId: "cyc_1", snapshot: "c".repeat(64), at: "2026-11-03T13:01:00.000Z" },
		{ type: "decided", locator: "https://other.example/paper", decision: "rejected", at: "2026-11-03T14:00:00.000Z" },
	];
	for (const e of inbox) f.ext("inbox.jsonl", e);
	const cycle: CycleLogEntry = {
		type: "cycle", cycleId: "cyc_1", trigger: "schedule", startedAt: "2026-11-03T13:00:00.000Z", endedAt: "2026-11-03T13:30:00.000Z",
		stoppedBy: "completed",
		gaps: [{
			gapId: "gap_1", type: "unverified", nodeId: N.a, questions: ["q1"], confidence: 0.9, rationale: HIDDEN.rationale, stoppedBy: "confidence",
			sources: [{ locator: HIDDEN.locator, outcome: "inbox", nodesAdded: 0 }], nodesAdded: 2, costUsd: 0.2, saturated: false, error: HIDDEN.researchError,
		}],
		watch: { entries: 1, items: 3, ingested: 1, inbox: 2 }, nodesAdded: 2, costUsd: 0.25, steers: [HIDDEN.steer],
	};
	f.ext("research-log.jsonl", cycle);
}
```

`tests/helpers/mcp-dir-hash.ts`

```typescript
// tests/helpers/mcp-dir-hash.ts
/**
 * The immutability oracle (REQ-mcp-02). `treeDigest` walks a directory
 * recursively and records, for every entry (file, directory, symlink): its
 * relative path, type, size, mtime in nanoseconds, inode and, for files, the
 * sha256 of the content. Directory mtimes are included on purpose: creating
 * and deleting a temporary or lock file leaves no file behind but changes the
 * directory's mtime. atime is excluded (a read may legitimately change it).
 * `fsTripwire` additionally makes every write API of node:fs throw while a
 * tool runs, so a write to ANY path (not only the data directory) is caught.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

export function treeDigest(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			const st = fs.lstatSync(full, { bigint: true });
			const rel = path.relative(root, full);
			const type = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
			const content = type === "f" ? createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "";
			lines.push(`${rel}|${type}|${st.size}|${st.mtimeNs}|${st.ino}|${content}`);
			if (type === "d") walk(full);
		}
	};
	const rootStat = fs.lstatSync(root, { bigint: true });
	lines.push(`.|d|${rootStat.mtimeNs}`);
	walk(root);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

type Fn = (...args: unknown[]) => unknown;
type Table = Record<string, Fn>;
const WRITE_APIS = [
	"writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync",
	"cpSync", "truncateSync", "ftruncateSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "utimesSync", "writeSync",
	"createWriteStream",
] as const;

/** While active, any call to a write API of node:fs throws. Returns the restore function. */
export function fsTripwire(): { calls: string[]; restore(): void } {
	const calls: string[] = [];
	const restores: Array<() => void> = [];
	for (const name of WRITE_APIS) {
		const m = mock.method(fs as unknown as Table, name, (..._args: unknown[]) => {
			calls.push(name);
			throw new Error(`fs.${name} called while the read-only server was running`);
		});
		restores.push(() => m.mock.restore());
	}
	const promises = fs.promises as unknown as Table;
	for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rename", "unlink", "copyFile", "truncate"]) {
		const m = mock.method(promises, name, async () => {
			calls.push(`promises.${name}`);
			throw new Error(`fs.promises.${name} called while the read-only server was running`);
		});
		restores.push(() => m.mock.restore());
	}
	// openSync with a write flag is a write too; read opens pass through.
	const realOpen = fs.openSync.bind(fs);
	const open = mock.method(fs as unknown as Table, "openSync", (p: unknown, flags?: unknown, mode?: unknown) => {
		const writes = typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
		if (writes) {
			calls.push("openSync(write)");
			throw new Error("fs.openSync for writing called while the read-only server was running");
		}
		return (realOpen as Fn)(p, flags, mode);
	});
	restores.push(() => open.mock.restore());
	return { calls, restore: () => restores.reverse().forEach((r) => r()) };
}
```

`tests/ext-mcp-readonly.test.ts`

```typescript
// tests/ext-mcp-readonly.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import { parseGoalEvent } from "../src/core/ext/goals.ts";
import { createGoalsStore } from "../src/store/ext/goals-store.ts";
import { createLecturesStore } from "../src/store/ext/lectures-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { createGraphReader, createLectureReader, createReadableGuard, EXT_FORMAT_VERSION, readOnlyLedger, validateDataRoot } from "../src/store/ext/readonly.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, node, seedStandard } from "./helpers/mcp-fixture.ts";

afterEach(cleanupAllFixtures);

const goal = (id: string, at = "2026-11-01T00:00:00.000Z") => ({
	type: "created", goalId: id, title: "t", origin: "user", originRef: "", targetNodeIds: [N.a], priority: 3, at,
});

describe("readOnlyLedger", () => {
	it("a missing file is empty; corrupt, torn and rejected lines are skipped", () => {
		const f = makeFixture();
		const ledger = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent);
		assert.deepEqual(ledger.readAll(), []);
		f.ext("goals.jsonl", goal("goal_000000000001"));
		f.ext("goals.jsonl", "{ not json");
		f.ext("goals.jsonl", { type: "created", goalId: "" }); // parser rejects
		f.ext("goals.jsonl", "");
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), '{"type":"created","goalId":"goal_0000000000'); // torn last line, no newline
		assert.equal(ledger.readAll().length, 1);
	});

	it("reads the same events as the app's createLedger (parity)", () => {
		const f = makeFixture();
		const store = createGoalsStore(f.extDir); // the app's writer
		store.appendEvent(goal("goal_000000000001") as never);
		store.appendEvent(goal("goal_000000000002") as never);
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), "garbage\n");
		const mine = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent).readAll();
		assert.deepEqual(mine, store.readEvents());
	});

	it("a parser that throws on a line does not break the read", () => {
		const f = makeFixture();
		f.ext("x.jsonl", { a: 1 });
		f.ext("x.jsonl", { a: 2 });
		const ledger = readOnlyLedger(f.extDir, "x.jsonl", (raw) => {
			if ((raw as { a: number }).a === 1) throw new Error("boom");
			return raw;
		});
		assert.deepEqual(ledger.readAll(), [{ a: 2 }]);
	});

	it("refuses a file above the size ceiling with data_too_large (bounded parse time)", () => {
		const f = makeFixture();
		f.ext("goals.jsonl", goal("goal_000000000001"));
		const ledger = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent, 10);
		assert.throws(() => ledger.readAll(), (e) => e instanceof ToolError && e.code === "data_too_large" && !/\/|\\/.test(e.message));
	});

	it("exposes no write method", () => {
		const f = makeFixture();
		assert.deepEqual(Object.keys(readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent)), ["readAll"]);
	});
});

describe("format stamps (REQ-mcp-03)", () => {
	it("the constant equals the app's", () => {
		assert.equal(EXT_FORMAT_VERSION, CURRENT_EXT_FORMAT_VERSION);
	});

	it("no stamp, version 1, a corrupt stamp and a non-integer stamp are readable", () => {
		const f = makeFixture();
		const guard = createReadableGuard(f.root);
		guard();
		f.writeStamp("ext", 1);
		f.writeStamp("graph", 1);
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), "{ corrupt");
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), '{"version": 2.5}');
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), "null");
		guard();
	});

	it("a newer ext stamp or a newer graph stamp refuses with a fixed message", () => {
		for (const dir of ["ext", "graph"] as const) {
			const f = makeFixture();
			f.writeStamp(dir, 2);
			assert.throws(() => createReadableGuard(f.root)(), (e) => e instanceof ToolError && e.code === "data_newer_than_build" && !e.message.includes(f.root));
		}
	});
});

describe("validateDataRoot", () => {
	it("accepts a directory, refuses a missing path and a file, and never creates anything", () => {
		const f = makeFixture();
		validateDataRoot(f.root);
		const missing = path.join(f.root, "nope");
		assert.throws(() => validateDataRoot(missing), /data directory not found/);
		assert.equal(fs.existsSync(missing), false);
		const file = path.join(f.root, "afile");
		fs.writeFileSync(file, "x");
		assert.throws(() => validateDataRoot(file), /data directory not found/);
	});
});

describe("graph reader", () => {
	it("skips corrupt and ill-shaped lines and keeps order", () => {
		const f = makeFixture();
		f.graph("nodes.jsonl", node("n_1", "One"));
		f.graph("nodes.jsonl", "{ torn");
		f.graph("nodes.jsonl", { id: "n_bad", name: 5 });
		f.graph("nodes.jsonl", node("n_2", "Two"));
		f.graph("chains.jsonl", { id: "c", premises: [], conclusion: "n_1", provenance: [], createdAt: "x" }); // no premises
		f.graph("chains.jsonl", { id: "c2", premises: ["n_1"], conclusion: "n_2", provenance: [], createdAt: "x" });
		const reader = createGraphReader(f.graphDir);
		assert.deepEqual(reader.readNodes().map((n) => n.id), ["n_1", "n_2"]);
		assert.deepEqual(reader.readChains().map((c) => c.id), ["c2"]);
	});

	it("matches upstream's graphStore on the same files, and importing upstream deletes legacy ledgers (why we do not)", () => {
		const f = makeFixture();
		seedStandard(f);
		f.graph("nodes.jsonl", "garbage");
		f.graph("nodes.jsonl", { id: "n_x", name: "x" });
		const legacy = path.join(f.graphDir, "edges.jsonl");
		fs.writeFileSync(legacy, "legacy\n");
		const script = `
			import { graphStore } from "./src/store/graph.ts";
			process.stdout.write(JSON.stringify({ nodes: graphStore.readNodes(), chains: graphStore.readChains() }));
		`;
		const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: path.resolve(import.meta.dirname, ".."),
			env: { ...process.env, LH_DATA_DIR: f.root, NODE_ENV: "test" },
			encoding: "utf-8",
		});
		const upstream = JSON.parse(out.slice(out.indexOf("{"))) as { nodes: unknown[]; chains: unknown[] };
		const mine = createGraphReader(f.graphDir);
		assert.deepEqual(mine.readNodes(), upstream.nodes);
		assert.deepEqual(mine.readChains(), upstream.chains);
		assert.equal(fs.existsSync(legacy), false, "importing store/graph.ts purged edges.jsonl: the server must never import it");
	});
});

describe("lecture reader", () => {
	it("reads what the app's store writes, skips junk, and ignores a file under another id", () => {
		const f = makeFixture();
		const store = createLecturesStore(f.extDir);
		const a = makeLecture();
		const b = makeLecture({ id: "lec_b0123abcd_c02_l02", order: 2, title: "Second" });
		store.save(a);
		store.save(b);
		const reader = createLectureReader(f.extDir);
		assert.deepEqual(reader.list(), store.list()); // parity with the app's reader on clean data
		fs.mkdirSync(path.join(f.extDir, "lectures", "not-a-lecture-id"), { recursive: true });
		fs.mkdirSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l03"), { recursive: true });
		fs.writeFileSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l03", "lecture.json"), JSON.stringify({ ...a, id: "lec_b0123abcd_c02_l01" })); // wrong dir
		fs.mkdirSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l04"), { recursive: true });
		fs.writeFileSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l04", "lecture.json"), "{ corrupt");
		// The app's store would list the wrong-directory file as a duplicate of l01; the server does not.
		assert.deepEqual(reader.list().map((l) => l.id), [a.id, b.id]);
		assert.equal(reader.get("lec_b0123abcd_c02_l03"), null);
		assert.equal(reader.get("../../etc/passwd"), null);
		assert.equal(reader.get("lec_b0123abcd_c02_l99"), null);
	});
});

void GOAL_ID;
```

- [ ] **Step 4: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-readonly.test.ts
```

Expected: FAIL with `Cannot find module '../src/store/ext/readonly.ts'` (the fixture also needs `deps.ts`).

- [ ] **Step 5: Implement the read-only layer and the composition root**

`src/store/ext/readonly.ts`

```typescript
// src/store/ext/readonly.ts
/**
 * THE READ-ONLY DATA LAYER of the MCP server (REQ-mcp-01, REQ-mcp-02,
 * REQ-mcp-03). Deliberately NOT built on createLedger or the ext stores: those
 * modules also hold the write side (ensureExtFormat, atomic writes), and
 * upstream's store/graph.ts even deletes legacy ledgers when it is imported.
 * This file uses exactly three fs calls (statSync, readFileSync, readdirSync)
 * and a test (ext-mcp-closure) fails if anything reachable from the server
 * contains a write API. Reading rules mirror the app's: a stamp newer than
 * this build refuses, corrupt or invalid lines are skipped, a missing file is
 * empty. Added here: a size ceiling per file (bounded parse time).
 */

import fs from "node:fs";
import path from "node:path";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../core/contracts/graph.ts";
import type { GraphChain, GraphNode } from "../../core/contracts.ts";
import { NEWER_FORMAT_MESSAGE, ToolError } from "../../core/ext/mcp/errors.ts";
import { LIMITS } from "../../core/ext/mcp/limits.ts";
import type { LectureReader, ReadLog } from "../../core/ext/mcp/ports.ts";
import { isValidLectureId, parseLecture, type Lecture } from "../../core/ext/lecture/lecture.ts";
import type { GraphStore } from "../../core/ports.ts";

/** Same value as store/ext/format.ts CURRENT_EXT_FORMAT_VERSION (a test pins the equality). */
export const EXT_FORMAT_VERSION = 1;

function stampedVersion(dir: string): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, "format.json"), "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // a corrupt sidecar reads as unstamped, like the app
	}
}

/** Throws ToolError(data_newer_than_build) when either stamp is newer than this build. Never writes. */
export function createReadableGuard(dataRoot: string): () => void {
	const extDir = path.join(dataRoot, "ext");
	const graphDir = path.join(dataRoot, "graph");
	return () => {
		const ext = stampedVersion(extDir);
		const graph = stampedVersion(graphDir);
		if ((ext !== null && ext > EXT_FORMAT_VERSION) || (graph !== null && graph > CURRENT_GRAPH_FORMAT_VERSION)) {
			throw new ToolError("data_newer_than_build", NEWER_FORMAT_MESSAGE);
		}
	};
}

/** Startup check: the data directory must exist. It is never created. Throws a plain Error (stderr only). */
export function validateDataRoot(dataRoot: string): void {
	let isDir = false;
	try {
		isDir = fs.statSync(dataRoot).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) throw new Error(`data directory not found: ${dataRoot} (set LH_DATA_DIR to the app's data directory)`);
}

function readJsonl<T>(file: string, label: string, parse: (raw: unknown) => T | null, maxBytes: number): T[] {
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return [];
	}
	if (size > maxBytes) throw new ToolError("data_too_large", `${label} is larger than this server's read limit.`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			continue; // a corrupt or torn line is skipped, never repaired
		}
		let event: T | null;
		try {
			event = parse(value);
		} catch {
			continue;
		}
		if (event !== null) out.push(event);
	}
	return out;
}

/** A ledger under <dataRoot>/ext with only a read side. */
export function readOnlyLedger<T>(
	extDir: string,
	fileName: string,
	parse: (raw: unknown) => T | null,
	maxBytes: number = LIMITS.ledgerMaxBytes,
): ReadLog<T> {
	const file = path.join(extDir, fileName);
	return { readAll: () => readJsonl(file, fileName, parse, maxBytes) };
}

// ── the content graph (shape guards mirror store/graph.ts; a test pins parity) ──

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const isPoint = (v: unknown): boolean => isRecord(v) && isString(v.chatId) && isString(v.messageId);

const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isPoint);

const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isPoint) &&
	isString(v.createdAt);

export function createGraphReader(graphDir: string, maxBytes: number = LIMITS.ledgerMaxBytes): Pick<GraphStore, "readNodes" | "readChains"> {
	return {
		readNodes: () => readJsonl(path.join(graphDir, "nodes.jsonl"), "nodes.jsonl", (v) => (isGraphNode(v) ? v : null), maxBytes),
		readChains: () => readJsonl(path.join(graphDir, "chains.jsonl"), "chains.jsonl", (v) => (isGraphChain(v) ? v : null), maxBytes),
	};
}

// ── lectures (data/ext/lectures/<id>/lecture.json) ───────────────────────────

export function createLectureReader(extDir: string): LectureReader {
	const root = path.join(extDir, "lectures");
	function get(id: string): Lecture | null {
		if (!isValidLectureId(id)) return null;
		const file = path.join(root, id, "lecture.json");
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile() || stat.size > LIMITS.lectureFileMaxBytes) return null;
			const lecture = parseLecture(JSON.parse(fs.readFileSync(file, "utf-8")));
			return lecture !== null && lecture.id === id ? lecture : null; // a file under another id's directory is not that lecture
		} catch {
			return null;
		}
	}
	return {
		get,
		list() {
			let names: string[];
			try {
				names = fs.readdirSync(root);
			} catch {
				return [];
			}
			return names
				.filter(isValidLectureId)
				.sort()
				.slice(0, LIMITS.lectureFilesMax)
				.map(get)
				.filter((l): l is Lecture => l !== null);
		},
	};
}
```

`src/server/ext/mcp/deps.ts`

```typescript
// src/server/ext/mcp/deps.ts
/**
 * THE COMPOSITION ROOT of the read-only MCP server: builds McpDeps from a data
 * directory using only src/store/ext/readonly.ts. It does NOT import
 * src/server/stores.ts, src/server/ext/stores.ts, settings, keys, chats or any
 * agent code: the server cannot reach a model, a secret or a write path
 * because none of them is in its import closure (test: ext-mcp-closure).
 */

import path from "node:path";
import { parseCardEvent } from "../../../core/ext/cards.ts";
import { parseExplanationEvent } from "../../../core/ext/explanations.ts";
import { parseFrontierEvent } from "../../../core/ext/frontier.ts";
import { parseGoalEvent } from "../../../core/ext/goals.ts";
import { parseInboxEvent } from "../../../core/ext/inbox.ts";
import type { McpDeps, ReadLog } from "../../../core/ext/mcp/ports.ts";
import { parseExerciseEvent } from "../../../core/ext/practice/exercises.ts";
import { parseCycleLogEntry } from "../../../core/ext/research-log.ts";
import { parseReviewEvent } from "../../../core/ext/review.ts";
import { parseVerificationEvent } from "../../../core/ext/trust.ts";
import { createGraphReader, createLectureReader, createReadableGuard, readOnlyLedger } from "../../../store/ext/readonly.ts";

/** Every write the app's types allow is refused loudly: reaching this is a bug, never a feature. */
function refuseWrite(): never {
	throw new Error("read-only server: a write was attempted");
}

/** The app's store shape (appendEvent + readEvents) over a read-only log. */
function asStore<T>(log: ReadLog<T>): { appendEvent(event: T): void; readEvents(): T[] } {
	return { appendEvent: refuseWrite, readEvents: () => log.readAll() };
}

export function createMcpDeps(dataRoot: string, clock: () => string = () => new Date().toISOString()): McpDeps {
	const extDir = path.join(dataRoot, "ext");
	const graph = createGraphReader(path.join(dataRoot, "graph"));
	return {
		review: {
			graphStore: graph,
			goalsStore: asStore(readOnlyLedger(extDir, "goals.jsonl", parseGoalEvent)),
			reviewStore: asStore(readOnlyLedger(extDir, "review.jsonl", parseReviewEvent)),
			cardsStore: asStore(readOnlyLedger(extDir, "cards.jsonl", parseCardEvent)),
		},
		verification: readOnlyLedger(extDir, "verification.jsonl", parseVerificationEvent),
		explanations: readOnlyLedger(extDir, "explanations.jsonl", parseExplanationEvent),
		exercises: readOnlyLedger(extDir, "exercises.jsonl", parseExerciseEvent),
		frontier: readOnlyLedger(extDir, "frontier.jsonl", parseFrontierEvent),
		inbox: readOnlyLedger(extDir, "inbox.jsonl", parseInboxEvent),
		researchLog: readOnlyLedger(extDir, "research-log.jsonl", parseCycleLogEntry),
		lectures: createLectureReader(extDir),
		now: clock,
		assertReadable: createReadableGuard(dataRoot),
	};
}
```

- [ ] **Step 6: Run the tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-readonly.test.ts tests/ext-personal-layer.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp\|readonly\|local-day"
npx eslint src/store/ext/readonly.ts src/server/ext/mcp src/core/ext/mcp src/core/ext/local-day.ts tests/ext-mcp-readonly.test.ts tests/helpers/mcp-fixture.ts tests/helpers/mcp-dir-hash.ts
```

Expected: all pass (the readonly file includes a parity test that spawns a child importing `src/store/graph.ts` to prove the legacy-ledger purge is real, and one that shows the app's lecture store lists a file stored under the wrong directory while this reader skips it); no tsc or eslint findings.

- [ ] **Step 7: Commit**

```bash
git add src/core/ext/local-day.ts src/core/ext/mcp/ports.ts src/store/ext/readonly.ts src/server/ext/mcp/deps.ts src/server/ext/personal-layer.ts tests/helpers/mcp-fixture.ts tests/helpers/mcp-dir-hash.ts tests/ext-mcp-readonly.test.ts
git commit -m "feat(mcp): read-only data layer and composition root

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Knowledge tools

REQ-mcp-04, -09, -10. `search_nodes`, `get_node`, `get_neighbors`, `list_lectures`, `get_lecture`, over one consistent view per call (`openCall`: stamps checked first, one clock reading, memoised graph and event reads). The node panel is built with the app's own `buildNodePanel`, so trust, staleness and alternative arguments are the app's. Output is allow-listed field by field: card answers, local file paths, query strings and credentials in source references, exercise reference solutions and slide narration never appear.

**Files:**
- Create: `src/core/ext/mcp/call.ts`, `trust-view.ts`, `search.ts`, `node.ts`, `lectures.ts`, `tools.ts` (knowledge rows only for now)
- Create: `tests/helpers/mcp-run.ts`
- Test: `tests/ext-mcp-knowledge.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/mcp-run.ts`

```typescript
// tests/helpers/mcp-run.ts
import assert from "node:assert/strict";
import { ToolError, type ToolErrorCode } from "../../src/core/ext/mcp/errors.ts";
import { runTool } from "../../src/core/ext/mcp/tools.ts";
import type { Fixture } from "./mcp-fixture.ts";

export type Json = any;

export function call(f: Fixture, name: string, input: unknown = {}, knowledgeOnly = false): Json {
	return runTool(name, f.deps, input, { knowledgeOnly });
}

export function errorCode(f: Fixture, name: string, input: unknown = {}, knowledgeOnly = false): ToolErrorCode | "none" | "other" {
	try {
		runTool(name, f.deps, input, { knowledgeOnly });
		return "none";
	} catch (e) {
		return e instanceof ToolError ? e.code : "other";
	}
}

export function expectError(f: Fixture, name: string, input: unknown, code: ToolErrorCode, knowledgeOnly = false): void {
	assert.equal(errorCode(f, name, input, knowledgeOnly), code, `${name}(${JSON.stringify(input)})`);
}
```

`tests/ext-mcp-knowledge.test.ts`

```typescript
// tests/ext-mcp-knowledge.test.ts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, node, chain, seedGraph, seedStandard, HIDDEN } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("search_nodes (REQ-mcp-04)", () => {
	it("finds by name, statement and alias, best match first, with trust", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "search_nodes", { query: "subset" });
		assert.equal(r.query, "subset");
		assert.deepEqual(r.items.map((i: { id: string }) => i.id).sort(), [N.a, N.b, N.c].sort()); // C by its alias "Subset order"
		assert.equal(r.count, r.items.length);
		assert.equal(r.truncated, false);
		const a = r.items.find((i: { id: string }) => i.id === N.a);
		assert.deepEqual(Object.keys(a).sort(), ["id", "name", "statement", "trust"]);
		assert.equal(a.trust, "sourced");
		assert.equal(call(f, "search_nodes", { query: "Axiom" }).items[0].id, N.a);
	});

	it("is deterministic: equal scores order by id", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_2", "same"), node("n_1", "same")], []);
		assert.deepEqual(call(f, "search_nodes", { query: "same" }).items.map((i: { id: string }) => i.id), ["n_1", "n_2"]);
	});

	it("bounds the list: default 20, maximum 50, truncated flag, invalid limits mean the default", () => {
		const f = makeFixture();
		seedGraph(f, Array.from({ length: 120 }, (_, i) => node(`n_${String(i).padStart(3, "0")}`, `thing ${i}`)), []);
		const d = call(f, "search_nodes", { query: "thing" });
		assert.equal(d.count, 20);
		assert.equal(d.truncated, true);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 1_000 }).count, 50);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 3 }).count, 3);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: Number.NaN }).count, 20);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 0 }).count, 20);
		assert.equal(call(f, "search_nodes", { query: "thing 11" }).count, 11 /* thing 11, 110-119 */);
	});

	it("filters by trust and by goal scope; a no-hit search is an empty page, not an error", () => {
		const f = makeFixture();
		seedStandard(f);
		assert.deepEqual(call(f, "search_nodes", { query: "set", trust: "sourced" }).items.map((i: { id: string }) => i.id), [N.a]);
		const inGoal = call(f, "search_nodes", { query: "node", goalId: GOAL_ID });
		assert.equal(inGoal.count, 0); // the loner is outside the goal's scope
		assert.ok(call(f, "search_nodes", { query: "set", goalId: GOAL_ID }).items.length >= 3);
		assert.deepEqual(call(f, "search_nodes", { query: "zzzz-nothing" }), { query: "zzzz-nothing", items: [], count: 0, truncated: false });
	});

	it("rejects bad input: empty or oversized queries, unknown trust, unknown goal", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const query of [undefined, "", "   ", 5, "x".repeat(201), "a b c d e f g h i"]) expectError(f, "search_nodes", { query }, "invalid_input");
		expectError(f, "search_nodes", { query: "set", trust: "maybe" }, "invalid_input");
		expectError(f, "search_nodes", { query: "set", goalId: "goal_unknown" }, "not_found");
		expectError(f, "search_nodes", { query: "set", goalId: "" }, "invalid_input");
	});

	it("goalId is refused under --knowledge-only", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "search_nodes", { query: "set", goalId: GOAL_ID }, "disabled", true);
		assert.ok(call(f, "search_nodes", { query: "set" }, true).count > 0);
	});

	it("a hostile query costs no more than a plain one (no regex, bounded tokens)", () => {
		const f = makeFixture();
		seedGraph(f, Array.from({ length: 3000 }, (_, i) => node(`n_${i}`, `name ${i}`, "x".repeat(300))), []);
		const started = Date.now();
		call(f, "search_nodes", { query: "(a+)+$ ".repeat(8).trim() });
		call(f, "search_nodes", { query: "a".repeat(200) });
		assert.ok(Date.now() - started < 3000, "search took too long");
	});

	it("duplicate node lines (link-appends) are one node whose phrasing becomes an alias", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_1", "Base", "first phrasing"), node("n_1", "Other name", "second phrasing")], []);
		const r = call(f, "search_nodes", { query: "second" });
		assert.deepEqual(r.items.map((i: { id: string }) => i.id), ["n_1"]);
		assert.equal(r.items[0].name, "Base");
	});
});

describe("get_node (REQ-mcp-04, REQ-mcp-09, REQ-mcp-10)", () => {
	it("returns statement, aliases, trust with evidence, explanation, arguments, lectures, cards, review, goals", () => {
		const f = makeFixture();
		seedStandard(f);
		const a = call(f, "get_node", { id: N.a });
		assert.equal(a.name, "Axiom A");
		assert.equal(a.trust.level, "sourced");
		assert.equal(a.trust.evidence.count, 1);
		assert.equal(a.trust.evidence.items[0].source, "lib_0000000a");
		assert.equal(a.cardCount, 1);
		assert.equal(a.studyState, "enabled");
		assert.ok(typeof a.review.dueAt === "string");
		assert.ok(a.review.recallProbability >= 0 && a.review.recallProbability <= 1);
		assert.equal(a.citingLectures.items[0].lectureId, "lec_b0123abcd_c02_l01");
		assert.deepEqual(a.conclusions.items.map((c: { id: string }) => c.id), [N.c]);
		assert.equal(a.goals.items[0].id, GOAL_ID);
		assert.equal(a.goals.items[0].isTarget, false);

		const c = call(f, "get_node", { id: N.c });
		assert.deepEqual(c.aliases.items, ["Subset order"]);
		assert.equal(c.arguments.count, 2, "two concluding chains = an alternative argument");
		assert.deepEqual(c.arguments.items.map((x: { premises: { count: number } }) => x.premises.count).sort(), [1, 2]);
		assert.equal(c.explanation.state, "current");
		assert.equal(c.explanation.noSourceContext, false);
		assert.match(c.explanation.body, /Follows from/);
		assert.equal(c.review, null);
	});

	it("marks a stale explanation and one written without source context", () => {
		const f = makeFixture();
		seedStandard(f);
		const d = call(f, "get_node", { id: N.d });
		assert.equal(d.explanation.state, "stale");
		assert.equal(d.explanation.noSourceContext, true);
		assert.equal(call(f, "get_node", { id: N.a }).explanation.state, "missing");
		assert.equal(call(f, "get_node", { id: N.a }).explanation.body, null);
	});

	it("never shows local paths, URL credentials, query strings, card answers or narration", () => {
		const f = makeFixture();
		seedStandard(f);
		const b = JSON.stringify(call(f, "get_node", { id: N.b }));
		assert.match(b, /algebra\.pdf/);
		assert.ok(!b.includes(HIDDEN.localPath));
		const a = JSON.stringify(call(f, "get_node", { id: N.a }));
		for (const secret of [HIDDEN.urlToken, HIDDEN.cardAnswer, "user:pw"]) assert.ok(!a.includes(secret), secret);
	});

	it("labels sources by library id, credential-free URL, or file name", () => {
		const f = makeFixture();
		seedStandard(f);
		f.ext("verification.jsonl", {
			type: "checked", nodeId: N.lone, outcome: "unverified", checker: "t:m", at: "2026-11-05T00:00:00.000Z", discarded: [],
			evidence: [
				{ sourceRef: `https://user:pw@example.org/p/q?token=${HIDDEN.urlToken}#f`, sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "example.org" },
				{ sourceRef: "file:///Users/x/y/book.pdf", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
				{ sourceRef: "C:\\Users\\x\\scan.pdf", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
				{ sourceRef: "/", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
			],
		});
		const labels = call(f, "get_node", { id: N.lone }).trust.evidence.items.map((e: { source: string }) => e.source);
		assert.deepEqual(labels, ["https://example.org/p/q", "book.pdf", "scan.pdf", "local source"]);
	});

	it("caps long text with an explicit marker and bounds every nested list", () => {
		const f = makeFixture();
		const premises = Array.from({ length: 30 }, (_, i) => node(`n_p${i}`, `premise ${i}`));
		const nodes = [node("n_big", "Big", "s".repeat(5000), Array.from({ length: 40 }, (_, i) => `alias-${i}-${"z".repeat(300)}`)), ...premises];
		const chains = [chain("c1", premises.map((p) => p.id), "n_big"), ...Array.from({ length: 12 }, (_, i) => chain(`c_alt${i}`, [premises[i]!.id], "n_big"))];
		seedGraph(f, nodes, chains);
		const r = call(f, "get_node", { id: "n_big" });
		assert.match(r.statement, /\[truncated: \d+ more characters\]$/);
		assert.equal(r.aliases.count, 10);
		assert.equal(r.aliases.truncated, true);
		assert.match(r.aliases.items[0], /\[truncated/);
		assert.equal(r.arguments.count, 8);
		assert.equal(r.arguments.truncated, true);
		assert.equal(r.arguments.items[0].premises.count, 12);
		assert.equal(r.arguments.items[0].premises.truncated, true);
	});

	it("unknown, malformed and prototype-ish ids are a structured not-found or invalid-input, never a crash", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const id of ["n_missing", "__proto__", "constructor", "../../etc/passwd", "n_aaaa1111 "]) expectError(f, "get_node", { id }, "not_found");
		for (const id of [undefined, null, 5, "", "   ", "a\nb", "x".repeat(300)]) expectError(f, "get_node", { id }, "invalid_input");
	});

	it("--knowledge-only drops every learner-performance field", () => {
		const f = makeFixture();
		seedStandard(f);
		const a = call(f, "get_node", { id: N.a }, true);
		assert.equal(a.studyState, "disabled");
		for (const key of ["review", "cardCount", "goals", "reviewUnavailable"]) assert.equal(key in a, false, key);
		assert.equal(a.trust.level, "sourced");
	});

	it("a node in a cycle of chains still answers (cycle-safe)", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_1", "One"), node("n_2", "Two")], [chain("c1", ["n_1"], "n_2"), chain("c2", ["n_2"], "n_1")]);
		assert.equal(call(f, "get_node", { id: "n_1" }).arguments.count, 1);
		assert.equal(call(f, "get_neighbors", { id: "n_1", depth: 2 }).nodes.count, 2);
	});

	it("a layered diamond graph does not blow up (bounded time)", () => {
		const f = makeFixture();
		const nodes = [] as ReturnType<typeof node>[];
		const chains = [] as ReturnType<typeof chain>[];
		for (let layer = 0; layer < 25; layer++) for (const side of ["l", "r"]) nodes.push(node(`n_${layer}${side}`, `n ${layer}${side}`));
		for (let layer = 1; layer < 25; layer++) for (const side of ["l", "r"]) chains.push(chain(`c${layer}${side}`, [`n_${layer - 1}l`, `n_${layer - 1}r`], `n_${layer}${side}`));
		seedGraph(f, nodes, chains);
		const started = Date.now();
		call(f, "get_node", { id: "n_24l" });
		assert.ok(Date.now() - started < 3000);
	});
});

describe("get_neighbors", () => {
	it("returns depth-1 or depth-2 neighbourhoods with names, trust and edges between included nodes", () => {
		const f = makeFixture();
		seedStandard(f);
		const one = call(f, "get_neighbors", { id: N.c });
		assert.equal(one.depth, 1);
		assert.equal(one.center.id, N.c);
		assert.deepEqual(one.nodes.items.map((n: { id: string }) => n.id), [N.c, N.a, N.b, N.d]);
		assert.deepEqual(one.nodes.items.map((n: { depth: number }) => n.depth), [0, 1, 1, 1]);
		assert.equal(one.edges.count, 3);
		const two = call(f, "get_neighbors", { id: N.d, depth: 2 });
		assert.deepEqual(two.nodes.items.map((n: { id: string }) => n.id), [N.d, N.c, N.a, N.b]);
		assert.equal(call(f, "get_neighbors", { id: N.lone }).nodes.count, 1);
	});

	it("rejects depth 0, 3, fractions and strings; unknown id is not-found", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const depth of [0, 3, 1.5, "1", null]) expectError(f, "get_neighbors", { id: N.a, depth }, "invalid_input");
		expectError(f, "get_neighbors", { id: "n_missing" }, "not_found");
	});

	it("bounds nodes and edges of a hub", () => {
		const f = makeFixture();
		const spokes = Array.from({ length: 200 }, (_, i) => node(`n_s${String(i).padStart(3, "0")}`, `s${i}`));
		seedGraph(f, [node("n_hub", "Hub"), ...spokes], spokes.map((s, i) => chain(`c${i}`, [s.id], "n_hub")));
		const r = call(f, "get_neighbors", { id: "n_hub", depth: 2 });
		assert.equal(r.nodes.count, 60);
		assert.equal(r.nodes.truncated, true);
		assert.equal(r.edges.count, 59);
		assert.equal(r.edges.truncated, false);
	});
});

describe("lectures (REQ-mcp-04)", () => {
	it("list_lectures gives the outline summary and can filter by chapter", () => {
		const f = makeFixture();
		seedStandard(f);
		const all = call(f, "list_lectures");
		assert.equal(all.count, 1);
		assert.deepEqual(all.items[0], {
			id: "lec_b0123abcd_c02_l01", title: "Sigma algebras", bookTitle: "Probability 1",
			chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 }, order: 1, createdAt: "2026-11-04T10:00:00.000Z",
			slideCount: 2, exerciseCount: 1, citedNodeCount: 2,
		});
		assert.equal(call(f, "list_lectures", { chapter: 2 }).count, 1);
		assert.equal(call(f, "list_lectures", { chapter: 3 }).count, 0);
		for (const chapter of [0, -1, 1.5, "2", null]) expectError(f, "list_lectures", { chapter }, "invalid_input");
	});

	it("get_lecture returns headings, node references and timed exercises, never the narration", () => {
		const f = makeFixture();
		seedStandard(f);
		const l = call(f, "get_lecture", { id: "lec_b0123abcd_c02_l01" });
		assert.deepEqual(l.slides.items.map((s: { heading: string }) => s.heading), ["Sigma algebra", "Looking ahead"]);
		assert.deepEqual(l.slides.items[0].nodeIds.items, [N.a]);
		assert.equal(l.exercises.items[0].seconds, 60);
		assert.match(l.exercises.items[0].prompt, /three element set/);
		assert.deepEqual(l.citedNodes.items.sort(), [N.a, N.b].sort());
		const text = JSON.stringify(l);
		assert.ok(!text.includes(HIDDEN.narration));
		assert.ok(!text.includes(HIDDEN.reveal));
	});

	it("get_lecture: malformed ids (including path traversal) are invalid input; an unknown id is not-found", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const id of ["../../ext/goals", "lec_x", "..", "lec_b0123abcd_c02_l01/../../x", "", undefined, 5]) expectError(f, "get_lecture", { id }, "invalid_input");
		expectError(f, "get_lecture", { id: "lec_b0123abcd_c09_l09" }, "not_found");
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-knowledge.test.ts
```

Expected: FAIL with `Cannot find module '../src/core/ext/mcp/tools.ts'`.

- [ ] **Step 3: Implement**

`src/core/ext/mcp/call.ts`

```typescript
// src/core/ext/mcp/call.ts
/**
 * One tool call's consistent view of the data. Every ledger is read at most
 * once per call and `now` is fixed, so a tool never mixes two instants or two
 * versions of the files while the app appends (REQ-mcp-03 risk: torn reads are
 * skipped line by line; a changed file between two reads cannot split a call).
 */

import type { GraphChain, GraphNode } from "../../contracts.ts";
import type { GraphStore } from "../../ports.ts";
import type { ReviewDeps } from "../review-service.ts";
import { snapshot, type Snapshot } from "../review-service.ts";
import { ToolError } from "./errors.ts";
import type { McpDeps } from "./ports.ts";

export interface Call {
	deps: McpDeps;
	now: string;
	/** The graph, read once. */
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	/** The app's own ReviewDeps over the same single reads and the fixed `now`. */
	review: ReviewDeps;
}

function memo<T>(read: () => T): () => T {
	let done = false;
	let value: T | undefined;
	return () => {
		if (!done) {
			value = read();
			done = true;
		}
		return value as T;
	};
}

export function openCall(deps: McpDeps): Call {
	deps.assertReadable();
	const now = deps.now();
	const graph: Pick<GraphStore, "readNodes" | "readChains"> = {
		readNodes: memo((): GraphNode[] => deps.review.graphStore.readNodes()),
		readChains: memo((): GraphChain[] => deps.review.graphStore.readChains()),
	};
	const r = deps.review;
	return {
		deps,
		now,
		graph,
		review: {
			...r,
			graphStore: graph,
			goalsStore: { ...r.goalsStore, readEvents: memo(() => r.goalsStore.readEvents()) },
			reviewStore: { ...r.reviewStore, readEvents: memo(() => r.reviewStore.readEvents()) },
			cardsStore: { ...r.cardsStore, readEvents: memo(() => r.cardsStore.readEvents()) },
			now: () => now,
		},
	};
}

/**
 * Runs a replay of the review history. Any failure becomes a fixed-text
 * data_inconsistent error: the raw exception, which may carry paths or ids,
 * never leaves the server.
 */
export function guardReplay<T>(replay: () => T): T {
	try {
		return replay();
	} catch (error) {
		if (error instanceof ToolError) throw error;
		throw new ToolError("data_inconsistent", "The review history could not be replayed; study-state tools are unavailable until it is repaired.");
	}
}

export function snapshotOf(call: Call): Snapshot {
	return guardReplay(() => snapshot(call.review, call.now));
}
```

`src/core/ext/mcp/trust-view.ts`

```typescript
// src/core/ext/mcp/trust-view.ts
/**
 * Trust as the server shows it. Evidence is mapped field by field (an
 * allow-list): the snapshot hash is omitted, a source is named by its library
 * id, its http(s) URL without credentials, query or fragment, or, for a local
 * PDF, its file name only. An absolute path never leaves the server.
 */

import { capText, LIMITS, page, type Page } from "./limits.ts";
import { deriveTrustMap, type Evidence, type TrustLevel } from "../trust.ts";
import type { VerificationEvent } from "../trust.ts";

export const TRUST_LEVELS: readonly TrustLevel[] = ["unverified", "sourced", "contested", "refuted"];

export function trustLevels(events: readonly VerificationEvent[]): Map<string, { level: TrustLevel; at: string; evidence: Evidence[] }> {
	return deriveTrustMap(events);
}

export function sourceLabel(ev: Pick<Evidence, "sourceRef" | "sourceId">): string {
	if (ev.sourceId !== null && ev.sourceId !== "") return capText(ev.sourceId, 80);
	try {
		const url = new URL(ev.sourceRef);
		if (url.protocol === "http:" || url.protocol === "https:") return capText(`${url.origin}${url.pathname}`, 200);
	} catch {
		// not a URL: fall through to the file-name rule
	}
	const base = ev.sourceRef.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
	return capText(base === "" ? "local source" : base, 80);
}

export interface EvidenceView {
	source: string;
	host: string;
	tier: Evidence["tier"];
	stance: Evidence["stance"];
	locator: string;
	quote: string;
	author?: string;
}

export function evidencePage(evidence: readonly Evidence[]): Page<EvidenceView> {
	const p = page(evidence, LIMITS.evidenceMax);
	return {
		...p,
		items: p.items.map((e) => ({
			source: sourceLabel(e),
			host: capText(e.host, 100),
			tier: e.tier,
			stance: e.stance,
			locator: capText(e.locator, LIMITS.locatorChars),
			quote: capText(e.quote, LIMITS.quoteChars),
			...(e.author !== undefined ? { author: capText(e.author, 100) } : {}),
		})),
	};
}
```

`src/core/ext/mcp/search.ts`

```typescript
// src/core/ext/mcp/search.ts
/** search_nodes (REQ-mcp-04): upstream's fuzzy scoring over name, statement and aliases. */

import { fuzzyScore } from "../../fuzzy.ts";
import { getGraph } from "../../graph.ts";
import { deriveGoals, goalScope } from "../goals.ts";
import type { Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { compareCodeUnits, optionalEnum, requireId, requireQuery } from "./input.ts";
import { capText, clampLimit, LIMITS, page } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { TRUST_LEVELS, trustLevels } from "./trust-view.ts";

export function searchNodes(call: Call, input: Record<string, unknown>, opts: RunOptions) {
	const query = requireQuery(input.query);
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const trust = optionalEnum(input.trust, TRUST_LEVELS, "trust");
	const goalId = input.goalId === undefined ? undefined : requireId(input.goalId, "goalId");
	if (goalId !== undefined && opts.knowledgeOnly) {
		throw new ToolError("disabled", "Filtering by goal needs study state, which is disabled (--knowledge-only).");
	}

	const { nodes, chains } = getGraph(call.graph);
	let scope: Set<string> | null = null;
	if (goalId !== undefined) {
		const goal = deriveGoals(call.review.goalsStore.readEvents()).find((g) => g.id === goalId);
		if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(goalId, 60)}".`);
		scope = new Set(goalScope(goal.targetNodeIds, chains));
	}

	const levels = trustLevels(call.deps.verification.readAll());
	const hits: Array<{ id: string; name: string; statement: string; score: number; level: string }> = [];
	for (const node of nodes) {
		if (scope !== null && !scope.has(node.id)) continue;
		const level = levels.get(node.id)?.level ?? "unverified";
		if (trust !== undefined && level !== trust) continue;
		const score = fuzzyScore(query, node.name, node.statement, ...node.aliases);
		if (score === null) continue;
		hits.push({ id: node.id, name: node.name, statement: node.statement, score, level });
	}
	hits.sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));

	const p = page(hits, limit);
	return {
		query,
		...p,
		items: p.items.map((h) => ({
			id: h.id,
			name: capText(h.name, LIMITS.nameChars),
			statement: capText(h.statement, LIMITS.listStatementChars),
			trust: h.level,
		})),
	};
}
```

`src/core/ext/mcp/node.ts`

```typescript
// src/core/ext/mcp/node.ts
/**
 * get_node and get_neighbors (REQ-mcp-04, REQ-mcp-09, REQ-mcp-10). get_node is
 * the app's own buildNodePanel (the panel the learner sees) mapped field by
 * field to a bounded, allow-listed shape.
 */

import { getGraph } from "../../graph.ts";
import { deriveCards } from "../cards.ts";
import { citingLectures } from "../lecture/lecture-graph.ts";
import { neighbourhood } from "../neighbourhood.ts";
import { buildNodePanel } from "../node-panel.ts";
import { snapshot } from "../review-service.ts";
import type { Call } from "./call.ts";
import { ToolError } from "./errors.ts";
import { parseDepth, requireId } from "./input.ts";
import { capText, LIMITS, page, round4, textPage } from "./limits.ts";
import type { RunOptions } from "./ports.ts";
import { evidencePage, trustLevels } from "./trust-view.ts";

const notFoundNode = (id: string): ToolError => new ToolError("not_found", `No node with id "${capText(id, 60)}".`);

export function getNode(call: Call, input: Record<string, unknown>, opts: RunOptions) {
	const id = requireId(input.id, "id");
	const levels = trustLevels(call.deps.verification.readAll());
	const trust = levels.get(id);
	const lectures = call.deps.lectures.list();

	const panel = buildNodePanel(id, {
		graph: call.graph,
		explanationEvents: call.deps.explanations.readAll(),
		goalEvents: call.review.goalsStore.readEvents(),
		sources: {},
		costAllowed: true,
		availableActions: [],
	});
	if (panel === null) throw notFoundNode(id);

	const ref = (r: { id: string; name: string }) => ({ id: r.id, name: capText(r.name, LIMITS.nameChars) });
	const ex = panel.explanation;
	const conclusions = new Map<string, { id: string; name: string }>();
	for (const u of panel.usedAsPremise) if (!conclusions.has(u.conclusion.id)) conclusions.set(u.conclusion.id, u.conclusion);

	const base = {
		id: panel.node.id,
		name: capText(panel.node.name, LIMITS.nameChars),
		statement: capText(panel.node.statement, LIMITS.statementChars),
		aliases: textPage(panel.node.aliases, LIMITS.aliasesMax, LIMITS.nameChars),
		trust: { level: trust?.level ?? "unverified", checkedAt: trust?.at ?? null, evidence: evidencePage(trust?.evidence ?? []) },
		explanation: {
			state: ex.state,
			noSourceContext: ex.current?.noSource ?? false,
			form: ex.form,
			version: ex.current?.version ?? null,
			author: ex.current?.author ?? null,
			body: ex.current === null ? null : capText(ex.current.body, LIMITS.explanationChars),
			pendingProposal: ex.proposal !== null,
		},
		// One entry per chain concluding the node; more than one means alternative arguments.
		arguments: (() => {
			const p = page(panel.concluding, LIMITS.argumentsMax);
			return { ...p, items: p.items.map((c) => ({ premises: page(c.premises.map(ref), LIMITS.premisesPerArgumentMax) })) };
		})(),
		conclusions: page([...conclusions.values()].map(ref), LIMITS.conclusionsMax),
		citingLectures: (() => {
			const p = page(citingLectures(id, lectures), LIMITS.citingLecturesMax);
			return { ...p, items: p.items.map((l) => ({ lectureId: l.id, title: capText(l.title, LIMITS.titleChars) })) };
		})(),
	};
	if (opts.knowledgeOnly) return { ...base, studyState: "disabled" as const };

	const cards = deriveCards(call.review.cardsStore.readEvents()).filter((c) => c.nodeId === id && c.status === "active");
	let review: {
		dueAt: string | null;
		recallProbability: number | null;
		reps: number;
		pinned: boolean;
		retired: boolean;
	} | null = null;
	let reviewUnavailable = false;
	try {
		const snap = snapshot(call.review, call.now);
		const state = snap.states.get(id);
		const pinned = snap.marks.pinned.has(id);
		const retired = snap.marks.retired.has(id);
		if (state !== undefined || pinned || retired) {
			const due = state?.card.due.getTime();
			review = {
				dueAt: due !== undefined && Number.isFinite(due) ? new Date(due).toISOString() : null,
				recallProbability: state === undefined ? null : round4(snap.recall(id)),
				reps: state?.card.reps ?? 0,
				pinned,
				retired,
			};
		}
	} catch {
		reviewUnavailable = true; // knowledge stays readable when the review history cannot be replayed
	}
	const goals = page(panel.goals, LIMITS.goalsPerNodeMax);
	return {
		...base,
		studyState: "enabled" as const,
		cardCount: cards.length,
		review,
		reviewUnavailable,
		goals: { ...goals, items: goals.items.map((g) => ({ id: g.id, title: capText(g.title, LIMITS.titleChars), status: g.status, isTarget: g.isTarget })) },
	};
}

export function getNeighbors(call: Call, input: Record<string, unknown>) {
	const id = requireId(input.id, "id");
	const depth = parseDepth(input.depth);
	const { nodes, chains } = getGraph(call.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	if (!byId.has(id)) throw notFoundNode(id);
	const levels = trustLevels(call.deps.verification.readAll());
	const hood = neighbourhood(id, chains, depth);

	const nodePage = page(hood.nodes, LIMITS.neighbourNodesMax);
	const kept = new Set(nodePage.items.map((n) => n.id));
	const edgePage = page(
		hood.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
		LIMITS.neighbourEdgesMax,
	);
	return {
		center: { id, name: capText(byId.get(id)!.name, LIMITS.nameChars) },
		depth,
		nodes: {
			...nodePage,
			items: nodePage.items.map((n) => ({
				id: n.id,
				name: capText(byId.get(n.id)?.name ?? n.id, LIMITS.nameChars),
				depth: n.depth,
				trust: levels.get(n.id)?.level ?? "unverified",
			})),
		},
		edges: edgePage,
	};
}
```

`src/core/ext/mcp/lectures.ts`

```typescript
// src/core/ext/mcp/lectures.ts
/**
 * list_lectures and get_lecture (REQ-mcp-04). A lecture is shown as an outline:
 * headings, the nodes each slide covers, and the timed exercises. The narration
 * (narrate, note and reveal blocks) is never returned (spec: slides' narration
 * text is omitted); the exercise prompt is, capped.
 */

import { isValidLectureId, lectureNodeRefs, type Lecture } from "../lecture/lecture.ts";
import type { Call } from "./call.ts";
import { ToolError, invalid } from "./errors.ts";
import { optionalInt, requireText } from "./input.ts";
import { capText, LIMITS, page, textPage } from "./limits.ts";

export function listLectures(call: Call, input: Record<string, unknown>) {
	const chapter = optionalInt(input.chapter, "chapter", 1, 100_000);
	const all = call.deps.lectures
		.list()
		.filter((l) => chapter === undefined || l.chapter.index === chapter)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const p = page(all, LIMITS.lecturesMax);
	return {
		...p,
		items: p.items.map((l) => ({
			id: l.id,
			title: capText(l.title, LIMITS.titleChars),
			bookTitle: capText(l.bookTitle, LIMITS.titleChars),
			chapter: { index: l.chapter.index, title: capText(l.chapter.title, LIMITS.titleChars), pageStart: l.chapter.pageStart, pageEnd: l.chapter.pageEnd },
			order: l.order,
			createdAt: l.createdAt,
			slideCount: l.slides.length,
			exerciseCount: l.blocks.filter((b) => b.role === "exercise").length,
			citedNodeCount: lectureNodeRefs(l).length,
		})),
	};
}

function outline(l: Lecture) {
	const slides = page(
		l.slides.map((s) => {
			const blocks = l.blocks.filter((b) => b.slideId === s.id);
			const ids = [...new Set(blocks.flatMap((b) => b.nodeIds))];
			return { id: s.id, heading: capText(s.heading, LIMITS.titleChars), blockCount: blocks.length, nodeIds: textPage(ids, LIMITS.slideNodesMax, LIMITS.idMaxChars) };
		}),
		LIMITS.slidesMax,
	);
	const exercises = page(
		l.blocks
			.filter((b) => b.role === "exercise")
			.map((b) => ({
				blockId: b.id,
				slideId: b.slideId,
				seconds: b.seconds ?? 0,
				prompt: capText(b.text, LIMITS.promptChars),
				nodeIds: textPage(b.nodeIds, LIMITS.slideNodesMax, LIMITS.idMaxChars),
			})),
		LIMITS.exercisesMax,
	);
	return {
		id: l.id,
		title: capText(l.title, LIMITS.titleChars),
		bookTitle: capText(l.bookTitle, LIMITS.titleChars),
		chapter: { index: l.chapter.index, title: capText(l.chapter.title, LIMITS.titleChars), pageStart: l.chapter.pageStart, pageEnd: l.chapter.pageEnd },
		order: l.order,
		summary: capText(l.summary, LIMITS.summaryChars),
		createdAt: l.createdAt,
		slides,
		exercises,
		citedNodes: textPage(lectureNodeRefs(l), LIMITS.citedNodesMax, LIMITS.idMaxChars),
	};
}

export function getLecture(call: Call, input: Record<string, unknown>) {
	const id = requireText(input.id, "id", LIMITS.idMaxChars);
	if (!isValidLectureId(id)) throw invalid("id is not a lecture id (expected lec_b<8 hex>_c<NN>_l<NN>).");
	const lecture = call.deps.lectures.get(id);
	if (lecture === null) throw new ToolError("not_found", `No lecture with id "${id}".`);
	return outline(lecture);
}
```

The dispatcher, with the knowledge group only (the study rows arrive in Task 5):

`src/core/ext/mcp/tools.ts`

```typescript
// src/core/ext/mcp/tools.ts
/**
 * The tool table and its dispatcher. runTool is the single entry the server
 * calls; it is also the core's own gatekeeper, independent of the SDK layer:
 *   1. an unknown tool name (including inherited names such as "constructor")
 *      is refused;
 *   2. the format stamps are checked FIRST, so a newer stamp answers every tool
 *      with the same clear error (REQ-mcp-03);
 *   3. the study group is refused under --knowledge-only (REQ-mcp-06);
 *   4. the arguments must be a plain object holding only the tool's declared
 *      fields: an unknown field is refused, never ignored, so a write-shaped
 *      request (`{"id": "n_1", "delete": true}`) cannot slip through.
 */

import { openCall, type Call } from "./call.ts";
import { ToolError, invalid } from "./errors.ts";
import { plainObject } from "./input.ts";
import { getLecture, listLectures } from "./lectures.ts";
import { capText } from "./limits.ts";
import { getNeighbors, getNode } from "./node.ts";
import type { McpDeps, RunOptions } from "./ports.ts";
import { searchNodes } from "./search.ts";

export type ToolGroup = "knowledge" | "study";

interface Handler {
	group: ToolGroup;
	/** The only argument names the tool accepts (a test pins them to the zod schemas of the catalog). */
	fields: readonly string[];
	run(call: Call, input: Record<string, unknown>, opts: RunOptions): unknown;
}

const HANDLERS: Record<string, Handler> = {
	search_nodes: { group: "knowledge", fields: ["query", "limit", "trust", "goalId"], run: searchNodes },
	get_node: { group: "knowledge", fields: ["id"], run: getNode },
	get_neighbors: { group: "knowledge", fields: ["id", "depth"], run: (c, i) => getNeighbors(c, i) },
	list_lectures: { group: "knowledge", fields: ["chapter"], run: (c, i) => listLectures(c, i) },
	get_lecture: { group: "knowledge", fields: ["id"], run: (c, i) => getLecture(c, i) },
};

export const TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(HANDLERS));

export function toolGroup(name: string): ToolGroup | null {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.group : null;
}

export function toolFields(name: string): readonly string[] {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.fields : [];
}

export function runTool(name: string, deps: McpDeps, input: unknown, opts: RunOptions): unknown {
	if (!Object.hasOwn(HANDLERS, name)) throw new ToolError("not_found", `Unknown tool "${capText(name, 60)}".`);
	const handler = HANDLERS[name]!;
	const call = openCall(deps); // stamps first
	if (opts.knowledgeOnly && handler.group === "study") {
		throw new ToolError("disabled", "Study-state tools are disabled (--knowledge-only).");
	}
	const args = plainObject(input);
	for (const key of Object.keys(args)) {
		if (!handler.fields.includes(key)) {
			const accepted = handler.fields.length === 0 ? "no arguments" : handler.fields.join(", ");
			throw invalid(`Unknown argument "${capText(key, 40)}". This server is read-only; ${name} accepts: ${accepted}.`);
		}
	}
	return handler.run(call, args, opts);
}
```

- [ ] **Step 4: Run the tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-knowledge.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/core/ext/mcp tests/ext-mcp-knowledge.test.ts tests/helpers/mcp-run.ts
```

Expected: all pass (23 tests); no tsc or eslint findings. If a `HIDDEN_*` assertion fails, an output field leaks: fix the allow-list, never the test.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/mcp/call.ts src/core/ext/mcp/trust-view.ts src/core/ext/mcp/search.ts src/core/ext/mcp/node.ts src/core/ext/mcp/lectures.ts src/core/ext/mcp/tools.ts tests/helpers/mcp-run.ts tests/ext-mcp-knowledge.test.ts
git commit -m "feat(mcp): knowledge tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Study-state tools

REQ-mcp-05, -06, -07, -10. `list_goals`, `get_goal`, `get_daily_plan`, `research_status`. The plan numbers come from the app's `computePlan` over the same deck, review history and default parameters; the test recomputes them with the app's function and compares field by field. A review history that cannot be replayed becomes a fixed `data_inconsistent` error (the next call still works), while `get_node` keeps serving knowledge with `reviewUnavailable: true`. Research output is allow-listed: no source locator, rationale, error text or steering message.

**Files:**
- Create: `src/core/ext/mcp/goals.ts`, `plan.ts`, `research.ts`
- Modify: `src/core/ext/mcp/tools.ts` (add the study rows)
- Test: `tests/ext-mcp-study.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/ext-mcp-study.test.ts`

```typescript
// tests/ext-mcp-study.test.ts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { startOfLocalDay } from "../src/core/ext/local-day.ts";
import { openCall } from "../src/core/ext/mcp/call.ts";
import { computePlan } from "../src/core/ext/review-queries.ts";
import { cleanupAllFixtures, GOAL_ID, HIDDEN, makeFixture, N, NOW, seedGraph, seedStandard } from "./helpers/mcp-fixture.ts";
import { call, errorCode, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const goalEvent = (targets: string[]) => ({
	type: "created", goalId: GOAL_ID, title: "Ready goal", origin: "user", originRef: "", targetNodeIds: targets, priority: 3, at: "2026-11-01T00:00:00.000Z",
});

describe("list_goals and get_goal (REQ-mcp-05)", () => {
	it("lists goals with scope size and the share of solid nodes, without the origin reference", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "list_goals");
		assert.equal(r.count, 1);
		assert.equal(r.truncated, false);
		const g = r.items[0];
		assert.equal(g.id, GOAL_ID);
		assert.equal(g.scopeSize, 4);
		assert.equal(g.targetCount, 1);
		assert.equal(g.solidShare, 0.25, "node A was reviewed and is the only solid one");
		assert.ok(!JSON.stringify(r).includes(HIDDEN.originRef));
	});

	it("filters by status; an unknown status is invalid input", () => {
		const f = makeFixture();
		seedStandard(f);
		assert.equal(call(f, "list_goals", { status: "active" }).count, 1);
		assert.equal(call(f, "list_goals", { status: "paused" }).count, 0);
		expectError(f, "list_goals", { status: "done" }, "invalid_input");
		expectError(f, "list_goals", { status: 3 }, "invalid_input");
	});

	it("get_goal: scope summary, due counts, targets and the exercise set state, without reference solutions", () => {
		const f = makeFixture();
		seedStandard(f);
		const g = call(f, "get_goal", { id: GOAL_ID });
		assert.equal(g.title, "Learn set order");
		assert.equal(g.scope.size, 4);
		assert.equal(g.due.dueNow + g.due.unseen + g.due.scheduled, 4);
		assert.equal(g.due.unseen, 2);
		assert.equal(g.targets.items[0].id, N.d);
		assert.deepEqual(g.exerciseSet, { state: "complete", exercises: 1, graded: 1 });
		const text = JSON.stringify(g);
		for (const secret of [HIDDEN.reference, HIDDEN.originRef]) assert.ok(!text.includes(secret));
	});

	it("exercise set states: none, complete, applied; the newest set wins; a graded event of an unknown set is ignored", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent([N.d]));
		assert.deepEqual(call(f, "get_goal", { id: GOAL_ID }).exerciseSet, { state: "none" });
		const ex = { id: "ex_1", prompt: "p", nodeIds: [N.a, N.c], steps: [{ id: "s1", text: "step", nodeIds: [N.a] }] };
		f.ext("exercises.jsonl", { type: "set_created", setId: "old", goalId: GOAL_ID, exercises: [ex], at: "2026-11-01T10:00:00.000Z" });
		f.ext("exercises.jsonl", { type: "graded", setId: "old", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [], lowConfidence: false, at: "2026-11-01T11:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "complete");
		f.ext("exercises.jsonl", { type: "applied", setId: "old", reached: false, at: "2026-11-01T12:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "applied");
		f.ext("exercises.jsonl", { type: "set_created", setId: "new", goalId: GOAL_ID, exercises: [ex], at: "2026-11-02T10:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "in_progress");
		f.ext("exercises.jsonl", { type: "graded", setId: "ghost", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [], lowConfidence: false, at: "2026-11-02T11:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "in_progress");
	});

	it("unknown or malformed goal ids", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "get_goal", { id: "goal_nope" }, "not_found");
		for (const id of [undefined, "", 7, "a\nb", null, {}]) expectError(f, "get_goal", { id }, "invalid_input");
	});

	it("a target that no longer exists does not crash and counts as the app counts it", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent(["n_deleted"]));
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).scope.size, 1, "the app counts the target itself in the scope");
		assert.equal(call(f, "list_goals").items[0].solidShare, 0);
	});

	it("study tools are disabled under --knowledge-only", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "list_goals", {}, "disabled", true);
		expectError(f, "get_goal", { id: GOAL_ID }, "disabled", true);
		expectError(f, "get_daily_plan", {}, "disabled", true);
		expectError(f, "research_status", {}, "disabled", true);
	});
});

describe("get_daily_plan (REQ-mcp-05, REQ-mcp-07)", () => {
	it("gives the same numbers as the app's computePlan for the same data, time and defaults", () => {
		const f = makeFixture();
		seedStandard(f);
		const plan = call(f, "get_daily_plan");
		const open = openCall(f.deps);
		const { plan: app } = computePlan({ ...open.review, now: () => NOW }, startOfLocalDay(new Date(NOW)));
		assert.equal(plan.due.total, app.due);
		assert.equal(plan.capacity, app.capacity);
		assert.equal(plan.newCardQuota, app.newQuota);
		assert.equal(plan.deferred, app.deferred.length);
		assert.equal(plan.needsCard, app.needsCard.length);
		assert.equal(plan.planned.total, app.items.length);
		assert.equal(plan.remainingMinutes, Math.round((app.remainingSec / 60) * 10) / 10);
		assert.equal(plan.budgetMinutes, 25);
	});

	it("an empty learner yields an empty plan, not an error", () => {
		const f = makeFixture();
		const p = call(f, "get_daily_plan");
		assert.equal(p.planned.total, 0);
		assert.equal(p.exerciseSetPending, false);
		assert.equal(p.pendingGoals.count, 0);
	});

	it("date: today is the default; a future date plans that day; past, far-future and non-dates are refused", () => {
		const f = makeFixture();
		seedStandard(f);
		const today = call(f, "get_daily_plan");
		assert.deepEqual(call(f, "get_daily_plan", { date: today.date }), today);
		const t = new Date(NOW);
		t.setDate(t.getDate() + 1);
		const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
		const future = call(f, "get_daily_plan", { date: iso });
		assert.equal(future.date, iso);
		assert.equal(future.spentMinutes, 0);
		assert.ok(future.due.total >= today.due.total);
		expectError(f, "get_daily_plan", { date: "2020-01-01" }, "invalid_input");
		expectError(f, "get_daily_plan", { date: "2099-01-01" }, "invalid_input");
		for (const date of ["2026-02-30", "tomorrow", "2026-11-4", 20261104, null, ""]) expectError(f, "get_daily_plan", { date }, "invalid_input");
	});

	it("exerciseSetPending: a goal that is solid and has no applied set is pending", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent([N.lone]));
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, false, "nothing reviewed yet: not ready");
		for (const at of ["2026-11-04T08:00:00.000Z", "2026-11-04T08:10:00.000Z", "2026-11-04T08:20:00.000Z"]) {
			f.ext("review.jsonl", { type: "review", nodeId: N.lone, channel: "fixed", rating: 4, durationSec: 10, at });
		}
		const p = call(f, "get_daily_plan");
		assert.equal(p.exerciseSetPending, true);
		assert.equal(p.pendingGoals.items[0].id, GOAL_ID);
		f.ext("exercises.jsonl", { type: "set_created", setId: "s", goalId: GOAL_ID, exercises: [{ id: "e", prompt: "p", nodeIds: [N.lone], steps: [{ id: "s1", text: "t", nodeIds: [N.lone] }] }], at: "2026-11-04T09:00:00.000Z" });
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, true, "a set that is not applied is still pending");
		f.ext("exercises.jsonl", { type: "applied", setId: "s", reached: true, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, false);
	});

	it("an unreplayable review history is a fixed-text data_inconsistent error and the next call still works", () => {
		const f = makeFixture();
		seedStandard(f);
		let broken = true;
		const real = f.deps.review.reviewStore.readEvents;
		f.deps.review.reviewStore.readEvents = () => {
			if (broken) throw new Error("/Users/secret/ext/review.jsonl exploded");
			return real();
		};
		for (const [tool, input] of [["get_daily_plan", {}], ["list_goals", {}], ["get_goal", { id: GOAL_ID }]] as const) {
			assert.equal(errorCode(f, tool, input), "data_inconsistent", tool);
		}
		assert.equal(call(f, "get_node", { id: N.a }).reviewUnavailable, true);
		broken = false;
		assert.equal(errorCode(f, "get_daily_plan"), "none");
	});
});

describe("research_status (REQ-mcp-05)", () => {
	it("summarises marks, inbox size and the last cycle without locators, rationale, errors or steering text", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "research_status");
		assert.deepEqual(r.frontier.items[0], {
			id: "mark_1", scope: { kind: "goal", id: GOAL_ID }, mark: "expand", maxDepth: 2, budgetUsd: 1.5,
			note: "grow the set theory area", author: "user", at: "2026-11-03T12:00:00.000Z",
		});
		assert.deepEqual(r.inbox, { pending: 1, approved: 0, rejected: 1, activated: 0, total: 2 });
		assert.equal(r.lastCycle.cycleId, "cyc_1");
		assert.equal(r.lastCycle.gaps, 1);
		assert.equal(r.lastCycle.nodesAdded, 2);
		assert.deepEqual(r.lastCycle.watch, { entries: 1, items: 3, ingested: 1, inbox: 2 });
		const text = JSON.stringify(r);
		for (const secret of [HIDDEN.locator, HIDDEN.researchError, HIDDEN.steer, HIDDEN.rationale]) assert.ok(!text.includes(secret), secret);
	});

	it("nothing yet: empty marks, zero inbox, no cycle", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "research_status"), {
			frontier: { items: [], count: 0, truncated: false },
			inbox: { pending: 0, approved: 0, rejected: 0, activated: 0, total: 0 },
			lastCycle: null,
		});
	});

	it("marks are bounded and the newest comes first", () => {
		const f = makeFixture();
		for (let i = 0; i < 30; i++) {
			f.ext("frontier.jsonl", { type: "set", markId: `m${i}`, scope: { kind: "node", id: N.a }, mark: "hold", note: "n", author: "agent", at: `2026-11-04T00:${String(i).padStart(2, "0")}:00.000Z` });
		}
		const r = call(f, "research_status");
		assert.equal(r.frontier.truncated, true);
		assert.ok(r.frontier.items.length <= 20);
		assert.equal(r.frontier.items[0].id, "m29");
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-study.test.ts
```

Expected: FAIL: `list_goals`, `get_goal`, `get_daily_plan` and `research_status` are answered with `not_found` (unknown tool).

- [ ] **Step 3: Implement**

`src/core/ext/mcp/goals.ts`

```typescript
// src/core/ext/mcp/goals.ts
/** list_goals and get_goal (REQ-mcp-05). Scope, readiness and deck rules are the app's own functions. */

import { getGraph } from "../../graph.ts";
import { goalReadiness } from "../deck.ts";
import { DEFAULT_RETENTION } from "../fsrs.ts";
import { deriveGoals, goalScope, type Goal } from "../goals.ts";
import { deriveExerciseSets, setComplete, type ExerciseSetState } from "../practice/exercises.ts";
import type { Call } from "./call.ts";
import { snapshotOf } from "./call.ts";
import { ToolError } from "./errors.ts";
import { instantMs, optionalEnum, requireId } from "./input.ts";
import { capText, clampLimit, LIMITS, page, round4 } from "./limits.ts";
import { trustLevels } from "./trust-view.ts";

export const GOAL_STATUSES = ["active", "paused", "reached"] as const;

export function listGoals(call: Call, input: Record<string, unknown>) {
	const status = optionalEnum(input.status, GOAL_STATUSES, "status");
	const limit = clampLimit(input.limit, LIMITS.listDefault, LIMITS.listMax);
	const snap = snapshotOf(call);
	const rows = snap.goals
		.filter((g) => status === undefined || g.status === status)
		.map((g) => {
			// Same scope and readiness as the app's goalReadinessReport.
			const r = goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall);
			return {
				id: g.id,
				title: capText(g.title, LIMITS.titleChars),
				status: g.status,
				priority: g.priority,
				origin: g.origin,
				createdAt: g.createdAt,
				targetCount: g.targetNodeIds.length,
				scopeSize: r.total,
				solidNodes: r.solid,
				solidShare: r.total === 0 ? 0 : round4(r.solid / r.total),
				ready: r.ready,
			};
		});
	return page(rows, limit);
}

/** The newest exercise set of a goal (a tie goes to the later one in the ledger), or null. */
export function latestExerciseSet(call: Call, goalId: string): ExerciseSetState | null {
	let latest: ExerciseSetState | null = null;
	for (const s of deriveExerciseSets(call.deps.exercises.readAll())) {
		if (s.goalId === goalId && (latest === null || instantMs(s.createdAt) >= instantMs(latest.createdAt))) latest = s;
	}
	return latest;
}

type ExerciseSetView =
	| { state: "none" }
	| { state: "in_progress" | "complete" | "applied"; exercises: number; graded: number };

function exerciseSetOf(call: Call, goalId: string): ExerciseSetView {
	const latest = latestExerciseSet(call, goalId);
	if (latest === null) return { state: "none" };
	const state = latest.applied !== null ? "applied" : setComplete(latest) ? "complete" : "in_progress";
	return { state, exercises: latest.exercises.length, graded: latest.graded.size };
}

export function getGoal(call: Call, input: Record<string, unknown>) {
	const id = requireId(input.id, "id");
	const snap = snapshotOf(call);
	const goal: Goal | undefined = snap.goals.find((g) => g.id === id);
	if (goal === undefined) throw new ToolError("not_found", `No goal with id "${capText(id, 60)}".`);

	const scope = goalScope(goal.targetNodeIds, snap.chains);
	const r = goalReadiness(scope, snap.recall);
	const levels = trustLevels(call.deps.verification.readAll());
	const names = new Map(getGraph(call.graph).nodes.map((n) => [n.id, n.name]));
	const nowMs = Date.parse(snap.now);

	let dueNow = 0;
	let unseen = 0;
	let scheduled = 0;
	const byTrust = { unverified: 0, sourced: 0, contested: 0, refuted: 0 };
	for (const nodeId of scope) {
		if (!snap.nodeIds.has(nodeId)) continue;
		byTrust[levels.get(nodeId)?.level ?? "unverified"] += 1;
		if (snap.marks.retired.has(nodeId) && !snap.marks.pinned.has(nodeId)) continue;
		const state = snap.states.get(nodeId);
		if (state === undefined) unseen += 1;
		else if (state.card.due.getTime() <= nowMs) dueNow += 1;
		else scheduled += 1;
	}
	const targets = page(goal.targetNodeIds, LIMITS.targetsMax);
	return {
		id: goal.id,
		title: capText(goal.title, LIMITS.titleChars),
		status: goal.status,
		priority: goal.priority,
		origin: goal.origin,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		desiredRetention: snap.marks.retention.get(goal.id) ?? DEFAULT_RETENTION,
		targets: {
			...targets,
			items: targets.items.map((t) => ({ id: t, name: capText(names.get(t) ?? t, LIMITS.nameChars), trust: levels.get(t)?.level ?? "unverified" })),
		},
		scope: { size: r.total, solid: r.solid, solidShare: r.total === 0 ? 0 : round4(r.solid / r.total), ready: r.ready, byTrust },
		due: { dueNow, unseen, scheduled },
		exerciseSet: exerciseSetOf(call, goal.id),
	};
}
```

`src/core/ext/mcp/plan.ts`

```typescript
// src/core/ext/mcp/plan.ts
/**
 * get_daily_plan (REQ-mcp-05, REQ-mcp-07). The numbers come from the app's own
 * computePlan (the same pure dailyPlan over the same deck, states, review
 * history and default parameters); this file only adds minutes and counts.
 *
 * `date` (YYYY-MM-DD, the server's local time zone): omitted or today = the
 * app's plan for now. A FUTURE date (at most 30 days ahead) plans that day as
 * of its last millisecond: everything due by then is due, nothing was spent.
 * A past date is refused (it cannot be reconstructed from the ledgers).
 */

import { computeReviewStats, DEFAULT_PLAN_PARAMS } from "../daily-plan.ts";
import { goalReadiness } from "../deck.ts";
import { goalScope } from "../goals.ts";
import { localIsoDate, startOfLocalDay } from "../local-day.ts";
import { computePlan } from "../review-queries.ts";
import type { Call } from "./call.ts";
import { guardReplay } from "./call.ts";
import { invalid } from "./errors.ts";
import { latestExerciseSet } from "./goals.ts";
import { parseLocalDate } from "./input.ts";
import { capText, LIMITS, page, round1 } from "./limits.ts";

const DAY_MS = 86_400_000;

export function getDailyPlan(call: Call, input: Record<string, unknown>) {
	const requested = input.date === undefined ? null : parseLocalDate(input.date, "date");
	const nowDate = new Date(call.now);
	const todayIso = localIsoDate(nowDate);
	let asOf = call.now;
	let dayStart = startOfLocalDay(nowDate);
	let dateIso = todayIso;

	if (requested !== null && requested.iso !== todayIso) {
		const dayMs = new Date(requested.year, requested.month - 1, requested.day).getTime();
		const todayMs = new Date(dayStart).getTime();
		if (dayMs < todayMs) throw invalid("date is in the past: only today and future days can be planned.");
		if (Math.round((dayMs - todayMs) / DAY_MS) > LIMITS.futureDaysMax) throw invalid(`date is more than ${LIMITS.futureDaysMax} days ahead.`);
		dayStart = new Date(dayMs).toISOString();
		asOf = new Date(requested.year, requested.month - 1, requested.day, 23, 59, 59, 999).toISOString();
		dateIso = requested.iso;
	}

	const { plan, snap } = guardReplay(() => computePlan({ ...call.review, now: () => asOf }, dayStart));
	const stats = computeReviewStats(call.review.reviewStore.readEvents(), dayStart);
	const params = DEFAULT_PLAN_PARAMS;
	const cost = (channel: "fixed" | "dialogic"): number => stats.medianSec[channel] ?? params.defaultDurationSec[channel];
	const count = (reason: "due" | "new", channel: "fixed" | "dialogic"): number =>
		plan.items.filter((i) => i.reason === reason && i.channel === channel).length;
	const estimatedSec = plan.items.reduce((sum, i) => sum + cost(i.channel), 0);

	// A goal waits for an exercise set when most of its scope is solid and no set has been applied yet.
	const pending = snap.goals
		.filter((g) => g.status === "active")
		.filter((g) => goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall).ready)
		.filter((g) => {
			const set = latestExerciseSet(call, g.id);
			return set === null || set.applied === null;
		});
	const pendingPage = page(pending, LIMITS.pendingGoalsMax);

	return {
		date: dateIso,
		asOf,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		budgetMinutes: round1(params.budgetSec / 60),
		spentMinutes: round1(stats.spentTodaySec / 60),
		remainingMinutes: round1(plan.remainingSec / 60),
		due: { fixed: count("due", "fixed"), dialogic: count("due", "dialogic"), total: plan.due },
		newItems: { fixed: count("new", "fixed"), dialogic: count("new", "dialogic"), total: plan.items.filter((i) => i.reason === "new").length },
		planned: { total: plan.items.length, estimatedMinutes: round1(estimatedSec / 60) },
		newCardQuota: plan.newQuota,
		capacity: plan.capacity,
		deferred: plan.deferred.length,
		needsCard: plan.needsCard.length,
		exerciseSetPending: pending.length > 0,
		pendingGoals: { ...pendingPage, items: pendingPage.items.map((g) => ({ id: g.id, title: capText(g.title, LIMITS.titleChars) })) },
	};
}
```

`src/core/ext/mcp/research.ts`

```typescript
// src/core/ext/mcp/research.ts
/**
 * research_status (REQ-mcp-05): frontier marks, inbox size, a summary of the
 * last cycle. Allow-listed: no source locator, question, rationale, error text
 * or steering message leaves the server.
 */

import { deriveMarks } from "../frontier.ts";
import { deriveInbox } from "../inbox.ts";
import type { Call } from "./call.ts";
import { instantMs } from "./input.ts";
import { capText, finiteOrNull, LIMITS, page } from "./limits.ts";

export function researchStatus(call: Call) {
	const marks = deriveMarks(call.deps.frontier.readAll()).sort((a, b) => instantMs(b.at) - instantMs(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const marksPage = page(marks, LIMITS.marksMax);

	const inbox = { pending: 0, approved: 0, rejected: 0, activated: 0, total: 0 };
	for (const item of deriveInbox(call.deps.inbox.readAll())) {
		inbox[item.status] += 1;
		inbox.total += 1;
	}

	let last = null as ReturnType<typeof call.deps.researchLog.readAll>[number] | null;
	for (const entry of call.deps.researchLog.readAll()) {
		if (last === null || instantMs(entry.endedAt) >= instantMs(last.endedAt)) last = entry;
	}

	return {
		frontier: {
			...marksPage,
			items: marksPage.items.map((m) => ({
				id: capText(m.id, LIMITS.idMaxChars),
				scope: { kind: m.scope.kind, id: capText(m.scope.id, LIMITS.idMaxChars) },
				mark: m.mark,
				maxDepth: finiteOrNull(m.maxDepth),
				budgetUsd: finiteOrNull(m.budgetUsd),
				note: capText(m.note, LIMITS.noteChars),
				author: m.author,
				at: m.at,
			})),
		},
		inbox,
		lastCycle:
			last === null
				? null
				: {
						cycleId: capText(last.cycleId, LIMITS.idMaxChars),
						trigger: last.trigger,
						startedAt: last.startedAt,
						endedAt: last.endedAt,
						stoppedBy: last.stoppedBy,
						gaps: last.gaps.length,
						nodesAdded: last.nodesAdded,
						costUsd: finiteOrNull(last.costUsd),
						watch: last.watch,
					},
	};
}
```

Replace `src/core/ext/mcp/tools.ts` with the full dispatcher (adds the imports of the three new modules and the four `study` rows):

`src/core/ext/mcp/tools.ts`

```typescript
// src/core/ext/mcp/tools.ts
/**
 * The tool table and its dispatcher. runTool is the single entry the server
 * calls; it is also the core's own gatekeeper, independent of the SDK layer:
 *   1. an unknown tool name (including inherited names such as "constructor")
 *      is refused;
 *   2. the format stamps are checked FIRST, so a newer stamp answers every tool
 *      with the same clear error (REQ-mcp-03);
 *   3. the study group is refused under --knowledge-only (REQ-mcp-06);
 *   4. the arguments must be a plain object holding only the tool's declared
 *      fields: an unknown field is refused, never ignored, so a write-shaped
 *      request (`{"id": "n_1", "delete": true}`) cannot slip through.
 */

import { openCall, type Call } from "./call.ts";
import { ToolError, invalid } from "./errors.ts";
import { getDailyPlan } from "./plan.ts";
import { getGoal, listGoals } from "./goals.ts";
import { plainObject } from "./input.ts";
import { getLecture, listLectures } from "./lectures.ts";
import { capText } from "./limits.ts";
import { getNeighbors, getNode } from "./node.ts";
import type { McpDeps, RunOptions } from "./ports.ts";
import { researchStatus } from "./research.ts";
import { searchNodes } from "./search.ts";

export type ToolGroup = "knowledge" | "study";

interface Handler {
	group: ToolGroup;
	/** The only argument names the tool accepts (a test pins them to the zod schemas of the catalog). */
	fields: readonly string[];
	run(call: Call, input: Record<string, unknown>, opts: RunOptions): unknown;
}

const HANDLERS: Record<string, Handler> = {
	search_nodes: { group: "knowledge", fields: ["query", "limit", "trust", "goalId"], run: searchNodes },
	get_node: { group: "knowledge", fields: ["id"], run: getNode },
	get_neighbors: { group: "knowledge", fields: ["id", "depth"], run: (c, i) => getNeighbors(c, i) },
	list_lectures: { group: "knowledge", fields: ["chapter"], run: (c, i) => listLectures(c, i) },
	get_lecture: { group: "knowledge", fields: ["id"], run: (c, i) => getLecture(c, i) },
	list_goals: { group: "study", fields: ["status", "limit"], run: (c, i) => listGoals(c, i) },
	get_goal: { group: "study", fields: ["id"], run: (c, i) => getGoal(c, i) },
	get_daily_plan: { group: "study", fields: ["date"], run: (c, i) => getDailyPlan(c, i) },
	research_status: { group: "study", fields: [], run: (c) => researchStatus(c) },
};

export const TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(HANDLERS));

export function toolGroup(name: string): ToolGroup | null {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.group : null;
}

export function toolFields(name: string): readonly string[] {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.fields : [];
}

export function runTool(name: string, deps: McpDeps, input: unknown, opts: RunOptions): unknown {
	if (!Object.hasOwn(HANDLERS, name)) throw new ToolError("not_found", `Unknown tool "${capText(name, 60)}".`);
	const handler = HANDLERS[name]!;
	const call = openCall(deps); // stamps first
	if (opts.knowledgeOnly && handler.group === "study") {
		throw new ToolError("disabled", "Study-state tools are disabled (--knowledge-only).");
	}
	const args = plainObject(input);
	for (const key of Object.keys(args)) {
		if (!handler.fields.includes(key)) {
			const accepted = handler.fields.length === 0 ? "no arguments" : handler.fields.join(", ");
			throw invalid(`Unknown argument "${capText(key, 40)}". This server is read-only; ${name} accepts: ${accepted}.`);
		}
	}
	return handler.run(call, args, opts);
}
```

- [ ] **Step 4: Run the tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-study.test.ts tests/ext-mcp-knowledge.test.ts tests/ext-personal-layer.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/core/ext/mcp tests/ext-mcp-study.test.ts
```

Expected: all pass (15 new tests); no findings. The parity test is the REQ-mcp-07 evidence: if it fails, the server has drifted from the app's plan function, so fix the server, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/mcp/goals.ts src/core/ext/mcp/plan.ts src/core/ext/mcp/research.ts src/core/ext/mcp/tools.ts tests/ext-mcp-study.test.ts
git commit -m "feat(mcp): study-state tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dispatcher gatekeeper (defence in depth)

REQ-mcp-02, -03, -10. `runTool` must be safe on its own, whatever the protocol layer does: an unknown argument is refused on every tool (a write-shaped request is never silently ignored), tool names are matched against own properties only (`constructor`, `__proto__` are unknown), non-object arguments are refused, the format stamp is checked before anything else, a corrupt or non-numeric stamp does not refuse (it mirrors the app), and a writer caught in the middle of an append (a torn last line, cut at several points) never breaks a read.

**Files:**
- Test: `tests/ext-mcp-dispatch.test.ts`
- (Implementation already in `src/core/ext/mcp/tools.ts`)

- [ ] **Step 1: Write the test**

`tests/ext-mcp-dispatch.test.ts`

```typescript
// tests/ext-mcp-dispatch.test.ts
/** runTool is the core's own gatekeeper, independent of the SDK's schema validation (defence in depth, REQ-mcp-02, -10). */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, makeFixture, N, seedStandard } from "./helpers/mcp-fixture.ts";
import { call, errorCode, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("runTool", () => {
	it("refuses an unknown argument on every tool, even when the schema layer would let it through", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const tool of TOOL_NAMES) {
			for (const key of ["delete", "write", "mark", "set", "__proto__x", "id2"]) {
				const input = { ...(tool === "get_node" || tool === "get_neighbors" || tool === "get_goal" ? { id: N.a } : {}), [key]: true };
				assert.equal(errorCode(f, tool, input), "invalid_input", `${tool} accepted "${key}"`);
			}
		}
	});

	it("refuses an unknown tool, including names inherited from Object, and non-object arguments (an absent or null argument object means no arguments)", () => {
		const f = makeFixture();
		for (const name of ["", "constructor", "__proto__", "toString", "hasOwnProperty", "set_goal", "GET_NODE", "get_node ", "get_node\n"]) {
			expectError(f, name, {}, "not_found");
		}
		for (const input of [null, undefined, 3, "x", true, [], [1]]) {
			const code = errorCode(f, "research_status", input);
			assert.ok(code === "invalid_input" || ((input === undefined || input === null) && code === "none"), `research_status(${JSON.stringify(input)}) gave ${code}`);
		}
	});

	it("checks the format stamp before anything else, even for an unknown argument or a disabled tool", () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("graph", 99);
		expectError(f, "get_node", { id: N.a, delete: true }, "data_newer_than_build");
		expectError(f, "list_goals", {}, "data_newer_than_build", true);
	});

	it("a stamp at the supported version is accepted; a corrupt or non-numeric stamp does not refuse", () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("ext", 1);
		assert.equal(errorCode(f, "research_status"), "none");
		fs.writeFileSync(`${f.extDir}/format.json`, "{not json");
		assert.equal(errorCode(f, "research_status"), "none");
		fs.writeFileSync(`${f.extDir}/format.json`, JSON.stringify({ version: "99" }));
		assert.equal(errorCode(f, "research_status"), "none");
		assert.equal(call(f, "get_node", { id: N.a }).id, N.a);
	});

	it("a writer caught mid-append (a torn last line) never breaks a read; the completed line shows up on the next call", () => {
		const f = makeFixture();
		seedStandard(f);
		const file = `${f.extDir}/review.jsonl`;
		const base = fs.readFileSync(file, "utf-8");
		const line = JSON.stringify({ type: "review", nodeId: N.lone, channel: "fixed", rating: 3, durationSec: 12, at: "2026-11-04T09:00:00.000Z" });
		for (let cut = 1; cut < line.length; cut += 11) {
			fs.writeFileSync(file, base + line.slice(0, cut)); // the writer is in the middle of its append
			assert.equal(call(f, "get_node", { id: N.lone }).review, null, `a torn line (${cut} bytes) is not a review`);
			assert.equal(errorCode(f, "get_daily_plan"), "none");
		}
		fs.writeFileSync(file, base + line + "\n"); // the append completes
		assert.notEqual(call(f, "get_node", { id: N.lone }).review, null);
	});
});
```

- [ ] **Step 2: Run it**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-dispatch.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3: Prove the test can fail (mutation spot-check, then revert)**

Temporarily change the argument check in `src/core/ext/mcp/tools.ts` so that unknown keys are accepted:

```bash
sed -i '' 's/if (!handler.fields.includes(key)) {/if (false) {/' src/core/ext/mcp/tools.ts
NODE_ENV=test npx tsx --test tests/ext-mcp-dispatch.test.ts
git checkout src/core/ext/mcp/tools.ts   # only if tools.ts is committed; otherwise undo the sed by hand
```

Expected: the first test (`refuses an unknown argument on every tool...`) FAILS with a message naming the tool that accepted the key. Then revert and re-run: 5 pass.

- [ ] **Step 4: Commit**

```bash
git add tests/ext-mcp-dispatch.test.ts
git commit -m "test(mcp): the dispatcher refuses write-shaped and malformed requests on its own

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Immutability oracle

REQ-mcp-02, -03 (adversarial). After every call of every tool, with several inputs each (valid, missing id, hostile, write-shaped), in these data states: full data, `--knowledge-only`, no `format.json`, a current stamp, an empty data directory, corrupt and torn lines, and a newer stamp, the data directory is byte-for-byte unchanged. The digest covers every entry of the tree: relative path, type, size, mtime in nanoseconds (files and directories, so a created-then-deleted lock file is caught), inode and the SHA-256 of file contents. A tripwire also makes every `fs` write API throw while the tool runs, so a write to any path is caught, not only inside the data directory. The test proves the oracle is not blind: it detects a new empty file, a touched mtime and a one-byte append, and the tripwire catches a write.

**Files:**
- Test: `tests/ext-mcp-immutable.test.ts` (uses `tests/helpers/mcp-dir-hash.ts` from Task 3)

- [ ] **Step 1: Write the test**

`tests/ext-mcp-immutable.test.ts`

```typescript
// tests/ext-mcp-immutable.test.ts
/**
 * REQ-mcp-02 (adversarial): after EVERY tool call, in every data state, the
 * data directory is byte-for-byte unchanged: contents, sizes, mtimes (files AND
 * directories), inodes; no new file, no format.json stamp, no lock or temp
 * file. A tripwire also makes every fs write API throw during the call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, seedGraph, seedStandard, type Fixture } from "./helpers/mcp-fixture.ts";
import { fsTripwire, treeDigest } from "./helpers/mcp-dir-hash.ts";
import { errorCode } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const INPUTS: Record<string, unknown[]> = {
	search_nodes: [{ query: "set" }, { query: "zzz" }, { query: "" }, { query: 7 }],
	get_node: [{ id: N.a }, { id: N.d }, { id: "n_missing" }, {}],
	get_neighbors: [{ id: N.c, depth: 2 }, { id: "n_missing" }],
	list_lectures: [{}, { chapter: "x" }],
	get_lecture: [{ id: "lec_missing" }, { id: "../../etc/passwd" }],
	list_goals: [{}, { status: "active" }],
	get_goal: [{ id: GOAL_ID }, { id: "goal_nope" }],
	get_daily_plan: [{}, { date: "2026-11-05" }, { date: "nope" }],
	research_status: [{}, { extra: 1 }],
};

function exercise(f: Fixture, label: string, knowledgeOnly: boolean): void {
	const before = treeDigest(f.root);
	const files = fs.readdirSync(f.root, { recursive: true }).map(String).sort();
	for (const tool of TOOL_NAMES) {
		for (const input of INPUTS[tool] ?? [{}]) {
			const trip = fsTripwire();
			try {
				errorCode(f, tool, input, knowledgeOnly);
			} finally {
				trip.restore();
			}
			assert.deepEqual(trip.calls, [], `${label}: ${tool} called a write API`);
			assert.equal(treeDigest(f.root), before, `${label}: ${tool}(${JSON.stringify(input)}) changed the data directory`);
		}
	}
	assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).map(String).sort(), files, `${label}: files appeared or vanished`);
}

describe("the data directory is untouched by every tool (REQ-mcp-02)", () => {
	it("full data, all tools", () => exercise(seedAndReturn(), "full", false));
	it("full data, knowledge-only", () => exercise(seedAndReturn(), "knowledge-only", true));

	it("data without any format.json: no stamp is written", () => {
		const f = seedAndReturn();
		for (const dir of [f.extDir, f.graphDir]) assert.ok(!fs.existsSync(path.join(dir, "format.json")));
		exercise(f, "unstamped", false);
		for (const dir of [f.extDir, f.graphDir]) assert.ok(!fs.existsSync(path.join(dir, "format.json")));
	});

	it("data with a stamp at the current version stays byte-identical", () => {
		const f = seedAndReturn();
		f.writeStamp("ext", 1);
		f.writeStamp("graph", 1);
		exercise(f, "stamped", false);
	});

	it("an empty data directory (no ext, no graph) is not populated", () => {
		const f = makeFixture();
		fs.rmSync(f.extDir, { recursive: true, force: true });
		fs.rmSync(f.graphDir, { recursive: true, force: true });
		exercise(f, "empty", false);
		assert.deepEqual(fs.readdirSync(f.root), []);
	});

	it("data with corrupt and torn lines is not repaired", () => {
		const f = seedAndReturn();
		fs.appendFileSync(path.join(f.extDir, "review.jsonl"), '{"type":"review","nodeId":"n_aa');
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), "not json at all\n");
		exercise(f, "corrupt", false);
	});

	it("a newer stamp refuses every call and still changes nothing", () => {
		const f = seedAndReturn();
		f.writeStamp("ext", 99);
		const before = treeDigest(f.root);
		for (const tool of TOOL_NAMES) assert.equal(errorCode(f, tool, tool === "get_node" ? { id: N.a } : {}), "data_newer_than_build", tool);
		assert.equal(treeDigest(f.root), before);
	});

	it("the oracle detects a one-byte change, a new empty file and a touched mtime (it is not blind)", () => {
		const f = seedAndReturn();
		const base = treeDigest(f.root);
		const goals = path.join(f.extDir, "goals.jsonl");
		const original = fs.readFileSync(goals);
		fs.writeFileSync(path.join(f.root, "x.lock"), "");
		assert.notEqual(treeDigest(f.root), base, "new empty file");
		fs.rmSync(path.join(f.root, "x.lock"));
		const st = fs.statSync(goals);
		fs.utimesSync(goals, st.atime, new Date(st.mtimeMs + 5000));
		assert.notEqual(treeDigest(f.root), base, "touched mtime");
		fs.writeFileSync(goals, Buffer.concat([original, Buffer.from(" ")]));
		assert.notEqual(treeDigest(f.root), base, "one byte");
	});

	it("the tripwire is live: a write during a call is caught", () => {
		const f = seedAndReturn();
		const trip = fsTripwire();
		try {
			assert.throws(() => fs.writeFileSync(path.join(f.root, "boom"), "x"));
		} finally {
			trip.restore();
		}
		assert.deepEqual(trip.calls, ["writeFileSync"]);
		assert.ok(!fs.existsSync(path.join(f.root, "boom")));
	});
});

function seedAndReturn(): Fixture {
	const f = makeFixture();
	seedStandard(f);
	return f;
}
void seedGraph;
```

- [ ] **Step 2: Run it**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-immutable.test.ts
```

Expected: 9 tests pass. (The code under test exists already; the oracle's own tests, 'is not blind' and 'the tripwire is live', are what would fail if the helper were wrong.)

- [ ] **Step 3: Mutation spot-check, then revert**

In `src/store/ext/readonly.ts`, inside the function returned by `createReadableGuard`, add `fs.mkdirSync(extDir, { recursive: true });` as its first line, then run:

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-immutable.test.ts
```

Expected: FAIL on 6 tests (full data, knowledge-only, no format.json, current stamp, empty data directory, corrupt lines); the messages name `mkdirSync`. Remove the line and re-run: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/ext-mcp-immutable.test.ts
git commit -m "test(mcp): byte-for-byte immutability oracle over every tool

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Zod catalog and the MCP server object

REQ-mcp-01, -02, -04, -05, -06, -08, -10, -12. The protocol layer. `catalog.ts` holds the strict zod input contract of each tool (the only place zod appears; the core stays zod-free) and a test pins its keys to the dispatcher's `fields`, so the two cannot drift. `server.ts` registers every tool as read-only/closed-world/non-destructive through one safe wrapper: a `ToolError` keeps its code and fixed message, any other error becomes the fixed `internal` text (the real error goes to the `log` callback, which the entry points at stderr), and a result above 128 KiB is refused, never cut. Under `--knowledge-only` the study tools are not registered at all.

**Files:**
- Create: `src/server/ext/mcp/catalog.ts`, `src/server/ext/mcp/server.ts`, `tests/helpers/mcp-client.ts`
- Test: `tests/ext-mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/mcp-client.ts`

```typescript
// tests/helpers/mcp-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server/ext/mcp/server.ts";
import type { Fixture } from "./mcp-fixture.ts";

export type Json = any;

export async function connect(f: Fixture, knowledgeOnly = false): Promise<{ client: Client; logs: string[]; close(): Promise<void> }> {
	const logs: string[] = [];
	const server = createServer(f.deps, { knowledgeOnly, log: (m) => logs.push(m) });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return { client, logs, close: async () => { await client.close(); await server.close(); } };
}

export async function callTool(client: Client, name: string, args: unknown = {}): Promise<{ isError: boolean; body: Json; text: string }> {
	const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	const text = r.content.map((c) => c.text ?? "").join("");
	return { isError: r.isError === true, body: r.structuredContent ?? parse(text), text };
}

function parse(text: string): Json {
	try {
		return JSON.parse(text);
	} catch {
		return { error: { code: "protocol", message: text } };
	}
}
```

`tests/ext-mcp-server.test.ts`

```typescript
// tests/ext-mcp-server.test.ts
/** The protocol layer in process (REQ-mcp-01, -04, -05, -06, -08, -10, -12). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CATALOG } from "../src/server/ext/mcp/catalog.ts";
import { TOOL_NAMES, toolFields, toolGroup } from "../src/core/ext/mcp/tools.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { cleanupAllFixtures, GOAL_ID, HIDDEN, makeFixture, N, seedGraph, seedStandard } from "./helpers/mcp-fixture.ts";
import { callTool, connect } from "./helpers/mcp-client.ts";

afterEach(cleanupAllFixtures);

describe("catalog and registration", () => {
	it("the zod schemas and the handler tables name exactly the same tools and fields", () => {
		assert.deepEqual(Object.keys(CATALOG).sort(), [...TOOL_NAMES].sort());
		for (const name of TOOL_NAMES) assert.deepEqual(Object.keys(CATALOG[name]!.input.shape).sort(), [...toolFields(name)].sort(), name);
	});

	it("lists every tool as read-only, closed-world, non-destructive, with a description and an input schema", async () => {
		const f = makeFixture();
		const { client, close } = await connect(f);
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
		for (const t of tools) {
			assert.equal(t.annotations?.readOnlyHint, true, t.name);
			assert.equal(t.annotations?.destructiveHint, false, t.name);
			assert.equal(t.annotations?.openWorldHint, false, t.name);
			assert.ok((t.description ?? "").length > 20, t.name);
			assert.equal((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, `${t.name} must reject unknown keys`);
		}
		await close();
	});

	it("--knowledge-only registers only the knowledge group; the others are unknown tools", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f, true);
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES.filter((n) => toolGroup(n) === "knowledge").sort());
		for (const name of ["list_goals", "get_goal", "get_daily_plan", "research_status"]) {
			assert.equal((await callTool(client, name, { id: GOAL_ID })).isError, true, name);
		}
		assert.equal((await callTool(client, "get_node", { id: N.a })).isError, false);
		await close();
	});

	it("no tool name suggests a write", async () => {
		for (const name of TOOL_NAMES) assert.ok(!/^(set|add|create|update|delete|remove|write|mark|put|post|run|start|apply|save|import|upload)/.test(name), name);
	});
});

describe("calls over the protocol", () => {
	it("every tool accepts its documented arguments through the SDK's schema validation and answers", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const valid: Record<string, unknown[]> = {
			search_nodes: [{ query: "set" }, { query: "set", limit: 5, trust: "sourced", goalId: GOAL_ID }],
			get_node: [{ id: N.a }],
			get_neighbors: [{ id: N.c }, { id: N.c, depth: 2 }],
			list_lectures: [{}, { chapter: 2 }],
			get_lecture: [{ id: "lec_b0123abcd_c02_l01" }],
			list_goals: [{}, { status: "active", limit: 10 }],
			get_goal: [{ id: GOAL_ID }],
			get_daily_plan: [{}, { date: "2026-11-05" }],
			research_status: [{}],
		};
		assert.deepEqual(Object.keys(valid).sort(), [...TOOL_NAMES].sort());
		for (const [tool, inputs] of Object.entries(valid)) {
			for (const input of inputs) {
				const r = await callTool(client, tool, input);
				assert.equal(r.isError, false, `${tool}(${JSON.stringify(input)}): ${r.text.slice(0, 200)}`);
			}
		}
		await close();
	});

	it("returns structured content that equals the JSON text, for success and for failure", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const ok = await callTool(client, "get_node", { id: N.a });
		assert.equal(ok.isError, false);
		assert.deepEqual(JSON.parse(ok.text), ok.body);
		const bad = await callTool(client, "get_node", { id: "n_missing" });
		assert.equal(bad.isError, true);
		assert.equal(bad.body.error.code, "not_found");
		await close();
	});

	it("write-shaped or unknown arguments are refused, never ignored (REQ-mcp-02)", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const shapes: Array<[string, unknown]> = [
			["get_node", { id: N.a, delete: true }],
			["get_node", { id: N.a, action: "update", body: "x" }],
			["search_nodes", { query: "set", write: true }],
			["list_goals", { status: "active", set_status: "paused" }],
			["research_status", { mark: "hold" }],
			["get_daily_plan", { date: "2026-11-05", mark_done: true }],
			["get_node", { id: N.a, __proto__: { admin: true }, constructor: "x" }],
		];
		for (const [tool, args] of shapes) assert.equal((await callTool(client, tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
		for (const name of ["set_goal", "delete_node", "add_node", "mark_reviewed", "constructor", "__proto__", "toString", "", "GET_NODE"]) {
			assert.equal((await callTool(client, name, { id: N.a })).isError, true, name);
		}
		await close();
	});

	it("wrong-typed, oversized and hostile arguments give a structured error, not a crash", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const hostile: Array<[string, unknown]> = [
			["get_node", { id: null }], ["get_node", { id: ["a"] }], ["get_node", { id: "x".repeat(10_000) }],
			["search_nodes", { query: "a".repeat(100_000) }], ["search_nodes", { query: "set", limit: Number.NaN }],
			["search_nodes", { query: "set", limit: 1e12 }], ["search_nodes", { query: "set", limit: -3 }], ["search_nodes", { query: "set", limit: 1.5 }],
			["get_neighbors", { id: N.a, depth: 9 }], ["get_neighbors", { id: N.a, depth: "2" }],
			["get_daily_plan", { date: "9999-99-99" }], ["list_goals", { status: "'; drop table" }],
		];
		for (const [tool, args] of hostile) {
			const r = await callTool(client, tool, args);
			assert.equal(r.isError, true, `${tool} ${JSON.stringify(args).slice(0, 60)}`);
		}
		assert.equal((await callTool(client, "get_node", { id: N.a })).isError, false, "the server still answers");
		await close();
	});

	it("an unexpected internal error is the fixed internal message, logged on the side, never the raw message", async () => {
		const f = makeFixture();
		seedStandard(f);
		f.deps.verification = {
			readAll() {
				throw new Error(`EACCES: permission denied, open '${HIDDEN.localPath}/verification.jsonl' sk-ant-api03-HIDDENKEY`);
			},
		};
		const { client, logs, close } = await connect(f);
		const r = await callTool(client, "get_node", { id: N.a });
		assert.equal(r.isError, true);
		assert.equal(r.body.error.code, "internal");
		assert.ok(!r.text.includes("EACCES") && !r.text.includes(HIDDEN.localPath) && !r.text.includes("sk-ant"));
		assert.ok(logs.join("\n").includes("EACCES"), "the real error is available to the operator on stderr");
		assert.equal((await callTool(client, "list_lectures", {})).isError, false, "other tools keep working");
		await close();
	});

	it("a result above the response limit is refused, not cut", async () => {
		const f = makeFixture();
		seedGraph(f);
		const big = "x".repeat(LIMITS.statementChars);
		for (let i = 0; i < 40; i++) f.graph("nodes.jsonl", { id: `n_big${String(i).padStart(4, "0")}`, name: `Big ${i}`, statement: big, aliases: Array.from({ length: 30 }, (_, k) => `${big.slice(0, 190)}${k}`), kind: "definition", createdAt: "2026-11-01T00:00:00.000Z" });
		const { client, close } = await connect(f);
		const r = await callTool(client, "search_nodes", { query: "big", limit: 50 });
		assert.ok(r.text.length <= LIMITS.responseMaxBytes * 1.1 || r.isError);
		if (r.isError) assert.equal(r.body.error.code, "response_too_large");
		await close();
	});

	it("is read-only under concurrency: many parallel calls all answer", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const results = await Promise.all(Array.from({ length: 60 }, (_, i) => callTool(client, i % 2 ? "get_node" : "search_nodes", i % 2 ? { id: N.a } : { query: "set" })));
		assert.ok(results.every((r) => !r.isError));
		await close();
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-server.test.ts
```

Expected: FAIL with `Cannot find module '../src/server/ext/mcp/catalog.ts'`.

- [ ] **Step 3: Implement**

`src/server/ext/mcp/catalog.ts`

```typescript
// src/server/ext/mcp/catalog.ts
/**
 * The tool catalog: name, title, description and the zod INPUT contract of each
 * tool (REQ-mcp-12). Core has no zod, so the schemas live here. Every schema is
 * strict: an unknown key is an error, which is how a write-shaped request is
 * refused at the protocol edge (runTool refuses it again in the core).
 * The language-neutral contract (docs/ext/CONTRACTS.md) is derived from these.
 */

import { z } from "zod";
import { LIMITS } from "../../../core/ext/mcp/limits.ts";

const id = z.string().min(1).max(LIMITS.idMaxChars);
const limit = z.number().int().min(1).max(LIMITS.listMax).optional();
const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

export interface ToolSpec {
	title: string;
	description: string;
	input: z.ZodObject<z.ZodRawShape>;
}

export const CATALOG: Record<string, ToolSpec> = {
	search_nodes: {
		title: "Search knowledge nodes",
		description:
			"Fuzzy text search over node names, statements and aliases. Returns id, name, a shortened statement and the trust level. Read-only.",
		input: strict({
			query: z.string().min(1).max(LIMITS.queryMaxChars),
			limit,
			trust: z.enum(["unverified", "sourced", "contested", "refuted"]).optional(),
			goalId: id.optional(),
		}),
	},
	get_node: {
		title: "Read one knowledge node",
		description:
			"Statement, aliases, trust level with evidence, the current explanation (flagged stale or without source context), premises, conclusions, alternative arguments, citing lectures, card count, review state and goals. Read-only.",
		input: strict({ id }),
	},
	get_neighbors: {
		title: "Read a node's neighbourhood",
		description: "Nodes and edges within depth 1 or 2 of a node. Bounded. Read-only.",
		input: strict({ id, depth: z.number().int().min(1).max(2).optional() }),
	},
	list_lectures: {
		title: "List lectures",
		description: "Registered lectures with counts; chapter (a chapter number) keeps one chapter. Read-only.",
		input: strict({ chapter: z.number().int().min(1).max(100_000).optional() }),
	},
	get_lecture: {
		title: "Read one lecture outline",
		description: "Outline, referenced nodes and timed exercises. Slide narration text is never returned. Read-only.",
		input: strict({ id }),
	},
	list_goals: {
		title: "List study goals",
		description: "Goals with scope size and the share of solid nodes. Study-state group (disabled by --knowledge-only). Read-only.",
		input: strict({ status: z.enum(["active", "paused", "reached"]).optional(), limit }),
	},
	get_goal: {
		title: "Read one study goal",
		description: "Scope summary, due counts and the state of the exercise set. Study-state group. Read-only.",
		input: strict({ id }),
	},
	get_daily_plan: {
		title: "Read the daily study plan",
		description:
			"Budget in minutes, due counts per channel, estimated minutes, new-card quota and whether an exercise set is pending, computed by the app's own plan function. date (YYYY-MM-DD, server local time) may be today or up to 30 days ahead. Study-state group. Read-only.",
		input: strict({ date: z.string().length(10).optional() }),
	},
	research_status: {
		title: "Read research status",
		description: "Frontier marks, inbox size and a summary of the last research cycle. Study-state group. Read-only.",
		input: strict({}),
	},
};
```

`src/server/ext/mcp/server.ts`

```typescript
// src/server/ext/mcp/server.ts
/**
 * The MCP server object (REQ-mcp-01, -02, -08, -10, -12). Every tool goes
 * through one safe wrapper:
 *   - a ToolError keeps its code and fixed message;
 *   - any other error (including an SDK or filesystem error) becomes the fixed
 *     `internal` failure, and the real error is logged on STDERR only;
 *   - a result above responseMaxBytes is refused, never truncated silently.
 * All tools are annotated readOnlyHint, closed-world and non-destructive.
 * Under --knowledge-only the study tools are not even registered.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { failureOf, INTERNAL_MESSAGE, ToolError, type ToolFailure } from "../../../core/ext/mcp/errors.ts";
import { LIMITS } from "../../../core/ext/mcp/limits.ts";
import type { McpDeps } from "../../../core/ext/mcp/ports.ts";
import { runTool, toolGroup, TOOL_NAMES } from "../../../core/ext/mcp/tools.ts";
import { CATALOG } from "./catalog.ts";

export const SERVER_NAME = "learning-platform";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
	knowledgeOnly: boolean;
	/** Where unexpected errors are logged. Must NEVER be stdout. */
	log?: (message: string) => void;
}

const INSTRUCTIONS =
	"Read-only access to a local learning knowledge base. No tool changes anything. Ids come from search_nodes, list_lectures or list_goals. Every list carries count and truncated; long text ends with a truncation marker.";

function asResult(payload: object, isError: boolean): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown>, isError };
}

export function safeCall(name: string, deps: McpDeps, input: unknown, opts: ServerOptions): CallToolResult {
	try {
		const result = runTool(name, deps, input, { knowledgeOnly: opts.knowledgeOnly }) as object;
		const bytes = Buffer.byteLength(JSON.stringify(result), "utf-8");
		if (bytes > LIMITS.responseMaxBytes) {
			throw new ToolError("response_too_large", "The result is larger than this server's response limit. Narrow the request.");
		}
		return asResult(result, false);
	} catch (error) {
		if (!(error instanceof ToolError)) opts.log?.(`tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		const failure: ToolFailure = error instanceof ToolError ? failureOf(error) : { error: { code: "internal", message: INTERNAL_MESSAGE } };
		return asResult(failure, true);
	}
}

export function createServer(deps: McpDeps, opts: ServerOptions): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS, maxToolInputElements: LIMITS.maxToolInputElements },
	);
	for (const name of TOOL_NAMES) {
		if (opts.knowledgeOnly && toolGroup(name) === "study") continue;
		const spec = CATALOG[name];
		if (spec === undefined) throw new Error(`tool ${name} has no catalog entry`);
		server.registerTool(
			name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.input,
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			},
			(args: unknown) => safeCall(name, deps, args, opts),
		);
	}
	return server;
}
```

- [ ] **Step 4: Run the tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-server.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/server/ext/mcp tests/ext-mcp-server.test.ts tests/helpers/mcp-client.ts
```

Expected: all pass (11 tests); no findings. The test 'every tool accepts its documented arguments through the SDK schema validation' is what catches a zod contract that disagrees with the handler (for example a string where the handler wants an integer).

- [ ] **Step 5: Commit**

```bash
git add src/server/ext/mcp/catalog.ts src/server/ext/mcp/server.ts tests/helpers/mcp-client.ts tests/ext-mcp-server.test.ts
git commit -m "feat(mcp): zod catalog and read-only MCP server object

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Entry script, stdout guard, process tests and import-closure guard

REQ-mcp-01, -03, -11. Stdout belongs to the protocol. `installStdioGuard` redirects `process.stdout.write` and `console.log/info/debug` to stderr and hands the transport a dedicated `Writable` that wraps the real stdout write; a closed stdout (`EPIPE`) ends the process quietly. `args.ts` accepts only `--knowledge-only` and reads `LH_DATA_DIR`; the entry never creates the data directory. The process tests start the real entry through `tsx` and talk JSON-RPC over pipes. The closure test (written here because it scans the entry) proves the server cannot reach a model, a key or a write path.

**Files:**
- Create: `src/server/ext/mcp/stdio-guard.ts`, `src/server/ext/mcp/args.ts`, `scripts/ext-mcp.ts`
- Test: `tests/ext-mcp-stdio.test.ts`, `tests/ext-mcp-closure.test.ts` (+ `tests/helpers/mcp-closure.ts`)

- [ ] **Step 1: Write the failing tests**

`tests/helpers/mcp-closure.ts`

```typescript
// tests/helpers/mcp-closure.ts
/** Static RUNTIME import closure ("import type" / "export type" statements are erased by the compiler and skipped).
 * Static import closure of an entry file, followed through relative imports (type-only imports included: conservative). */
import fs from "node:fs";
import path from "node:path";

const IMPORT_RE = /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm;

export interface Closure {
	files: string[];
	packages: string[];
}

export function importClosure(entry: string, root: string): Closure {
	const files = new Set<string>();
	const packages = new Set<string>();
	const visit = (file: string): void => {
		if (files.has(file)) return;
		files.add(file);
		const src = fs.readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
		for (const m of src.matchAll(IMPORT_RE)) {
			const spec = m[1] ?? m[2] ?? m[3];
			if (spec === undefined) continue;
			if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec));
			else packages.add(spec);
		}
	};
	visit(path.resolve(root, entry));
	return { files: [...files].map((f) => path.relative(root, f)).sort(), packages: [...packages].sort() };
}
```

`tests/ext-mcp-closure.test.ts`

```typescript
// tests/ext-mcp-closure.test.ts
/**
 * REQ-mcp-01, -02, -11: the server cannot reach a model, a key or a write path
 * because none of them is in its import closure.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { importClosure } from "./helpers/mcp-closure.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const closure = importClosure("scripts/ext-mcp.ts", ROOT);

const FORBIDDEN_FILES = [
	/^src\/agent\//,
	/^src\/store\/graph\.ts$/,
	/^src\/store\/(settings|keys|chats)/,
	/^src\/server\/(stores|verification|settings|keys)/,
	/^src\/server\/ext\/(?!mcp\/)/,
	/^config\.ts$/,
	/^src\/store\/ext\/(?!readonly\.ts$)/,
];
const FORBIDDEN_NODE = /^node:(child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|vm|dns|inspector)$/;
const WRITE_CALL = /\b(writeFileSync|appendFileSync|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|truncateSync|symlinkSync|linkSync|createWriteStream|fs\.promises|node:fs\/promises|openSync\([^)]*["'][wa])/;

describe("the server's import closure (REQ-mcp-01, -02, -11)", () => {
	it("contains the entry, the read-only layer and nothing from the app's write, agent or settings code", () => {
		assert.ok(closure.files.includes("scripts/ext-mcp.ts"));
		assert.ok(closure.files.includes("src/store/ext/readonly.ts"));
		for (const f of closure.files) for (const re of FORBIDDEN_FILES) assert.ok(!re.test(f), `${f} must not be imported by the server`);
	});

	it("imports only node builtins without network, process or thread access, the MCP SDK, zod and ts-fsrs (the app's pure scheduler)", () => {
		for (const p of closure.packages) {
			const ok = p.startsWith("node:") ? !FORBIDDEN_NODE.test(p) : p.startsWith("@modelcontextprotocol/sdk/") || p === "zod" || p === "ts-fsrs";
			assert.ok(ok, `package ${p} is not allowed in the server closure`);
		}
	});

	it("no file of the closure calls a filesystem write API", () => {
		for (const f of closure.files) {
			const src = fs.readFileSync(path.join(ROOT, f), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			assert.ok(!WRITE_CALL.test(src), `${f} mentions a write API`);
		}
	});

	it("no file of the closure reads process.env except the entry arguments, or touches fetch/WebSocket/listen", () => {
		for (const f of closure.files) {
			const src = fs.readFileSync(path.join(ROOT, f), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			assert.ok(!/\b(fetch|WebSocket|XMLHttpRequest)\s*\(|\.listen\s*\(/.test(src), `${f} uses the network`);
			if (f !== "scripts/ext-mcp.ts" && f !== "src/server/ext/mcp/args.ts") assert.ok(!/process\.env/.test(src), `${f} reads process.env`);
		}
	});

	it("the scanner itself sees a planted forbidden import (guard against a blind scanner)", () => {
		const dir = fs.mkdtempSync(path.join(ROOT, "tests", ".closure-"));
		try {
			fs.writeFileSync(path.join(dir, "a.ts"), 'import "./b.ts";\nexport * from "../../src/agent/runtime.ts";\n');
			fs.writeFileSync(path.join(dir, "b.ts"), 'import("node:child_process");\n');
			const c = importClosure(path.relative(ROOT, path.join(dir, "a.ts")), ROOT);
			assert.ok(c.packages.includes("node:child_process"));
		} catch (e) {
			// the agent path may not resolve in this tree; only a resolution failure is tolerated, not a missed package
			if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

`tests/ext-mcp-stdio.test.ts`

```typescript
// tests/ext-mcp-stdio.test.ts
/** The real process over stdio (REQ-mcp-01, -03, -11) and the stdout guard. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { installStdioGuard } from "../src/server/ext/mcp/stdio-guard.ts";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, makeFixture, N, seedStandard } from "./helpers/mcp-fixture.ts";
import { treeDigest } from "./helpers/mcp-dir-hash.ts";

const sessions: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const c of sessions.splice(0)) c.kill("SIGKILL");
	cleanupAllFixtures();
});

const VALID_INPUTS: Record<string, unknown> = {
	search_nodes: { query: "set" },
	get_node: { id: "n_aaaa1111" },
	get_neighbors: { id: "n_aaaa1111", depth: 2 },
	get_lecture: { id: "lec_x" },
	get_goal: { id: "goal_aaaaaaaaaaaa" },
};

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SECRET = "sk-ant-api03-HIDDEN_ENV_SECRET_77";

interface Session {
	child: ChildProcessWithoutNullStreams;
	stdoutLines: string[];
	stderr(): string;
	request(method: string, params?: unknown): Promise<{ result?: any; error?: any }>;
	exit(): Promise<number | null>;
}

function start(dataDir: string, args: string[] = [], env: Record<string, string> = {}): Session {
	const child = spawn(TSX, [path.join(ROOT, "scripts", "ext-mcp.ts"), ...args], {
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LH_DATA_DIR: dataDir, NODE_ENV: "test", ANTHROPIC_API_KEY: SECRET, ...env },
	});
	sessions.push(child);
	let err = "";
	child.stderr.on("data", (d: Buffer) => (err += d.toString()));
	const stdoutLines: string[] = [];
	const waiting = new Map<number, (m: any) => void>();
	let buf = "";
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString();
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line === "") continue;
			stdoutLines.push(line);
			try {
				const m = JSON.parse(line);
				if (typeof m.id === "number") waiting.get(m.id)?.(m);
			} catch {
				/* recorded in stdoutLines; the hygiene test inspects it */
			}
		}
	});
	let id = 0;
	const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
	return {
		child,
		stdoutLines,
		stderr: () => err,
		request: (method, params) =>
			new Promise((resolve, reject) => {
				const n = ++id;
				const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${err}`)), 20_000);
				waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
				child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
			}),
		exit: async () => { child.stdin.end(); return exited; },
	};
}

async function handshake(s: Session): Promise<void> {
	const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	assert.ok(init.result, JSON.stringify(init));
	s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

function hasLsof(): boolean {
	return spawnSync("lsof", ["-v"], { encoding: "utf-8" }).error === undefined;
}

describe("the server process", () => {
	it("speaks only JSON-RPC on stdout, answers every tool, never leaks an env or file secret, and leaves the data untouched", async () => {
		const f = makeFixture();
		seedStandard(f);
		fs.writeFileSync(path.join(f.root, "settings.json"), JSON.stringify({ apiKeys: { anthropic: SECRET } }));
		fs.mkdirSync(path.join(f.root, "chats"));
		fs.writeFileSync(path.join(f.root, "chats", "c1.json"), `{"note":"${SECRET}"}`);
		const before = treeDigest(f.root);
		const s = start(f.root);
		await handshake(s);
		const list = await s.request("tools/list");
		assert.equal(list.result.tools.length, TOOL_NAMES.length);
		const all: string[] = [JSON.stringify(list)];
		for (const name of TOOL_NAMES) {
			const r = await s.request("tools/call", { name, arguments: VALID_INPUTS[name] ?? {} });
			all.push(JSON.stringify(r));
			assert.ok(r.result, `${name}: ${JSON.stringify(r)}`);
		}
		const code = await s.exit();
		assert.equal(code, 0, s.stderr());
		for (const line of s.stdoutLines) {
			const m = JSON.parse(line);
			assert.equal(m.jsonrpc, "2.0", `non-protocol stdout line: ${line.slice(0, 80)}`);
		}
		const everything = s.stdoutLines.join("\n") + all.join("\n");
		assert.ok(!everything.includes(SECRET), "the key must never be served");
		assert.ok(!everything.includes(f.root), "the data path must never be served");
		assert.equal(treeDigest(f.root), before);
	});

	it("opens no listening socket (lsof proves the probe sees the process before it reports no sockets)", { skip: !hasLsof() }, async () => {
		const f = makeFixture();
		const s = start(f.root);
		await handshake(s);
		const lsof = (args: string[]): string => {
			const r = spawnSync("lsof", ["-nP", "-p", String(s.child.pid), ...args], { encoding: "utf-8", timeout: 20_000 });
			return r.stdout ?? "";
		};
		assert.match(lsof([]), /cwd/, "the probe must be able to see the process");
		assert.equal(lsof(["-a", "-i"]).trim(), "", "the server must hold no network socket");
		await s.exit();
	});

	it("a newer stamp makes every tool answer with the same clear error over the wire", async () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("ext", 99);
		const s = start(f.root);
		await handshake(s);
		for (const name of TOOL_NAMES) {
			const r = await s.request("tools/call", { name, arguments: VALID_INPUTS[name] ?? {} });
			assert.equal(r.result.isError, true, name);
			assert.equal(r.result.structuredContent?.error?.code, "data_newer_than_build", name);
		}
		await s.exit();
	});

	it("fails to start with a message on stderr and an empty stdout for a missing data directory or an unknown argument", async () => {
		const missing = start(path.join(makeFixture().root, "does-not-exist"));
		assert.equal(await missing.exit(), 1);
		assert.match(missing.stderr(), /data directory not found/);
		assert.deepEqual(missing.stdoutLines, []);
		const badArg = start(makeFixture().root, ["--write"]);
		assert.equal(await badArg.exit(), 1);
		assert.match(badArg.stderr(), /unknown argument/);
		assert.deepEqual(badArg.stdoutLines, []);
	});

	it("an oversized request ends the session cleanly (the transport fails closed): no hang, no data change, no payload echoed", async () => {
		const f = makeFixture();
		seedStandard(f);
		const before = treeDigest(f.root);
		const s = start(f.root);
		await handshake(s);
		const big = JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "search_nodes", arguments: { query: "x".repeat(300_000) } } });
		s.child.stdin.write(big + "\n", () => undefined);
		const code = await Promise.race([s.exit(), new Promise<string>((res) => setTimeout(() => res("hung"), 15_000))]);
		assert.notEqual(code, "hung", "the server must not hang on an oversized request");
		for (const line of s.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
		assert.ok(!s.stderr().includes("xxxxxxxxxxxxxxxx"), "the payload is never echoed");
		assert.equal(treeDigest(f.root), before);
	});
});

describe("stdio guard", () => {
	it("moves stray stdout writes and console.log to stderr; only the protocol stream reaches real stdout", () => {
		const out = new PassThrough();
		const err = new PassThrough();
		const real: string[] = [];
		out.write = ((chunk: string | Uint8Array, cb?: unknown) => { real.push(String(chunk)); if (typeof cb === "function") (cb as () => void)(); return true; }) as typeof out.write;
		const stderr: string[] = [];
		err.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof err.write;
		const proc = { stdout: out, stderr: err, exit: () => undefined } as unknown as NodeJS.Process;
		const originalLog = console.log;
		const guard = installStdioGuard(proc, () => undefined);
		try {
			proc.stdout.write("stray\n");
			console.log("hello", { a: 1 });
			console.info("info");
			console.debug("dbg");
			assert.deepEqual(real, [], "nothing but the protocol may reach stdout");
			assert.ok(stderr.join("").includes("stray") && stderr.join("").includes("hello"));
			guard.protocolOut.write('{"jsonrpc":"2.0"}\n');
			assert.deepEqual(real, ['{"jsonrpc":"2.0"}\n']);
		} finally {
			guard.restore();
		}
		assert.equal(console.log, originalLog);
	});
});
```

- [ ] **Step 2: Run to see them fail**

```bash
NODE_ENV=test npx tsx --test --test-timeout=60000 tests/ext-mcp-closure.test.ts tests/ext-mcp-stdio.test.ts
```

Expected: FAIL: the closure test cannot read `scripts/ext-mcp.ts` (ENOENT) and the process tests cannot start it. (A failing process test must never hang the run: the test file kills every spawned child in `afterEach`.)

- [ ] **Step 3: Implement**

`src/server/ext/mcp/stdio-guard.ts`

```typescript
// src/server/ext/mcp/stdio-guard.ts
/**
 * Stdout belongs to the protocol (REQ-mcp-01). Any stray console.log, library
 * warning or debug print on stdout would corrupt the JSON-RPC stream, so:
 *   - process.stdout.write and console.log/info/debug are redirected to stderr;
 *   - the transport gets a dedicated Writable that writes to the REAL stdout.
 * A closed stdout (EPIPE) ends the process quietly instead of crashing.
 */

import { Writable } from "node:stream";

export interface StdioGuard {
	/** Hand this to StdioServerTransport as its output stream. */
	protocolOut: Writable;
	restore(): void;
}

export function installStdioGuard(proc: NodeJS.Process = process, onClosed: () => void = () => proc.exit(0)): StdioGuard {
	const realWrite = proc.stdout.write.bind(proc.stdout) as (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;
	const toStderr = (chunk: string | Uint8Array, cb?: unknown): boolean =>
		proc.stderr.write(chunk, typeof cb === "function" ? (cb as (err?: Error | null) => void) : undefined);

	const originalWrite = proc.stdout.write;
	proc.stdout.write = ((chunk: string | Uint8Array, cb?: unknown) => toStderr(chunk, cb)) as typeof proc.stdout.write;

	const originals = { log: console.log, info: console.info, debug: console.debug };
	const redirect =
		(prefix: string) =>
		(...args: unknown[]): void => {
			proc.stderr.write(`${prefix}${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
		};
	console.log = redirect("");
	console.info = redirect("");
	console.debug = redirect("");

	proc.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") onClosed();
	});

	const protocolOut = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			realWrite(chunk, (err) => callback(err ?? undefined));
		},
	});

	return {
		protocolOut,
		restore() {
			proc.stdout.write = originalWrite;
			console.log = originals.log;
			console.info = originals.info;
			console.debug = originals.debug;
		},
	};
}
```

`src/server/ext/mcp/args.ts`

```typescript
// src/server/ext/mcp/args.ts
/** Command line and environment of the server. The only flag is --knowledge-only; anything else is refused. */

import path from "node:path";

export interface McpArgs {
	dataRoot: string;
	knowledgeOnly: boolean;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>, defaultDataRoot: string): McpArgs {
	let knowledgeOnly = false;
	for (const arg of argv) {
		if (arg === "--knowledge-only") knowledgeOnly = true;
		else throw new Error(`unknown argument "${arg.slice(0, 40)}". The only option is --knowledge-only.`);
	}
	const fromEnv = env.LH_DATA_DIR;
	return { dataRoot: fromEnv !== undefined && fromEnv !== "" ? path.resolve(fromEnv) : defaultDataRoot, knowledgeOnly };
}
```

`scripts/ext-mcp.ts`

```typescript
// scripts/ext-mcp.ts
/**
 * Entry of the read-only MCP server (stdio). Launched by the client:
 *   LH_DATA_DIR=<dir> npx tsx scripts/ext-mcp.ts [--knowledge-only]
 * Imports only the read-only layer (see tests/ext-mcp-closure.test.ts). Nothing
 * but protocol goes to stdout; diagnostics go to stderr.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { validateDataRoot } from "../src/store/ext/readonly.ts";
import { parseArgs } from "../src/server/ext/mcp/args.ts";
import { createMcpDeps } from "../src/server/ext/mcp/deps.ts";
import { createServer } from "../src/server/ext/mcp/server.ts";
import { installStdioGuard } from "../src/server/ext/mcp/stdio-guard.ts";

const guard = installStdioGuard();
const log = (message: string): void => void process.stderr.write(`[ext-mcp] ${message}\n`);

try {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const args = parseArgs(process.argv.slice(2), process.env, path.join(root, "data"));
	validateDataRoot(args.dataRoot);
	const server = createServer(createMcpDeps(args.dataRoot), { knowledgeOnly: args.knowledgeOnly, log });
	const transport = new StdioServerTransport(process.stdin, guard.protocolOut, { maxBufferSize: LIMITS.requestMaxBytes });
	await server.connect(transport);
	log(`ready (${args.knowledgeOnly ? "knowledge only" : "knowledge and study"})`);
} catch (error) {
	log(`cannot start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
```

- [ ] **Step 4: Run the tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test --test-timeout=60000 tests/ext-mcp-closure.test.ts tests/ext-mcp-stdio.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp\|scripts/ext-mcp"
npx eslint src/server/ext/mcp tests/ext-mcp-stdio.test.ts tests/ext-mcp-closure.test.ts tests/helpers/mcp-closure.ts
```

Expected: closure: 5 pass; stdio: 6 pass (about 2 seconds); no findings. `scripts/` is on the ESLint ignore list, so `scripts/ext-mcp.ts` is checked by `tsc` only. The 'opens no listening socket' test is skipped when `lsof` is not installed; on macOS it runs, and first proves the probe can see the process.

- [ ] **Step 5: Try it by hand**

```bash
D=$(mktemp -d)
LH_DATA_DIR=$D npx tsx scripts/ext-mcp.ts < /dev/null; echo exit=$?
ls -A $D | wc -l
LH_DATA_DIR=/nonexistent npx tsx scripts/ext-mcp.ts < /dev/null; echo exit=$?
LH_DATA_DIR=$D npx tsx scripts/ext-mcp.ts --write < /dev/null; echo exit=$?
```

Expected: the first run prints '[ext-mcp] ready (knowledge and study)' on stderr and exits 0 when stdin closes, and the directory listing count is 0 (nothing was created in the data directory); the second prints 'cannot start: data directory not found: /nonexistent' and exits 1; the third prints 'cannot start: unknown argument' and exits 1. Nothing is printed on stdout in any case.

- [ ] **Step 6: Commit**

```bash
git add src/server/ext/mcp/stdio-guard.ts src/server/ext/mcp/args.ts scripts/ext-mcp.ts tests/helpers/mcp-closure.ts tests/ext-mcp-closure.test.ts tests/ext-mcp-stdio.test.ts
git commit -m "feat(mcp): stdio entry, stdout guard, process and import-closure tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Bounded outputs at scale

REQ-mcp-08. A fixture with 1,500 nodes (50 KB statements, 40 aliases each), 1,500 chains, 80 goals with 60 targets each, 60 research marks with huge notes, a 60-slide lecture with 20 KB headings, 80 documents and 80 debriefs. Every tool must answer within the response limit; every array must be the `items` of a page that also carries a matching `count` and a boolean `truncated` (a bare array fails the walk); no string exceeds the longest field cap plus the marker; numbers are finite. Limits that are NaN, infinite, fractional, zero, negative, strings or absurdly large fall back or are capped; a query with too many words or characters is refused quickly; depth-2 neighbourhoods of a hub node are capped in nodes and edges.

**Files:**
- Test: `tests/ext-mcp-bounds.test.ts`

- [ ] **Step 1: Write the test**

`tests/ext-mcp-bounds.test.ts`

```typescript
// tests/ext-mcp-bounds.test.ts
/** REQ-mcp-08 at scale: every output of every tool stays bounded, paged and finite. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import fs from "node:fs";
import path from "node:path";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { chain, cleanupAllFixtures, makeFixture, node, type Fixture } from "./helpers/mcp-fixture.ts";
import { call, errorCode, type Json } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const LONG = "L".repeat(50_000);
const MAX_STRING = LIMITS.explanationChars + 100; // the longest field + its truncation marker

function bigFixture(): Fixture {
	const f = makeFixture();
	const alias = (i: number): string => `alias ${i} ${"a".repeat(500)}`;
	for (let i = 0; i < 1500; i++) {
		const id = `n_${String(i).padStart(8, "0")}`;
		f.graph("nodes.jsonl", node(id, `Set concept ${i} ${"N".repeat(400)}`, `${LONG} statement ${i}`, Array.from({ length: 40 }, (_, k) => alias(k))));
	}
	for (let i = 1; i < 1500; i++) {
		f.graph("chains.jsonl", chain(`ch_${i}`, [`n_${String(i - 1).padStart(8, "0")}`, `n_${String(Math.max(0, i - 2)).padStart(8, "0")}`, `n_00000000`], `n_${String(i).padStart(8, "0")}`));
	}
	for (let g = 0; g < 80; g++) {
		f.ext("goals.jsonl", { type: "created", goalId: `goal_${String(g).padStart(12, "0")}`, title: LONG, origin: "user", originRef: "", targetNodeIds: Array.from({ length: 60 }, (_, k) => `n_${String(k).padStart(8, "0")}`), priority: 3, at: "2026-11-01T00:00:00.000Z" });
	}
	for (let m = 0; m < 60; m++) {
		f.ext("frontier.jsonl", { type: "set", markId: `m${m}`, scope: { kind: "node", id: "n_00000000" }, mark: "hold", note: LONG, author: "agent", at: "2026-11-04T00:00:00.000Z" });
	}
	const base = makeLecture();
	const lecture = {
		...base,
		summary: LONG,
		title: LONG,
		slides: [...base.slides, ...Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, heading: LONG.slice(0, 20_000), elements: [{ id: `e${i}`, type: "text", content: `${LONG.slice(0, 20_000)} [[n_${String(i).padStart(8, "0")}]]` }] }))],
	};
	fs.mkdirSync(path.join(f.extDir, "lectures", lecture.id), { recursive: true });
	fs.writeFileSync(path.join(f.extDir, "lectures", lecture.id, "lecture.json"), JSON.stringify(lecture));
	f.ext("explanations.jsonl", { type: "version", nodeId: "n_00000000", version: 1, body: LONG, author: "agent", sourceRefs: [], styleVersion: "abc123abc123", fingerprint: "x", noSource: false, proposed: false, at: "2026-11-02T11:00:00.000Z" });
	return f;
}

/** Every array in a result must be the `items` of a page-shaped object, or a short tuple of scalars; no non-finite number can be serialised. */
function walk(value: Json, where: string, strings: { max: number }): void {
	if (typeof value === "string") {
		strings.max = Math.max(strings.max, value.length);
		return;
	}
	if (typeof value === "number") {
		assert.ok(Number.isFinite(value), `${where}: non-finite number`);
		return;
	}
	if (Array.isArray(value)) {
		throw new Error(`${where}: a bare array escaped the Page wrapper`);
	}
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (k === "items") {
				assert.ok(Array.isArray(v), `${where}.items`);
				assert.equal(typeof value.count, "number", `${where}: items without count`);
				assert.equal(typeof value.truncated, "boolean", `${where}: items without truncated`);
				assert.equal(value.count, (v as Json[]).length, `${where}: count must equal the items returned`);
				assert.ok((v as Json[]).length <= 200, `${where}: page too long`);
				(v as Json[]).forEach((item, i) => walk(item, `${where}.items[${i}]`, strings));
			} else walk(v, `${where}.${k}`, strings);
		}
	}
}

describe("bounded outputs at scale (REQ-mcp-08)", () => {
	it("every tool answers within the response limit, with paged lists and capped strings", () => {
		const f = bigFixture();
		const cases: Array<[string, unknown]> = [
			["search_nodes", { query: "set concept", limit: 50 }], ["search_nodes", { query: "set concept" }],
			["get_node", { id: "n_00000000" }], ["get_node", { id: "n_00000700" }],
			["get_neighbors", { id: "n_00000700", depth: 2 }], ["get_neighbors", { id: "n_00000000", depth: 2 }],
			["list_lectures", {}], ["get_lecture", { id: makeLecture().id }], ["list_goals", { limit: 50 }], ["list_goals", {}], ["get_goal", { id: "goal_000000000000" }],
			["get_daily_plan", {}], ["research_status", {}],
		];
		for (const [tool, input] of cases) {
			const out = call(f, tool, input);
			const bytes = Buffer.byteLength(JSON.stringify(out), "utf-8");
			assert.ok(bytes <= LIMITS.responseMaxBytes, `${tool}: ${bytes} bytes`);
			const strings = { max: 0 };
			walk(out, tool, strings);
			assert.ok(strings.max <= MAX_STRING, `${tool}: a string of ${strings.max} characters`);
		}
		assert.equal(new Set(cases.map(([t]) => t)).size, TOOL_NAMES.length, "every tool is covered by this test");
	});

	it("truncation is explicit: the marker says how much was cut and a page says truncated", () => {
		const f = bigFixture();
		const node0 = call(f, "get_node", { id: "n_00000000" });
		assert.match(JSON.stringify(node0), /… \[truncated: \d+ more characters\]/);
		const r = call(f, "list_goals", { limit: 50 });
		assert.equal(r.count, 50);
		assert.equal(r.truncated, true);
		assert.equal(call(f, "research_status").frontier.truncated, true);
	});

	it("limits that are not positive integers fall back to the default; huge ones are capped", () => {
		const f = bigFixture();
		for (const limit of [Number.NaN, Infinity, -1, 0, 1.5, "10", null, 1e12]) {
			const r = call(f, "search_nodes", { query: "set concept", limit });
			assert.ok(r.count >= 1 && r.count <= LIMITS.listMax, `limit ${String(limit)} gave ${r.count}`);
		}
	});

	it("a long query is refused and a many-word query is bounded (no unbounded parsing time)", () => {
		const f = bigFixture();
		assert.equal(errorCode(f, "search_nodes", { query: "a".repeat(LIMITS.queryMaxChars + 1) }), "invalid_input");
		const started = performance.now();
		assert.equal(errorCode(f, "search_nodes", { query: Array.from({ length: 90 }, () => "a").join(" ") }), "invalid_input", "more than 8 words");
		assert.equal(call(f, "search_nodes", { query: "set concept alpha beta gamma delta epsilon zeta" }).truncated !== undefined, true);
		assert.ok(performance.now() - started < 5000, "the longest allowed query must stay fast");
	});

	it("depth-2 neighbourhoods of a hub node are capped in nodes and edges", () => {
		const f = bigFixture();
		const n = call(f, "get_neighbors", { id: "n_00000000", depth: 2 });
		assert.ok(n.nodes.items.length <= LIMITS.neighbourNodesMax);
		assert.ok(n.edges.items.length <= LIMITS.neighbourEdgesMax);
		assert.equal(n.nodes.truncated, true);
	});
});
```

- [ ] **Step 2: Run it**

```bash
NODE_ENV=test npx tsx --test --test-timeout=60000 tests/ext-mcp-bounds.test.ts
```

Expected: 5 pass in a few seconds. If the first test fails with `a bare array escaped the Page wrapper`, a tool returns an unwrapped array: wrap it with `page()`; if it fails on bytes, lower the cap of the largest field or fit the list to `LIMITS.listBudgetBytes` as `get_recent_debriefs` does (Task 11).

- [ ] **Step 3: Commit**

```bash
git add tests/ext-mcp-bounds.test.ts
git commit -m "test(mcp): every tool stays bounded at scale

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `get_recent_debriefs` (conditional on the session-debriefs plan)

REQ-mcp-13. Run this task only when Task 1 step 5 found `src/core/ext/debrief/journal.ts`. Debriefs come from the app's own `recentDebriefs` reader over `journal.jsonl` (first event per key wins, newest first, corrupt events skipped by `parseJournalEvent`). The tool adds: an ISO instant with an explicit time zone for `since` (the reader silently ignores an unparseable one; this tool refuses it), a closed `kind` list, the latest weekly synthesis alongside the page whatever the filter or page size, commentary capped, facts above 4 KiB replaced by a marker, no internal chat id, and a byte budget (`fitToBudget`) because 50 entries of capped commentary plus facts exceed the 128 KiB response limit (found by the bounds test: 162 KB before the budget existed). The tool belongs to the study group, so `--knowledge-only` disables it.

The code below was verified in a scratch tree against the exact `journal.ts` code block of the session-debriefs plan. If the real exports differ in name or shape, adapt `debriefs.ts` and keep the test file as the specification.

**Files:**
- Create: `src/core/ext/mcp/debriefs.ts`
- Modify: `src/core/ext/mcp/ports.ts`, `src/server/ext/mcp/deps.ts`, `src/core/ext/mcp/tools.ts`, `src/server/ext/mcp/catalog.ts`
- Modify (tests): `tests/ext-mcp-server.test.ts`, `tests/ext-mcp-bounds.test.ts`
- Test: `tests/ext-mcp-debriefs.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/ext-mcp-debriefs.test.ts`

```typescript
// tests/ext-mcp-debriefs.test.ts
/** get_recent_debriefs (REQ-mcp-13). Needs src/core/ext/debrief/journal.ts from the session-debriefs plan. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SESSION_KINDS, debriefId } from "../src/core/ext/debrief/journal.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { DEBRIEF_KINDS } from "../src/server/ext/mcp/catalog.ts";
import { cleanupAllFixtures, makeFixture, type Fixture } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const session = (sessionId: string, sessionKind: string, at: string, over: Record<string, unknown> = {}) => ({
	id: debriefId(sessionId), kind: "session", sessionId, sessionKind, weekOf: null, at,
	facts: { kind: sessionKind, cards: 3 }, commentary: `Commentary of ${sessionId}`, nullReason: null, author: "agent", ...over,
});
const weekly = (weekOf: string, at: string) => ({
	id: debriefId(`weekly:${weekOf}`), kind: "weekly", sessionId: null, sessionKind: null, weekOf, at,
	facts: { kind: "weekly", sessions: 4 }, commentary: "Weekly text", nullReason: null, author: "agent",
});

function seedJournal(f: Fixture): void {
	f.ext("journal.jsonl", session("s1", "review", "2026-11-01T10:00:00.000Z"));
	f.ext("journal.jsonl", session("s2", "lecture", "2026-11-02T10:00:00.000Z"));
	f.ext("journal.jsonl", session("s3", "review", "2026-11-03T10:00:00.000Z"));
	f.ext("journal.jsonl", weekly("2026-10-26", "2026-11-02T08:00:00.000Z"));
	f.ext("journal.jsonl", weekly("2026-11-02", "2026-11-04T08:00:00.000Z"));
}

describe("get_recent_debriefs (REQ-mcp-13)", () => {
	it("the zod kind list is the journal's session kinds plus weekly", () => {
		assert.deepEqual([...DEBRIEF_KINDS], [...SESSION_KINDS, "weekly"]);
	});

	it("newest first, with the latest weekly synthesis alongside, bounded and paged", () => {
		const f = makeFixture();
		seedJournal(f);
		const r = call(f, "get_recent_debriefs");
		assert.deepEqual(r.debriefs.items.map((e: { at: string }) => e.at), [
			"2026-11-04T08:00:00.000Z", "2026-11-03T10:00:00.000Z", "2026-11-02T10:00:00.000Z", "2026-11-02T08:00:00.000Z", "2026-11-01T10:00:00.000Z",
		]);
		assert.equal(r.debriefs.count, 5);
		assert.equal(r.debriefs.truncated, false);
		assert.equal(r.latestWeekly.weekOf, "2026-11-02");
		assert.deepEqual(r.latestWeekly.facts, { kind: "weekly", sessions: 4 });
		assert.ok(!("sessionId" in r.debriefs.items[1]), "no internal chat id is exposed");
	});

	it("filters by kind and since; limit truncates explicitly", () => {
		const f = makeFixture();
		seedJournal(f);
		assert.equal(call(f, "get_recent_debriefs", { kind: "review" }).debriefs.count, 2);
		assert.equal(call(f, "get_recent_debriefs", { kind: "weekly" }).debriefs.count, 2);
		assert.equal(call(f, "get_recent_debriefs", { since: "2026-11-03T00:00:00Z" }).debriefs.count, 2);
		const two = call(f, "get_recent_debriefs", { limit: 2 });
		assert.equal(two.debriefs.count, 2);
		assert.equal(two.debriefs.truncated, true);
		assert.equal(two.latestWeekly.weekOf, "2026-11-02", "the weekly synthesis does not depend on the page");
	});

	it("rejects unknown kinds, zone-less or unparseable instants; falls back for bad limits", () => {
		const f = makeFixture();
		seedJournal(f);
		for (const input of [{ kind: "daily" }, { since: "2026-11-03" }, { since: "yesterday" }, { since: 5 }, { kind: 3 }]) {
			expectError(f, "get_recent_debriefs", input, "invalid_input");
		}
		for (const limit of [Number.NaN, 0, -2, 2.5, 1e9, "3"]) {
			const r = call(f, "get_recent_debriefs", { limit });
			assert.ok(r.debriefs.count >= 1 && r.debriefs.count <= LIMITS.debriefsMax);
		}
	});

	it("a duplicate key keeps the first debrief; corrupt lines and invalid events are skipped", () => {
		const f = makeFixture();
		f.ext("journal.jsonl", session("dup", "study", "2026-11-01T10:00:00.000Z", { commentary: "first" }));
		f.ext("journal.jsonl", session("dup", "study", "2026-11-02T10:00:00.000Z", { commentary: "second" }));
		f.ext("journal.jsonl", "{not json");
		f.ext("journal.jsonl", { id: "x", kind: "session" });
		const r = call(f, "get_recent_debriefs");
		assert.equal(r.debriefs.count, 1);
		assert.equal(r.debriefs.items[0].commentary, "first");
	});

	it("oversized commentary is capped with the marker and oversized facts are replaced by a marker", () => {
		const f = makeFixture();
		f.ext("journal.jsonl", session("big", "review", "2026-11-01T10:00:00.000Z", { commentary: "c".repeat(20_000), facts: { kind: "review", blob: "f".repeat(20_000) } }));
		const e = call(f, "get_recent_debriefs").debriefs.items[0];
		assert.match(e.commentary, /… \[truncated: \d+ more characters\]$/);
		assert.deepEqual(e.facts, { kind: "review", omitted: "facts exceed the size limit" });
	});

	it("a null commentary (ceiling or error) is reported with its reason; nothing yet gives an empty page", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "get_recent_debriefs"), { debriefs: { items: [], count: 0, truncated: false }, latestWeekly: null });
		f.ext("journal.jsonl", session("n", "review", "2026-11-01T10:00:00.000Z", { commentary: null, nullReason: "ceiling" }));
		const e = call(f, "get_recent_debriefs").debriefs.items[0];
		assert.equal(e.commentary, null);
		assert.equal(e.nullReason, "ceiling");
	});

	it("is disabled by --knowledge-only", () => {
		const f = makeFixture();
		seedJournal(f);
		expectError(f, "get_recent_debriefs", {}, "disabled", true);
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-debriefs.test.ts
```

Expected: FAIL: `get_recent_debriefs` is an unknown tool and `DEBRIEF_KINDS` is not exported.

- [ ] **Step 3: Implement**

`src/core/ext/mcp/debriefs.ts`

```typescript
// src/core/ext/mcp/debriefs.ts
/**
 * get_recent_debriefs (REQ-mcp-13): session debriefs and the latest weekly
 * synthesis, from the app's own recentDebriefs reader (first event per key
 * wins, newest first). Facts are a computed object; they are kept only when
 * small, otherwise replaced by a marker, so one entry cannot fill the response.
 */

import { recentDebriefs, SESSION_KINDS, type JournalEvent } from "../debrief/journal.ts";
import type { Call } from "./call.ts";
import { optionalEnum, parseInstant } from "./input.ts";
import { capText, clampLimit, fitToBudget, LIMITS, page } from "./limits.ts";

const KINDS = [...SESSION_KINDS, "weekly"] as const;

function entry(e: JournalEvent) {
	const factsText = JSON.stringify(e.facts);
	const small = factsText !== undefined && Buffer.byteLength(factsText, "utf-8") <= LIMITS.factsBytes;
	return {
		id: capText(e.id, LIMITS.idMaxChars),
		kind: e.kind,
		sessionKind: e.sessionKind,
		weekOf: e.weekOf,
		at: e.at,
		facts: small ? e.facts : { kind: e.facts.kind, omitted: "facts exceed the size limit" },
		commentary: e.commentary === null ? null : capText(e.commentary, LIMITS.commentaryChars),
		nullReason: e.nullReason,
	};
}

export function getRecentDebriefs(call: Call, input: Record<string, unknown>) {
	const limit = clampLimit(input.limit, LIMITS.debriefsDefault, LIMITS.debriefsMax);
	const kind = optionalEnum(input.kind, KINDS, "kind");
	const since = input.since === undefined ? undefined : parseInstant(input.since, "since");
	const journal = call.deps.journal.readAll();
	// The reader reports truncation against its own limit; ask for one more to know whether more exist.
	const found = recentDebriefs(journal, { limit: Math.min(limit + 1, LIMITS.debriefsMax + 1), kind, since });
	const debriefs = page(found.entries, limit);
	const weekly = recentDebriefs(journal, { limit: 1, kind: "weekly" }).entries[0];
	const items = fitToBudget({ ...debriefs, items: debriefs.items.map(entry) }, LIMITS.listBudgetBytes);
	return { debriefs: items, latestWeekly: weekly === undefined ? null : entry(weekly) };
}
```

Wire it in. In `src/core/ext/mcp/ports.ts` add the import `import type { JournalEvent } from "../debrief/journal.ts";` (next to the other type imports) and, in `McpDeps`, after `researchLog`:

```typescript
	journal: ReadLog<JournalEvent>;
```

In `src/server/ext/mcp/deps.ts` add `import { parseJournalEvent } from "../../../core/ext/debrief/journal.ts";` and, in the returned record, before `lectures`:

```typescript
		journal: readOnlyLedger(extDir, "journal.jsonl", parseJournalEvent),
```

In `src/core/ext/mcp/tools.ts` add `import { getRecentDebriefs } from "./debriefs.ts";` and, after the `research_status` row:

```typescript
	get_recent_debriefs: { group: "study", fields: ["limit", "since", "kind"], run: (c, i) => getRecentDebriefs(c, i) },
```

In `src/server/ext/mcp/catalog.ts`, above `const strict`, add the kind list (a test pins it to the journal's `SESSION_KINDS`), and add the entry before the closing `};`:

```typescript
/** The session kinds of the journal plus "weekly" (a test pins this list to SESSION_KINDS). */
export const DEBRIEF_KINDS = ["review", "lecture", "office_hours", "study", "exercises", "weekly"] as const;
```

```typescript
	get_recent_debriefs: {
		title: "Read recent session debriefs",
		description:
			"Newest-first session debriefs and the latest weekly synthesis with their computed facts and commentary. since is an ISO-8601 instant with a time zone. Study-state group. Read-only.",
		input: strict({
			limit: z.number().int().min(1).max(LIMITS.debriefsMax).optional(),
			since: z.string().min(10).max(40).optional(),
			kind: z.enum(DEBRIEF_KINDS).optional(),
		}),
	},
```

Extend two existing tests so the new tool is covered by the shared walks. In `tests/ext-mcp-server.test.ts`, in the `valid` map of the contract-smoke test add:

```typescript
			get_recent_debriefs: [{}, { limit: 5, since: "2026-11-01T00:00:00Z", kind: "weekly" }],
```

In `tests/ext-mcp-bounds.test.ts` add `["get_recent_debriefs", { limit: 50 }]` to `cases`, and inside `bigFixture()` before the `explanations.jsonl` line add:

```typescript
	for (let j = 0; j < 80; j++) {
		f.ext("journal.jsonl", { id: `deb_${String(j).padStart(12, "0")}`, kind: "session", sessionId: `s${j}`, sessionKind: "review", weekOf: null, at: "2026-11-01T10:00:00.000Z", facts: { kind: "review", blob: LONG }, commentary: LONG, nullReason: null, author: "agent" });
	}
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-debriefs.test.ts tests/ext-mcp-server.test.ts tests/ext-mcp-bounds.test.ts tests/ext-mcp-immutable.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/core/ext/mcp src/server/ext/mcp tests/ext-mcp-debriefs.test.ts
```

Expected: all pass (8 new tests); no findings. The bounds test fails with `162572 bytes` if the `fitToBudget` line in `debriefs.ts` is removed.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/mcp src/server/ext/mcp tests/ext-mcp-debriefs.test.ts tests/ext-mcp-server.test.ts tests/ext-mcp-bounds.test.ts
git commit -m "feat(mcp): get_recent_debriefs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `list_documents` (conditional on the assisted-study plan)

REQ-mcp-14. Run this task only when Task 1 step 5 found `src/core/ext/study/documents.ts` and `reading.ts`. Registered PDFs with title, page count, last page and reading progress, from the app's own `deriveDocuments` and `deriveReading` (a page counts as read after the dwell time; a page beyond the page count is ignored; the first registration of a document wins). No file path and no chat id leave the server. Study group: disabled by `--knowledge-only`.

**Files:**
- Create: `src/core/ext/mcp/documents.ts`
- Modify: `src/core/ext/mcp/ports.ts`, `src/server/ext/mcp/deps.ts`, `src/core/ext/mcp/tools.ts`, `src/server/ext/mcp/catalog.ts`, `tests/ext-mcp-server.test.ts`, `tests/ext-mcp-bounds.test.ts`
- Test: `tests/ext-mcp-documents.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/ext-mcp-documents.test.ts`

```typescript
// tests/ext-mcp-documents.test.ts
/** list_documents (REQ-mcp-14). Needs src/core/ext/study/documents.ts and reading.ts from the assisted-study plan. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { cleanupAllFixtures, makeFixture } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("list_documents (REQ-mcp-14)", () => {
	const A = "a".repeat(64);
	const B = "b".repeat(64);

	it("lists title, page count and reading progress, newest registration first, without chat ids", () => {
		const f = makeFixture();
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "Probability", pageCount: 10, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: B, title: "Algebra", pageCount: 4, at: "2026-11-02T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "chat", documentId: A, chatId: "chat_secret_1", at: "2026-11-01T10:05:00.000Z" });
		for (const [page, at] of [[1, "10:00:00"], [2, "10:00:10"], [3, "10:00:12"], [2, "10:00:14"]] as const) {
			f.ext("reading.jsonl", { type: "visit", documentId: A, page, at: `2026-11-03T${at}.000Z` });
		}
		f.ext("reading.jsonl", { type: "close", documentId: A, at: "2026-11-03T10:02:00.000Z" });
		const r = call(f, "list_documents");
		assert.deepEqual(r.items.map((d: { title: string }) => d.title), ["Algebra", "Probability"]);
		const prob = r.items[1];
		assert.equal(prob.pageCount, 10);
		assert.equal(prob.lastPage, 2);
		assert.equal(prob.readPages, 2, "pages 1 and 2 dwelt long enough; page 3 only 2 seconds");
		assert.equal(prob.readShare, 0.2);
		assert.equal(r.items[0].lastPage, null);
		assert.equal(r.items[0].readShare, 0);
		const text = JSON.stringify(r);
		assert.ok(!text.includes("chat_secret_1") && !text.includes("chatId"));
	});

	it("empty, corrupt and duplicate registrations", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "list_documents"), { items: [], count: 0, truncated: false });
		f.ext("documents.jsonl", "garbage");
		f.ext("documents.jsonl", { type: "registered", documentId: "short", title: "x", pageCount: 3, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "First", pageCount: 3, at: "2026-11-01T10:00:00.000Z" });
		f.ext("documents.jsonl", { type: "registered", documentId: A, title: "Second", pageCount: 99, at: "2026-11-02T10:00:00.000Z" });
		f.ext("reading.jsonl", { type: "visit", documentId: A, page: 99, at: "2026-11-03T10:00:00.000Z" });
		const r = call(f, "list_documents");
		assert.equal(r.count, 1);
		assert.equal(r.items[0].title, "First");
		assert.equal(r.items[0].lastPage, null, "a page beyond the page count is ignored");
	});

	it("is bounded and disabled by --knowledge-only", () => {
		const f = makeFixture();
		for (let i = 0; i < 130; i++) {
			f.ext("documents.jsonl", { type: "registered", documentId: i.toString(16).padStart(64, "0"), title: `Doc ${i}`, pageCount: 5, at: `2026-11-01T10:${String(i % 60).padStart(2, "0")}:00.000Z` });
		}
		const r = call(f, "list_documents");
		assert.equal(r.count, LIMITS.documentsMax);
		assert.equal(r.truncated, true);
		expectError(f, "list_documents", {}, "disabled", true);
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-documents.test.ts
```

Expected: FAIL: `list_documents` is an unknown tool.

- [ ] **Step 3: Implement**

`src/core/ext/mcp/documents.ts`

```typescript
// src/core/ext/mcp/documents.ts
/** list_documents (REQ-mcp-14): registered PDFs with title, page count and reading progress. No file path, no chat id. */

import { deriveDocuments } from "../study/documents.ts";
import { deriveReading } from "../study/reading.ts";
import type { Call } from "./call.ts";
import { capText, LIMITS, page, round4 } from "./limits.ts";

export function listDocuments(call: Call) {
	const events = call.deps.reading.readAll();
	const docs = deriveDocuments(call.deps.documents.readAll()).sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : a.registeredAt > b.registeredAt ? -1 : a.id < b.id ? -1 : 1));
	const p = page(docs, LIMITS.documentsMax);
	return {
		...p,
		items: p.items.map((d) => {
			const reading = deriveReading(events, d.id, { pageCount: d.pageCount });
			return {
				id: d.id,
				title: capText(d.title, LIMITS.titleChars),
				pageCount: d.pageCount,
				registeredAt: d.registeredAt,
				lastPage: reading.lastPage,
				readPages: reading.readPages.length,
				readShare: round4(reading.readPages.length / d.pageCount),
			};
		}),
	};
}
```

Wire it in. In `src/core/ext/mcp/ports.ts` add `import type { DocumentEvent } from "../study/documents.ts";` and `import type { ReadingEvent } from "../study/reading.ts";`, and in `McpDeps`:

```typescript
	documents: ReadLog<DocumentEvent>;
	reading: ReadLog<ReadingEvent>;
```

In `src/server/ext/mcp/deps.ts` add `import { parseDocumentEvent } from "../../../core/ext/study/documents.ts";` and `import { parseReadingEvent } from "../../../core/ext/study/reading.ts";`, and in the returned record, before `lectures`:

```typescript
		documents: readOnlyLedger(extDir, "documents.jsonl", parseDocumentEvent),
		reading: readOnlyLedger(extDir, "reading.jsonl", parseReadingEvent),
```

In `src/core/ext/mcp/tools.ts` add `import { listDocuments } from "./documents.ts";` and the row (after the last `study` row):

```typescript
	list_documents: { group: "study", fields: [], run: (c) => listDocuments(c) },
```

In `src/server/ext/mcp/catalog.ts` add the entry before the closing `};`:

```typescript
	list_documents: {
		title: "List registered documents",
		description: "Registered PDFs with title, page count and reading progress. Study-state group. Read-only.",
		input: strict({}),
	},
```

In `tests/ext-mcp-server.test.ts`, in the `valid` map of the contract-smoke test add:

```typescript
			list_documents: [{}],
```

In `tests/ext-mcp-bounds.test.ts` add `["list_documents", {}]` to `cases`, and inside the `for (let j = 0; j < 80; j++)` loop of `bigFixture()` (add that loop if Task 11 was skipped) add:

```typescript
		f.ext("documents.jsonl", { type: "registered", documentId: j.toString(16).padStart(64, "0"), title: LONG, pageCount: 9, at: "2026-11-01T10:00:00.000Z" });
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-documents.test.ts tests/ext-mcp-server.test.ts tests/ext-mcp-bounds.test.ts tests/ext-mcp-immutable.test.ts
npx tsc --noEmit 2>&1 | grep "ext/mcp\|ext-mcp"
npx eslint src/core/ext/mcp src/server/ext/mcp tests/ext-mcp-documents.test.ts
```

Expected: all pass (3 new tests); no findings.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/mcp src/server/ext/mcp tests/ext-mcp-documents.test.ts tests/ext-mcp-server.test.ts tests/ext-mcp-bounds.test.ts
git commit -m "feat(mcp): list_documents

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Contract document, touchpoint note and consumer hand-off

REQ-mcp-12. The server's contract is documented in `docs/ext/CONTRACTS.md` in language-neutral terms, and a test keeps the document and the code from drifting: every tool, every input field, every error code and the headline bounds must appear in it. Also in this task: the `TOUCHPOINTS.md` note and the hand-off notes for the daily-schedule project. **This plan does not edit these two documents itself; this task is where the executor does.**

**Files:**
- Modify: `docs/ext/CONTRACTS.md` (append one section at the end)
- Modify: `docs/ext/TOUCHPOINTS.md` (one sentence replaced, one paragraph added; no table row)
- Test: `tests/ext-mcp-contract-doc.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ext-mcp-contract-doc.test.ts`

```typescript
// tests/ext-mcp-contract-doc.test.ts
/**
 * REQ-mcp-12: the language-neutral contract in docs/ext/CONTRACTS.md names every
 * tool, every input field, every error code and the headline bounds of the code.
 * A tool or field added without documentation fails here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ToolErrorCode } from "../src/core/ext/mcp/errors.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { toolFields, TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";

const doc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "ext", "CONTRACTS.md"), "utf-8");
const section = doc.slice(doc.indexOf("## MCP server (read-only, stdio)"));

const ERROR_CODES: ToolErrorCode[] = ["invalid_input", "not_found", "disabled", "data_newer_than_build", "data_too_large", "data_inconsistent", "response_too_large", "internal"];

describe("the MCP contract document (REQ-mcp-12)", () => {
	it("has the MCP section", () => {
		assert.ok(section.startsWith("## MCP server"), "section missing");
	});

	it("describes every tool, with every one of its input fields, in the tool's own paragraph", () => {
		for (const name of TOOL_NAMES) {
			const start = section.indexOf(`\`${name}\` input:`);
			assert.ok(start >= 0, `${name} is not documented`);
			const end = section.indexOf("\n\n", start);
			const paragraph = section.slice(start, end < 0 ? undefined : end);
			for (const field of toolFields(name)) assert.ok(paragraph.includes(`\`${field}\``), `${name}: input field ${field} is not documented`);
			assert.ok(paragraph.includes("Output:"), `${name}: output is not documented`);
		}
	});

	it("lists every error code", () => {
		for (const code of ERROR_CODES) assert.ok(section.includes(`\`${code}\``), code);
	});

	it("states the bounds the code enforces", () => {
		assert.ok(section.includes(`${LIMITS.responseMaxBytes / 1024} KiB`));
		assert.ok(section.includes(`${LIMITS.requestMaxBytes / 1024} KiB`));
		assert.ok(section.includes(`${LIMITS.ledgerMaxBytes / 1024 / 1024} MiB`));
		assert.ok(section.includes(`${LIMITS.queryMaxChars} characters, ${LIMITS.queryMaxTokens} words`));
		assert.ok(section.includes(`${LIMITS.neighbourNodesMax} nodes, ${LIMITS.neighbourEdgesMax} edges`));
		assert.ok(section.includes(`${LIMITS.futureDaysMax} days`));
		assert.ok(section.includes(`${LIMITS.listDefault} / ${LIMITS.listMax}`));
		if (TOOL_NAMES.includes("get_recent_debriefs")) {
			assert.ok(section.includes(`${LIMITS.listBudgetBytes / 1024} KiB`));
			assert.ok(section.includes(`${LIMITS.factsBytes / 1024} KiB`));
		}
	});

	it("states the read-only facts a consumer relies on", () => {
		for (const phrase of ["readOnlyHint: true", "never writes", "no socket", "format.json", "--knowledge-only", "LH_DATA_DIR"]) assert.ok(section.includes(phrase), phrase);
	});
});
```

- [ ] **Step 2: Run to see it fail**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-contract-doc.test.ts
```

Expected: FAIL on the first test (`section missing`); the others fail on `Cannot read` or on the missing tools.

- [ ] **Step 3: Append the contract section to `docs/ext/CONTRACTS.md`**

Append exactly this at the end of the file (one blank line before the heading). If Task 11 or 12 was skipped, delete the paragraph of the tool that does not exist (`get_recent_debriefs`, `list_documents`) and, for Task 11, the sentence about facts and the debriefs part of the first row of the bounds table; the test is written to accept that.

````markdown
## MCP server (read-only, stdio)

Process: `LH_DATA_DIR=<data directory> npx tsx scripts/ext-mcp.ts [--knowledge-only]`, started by the client, speaking MCP (JSON-RPC 2.0, newline-delimited) over stdin/stdout. Stdout carries only protocol; diagnostics go to stderr. The server reads `ext/*.jsonl`, `ext/lectures/*/lecture.json` and `graph/*.jsonl`; it never writes, creates, locks or stamps anything; it opens no socket and calls no model. Corrupt or torn ledger lines are skipped. A `format.json` stamp newer than the build makes every tool fail with `data_newer_than_build`. A request line above 256 KiB ends the session (the client restarts the process).

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`. Every input object is strict: an unknown field is an error, never ignored. Arguments are validated twice (JSON Schema at the protocol edge, the same rules in the core).

### Result envelope

Success: `structuredContent` is the tool's result object and `content[0].text` is the same object as JSON; `isError` is false.
Failure: `isError` is true and `structuredContent` is `{"error": {"code": <code>, "message": <fixed text>}}`. Messages never contain a path, a stack trace or a raw exception text.

| Error code | Meaning |
|---|---|
| `invalid_input` | argument missing, mistyped, out of range or unknown |
| `not_found` | unknown id (or unknown tool) |
| `disabled` | tool or filter disabled by `--knowledge-only` |
| `data_newer_than_build` | a stamp is newer than this build understands |
| `data_too_large` | a ledger file exceeds the 128 MiB read ceiling |
| `data_inconsistent` | the review history cannot be replayed |
| `response_too_large` | the result would exceed 128 KiB; narrow the request |
| `internal` | anything else (details only on stderr) |

### Bounds

Every list is a page `{items, count, truncated}` (`count` is the number of items returned). Long text ends with `… [truncated: N more characters]`. Numbers are finite or `null`.

| Bound | Value |
|---|---|
| default / maximum `limit` | 20 / 50 (debriefs 10 / 50, and at most 96 KiB of entries) |
| query | 200 characters, 8 words |
| id | 200 characters |
| statement / explanation / quote | 2000 / 6000 / 400 characters |
| neighbourhood | 60 nodes, 120 edges |
| lectures / documents | 100 each |
| response | 128 KiB |
| future day for `get_daily_plan` | 30 days |

### Knowledge group

`search_nodes` input: `query` (string, required), `limit` (integer 1..50), `trust` (`unverified|sourced|contested|refuted`), `goalId` (string; needs study state). Output: `{query, items[{id, name, statement, trust}], count, truncated}`.

`get_node` input: `id`. Output: `{id, name, statement, aliases(page), trust{level, checkedAt, evidence(page)}, explanation{state, noSourceContext, form, version, author, body, pendingProposal}, arguments(page of {premises(page)}), conclusions(page), citingLectures(page), studyState, cardCount, review{dueAt, recallProbability, reps, pinned, retired}|null, reviewUnavailable, goals(page)}`. Under `--knowledge-only` the last five fields are absent and `studyState` is `"disabled"`. `explanation.state` says when the text is stale; `noSourceContext` is true when it was written without source context. Evidence carries a source label, never a local path, query string or credential.

`get_neighbors` input: `id`, `depth` (1 or 2). Output: `{center, depth, nodes(page of {id, name, depth, trust}), edges(page of {from, to})}`.

`list_lectures` input: `chapter` (integer chapter number). Output: page of `{id, title, bookTitle, chapter, order, createdAt, slideCount, exerciseCount, citedNodeCount}`.

`get_lecture` input: `id`. Output: outline `{id, title, bookTitle, chapter, order, summary, createdAt, slides(page), exercises(page of {blockId, slideId, seconds, prompt, nodeIds}), citedNodes(page)}`. Narration text is never returned.

### Study-state group (disabled by `--knowledge-only`)

`list_goals` input: `status` (`active|paused|reached`), `limit`. Output: page of `{id, title, status, priority, origin, createdAt, targetCount, scopeSize, solidNodes, solidShare, ready}`.

`get_goal` input: `id`. Output: `{id, title, status, priority, origin, createdAt, updatedAt, desiredRetention, targets(page), scope{size, solid, solidShare, ready, byTrust}, due{dueNow, unseen, scheduled}, exerciseSet{state: none|in_progress|complete|applied, exercises, graded}}`. Exercise prompts and reference solutions are never returned.

`get_daily_plan` input: `date` (`YYYY-MM-DD`, server local zone; today or up to 30 days ahead). Output: `{date, asOf, timezone, budgetMinutes, spentMinutes, remainingMinutes, due{fixed, dialogic, total}, newItems{fixed, dialogic, total}, planned{total, estimatedMinutes}, newCardQuota, capacity, deferred, needsCard, exerciseSetPending, pendingGoals(page)}`. The numbers come from the app's own plan function over the same data, time and default parameters. A future date is planned as of its last millisecond with nothing spent.

`research_status` input: none. Output: `{frontier(page of {id, scope, mark, maxDepth, budgetUsd, note, author, at}), inbox{pending, approved, rejected, activated, total}, lastCycle{cycleId, trigger, startedAt, endedAt, stoppedBy, gaps, nodesAdded, costUsd, watch}|null}`. Source locators, rationales, error texts and steering messages are never returned.

`get_recent_debriefs` input: `limit`, `since` (ISO-8601 instant with a time zone), `kind` (`review|lecture|office_hours|study|exercises|weekly`). Output: `{debriefs(page of {id, kind, sessionKind, weekOf, at, facts, commentary, nullReason}), latestWeekly}`. Facts above 4 KiB are replaced by `{kind, omitted}`.

`list_documents` input: none. Output: page of `{id, title, pageCount, registeredAt, lastPage, readPages, readShare}`. No file path and no chat id.
````

- [ ] **Step 4: Touchpoint note in `docs/ext/TOUCHPOINTS.md`**

The file ends with this paragraph:

```
Planned (not yet touched): the PDF viewer
and MCP dependencies in `package.json`.
```

Replace it with the following (the MCP dependency turned out to be an existing upstream dependency, so the planned `package.json` touchpoint is not needed):

```
Planned (not yet touched): the PDF viewer.

MCP server: no touchpoint. The entry is `scripts/ext-mcp.ts` (inside the `scripts/ext-*`
exclusion above) and its code lives under `src/**/ext/**`. `@modelcontextprotocol/sdk` 1.32.1 is
already an upstream dependency, so `package.json` is unchanged; there is deliberately no `npm run`
script for the server (it would edit `package.json`): launch it with
`LH_DATA_DIR=<data directory> npx tsx scripts/ext-mcp.ts [--knowledge-only]`.
`src/server/ext/personal-layer.ts` re-exports `startOfLocalDay` from `src/core/ext/local-day.ts`
(both under the exclusion).
```

No row is added to the table: the closed list of edited upstream files does not grow.

- [ ] **Step 5: Run the document test and the touchpoint check**

```bash
NODE_ENV=test npx tsx --test tests/ext-mcp-contract-doc.test.ts
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*' | tail -n 3
```

Expected: 5 tests pass; the touchpoint summary is identical to the one recorded in Task 1 step 6 (this plan edits no upstream file).

- [ ] **Step 6: Commit**

```bash
git add docs/ext/CONTRACTS.md docs/ext/TOUCHPOINTS.md tests/ext-mcp-contract-doc.test.ts
git commit -m "docs(mcp): language-neutral contract, touchpoint note, doc consistency test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand-off notes for the daily-schedule project (a different repository, `Sistema/UI-AI-workspace/backend`; nothing to commit here)**

Give the user these notes; the registration is a separate piece of work in that project.

1. **Register a stdio server** in the options of the Claude Agent SDK agents that plan the day. The server key `learning` makes the tools appear as `mcp__learning__<tool>`:

   ```python
   mcp_servers={
       "learning": {
           "type": "stdio",
           "command": "<learnharness>/node_modules/.bin/tsx",
           "args": ["<learnharness>/scripts/ext-mcp.ts"],          # add "--knowledge-only" for an agent that must not see performance data
           "env": {"LH_DATA_DIR": "<data directory>", "PATH": "<dir of node>:/usr/bin:/bin"},
       }
   }
   ```

   Use absolute paths (the working directory of the child is not guaranteed). Pass a **minimal environment**: the server needs no API key and reads none, so none should be inherited.
2. **Permissions are fail-closed in `agents/permissions.py`:** add an explicit set, never a wildcard, so a tool added later is not allowed by accident:
   `LEARNING_TOOLS = {"mcp__learning__search_nodes", "mcp__learning__get_node", "mcp__learning__get_neighbors", "mcp__learning__list_lectures", "mcp__learning__get_lecture", "mcp__learning__list_goals", "mcp__learning__get_goal", "mcp__learning__get_daily_plan", "mcp__learning__research_status", "mcp__learning__get_recent_debriefs", "mcp__learning__list_documents"}`
   and grant it only to the planning agent(s). For an agent started with `--knowledge-only`, grant only the first five names.
3. **Opt-in and degrade gracefully:** gate the registration behind a flag (for example `LEARNING_MCP_ENABLED`, default off). If the process cannot start (the data directory is missing, exit code 1, reason on stderr) the agent should continue without it.
4. **What the consumer must expect:** every result is `structuredContent`; check `isError` and `error.code` (`not_found`, `invalid_input`, `data_newer_than_build`...). `get_daily_plan` is a snapshot at call time and may differ from the app a moment later. An oversized request ends the session; the SDK client restarts the process on the next call.
5. **Not covered (a later list of narrow write actions):** marking a study block done, creating goals, any change of state; semantic search; plans for past days.

---

### Task 14: Final verification

**Files:** none changed (unless a check fails).

- [ ] **Step 1: The whole MCP suite, then the whole project**

```bash
NODE_ENV=test npx tsx --test --test-timeout=120000 tests/ext-mcp-*.test.ts 2>&1 | tail -n 10
NODE_ENV=test npx tsx --test tests/*.test.ts tests/*.test.tsx 2>&1 | tail -n 12
npx tsc --noEmit 2>&1 | tail -n 3
npx eslint . 2>&1 | tail -n 3
```

Expected: the MCP files pass (124 tests with Tasks 11 and 12: input 17, readonly 12, knowledge 23, study 15, dispatch 5, immutable 9, server 11, closure 5, stdio 6, bounds 5, contract-doc 5, debriefs 8, documents 3); the whole project shows the Task 1 baseline failures only plus the new passing tests; tsc and eslint show nothing new compared with the Task 1 baseline.

- [ ] **Step 2: Touchpoint check (REQ-int-04)**

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*' | tail -n 3
git status --short | grep -v "ext" | head
```

Expected: same summary as Task 1 step 6; no unexpected file outside the exclusion list.

- [ ] **Step 3: Both supported Node versions**

```bash
source ~/.nvm/nvm.sh
nvm use 22 && NODE_ENV=test npx tsx --test --test-timeout=120000 tests/ext-mcp-*.test.ts 2>&1 | grep -E "^# (pass|fail)"
nvm use 26
```

Expected: `# pass` with all tests and `# fail 0` on Node 22 (TAP output) as well as on 26.

- [ ] **Step 4: Real data, real client, digest before and after**

Run the server against the real data directory with the SDK's own client, and prove the directory did not change. The client script is a hidden, untracked file in the fork's root (so the SDK import resolves) and the last command deletes it:

```bash
DATA=${LH_DATA_DIR:-$PWD/data}
before=$(find "$DATA" -type f -exec stat -f '%m %z %N' {} + | sort | shasum)
cat > .ext-mcp-smoke.mts <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "scripts/ext-mcp.ts"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LH_DATA_DIR: process.env.LH_DATA_DIR ?? "" }, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
for (const name of ["get_daily_plan", "research_status", "list_goals", "list_lectures"]) {
  const r = await client.callTool({ name, arguments: {} });
  console.log(name, r.isError ? "ERROR" : "ok", JSON.stringify(r.structuredContent).slice(0, 160));
}
await client.close();
EOF
LH_DATA_DIR="$DATA" npx tsx .ext-mcp-smoke.mts
after=$(find "$DATA" -type f -exec stat -f '%m %z %N' {} + | sort | shasum)
[ "$before" = "$after" ] && echo UNCHANGED || echo CHANGED
rm .ext-mcp-smoke.mts
```

Expected: the tool list, four `ok` lines with plausible numbers for your real data (`get_daily_plan` should match what the app's daily plan shows at that moment, up to the snapshot caveat), and `UNCHANGED`. A `CHANGED` result is a release blocker: it means the app (not the server) wrote in between, or the server did; re-run with the app closed.

- [ ] **Step 5: Mutation spot-checks of the other layers (each one: edit, run, expect failure, revert)**

| Edit | Run | Expected failure |
|---|---|---|
| in `src/server/ext/mcp/server.ts`, make the `internal` failure use `String(error)` instead of the fixed message | `tests/ext-mcp-server.test.ts` | `an unexpected internal error is the fixed internal message...` |
| in `src/server/ext/mcp/deps.ts`, add `import "../../../../config.ts";` | `tests/ext-mcp-closure.test.ts` | `contains the entry, the read-only layer and nothing from...` names `config.ts` |
| in `src/store/ext/readonly.ts`, add `fs.appendFileSync(file, "");` as the first line of `readJsonl` | `tests/ext-mcp-immutable.test.ts`, `tests/ext-mcp-closure.test.ts` | tripwire / write-API scan |
| in `src/core/ext/mcp/plan.ts`, change `total: plan.due` to `total: plan.due + 1` | `tests/ext-mcp-study.test.ts` | the REQ-mcp-07 parity test (`gives the same numbers as the app's computePlan...`) |

Revert every edit (`git checkout -- <file>`), re-run the suite: green.

- [ ] **Step 6: Report**

Tell the user what was built, the pinned SDK version (1.32.1), the test counts, the Task 14 step 4 outcome, which tasks were skipped (11, 12) if any, and the decisions below.

No commit in this task (nothing changed).

## Self-review

### 1. Spec coverage by REQ id

| REQ | What it demands | Tasks | Evidence |
|---|---|---|---|
| REQ-mcp-01 | standalone stdio process, reads the data directory, runs without the app, no model calls | 3, 8, 9 | process tests over real pipes (Task 9); closure test: no agent, model, settings or key code reachable (Task 9); read-only layer (Task 3) |
| REQ-mcp-02 | never writes any file, stamps included | 3, 6, 7, 8, 9, 14 | write methods that throw (3); dispatcher refuses unknown/write-shaped arguments (6); recursive digest plus `fs` tripwire after every call of every tool in six data states (7); write-shaped input over the protocol, write-named tools (8); closure scan for write APIs and a digest around the real process (9); real-data smoke (14) |
| REQ-mcp-03 | newer stamp fails every tool; corrupt lines skipped | 3, 6, 7, 9 | stamp guard and torn/corrupt tests (3); stamp checked before everything (6); every tool, byte-unchanged (7); over the wire for every tool (9) |
| REQ-mcp-04 | `search_nodes`, `get_node`, `get_neighbors`, `list_lectures`, `get_lecture` with the fields of the spec | 4, 8 | knowledge tests (23); schema-level smoke of every tool (8) |
| REQ-mcp-05 | `list_goals`, `get_goal`, `get_daily_plan`, `research_status` | 5, 8 | study tests (15) |
| REQ-mcp-06 | `--knowledge-only` disables the study group | 5, 8, 11, 12 | runtime `disabled` error in the core (5); tools not even registered (8) |
| REQ-mcp-07 | same plan function, identical output for identical data, time and settings | 5 | parity test against the app's `computePlan`, field by field; mutation check in 14. Holds for the app's default plan parameters (gap G2) |
| REQ-mcp-08 | bounded lists with `count` and `truncated`, capped text with a marker | 2, 4, 5, 10, 11 | limits tests (2); a 1,500-node / 80-goal / 80-debrief fixture with a walk that rejects bare arrays and over-long strings (10); byte budget for debriefs (11); response-size refusal (8) |
| REQ-mcp-09 | trust level with evidence; explanation stale / without source context | 4 | knowledge tests on trust, evidence allow-list (no paths, credentials or query strings), `explanation.state`, `noSourceContext` |
| REQ-mcp-10 | unknown id gives a structured not-found, never a crash | 4, 5, 6, 8 | per-tool tests; unknown tools; hostile arguments over the protocol; internal errors become a fixed message and the next call works |
| REQ-mcp-11 | no network listener | 9 | closure scan (no network, process or thread module, no `fetch`, no `.listen`); `lsof` probe on the running process, which first proves it can see the process |
| REQ-mcp-12 | tool schemas documented as language-neutral contracts | 8, 13 | strict zod schemas published by `tools/list` and pinned to the dispatcher's fields (8); `CONTRACTS.md` section kept honest by a document test (13). Gap G3 |
| REQ-mcp-13 | `get_recent_debriefs`, bounded, disabled by `--knowledge-only` | 11 | debriefs tests (8). Conditional, gap G1 |
| REQ-mcp-14 | `list_documents` with title, page count, reading progress | 12 | documents tests (3). Conditional, gap G1 |

The spec's four "open items for the plan" are closed: SDK dependency and version (1.32.1, no `package.json` change, decision D2); registration and uncovered needs (Task 13 step 7); default limits (the `LIMITS` table in `limits.ts` and the bounds table in `CONTRACTS.md`); narration on request (decision D5, default never).

### 2. Placeholder scan

Searched the finished plan for `TBD`, `TODO`, `FIXME`, `implement later`, `fill in`, `similar to`, `appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above` and `as above`: see the result recorded at the end of this section. Every code step contains complete code or an exact edit; every file embedded in this plan was copied from a scratch tree where the same files compile (`tsc`), pass ESLint, and pass 124 tests on Node 26 and on Node 22.23. Tasks 11 and 12 were verified against the code blocks of the sibling plans, not against repository modules that do not exist yet.

### 3. Type consistency

Names used across tasks and defined once: `ToolError`, `ToolErrorCode`, `failureOf`, `INTERNAL_MESSAGE` (Task 2); `LIMITS`, `Page`, `page`, `textPage`, `capText`, `clampLimit`, `fitToBudget`, `round1`, `round4`, `finiteOrNull` (Task 2); `McpDeps`, `ReadLog`, `LectureReader`, `RunOptions` (Task 3, extended in Tasks 11 and 12); `createMcpDeps(dataRoot, clock)` (Task 3); `openCall`, `Call`, `snapshotOf`, `guardReplay` (Task 4); `runTool(name, deps, input, opts)`, `TOOL_NAMES`, `toolGroup`, `toolFields` (Tasks 4-5); `CATALOG`, `DEBRIEF_KINDS` (Tasks 8, 11); `createServer(deps, {knowledgeOnly, log})`, `safeCall` (Task 8); `installStdioGuard`, `parseArgs` (Task 9). Test helpers: `makeFixture`, `seedStandard`, `seedGraph`, `GOAL_ID`, `N`, `NOW`, `HIDDEN`, `call`, `errorCode`, `expectError`, `treeDigest`, `fsTripwire`, `importClosure`, `connect`, `callTool`. The whole set typechecks together under `strict`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. One deliberate asymmetry: `tools.ts` is shown three times (knowledge rows in Task 4, study rows in Task 5, one edit per sibling tool in Tasks 11 and 12) and each version is a strict superset of the previous one.

### 4. Requirement gaps and weak points

- **G1 - REQ-mcp-13 and REQ-mcp-14 are conditional.** The session-debriefs and assisted-study modules are not in the repository yet. The tools and tests were verified against the exact `journal.ts`, `documents.ts` and `reading.ts` code blocks of those plans. If the real modules differ in names or shapes, Tasks 11 and 12 need adapting (the test files define the behaviour). Until then the plan delivers REQ-mcp-01..12.
- **G2 - REQ-mcp-07 holds for the default plan parameters.** The app computes the plan with `deps.params ?? DEFAULT_PLAN_PARAMS` and nothing passes custom parameters today. The server does not read `settings.json` (it also holds provider secrets, and keeping it out of the import closure is a guarantee worth more than parity with a setting that does not exist). If the app later makes the daily budget configurable, `McpDeps` needs the same parameters and the parity test needs a settings case.
- **G3 - REQ-mcp-12 is documented in prose plus runtime JSON Schema for inputs.** `tools/list` publishes machine-readable input schemas (generated from the zod contracts); outputs are described in `CONTRACTS.md` and not registered as `outputSchema`, so a consumer cannot validate them mechanically. No standalone `.json` schema files are shipped.
- **G4 - Oversized request ends the session.** The SDK transport closes itself when a request line exceeds 256 KiB; the process exits. It fails closed and is tested, but a client sees a disconnect rather than an error result (decision D3).
- **G5 - No concurrent-writer stress test.** A torn last line is simulated deterministically at several cut points; a real second process appending while the server reads is not run in the suite (it would be timing-dependent). The reader opens, reads and closes within one synchronous call, and skipping a torn line is covered.
- **G6 - Platform.** The listener probe needs `lsof` (skipped when absent). The suite was run on macOS only.
- **G7 - No OS-level sandbox.** Node's `--permission` model cannot run tsx (checked). Read-only rests on the code-level layers above, which is the baseline level of the spec's security profile.
- **G8 - A corrupt or non-numeric `format.json` reads as absent**, exactly as in the app's `docs/ext/CONTRACTS.md`; it does not refuse. A stamp with a number above the supported version refuses.

### 5. Decisions the user must make

Each has a default the plan already implements; answering "defaults" accepts all. They are listed in the order of how much they matter.

- **D1 - What does `--knowledge-only` hide?** The spec says it disables the study-state group. The plan also removes the learner-performance fields from `get_node` (card count, review state, goals; `studyState` becomes `"disabled"`) and refuses `search_nodes` with `goalId`, because those fields describe the learner. **Default: yes, hide them.** The alternative (hide only the study tools) leaves due dates and recall probabilities visible to an agent you meant to keep out of your performance data.
- **D2 - SDK version.** Pinned at 1.32.1, which is what the repository already depends on. 1.32.2 exists. **Default: stay on 1.32.1** (a bump is a `package.json` touchpoint and a separate, reviewable change).
- **D3 - Oversized requests.** A request line above 256 KiB ends the session (SDK behaviour, verified). **Default: accept it.** Surviving it would need a custom transport that discards the oversized line.
- **D4 - Dates in `get_daily_plan`.** Today and up to 30 days ahead are planned; past dates are refused because the ledgers cannot reconstruct them. **Default: as described.** Say if you want a longer horizon.
- **D5 - Lecture narration.** The spec leaves open whether `get_lecture` may return the slides' narration on request. **Default: never** (outline, references and exercises only; there is no flag).
- **D6 - Evidence source labels.** `get_node` shows a source as its library id, or a web origin and path without query string or credentials, or the file name, or "local source" for a local PDF; never an absolute path. **Default: yes.**
- **D7 - When to run Tasks 11 and 12.** After the session-debriefs and assisted-study plans have landed (recommended, so they run against real modules), or now against stubs. **Default: after.**

### Placeholder scan result

The scan (case-insensitive, over the whole plan including embedded code) found no placeholder: the only line matching any pattern is the sentence above that lists the patterns.
