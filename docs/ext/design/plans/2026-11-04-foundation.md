# Foundation (Extension Layer Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared skeleton of the extension layer in the LearnHarness fork: a versioned `data/ext/` directory, a generic event-ledger adapter, the goal entity (events, derivation, scope) and a goal-creation service, with no edits to upstream source files.

**Architecture:** New code mirrors upstream layering (`src/core/ext/` pure logic, `src/store/ext/` fs adapters, `src/server/ext/` composition root). `data/ext/` has its own `format.json` stamp so upstream's graph stamp is untouched. A goal creates its target node through the upstream `mergeFindings` merger with a `goal_…` source id; nothing else writes upstream ledgers.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node 26, `node:test` via `tsx`, no new dependencies.

**Specs:** `docs/superpowers/specs/2026-11-04-learning-platform-integration-design.md` (REQ-int-01 to 04, REQ-goal-01, REQ-goal-02, REQ-port-01).

**Decisions made in this plan (flag to change):** goal priority is an integer 1 to 5, default 3, higher means more important. A goal may target an existing node (`existingNodeId`) instead of creating one.

**Working directory for every command:** `<repo>` (the fork, its own git repo).

**Command prefix for Node 26:** every shell session starts with `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/store/ext/paths.ts` | Paths of the `data/ext/` files, computed from a data root |
| `src/store/ext/format.ts` | The `format.json` stamp: read guard and lazy write |
| `src/store/ext/ledger.ts` | Generic append-only JSONL ledger with a validating parser |
| `src/core/ext/goals.ts` | Goal event types, parser, `deriveGoals`, `goalScope`, `activeScope` (pure) |
| `src/core/ext/ports.ts` | The `GoalsStore` port |
| `src/core/ext/goal-service.ts` | `createGoal`: validates, creates or reuses the target node, appends the event |
| `src/store/ext/goals-store.ts` | `GoalsStore` adapter over the ledger |
| `src/server/ext/stores.ts` | Composition root for extension stores |
| `tests/helpers/memory-graph-store.ts` | In-memory `GraphStore` for tests |
| `tests/ext-*.test.ts` | One test file per module |
| `docs/ext/TOUCHPOINTS.md` | The closed list of upstream files touched |
| `docs/ext/CONTRACTS.md` | Language-neutral contracts of the formats and derivations |

---

### Task 1: Git setup of the fork

**Files:**
- Modify: `package.json` (already modified locally: `allowScripts`)

- [ ] **Step 1: Rename the remote and create the working branch**

```bash
git remote rename origin upstream
git checkout -b ext
git remote -v
```

Expected: two lines `upstream  https://github.com/amosblomqvist/learnharness.git (fetch|push)`; `git branch --show-current` prints `ext`.

- [ ] **Step 2: Check that extension data is not tracked**

```bash
git check-ignore -v data/ext/goals.jsonl
```

Expected: a line naming a `.gitignore` rule that covers `data/` (for example `.gitignore:NN:/data/ ...`). If it prints nothing, add `/data/ext/` on its own line to `.gitignore` and note it in `docs/ext/TOUCHPOINTS.md` in Task 9.

- [ ] **Step 3: Commit the local `allowScripts` change**

```bash
git add package.json
git commit -m "chore: approve install scripts for fsevents, protobufjs, unrs-resolver" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed`.

---

### Task 2: Extension paths

**Files:**
- Create: `src/store/ext/paths.ts`
- Test: `tests/ext-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-paths.test.ts
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { extPathsFor } from "../src/store/ext/paths.ts";

describe("extension paths", () => {
	it("places everything under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		assert.equal(p.dir, path.join("/tmp/lh-data", "ext"));
		assert.equal(p.format, path.join("/tmp/lh-data", "ext", "format.json"));
		assert.equal(p.goals, path.join("/tmp/lh-data", "ext", "goals.jsonl"));
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-paths.test.ts`
Expected: FAIL with a "Cannot find module" error for `src/store/ext/paths.ts`.

- [ ] **Step 3: Implement**

```ts
// src/store/ext/paths.ts
/**
 * Paths of the extension layer's files (docs/superpowers/specs/
 * 2026-11-04-learning-platform-integration-design.md). Everything lives in
 * <data root>/ext, beside (never inside) upstream's data/graph, with its
 * own format stamp.
 */

import path from "node:path";
import { PATHS } from "../../../config.ts";

export interface ExtPaths {
	dir: string;
	format: string;
	goals: string;
}

export function extPathsFor(dataRoot: string): ExtPaths {
	const dir = path.join(dataRoot, "ext");
	return {
		dir,
		format: path.join(dir, "format.json"),
		goals: path.join(dir, "goals.jsonl"),
	};
}

/** The live paths (LH_DATA_DIR-aware, like every upstream mutable record). */
export const EXT_PATHS: ExtPaths = extPathsFor(PATHS.data);
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-paths.test.ts`
Expected: PASS, `pass 1`.

- [ ] **Step 5: Commit**

```bash
git add src/store/ext/paths.ts tests/ext-paths.test.ts
git commit -m "feat(ext): add extension data paths" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Format stamp

**Files:**
- Create: `src/store/ext/format.ts`
- Test: `tests/ext-format.test.ts`

Contract (REQ-int-01): reading never writes; a stamp newer than the build makes reads throw; no sidecar means version 1; a corrupt sidecar reads as unstamped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-format.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CURRENT_EXT_FORMAT_VERSION, assertExtFormat, ensureExtFormat } from "../src/store/ext/format.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension format stamp", () => {
	it("assert never writes when there is no sidecar", () => {
		const dir = tmp();
		assertExtFormat(dir);
		assert.deepEqual(fs.readdirSync(dir), []);
	});

	it("assert never creates a missing directory", () => {
		const dir = path.join(tmp(), "not-there");
		assertExtFormat(dir);
		assert.equal(fs.existsSync(dir), false);
	});

	it("ensure writes the sidecar with the current version, once", () => {
		const dir = path.join(tmp(), "ext");
		ensureExtFormat(dir);
		const first = fs.readFileSync(path.join(dir, "format.json"), "utf-8");
		assert.deepEqual(JSON.parse(first), { version: CURRENT_EXT_FORMAT_VERSION });
		ensureExtFormat(dir);
		assert.equal(fs.readFileSync(path.join(dir, "format.json"), "utf-8"), first);
	});

	it("assert throws on a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		assert.throws(() => assertExtFormat(dir), /format version/);
	});

	it("assert accepts the current version", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION }));
		assertExtFormat(dir);
	});

	it("a corrupt sidecar reads as unstamped and is not fatal", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), "{not json");
		assertExtFormat(dir);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-format.test.ts`
Expected: FAIL, "Cannot find module" for `src/store/ext/format.ts`.

- [ ] **Step 3: Implement**

```ts
// src/store/ext/format.ts
/**
 * The extension family's FORMAT STAMP: <dir>/format.json. Same doctrine as
 * upstream's graph stamp (src/store/graph-format.ts): LAZY v1 (no sidecar
 * means version 1, the first write creates it), reads never write, and a
 * stamp NEWER than this build makes reads throw so an old build never
 * misreads or rewrites data it does not understand. A corrupt sidecar reads
 * as unstamped.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../atomic-write.ts";

export const CURRENT_EXT_FORMAT_VERSION = 1;

function formatFile(dir: string): string {
	return path.join(dir, "format.json");
}

function stampedVersion(dir: string): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(formatFile(dir), "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null;
	}
}

/** READ-SIDE GUARD: throws when the data was written by a NEWER build. Never writes. */
export function assertExtFormat(dir: string): void {
	const v = stampedVersion(dir);
	if (v !== null && v > CURRENT_EXT_FORMAT_VERSION) {
		throw new Error(
			`Extension data in ${dir} is stamped with format version ${v}, but this build understands only ${CURRENT_EXT_FORMAT_VERSION}. Upgrade the app before reading it.`,
		);
	}
}

/** WRITE-SIDE STAMP: creates the directory and the sidecar on first use. */
export function ensureExtFormat(dir: string): void {
	if (stampedVersion(dir) !== null) return;
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(formatFile(dir), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION }, null, "\t") + "\n", {
		allowInPlaceFallback: true,
	});
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-format.test.ts`
Expected: PASS, `pass 6`.

- [ ] **Step 5: Commit**

```bash
git add src/store/ext/format.ts tests/ext-format.test.ts
git commit -m "feat(ext): add extension format stamp" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Generic event ledger

**Files:**
- Create: `src/store/ext/ledger.ts`
- Test: `tests/ext-ledger.test.ts`

Contract: `append` stamps the directory lazily, validates the event with the parser before writing (throws if rejected), and never loses earlier lines; `readAll` never writes, returns `[]` for a missing file, skips corrupt lines and lines the parser rejects, and throws on a newer stamp.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-ledger.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { createLedger } from "../src/store/ext/ledger.ts";

interface Ping {
	n: number;
}
function parsePing(raw: unknown): Ping | null {
	if (typeof raw !== "object" || raw === null) return null;
	const n = (raw as { n?: unknown }).n;
	return typeof n === "number" ? { n } : null;
}

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension ledger", () => {
	it("round-trips appended events in order", () => {
		const dir = tmp();
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		ledger.append({ n: 1 });
		ledger.append({ n: 2 });
		assert.deepEqual(ledger.readAll(), [{ n: 1 }, { n: 2 }]);
	});

	it("reading a missing ledger returns [] and writes nothing", () => {
		const dir = path.join(tmp(), "ext");
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.deepEqual(ledger.readAll(), []);
		assert.equal(fs.existsSync(dir), false);
	});

	it("the first append creates the stamp", () => {
		const dir = path.join(tmp(), "ext");
		createLedger(dir, "pings.jsonl", parsePing).append({ n: 1 });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8")), {
			version: CURRENT_EXT_FORMAT_VERSION,
		});
	});

	it("skips corrupt lines and lines the parser rejects", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "pings.jsonl"), `{"n":1}\n{broken\n{"x":true}\n\n{"n":3}\n`);
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.deepEqual(ledger.readAll(), [{ n: 1 }, { n: 3 }]);
	});

	it("append rejects an event the parser refuses and writes nothing", () => {
		const dir = tmp();
		const ledger = createLedger(dir, "pings.jsonl", (raw) => parsePing(raw));
		assert.throws(() => ledger.append({ n: "x" } as unknown as Ping), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "pings.jsonl")), false);
	});

	it("both read and append refuse a newer stamp", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		const ledger = createLedger(dir, "pings.jsonl", parsePing);
		assert.throws(() => ledger.readAll(), /format version/);
		assert.throws(() => ledger.append({ n: 1 }), /format version/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-ledger.test.ts`
Expected: FAIL, "Cannot find module" for `src/store/ext/ledger.ts`.

- [ ] **Step 3: Implement**

```ts
// src/store/ext/ledger.ts
/**
 * Generic append-only JSONL event ledger for the extension layer. One line
 * per event; current state is DERIVED by the caller (store events, derive
 * state — the same doctrine as upstream's graph ledgers). A parser validates
 * every event on the way in and on the way out: the ledger never writes what
 * the parser rejects, and skips (never repairs) corrupt or invalid lines on
 * read, so a torn append cannot take the data down.
 */

import fs from "node:fs";
import path from "node:path";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export interface Ledger<T> {
	/** Throws if the parser rejects the event or the stamp is newer than this build. */
	append(event: T): void;
	/** Never writes. [] when the file does not exist. Throws on a newer stamp. */
	readAll(): T[];
}

export function createLedger<T>(dir: string, fileName: string, parse: (raw: unknown) => T | null): Ledger<T> {
	const file = path.join(dir, fileName);
	return {
		append(event: T): void {
			assertExtFormat(dir);
			if (parse(event) === null) throw new Error(`ledger ${fileName}: event rejected by its parser`);
			ensureExtFormat(dir);
			fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
		},
		readAll(): T[] {
			assertExtFormat(dir);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return [];
			}
			const out: T[] = [];
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				let value: unknown;
				try {
					value = JSON.parse(trimmed);
				} catch {
					continue;
				}
				const event = parse(value);
				if (event !== null) out.push(event);
			}
			return out;
		},
	};
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-ledger.test.ts`
Expected: PASS, `pass 6`.

- [ ] **Step 5: Commit**

```bash
git add src/store/ext/ledger.ts tests/ext-ledger.test.ts
git commit -m "feat(ext): add generic validating JSONL ledger" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Goals (pure core)

**Files:**
- Create: `src/core/ext/goals.ts`
- Test: `tests/ext-goals.test.ts`

Contract: `parseGoalEvent` accepts only well-formed events (priority integer 1 to 5; at least one non-empty target id; known origin and status). `deriveGoals` replays events in order: a duplicate `created` for a known id is ignored, a `status` event for an unknown goal is ignored, new goals are `active`. `goalScope` is the target ids plus the transitive closure of their premises over the given chains, cycle-safe, each id once, targets first in input order. `activeScope` is the union of the scopes of active goals.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-goals.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_GOAL_PRIORITY,
	activeScope,
	deriveGoals,
	goalScope,
	parseGoalEvent,
	type GoalEvent,
} from "../src/core/ext/goals.ts";

const created = (goalId: string, targets: string[], at = "2026-11-04T10:00:00.000Z"): GoalEvent => ({
	type: "created",
	goalId,
	title: `Goal ${goalId}`,
	origin: "user",
	originRef: "",
	targetNodeIds: targets,
	priority: DEFAULT_GOAL_PRIORITY,
	at,
});

describe("parseGoalEvent", () => {
	it("accepts a well-formed created event", () => {
		assert.deepEqual(parseGoalEvent(created("goal_a", ["n_1"])), created("goal_a", ["n_1"]));
	});
	it("accepts a status event", () => {
		const e = { type: "status", goalId: "goal_a", status: "paused", at: "t" };
		assert.deepEqual(parseGoalEvent(e), e);
	});
	it("rejects bad shapes", () => {
		const base = created("goal_a", ["n_1"]);
		for (const bad of [
			null,
			"x",
			{ ...base, goalId: "" },
			{ ...base, title: "" },
			{ ...base, origin: "web" },
			{ ...base, targetNodeIds: [] },
			{ ...base, targetNodeIds: [""] },
			{ ...base, priority: 0 },
			{ ...base, priority: 6 },
			{ ...base, priority: 2.5 },
			{ type: "status", goalId: "goal_a", status: "done", at: "t" },
			{ type: "other", goalId: "goal_a", at: "t" },
		]) {
			assert.equal(parseGoalEvent(bad), null, JSON.stringify(bad));
		}
	});
});

describe("deriveGoals", () => {
	it("starts active and applies status events in order", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ type: "status", goalId: "goal_a", status: "paused", at: "2026-11-04T11:00:00.000Z" },
			{ type: "status", goalId: "goal_a", status: "reached", at: "2026-11-04T12:00:00.000Z" },
		]);
		assert.equal(goals.length, 1);
		assert.equal(goals[0]?.status, "reached");
		assert.equal(goals[0]?.createdAt, "2026-11-04T10:00:00.000Z");
		assert.equal(goals[0]?.updatedAt, "2026-11-04T12:00:00.000Z");
	});
	it("ignores a duplicate created and a status for an unknown goal", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ ...created("goal_a", ["n_2"]), title: "other" },
			{ type: "status", goalId: "goal_zzz", status: "paused", at: "t" },
		]);
		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0]?.targetNodeIds, ["n_1"]);
		assert.equal(goals[0]?.title, "Goal goal_a");
	});
	it("keeps creation order", () => {
		const ids = deriveGoals([created("goal_b", ["n_1"]), created("goal_a", ["n_2"])]).map((g) => g.id);
		assert.deepEqual(ids, ["goal_b", "goal_a"]);
	});
});

describe("goalScope", () => {
	const chains = [
		{ premises: ["n_a", "n_b"], conclusion: "n_c" },
		{ premises: ["n_c", "n_d"], conclusion: "n_t" },
		{ premises: ["n_x"], conclusion: "n_unrelated" },
	];
	it("is the target plus the transitive premise closure", () => {
		assert.deepEqual(new Set(goalScope(["n_t"], chains)), new Set(["n_t", "n_c", "n_d", "n_a", "n_b"]));
	});
	it("is just the targets when no chain concludes them", () => {
		assert.deepEqual(goalScope(["n_solo"], chains), ["n_solo"]);
	});
	it("lists each id once and starts with the targets", () => {
		const out = goalScope(["n_t", "n_c"], chains);
		assert.equal(new Set(out).size, out.length);
		assert.deepEqual(out.slice(0, 2), ["n_t", "n_c"]);
	});
	it("terminates on a cycle", () => {
		const cyc = [
			{ premises: ["n_b"], conclusion: "n_a" },
			{ premises: ["n_a"], conclusion: "n_b" },
		];
		assert.deepEqual(new Set(goalScope(["n_a"], cyc)), new Set(["n_a", "n_b"]));
	});
});

describe("activeScope", () => {
	it("unions the scopes of active goals only", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_t"]),
			created("goal_b", ["n_other"]),
			{ type: "status", goalId: "goal_b", status: "paused", at: "t" },
		]);
		const chains = [{ premises: ["n_p"], conclusion: "n_t" }];
		assert.deepEqual(new Set(activeScope(goals, chains)), new Set(["n_t", "n_p"]));
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goals.test.ts`
Expected: FAIL, "Cannot find module" for `src/core/ext/goals.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/goals.ts
/**
 * Goals (umbrella spec: REQ-goal-01, REQ-goal-02). A goal is one or more
 * TARGET NODES the learner wants to master; its SCOPE is the targets plus
 * the transitive closure of their premises over the chains. Goals are an
 * event log (store events, derive state); this module is pure.
 */

import type { GraphChain } from "../contracts.ts";

export type GoalOrigin = "chat" | "user" | "pdf";
export type GoalStatus = "active" | "paused" | "reached";

export const MIN_GOAL_PRIORITY = 1;
export const MAX_GOAL_PRIORITY = 5;
export const DEFAULT_GOAL_PRIORITY = 3;

export type GoalEvent =
	| {
			type: "created";
			goalId: string;
			title: string;
			origin: GoalOrigin;
			originRef: string;
			targetNodeIds: string[];
			priority: number;
			at: string;
	  }
	| { type: "status"; goalId: string; status: GoalStatus; at: string };

export interface Goal {
	id: string;
	title: string;
	origin: GoalOrigin;
	originRef: string;
	targetNodeIds: string[];
	priority: number;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
}

const ORIGINS = new Set<string>(["chat", "user", "pdf"]);
const STATUSES = new Set<string>(["active", "paused", "reached"]);

export function isValidGoalPriority(p: unknown): p is number {
	return typeof p === "number" && Number.isInteger(p) && p >= MIN_GOAL_PRIORITY && p <= MAX_GOAL_PRIORITY;
}

export function parseGoalEvent(raw: unknown): GoalEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.goalId !== "string" || r.goalId === "" || typeof r.at !== "string") return null;
	if (r.type === "status") {
		if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
		return { type: "status", goalId: r.goalId, status: r.status as GoalStatus, at: r.at };
	}
	if (r.type === "created") {
		if (typeof r.title !== "string" || r.title === "") return null;
		if (typeof r.origin !== "string" || !ORIGINS.has(r.origin)) return null;
		if (typeof r.originRef !== "string") return null;
		if (!Array.isArray(r.targetNodeIds) || r.targetNodeIds.length === 0) return null;
		if (!r.targetNodeIds.every((id) => typeof id === "string" && id !== "")) return null;
		if (!isValidGoalPriority(r.priority)) return null;
		return {
			type: "created",
			goalId: r.goalId,
			title: r.title,
			origin: r.origin as GoalOrigin,
			originRef: r.originRef,
			targetNodeIds: [...(r.targetNodeIds as string[])],
			priority: r.priority,
			at: r.at,
		};
	}
	return null;
}

/** Replay the events in order. A duplicate `created` for a known id and a `status` for an unknown goal are ignored. */
export function deriveGoals(events: readonly GoalEvent[]): Goal[] {
	const goals = new Map<string, Goal>();
	for (const e of events) {
		if (e.type === "created") {
			if (goals.has(e.goalId)) continue;
			goals.set(e.goalId, {
				id: e.goalId,
				title: e.title,
				origin: e.origin,
				originRef: e.originRef,
				targetNodeIds: [...e.targetNodeIds],
				priority: e.priority,
				status: "active",
				createdAt: e.at,
				updatedAt: e.at,
			});
		} else {
			const goal = goals.get(e.goalId);
			if (goal === undefined) continue;
			goal.status = e.status;
			goal.updatedAt = e.at;
		}
	}
	return [...goals.values()];
}

/** The targets plus the transitive closure of their premises over `chains`. Cycle-safe; each id once; targets first. */
export function goalScope(
	targetNodeIds: readonly string[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
): string[] {
	const premisesOf = new Map<string, string[][]>();
	for (const chain of chains) {
		const bucket = premisesOf.get(chain.conclusion);
		if (bucket === undefined) premisesOf.set(chain.conclusion, [chain.premises]);
		else bucket.push(chain.premises);
	}
	const seen = new Set<string>();
	const queue = [...targetNodeIds];
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		for (const premises of premisesOf.get(id) ?? []) {
			for (const premise of premises) if (!seen.has(premise)) queue.push(premise);
		}
	}
	return [...seen];
}

/** The union of the scopes of all active goals. */
export function activeScope(goals: readonly Goal[], chains: readonly Pick<GraphChain, "premises" | "conclusion">[]): string[] {
	const out = new Set<string>();
	for (const goal of goals) {
		if (goal.status !== "active") continue;
		for (const id of goalScope(goal.targetNodeIds, chains)) out.add(id);
	}
	return [...out];
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goals.test.ts`
Expected: PASS, `pass 11`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/goals.ts tests/ext-goals.test.ts
git commit -m "feat(ext): add goal events, derivation and scope" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Goals port and store adapter

**Files:**
- Create: `src/core/ext/ports.ts`
- Create: `src/store/ext/goals-store.ts`
- Test: `tests/ext-goals-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-goals-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import { createGoalsStore } from "../src/store/ext/goals-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const created: GoalEvent = {
	type: "created",
	goalId: "goal_a",
	title: "Understand X",
	origin: "chat",
	originRef: "chat_1",
	targetNodeIds: ["n_1"],
	priority: 3,
	at: "2026-11-04T10:00:00.000Z",
};

describe("goals store", () => {
	it("persists events to goals.jsonl and derives the goal back", () => {
		const dir = tmp();
		const store = createGoalsStore(dir);
		store.appendEvent(created);
		store.appendEvent({ type: "status", goalId: "goal_a", status: "paused", at: "2026-11-04T11:00:00.000Z" });
		assert.equal(fs.existsSync(path.join(dir, "goals.jsonl")), true);
		const goals = deriveGoals(createGoalsStore(dir).readEvents());
		assert.equal(goals[0]?.status, "paused");
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createGoalsStore(dir);
		assert.throws(() => store.appendEvent({ ...created, priority: 9 }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "goals.jsonl")), false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goals-store.test.ts`
Expected: FAIL, "Cannot find module" for `src/store/ext/goals-store.ts`.

- [ ] **Step 3: Implement the port and the adapter**

```ts
// src/core/ext/ports.ts
/**
 * Storage ports of the extension layer (same hexagonal rule as
 * src/core/ports.ts: core codes against these types, adapters live in
 * src/store/ext/, wiring happens once in src/server/ext/stores.ts).
 */

import type { GoalEvent } from "./goals.ts";

export interface GoalsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: GoalEvent): void;
	/** Valid events in append order. */
	readEvents(): GoalEvent[];
}
```

```ts
// src/store/ext/goals-store.ts
import { parseGoalEvent } from "../../core/ext/goals.ts";
import type { GoalsStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createGoalsStore(dir: string): GoalsStore {
	const ledger = createLedger(dir, "goals.jsonl", parseGoalEvent);
	return {
		appendEvent: (event) => ledger.append(event),
		readEvents: () => ledger.readAll(),
	};
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goals-store.test.ts`
Expected: PASS, `pass 2`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/ports.ts src/store/ext/goals-store.ts tests/ext-goals-store.test.ts
git commit -m "feat(ext): add goals store port and adapter" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: In-memory graph store test helper

**Files:**
- Create: `tests/helpers/memory-graph-store.ts`

No test of its own: it is exercised by Task 8. The `npm test` glob (`tests/*.test.ts`) does not pick up `tests/helpers/`.

- [ ] **Step 1: Write the helper**

```ts
// tests/helpers/memory-graph-store.ts
/**
 * An in-memory GraphStore for tests that run upstream's pure merger
 * (core/graph.ts mergeFindings) without touching data/graph. It implements
 * only the ledger methods the merger uses; every other method throws, so a
 * test that needs more fails loudly instead of silently passing.
 */

import type { CoverageEntry, GraphChain, GraphNode, SessionCheckpoint } from "../../src/core/contracts.ts";
import type { GraphStore } from "../../src/core/ports.ts";

export function createMemoryGraphStore(): GraphStore {
	let nodes: GraphNode[] = [];
	let chains: GraphChain[] = [];
	let checkpoints: SessionCheckpoint[] = [];
	let coverage: CoverageEntry[] = [];
	const implemented = {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => [...nodes],
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => [...chains],
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => [...checkpoints],
		appendCoverage: (c: CoverageEntry) => void coverage.push(c),
		readCoverage: () => [...coverage],
		rewriteLedgers: (next: {
			nodes?: GraphNode[];
			chains?: GraphChain[];
			coverage?: CoverageEntry[];
			checkpoints?: SessionCheckpoint[];
		}) => {
			if (next.nodes !== undefined) nodes = [...next.nodes];
			if (next.chains !== undefined) chains = [...next.chains];
			if (next.coverage !== undefined) coverage = [...next.coverage];
			if (next.checkpoints !== undefined) checkpoints = [...next.checkpoints];
		},
	};
	return new Proxy(implemented, {
		get(target, prop) {
			if (prop in target) return target[prop as keyof typeof target];
			throw new Error(`memory graph store: ${String(prop)} is not implemented`);
		},
	}) as unknown as GraphStore;
}
```

- [ ] **Step 2: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsc --noEmit`
Expected: exit code 0, no output.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/memory-graph-store.ts
git commit -m "test(ext): add in-memory GraphStore helper" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Goal service

**Files:**
- Create: `src/core/ext/goal-service.ts`
- Test: `tests/ext-goal-service.test.ts`

Contract (REQ-goal-01): `createGoal` validates title, priority, and (for a new target) statement BEFORE any write; with `statement` it creates the target node through upstream's `mergeFindings` using the goal id as source id (provenance `{chatId: goalId, messageId: ""}`); with `existingNodeId` it creates no node and throws if the node is unknown; it then appends the `created` event and returns the derived goal. `createGoal` takes injectable `now` and `newGoalId` for determinism.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-goal-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGoal } from "../src/core/ext/goal-service.ts";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";

function memoryGoalsStore(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

function deps() {
	const graphStore = createMemoryGraphStore();
	const goalsStore = memoryGoalsStore();
	let n = 0;
	return {
		graphStore,
		goalsStore,
		now: () => "2026-11-04T10:00:00.000Z",
		newGoalId: () => `goal_test${++n}`,
	};
}

describe("createGoal", () => {
	it("creates the target node through the merger with the goal id as provenance", () => {
		const d = deps();
		const goal = createGoal(
			{ title: "Dominated convergence", statement: "If |f_n| <= g integrable and f_n -> f a.e., then the integrals converge.", origin: "chat", originRef: "chat_1" },
			d,
		);
		const nodes = d.graphStore.readNodes();
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]?.name, "Dominated convergence");
		assert.deepEqual(nodes[0]?.provenance, [{ chatId: "goal_test1", messageId: "" }]);
		assert.deepEqual(goal.targetNodeIds, [nodes[0]?.id]);
		assert.equal(goal.id, "goal_test1");
		assert.equal(goal.status, "active");
		assert.equal(goal.priority, 3);
		assert.equal(goal.origin, "chat");
	});

	it("appends exactly one created event that derives back to the goal", () => {
		const d = deps();
		createGoal({ title: "T", statement: "S is true.", origin: "user", originRef: "" }, d);
		assert.equal(d.goalsStore.events.length, 1);
		assert.equal(deriveGoals(d.goalsStore.readEvents()).length, 1);
	});

	it("with existingNodeId creates no node and targets that node", () => {
		const d = deps();
		const first = createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "" }, d);
		const nodeId = first.targetNodeIds[0]!;
		const second = createGoal(
			{ title: "B", existingNodeId: nodeId, origin: "user", originRef: "", priority: 5 },
			d,
		);
		assert.equal(d.graphStore.readNodes().length, 1);
		assert.deepEqual(second.targetNodeIds, [nodeId]);
		assert.equal(second.priority, 5);
	});

	it("throws on an unknown existingNodeId without writing anything", () => {
		const d = deps();
		assert.throws(
			() => createGoal({ title: "B", existingNodeId: "n_missing", origin: "user", originRef: "" }, d),
			/unknown node/,
		);
		assert.equal(d.goalsStore.events.length, 0);
	});

	it("validates before writing: empty title, empty statement, bad priority", () => {
		const d = deps();
		assert.throws(() => createGoal({ title: "", statement: "S.", origin: "user", originRef: "" }, d), /title/);
		assert.throws(() => createGoal({ title: "T", statement: "  ", origin: "user", originRef: "" }, d), /statement/);
		assert.throws(() => createGoal({ title: "T", statement: "S.", origin: "user", originRef: "", priority: 0 }, d), /priority/);
		assert.equal(d.graphStore.readNodes().length, 0);
		assert.equal(d.goalsStore.events.length, 0);
	});

	it("two goals get separate nodes and ids", () => {
		const d = deps();
		const a = createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "" }, d);
		const b = createGoal({ title: "B", statement: "B holds.", origin: "pdf", originRef: "doc_1" }, d);
		assert.notEqual(a.id, b.id);
		assert.notEqual(a.targetNodeIds[0], b.targetNodeIds[0]);
		assert.equal(d.graphStore.readNodes().length, 2);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goal-service.test.ts`
Expected: FAIL, "Cannot find module" for `src/core/ext/goal-service.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/goal-service.ts
/**
 * createGoal (umbrella spec REQ-goal-01): a goal always has a target node.
 * With `statement` the node is created through upstream's merger
 * (core/graph.ts mergeFindings) — the ONLY writer of the content ledgers —
 * using the goal id as the source id, so its provenance is
 * {chatId: goalId, messageId: ""} (the same idea as the `src_…` ids of
 * imported notes). With `existingNodeId` no node is created. All validation
 * happens before the first write.
 */

import { randomBytes } from "node:crypto";
import type { AuditVerdicts, SessionFindings } from "../contracts.ts";
import { mergeFindings } from "../graph.ts";
import type { ChatStore, GraphStore } from "../ports.ts";
import {
	DEFAULT_GOAL_PRIORITY,
	deriveGoals,
	isValidGoalPriority,
	type Goal,
	type GoalOrigin,
} from "./goals.ts";
import type { GoalsStore } from "./ports.ts";

export interface GoalServiceDeps {
	graphStore: GraphStore;
	goalsStore: GoalsStore;
	now?: () => string;
	newGoalId?: () => string;
}

interface GoalInputBase {
	title: string;
	origin: GoalOrigin;
	originRef: string;
	priority?: number;
}
export type CreateGoalInput =
	| (GoalInputBase & { statement: string })
	| (GoalInputBase & { existingNodeId: string });

function newGoalId(): string {
	return `goal_${randomBytes(6).toString("hex")}`;
}

/** The merger is chat-store-free; if it ever reaches for one, fail loudly. */
const noChatStore = new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(`goal service: chatStore.${String(prop)} is not available to the merger`);
		},
	},
) as ChatStore;

export function createGoal(input: CreateGoalInput, deps: GoalServiceDeps): Goal {
	const now = (deps.now ?? (() => new Date().toISOString()))();
	const goalId = (deps.newGoalId ?? newGoalId)();
	const priority = input.priority ?? DEFAULT_GOAL_PRIORITY;

	if (input.title.trim() === "") throw new Error("createGoal: title must not be empty");
	if (!isValidGoalPriority(priority)) throw new Error(`createGoal: priority must be an integer 1 to 5, got ${priority}`);

	let targetNodeId: string;
	if ("existingNodeId" in input) {
		if (!deps.graphStore.readNodes().some((n) => n.id === input.existingNodeId)) {
			throw new Error(`createGoal: unknown node ${input.existingNodeId}`);
		}
		targetNodeId = input.existingNodeId;
	} else {
		if (input.statement.trim() === "") throw new Error("createGoal: statement must not be empty");
		const findings: SessionFindings = {
			propositions: [{ id: "p1", name: input.title, statement: input.statement, aliases: [] }],
			chains: [],
		};
		const verdicts: AuditVerdicts = { links: [] };
		mergeFindings(goalId, findings, verdicts, { chatStore: noChatStore, graphStore: deps.graphStore }, { foldedAt: now });
		const node = deps.graphStore.readNodes().find((n) => n.provenance.some((p) => p.chatId === goalId));
		if (node === undefined) throw new Error("createGoal: the merger did not create the target node");
		targetNodeId = node.id;
	}

	deps.goalsStore.appendEvent({
		type: "created",
		goalId,
		title: input.title,
		origin: input.origin,
		originRef: input.originRef,
		targetNodeIds: [targetNodeId],
		priority,
		at: now,
	});
	const goal = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === goalId);
	if (goal === undefined) throw new Error("createGoal: the created event did not derive a goal");
	return goal;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-goal-service.test.ts`
Expected: PASS, `pass 6`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/goal-service.ts tests/ext-goal-service.test.ts
git commit -m "feat(ext): add createGoal with target node via the upstream merger" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Composition root, contracts and touchpoints docs

**Files:**
- Create: `src/server/ext/stores.ts`
- Create: `docs/ext/TOUCHPOINTS.md`
- Create: `docs/ext/CONTRACTS.md`

- [ ] **Step 1: Write the composition root**

```ts
// src/server/ext/stores.ts
/**
 * THE COMPOSITION ROOT for the extension layer's stores — a separate file
 * from upstream's src/server/stores.ts on purpose (no upstream edit). Later
 * plans add their adapters here.
 */

import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
```

- [ ] **Step 2: Write `docs/ext/TOUCHPOINTS.md`**

````markdown
# Upstream touchpoints

The closed list of files of the LearnHarness fork that this extension edits. Any other
upstream file must stay byte-identical to `upstream/main` (REQ-int-04). Check with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**'
```

| File | Why | Added in |
|---|---|---|
| `package.json` | `allowScripts` entries for `fsevents`, `protobufjs`, `unrs-resolver` | Foundation |

Planned (not yet touched): `src/server/chat-handler.ts` (post-extraction verification hook),
the `kind` union of `ChatRecord` (`src/core/contracts/chat.ts`), `src/server/index.ts` and
`src/core/index.ts` (barrel exports when routes and UI arrive), `package.json` (FSRS, PDF viewer
and MCP dependencies).

Not touched on purpose: `config.ts` (paths are derived in `src/store/ext/paths.ts`) and
`src/server/stores.ts` (the extension has its own root, `src/server/ext/stores.ts`).
````

- [ ] **Step 3: Write `docs/ext/CONTRACTS.md`**

````markdown
# Extension contracts (language-neutral)

These contracts let a later rewrite in another language reproduce the formats and derivations
against the same files (REQ-port-01).

## Directory and stamp

- Directory: `<data root>/ext/`. Data root is `LH_DATA_DIR` or `<repo>/data`.
- `format.json`: `{"version": 1}`. Absent means version 1. A reader that finds a version greater
  than it understands must refuse to read. A corrupt file reads as absent. Reads never create it;
  the first append of any ledger does.

## Ledger files

- UTF-8 JSON Lines, one event per line, append-only, `\n` terminated.
- Readers skip empty lines, lines that are not valid JSON, and lines whose shape their parser rejects.
- Writers must not write an event their parser rejects.

## `goals.jsonl`

Event `created`: `{type:"created", goalId, title, origin, originRef, targetNodeIds, priority, at}`
- `goalId`: non-empty string, `goal_` plus 12 hex characters.
- `title`: non-empty. `origin`: `chat` | `user` | `pdf`. `originRef`: string (may be empty).
- `targetNodeIds`: array of at least one non-empty node id. `priority`: integer 1 to 5, default 3.
- `at`: ISO-8601 timestamp.

Event `status`: `{type:"status", goalId, status, at}` with `status` in `active` | `paused` | `reached`.

Derivation (`deriveGoals`): replay in file order; the first `created` for an id defines the goal
(status `active`, `createdAt = updatedAt = at`); later `created` for the same id are ignored;
`status` for an unknown goal is ignored; a `status` event sets `status` and `updatedAt`.
Goals are returned in creation order.

## Scope

`goalScope(targets, chains)`: the target ids followed by every node id reachable by repeatedly
adding the premises of any chain whose conclusion is already in the set. Each id once; targets
first in input order; terminates on cycles. `activeScope(goals, chains)`: the union of the scopes
of goals whose status is `active`.

## Target node

Creating a goal with a `statement` creates one node through the content-graph merger with
`sourceId = goalId`; the node's provenance is `[{chatId: goalId, messageId: ""}]`. Creating a goal
with an `existingNodeId` creates no node.
````

- [ ] **Step 4: Typecheck and lint**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsc --noEmit && npx eslint src/core/ext src/store/ext src/server/ext tests/ext-*.test.ts tests/helpers`
Expected: both commands exit with code 0 and print no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/ext/stores.ts docs/ext
git commit -m "feat(ext): add composition root and contract docs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification and manual graph check

- [ ] **Step 1: Run the whole test suite**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 2` (the two known `claude-code` tests that assume the CLI is absent), `pass` equal to the previous 3543 plus the new tests (33). Any failure outside the two known ones must be fixed before continuing.

- [ ] **Step 2: Confirm no upstream file changed except `package.json`**

Run: `git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**'`
Expected: only `package.json` is listed.

- [ ] **Step 3: Manual check that a goal node renders in the graph view**

`session-clusters.ts` groups nodes by the chat id of their first provenance point, and the graph view may not expect an id that is neither a chat nor a `src_…` source. Check once in the running app:

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
export LH_DATA_DIR="$(mktemp -d)"
npx tsx -e '
import { createGoal } from "./src/core/ext/goal-service.ts";
import { graphStore } from "./src/store/graph.ts";
import { extStores } from "./src/server/ext/stores.ts";
const goal = createGoal({ title: "Probe goal", statement: "A probe proposition is true.", origin: "user", originRef: "" }, { graphStore, goalsStore: extStores.goalsStore });
console.log(JSON.stringify(goal));
'
npm run dev
```

Open `http://localhost:3000`, open the knowledge map. Expected: the page loads without an error, and the node "Probe goal" is visible. Record the result in the commit message of the next step: if the node does not render or the page errors, stop and write the finding in `docs/ext/TOUCHPOINTS.md` under "Open findings" instead of continuing, because a fix would touch an upstream file.

- [ ] **Step 4: Commit the outcome of the check**

```bash
git add docs/ext
git commit --allow-empty -m "chore(ext): foundation verified (tests green apart from 2 known claude-code tests; goal node check recorded)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (umbrella spec).**
- REQ-int-01 (own stamp, reads never write, newer stamp fails): Task 3, Task 4.
- REQ-int-02 (ext code never writes upstream ledgers except through the merger): Task 8 uses `mergeFindings` only; Task 10 step 2 checks no upstream file changed. The memory store in tests is a helper, not production code.
- REQ-int-03 (upstream lint passes): Task 9 step 4.
- REQ-int-04 (upstream edits only in the closed list): Task 9 `TOUCHPOINTS.md`, Task 10 step 2.
- REQ-goal-01 (goal from chat, user or PDF creates a target node, origin recorded): Task 8 (origin and `originRef` stored; node created).
- REQ-goal-02 (scope = targets plus premise closure): Task 5.
- REQ-port-01 (language-neutral contracts): Task 9 `CONTRACTS.md`.

Not covered here by design: `frontier`, `review`, `verification`, `cards` ledgers and every other requirement belong to the plans of the child specs.

**Placeholder scan.** No TBD or "handle edge cases" steps. Task 10 step 3 is a manual check with an explicit expected result and an explicit stop rule.

**Type consistency.** `GoalEvent`, `Goal`, `parseGoalEvent`, `deriveGoals`, `goalScope`, `activeScope`, `isValidGoalPriority`, `DEFAULT_GOAL_PRIORITY` are defined in Task 5 and used with the same names in Tasks 6, 8. `GoalsStore` (Task 6) is used in Task 8. `createLedger(dir, fileName, parse)` (Task 4) matches Task 6. `extPathsFor`/`EXT_PATHS` (Task 2) match Task 9. `createMemoryGraphStore` (Task 7) matches Task 8's import.

**Known risk to verify during execution.** The Task 8 test assumes `mergeFindings` accepts a `deps` whose `chatStore` is never touched and a `source` of `{ foldedAt }`; this was read from the source (`src/core/graph.ts:149-157`) but not executed. If the merger touches `chatStore` the Proxy will throw and the test names the member.
