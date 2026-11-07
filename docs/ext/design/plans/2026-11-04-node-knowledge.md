# Node Knowledge (Explanations and Node Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every node of the LearnHarness fork a versioned, source-grounded detailed explanation, and a single reusable node panel (explanation, trust, chains, lectures, back-links, cards, goals, neighbourhood mini-graph, actions) that opens beside any view.

**Architecture:** Pure rules and derivations live in `src/core/ext/` (explanation events, staleness fingerprint, complexity, link checks, batching, neighbourhood, panel assembly). One ledger, `data/ext/explanations.jsonl`, goes through the Foundation's `createLedger`. One `submit` sub-agent (the shared `runSubmitAgent` seam) writes batches of explanations; a deterministic loop validates links and placeholders and regenerates at most twice. A server factory (`src/server/ext/node-knowledge.ts`) composes everything behind three thin routes under `app/api/ext/nodes/[id]/`. The panel is one client component, opened through a `lh:open-node` window event, so any view (graph, chat card, later lecture and review) opens it with one call.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node 26, `node:test` via `tsx`, Next.js (the fork's version, see `node_modules/next/dist/docs/`), React, TypeBox (already used by `submit-agent.ts`), pi-ai faux engine for the agent test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-node-knowledge-design.md` (REQ-node-01 to REQ-node-17). Umbrella: `2026-11-04-learning-platform-integration-design.md`.

**Working directory for every command:** `<repo>` (the fork, branch `ext`).

**Command prefix for Node 26:** every shell session starts with `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null`.

**Single test file:** `NODE_ENV=test npx tsx --test tests/<file>`. Output ends with a summary containing `fail 0` when green.

---

## Assumed interfaces (other child plans are written in parallel)

This plan builds on the Foundation (already on branch `ext`) and defines minimal seams for data that other child specs own. None of them blocks Tasks 1 to 11; only Task 12 needs one file from the cost plan.

| Assumed | Owner (child spec) | Shape this plan relies on | Where this plan consumes it |
|---|---|---|---|
| `costGate` | Verification / cost ceiling (REQ-cost-01) | `src/server/ext/cost-gate.ts` exports `costGate` with `allowed(): boolean` and `record(usd: number): void`, one shared daily ceiling | `src/server/ext/node-knowledge-live.ts` (Task 12). If the real gate has other method names, adapt in that one file; the core code only knows the `CostGate` port defined here. |
| Trust level and evidence of a node | Verification (child 1) | `PanelTrust = { level: "unverified" \| "sourced" \| "contested" \| "refuted"; evidence: PanelEvidence[] }`, evidence rows carry `sourceId`, `locator`, `quote`, `stance`, `tier`, `snapshotHash` | `PanelSources.trust` in `src/server/ext/panel-providers.ts`; default is `unverified` with no evidence |
| Lectures citing a node | Lecture / office hours (child 4) | `PanelLecture = { lectureId, title }` list per node | `PanelSources.lecturesCiting` |
| Cards and review state of a node | Personal layer (child 2) | `PanelCard = { cardId, question, status }`, `PanelReview = { dueAt, reps, pinned, retired }` | `PanelSources.cards`, `PanelSources.review` |
| Action handlers: create card, pin, retire, start review, verify now | Child 2 and child 1 | Async function `(nodeId) => unknown` per action | `nodeHandlers` in `src/server/ext/panel-providers.ts`; an absent handler disables its button |
| Chapter run calls the explanation generator | Lecture pipeline (child 4) | After the chapter graph merge it calls `generateNodeExplanations({ nodeIds, source: { text: chapterText, refs: [snapshotHash] } })`, exported by this plan | REQ-node-04 is delivered here as the entry point plus batching; child 4 only adds the call |
| Other plans' `src/core/index.ts`, `src/server/index.ts`, `src/store/ext/..`, `src/server/ext/stores.ts` edits | All | Each plan appends its own lines | Each of my edits to those files is a single appended line |

Everything else (graph, chains, goals, ledger, `createGoal`, memory graph store) is read from the real Foundation code.

## Decisions made in this plan (flag to change)

AGENTS.md says never guess a design decision; these are small defaults taken to keep the plan executable, each reversible in one place.

1. **Staleness fingerprint** is a canonical string, not a hash: the concluding chains' sorted premise lists, joined. Exact, readable, no crypto in `core`.
2. **Maximum sentence length** (open item): one constant, 25 words, for every language. A per-language table is not built until a real case needs one. Warning only.
3. **Batch rule** (open item): breadth-first order over the undirected chain adjacency inside the requested set, starting from the smallest id of each component, cut into batches of 6.
4. **Writer model role:** `teacher` (strong slot), because explanation quality is the product. Switching to a cheaper slot is one string in `node-knowledge-live.ts`.
5. **Style guide override** (open item): upstream's override grammar (`isValidSegmentPath`) accepts only the `prober/teacher/practice/shared` keys, so extending it would edit upstream. The default ships in `src/agent/ext/prompts/explanation-style.md`; a file at `<data>/prompts/ext/explanation-style.md` replaces it when present (read on every generation).
6. **Mini-graph** (open item): derived from the chains already in the panel data (premise to conclusion adjacency), with a tiny radial layout. Upstream's force layout and 1700-line `graph-view.tsx` are not reused (tight coupling, nothing to share without edits).
7. **Chat mentions** (open item): the only real node mention in chat today is the graph-context card (propositions with ids). It gets a button that opens the panel. No `[[…]]` markup is injected into teacher output, and no prompt file is edited.
8. **Panel placement:** a fixed right-hand `aside` plus matching `padding-right` on `body`, so the current view shrinks and is never replaced. Functional only; the UI session redesigns it.
9. **Agent versus user text:** an agent version written over a user-authored current version is stored as a `proposed` version; nothing changes until the user approves.
10. **Source context outside chapter runs:** the quotes of the node's verification evidence (assumed interface) are the source text, their snapshot hashes the references; none means "no source context".

## Simplification review (done before writing the tasks)

- Eliminated: a stored back-link index, a stored staleness flag, a per-language sentence table, a hash dependency, a second panel for graph and chat (one component), a new model role, a new prompt-override grammar, graph-view code reuse, a `[[…]]` syntax in chat, a regeneration queue (single-flight in memory is enough for one user).
- Kept because a spec requirement needs it: versions plus decisions (REQ-02), fingerprint (REQ-03), batching (REQ-04), ceiling gate (REQ-05, 16), complexity (REQ-06), deterministic checks (REQ-07, 08), history (REQ-13).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/ext/explanations.ts` | Event types, parser, derivation of current explanation and pending proposal (pure) |
| `src/core/ext/explanation-rules.ts` | Concluding-chains fingerprint, staleness, premise depth, complexity, form (pure) |
| `src/core/ext/explanation-check.ts` | Link extraction, deterministic checks, back-links, link rendering (pure, browser-safe) |
| `src/core/ext/explanation-batches.ts` | Grouping of neighbouring nodes into batches (pure) |
| `src/core/ext/node-knowledge-ports.ts` | `ExplanationsStore`, `ExplanationWriter`, `CostGate` ports |
| `src/core/ext/explanation-service.ts` | `generateExplanations`, `saveUserExplanation`, `decideProposal` (core, ports only) |
| `src/core/ext/neighbourhood.ts` | Depth 1 and 2 neighbourhood and radial positions (pure, browser-safe) |
| `src/core/ext/panel-history.ts` | Back and forward history (pure, browser-safe) |
| `src/core/ext/node-panel-types.ts` | Panel data types, `PanelSources`, `NODE_ACTIONS` (types and a const, browser-safe) |
| `src/core/ext/node-panel.ts` | `buildNodePanel` (server side, imports `core/graph.ts`) |
| `src/core/ext/index.ts` | Browser-safe barrel of the ext core |
| `src/store/ext/explanations-store.ts` | `ExplanationsStore` adapter over `createLedger` |
| `src/agent/ext/prompts/explanation-style.md` | Editable controlled-language style guide (default) |
| `src/agent/ext/explanation-writer.ts` | `createExplanationWriter`: style guide loading, prompt, `runSubmitAgent` |
| `src/server/ext/node-knowledge.ts` | `createNodeKnowledge` factory: panel, single-flight generation, edit, decide, actions |
| `src/server/ext/panel-providers.ts` | Default empty `PanelSources` and action handlers (later plans fill them) |
| `src/server/ext/node-knowledge-live.ts` | Live wiring (stores, engine, pricing, cost gate) |
| `src/server/ext/index.ts` | Server barrel of the ext layer |
| `app/api/ext/error-response.ts` | Maps `NodeKnowledgeError` to a JSON response |
| `app/api/ext/nodes/[id]/panel/route.ts` | `GET` panel data |
| `app/api/ext/nodes/[id]/explanation/route.ts` | `POST` generate, save, approve, reject |
| `app/api/ext/nodes/[id]/actions/route.ts` | `POST` node actions |
| `components/ext/open-node.ts` | `openNodePanel(nodeId)` and the event name |
| `components/ext/node-panel-view.tsx` | Presentational panel (testable) |
| `components/ext/node-panel.tsx` | Container: fetch, history, generation trigger, actions |
| `components/ext/node-panel-host.tsx` | Listens for the event, mounts the aside |
| `tests/helpers/ext-node-fixtures.ts` | Node and chain builders, memory explanations store, fake writer, cost gates |
| `tests/ext-*.test.ts(x)` | One test file per module |
| `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md` | Language-neutral contracts, closed list of upstream edits |

Upstream files edited (all added to `docs/ext/TOUCHPOINTS.md` in Task 16): `src/core/index.ts`, `src/server/index.ts`, `app/layout.tsx`, `components/graph-view.tsx`, `components/graph-context-card.tsx`. New files under `src/**/ext/`, `app/api/ext/`, `components/ext/` are not upstream edits.

---

### Task 1: Environment and baseline check (first, per plan rule)

**Files:** none changed.

- [ ] **Step 1: Confirm branch, Node version and a clean start**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
git branch --show-current
node --version
git status --short | head
```

Expected: `ext`; `v26.x.x`; no output from `git status` (or only files you know are yours). If the branch is not `ext`, run `git checkout ext`.

- [ ] **Step 2: Confirm the Foundation exists**

```bash
ls src/core/ext src/store/ext src/server/ext docs/ext tests/helpers/memory-graph-store.ts
```

Expected: `goal-service.ts goals.ts ports.ts`, `format.ts goals-store.ts ledger.ts paths.ts`, `stores.ts`, `CONTRACTS.md TOUCHPOINTS.md`, and the helper file listed.

- [ ] **Step 3: Baseline of the Foundation tests, typecheck and lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-*.test.ts 2>&1 | tail -8
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: `fail 0` for the ext tests; typecheck and lint print no errors. If either prints errors that exist before this plan, write them down: they are not caused by this plan and Task 18 compares against this baseline.

- [ ] **Step 4: Read the Next.js route conventions (AGENTS.md rule)**

```bash
sed -n 1,60p node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
```

Expected: confirms route handlers export `GET`/`POST` functions and that dynamic `params` is a `Promise` (the existing `app/api/graph/nodes/[id]/route.ts` already does `const { id } = await params`). Follow that file's pattern in Task 13.

- [ ] **Step 5: No commit (nothing changed).**

---

### Task 2: Explanation events and derivation (REQ-node-01, REQ-node-02)

**Files:**
- Create: `src/core/ext/explanations.ts`
- Test: `tests/ext-explanations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-explanations.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveExplanations, parseExplanationEvent, type ExplanationEvent } from "../src/core/ext/explanations.ts";

type VersionEvent = Extract<ExplanationEvent, { type: "version" }>;
const AT = "2026-11-04T10:00:00.000Z";

function v(over: Partial<VersionEvent> = {}): ExplanationEvent {
	return {
		type: "version",
		nodeId: "n_a",
		version: 1,
		body: "A holds.",
		author: "agent",
		sourceRefs: [],
		styleVersion: "s1",
		fingerprint: "",
		noSource: true,
		proposed: false,
		at: AT,
		...over,
	};
}
const decision = (version: number, d: "approved" | "rejected", nodeId = "n_a"): ExplanationEvent => ({
	type: "decision",
	nodeId,
	version,
	decision: d,
	at: AT,
});

describe("parseExplanationEvent", () => {
	it("accepts a valid version and a valid decision", () => {
		assert.deepEqual(parseExplanationEvent(v()), v());
		assert.deepEqual(parseExplanationEvent(decision(2, "approved")), decision(2, "approved"));
	});

	it("rejects malformed events", () => {
		for (const bad of [
			null,
			"x",
			{ type: "other" },
			v({ body: "   " }),
			v({ version: 0 }),
			v({ version: 1.5 }),
			v({ nodeId: "" }),
			v({ author: "user", proposed: true }),
			{ ...v(), sourceRefs: "h" },
			{ ...v(), noSource: "yes" },
			{ ...decision(1, "approved"), decision: "maybe" },
		]) {
			assert.equal(parseExplanationEvent(bad), null, JSON.stringify(bad));
		}
	});

	it("accepts the empty fingerprint of a node with no concluding chain", () => {
		assert.notEqual(parseExplanationEvent(v({ fingerprint: "" })), null);
	});
});

describe("deriveExplanations", () => {
	it("the latest accepted version is the current explanation", () => {
		const map = deriveExplanations([v({ version: 1, body: "one" }), v({ version: 2, body: "two" })]);
		assert.equal(map.get("n_a")?.current?.body, "two");
		assert.equal(map.get("n_a")?.latestVersion, 2);
		assert.equal(map.get("n_a")?.proposal, null);
	});

	it("a proposed version is not current until approved (REQ-node-02)", () => {
		const events = [v({ version: 1, author: "user", body: "mine" }), v({ version: 2, proposed: true, body: "agent" })];
		const pending = deriveExplanations(events).get("n_a");
		assert.equal(pending?.current?.body, "mine");
		assert.equal(pending?.proposal?.body, "agent");
		const approved = deriveExplanations([...events, decision(2, "approved")]).get("n_a");
		assert.equal(approved?.current?.body, "agent");
		assert.equal(approved?.proposal, null);
	});

	it("a rejected proposal disappears and the user version stays current", () => {
		const events = [v({ version: 1, author: "user", body: "mine" }), v({ version: 2, proposed: true }), decision(2, "rejected")];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "mine");
		assert.equal(e?.proposal, null);
		assert.equal(e?.latestVersion, 2);
	});

	it("a newer user version supersedes an older pending proposal", () => {
		const events = [v({ version: 1, proposed: true }), v({ version: 2, author: "user", body: "newer" })];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "newer");
		assert.equal(e?.proposal, null);
	});

	it("the first line for a version number wins; decisions for unknown versions or nodes are ignored", () => {
		const events = [v({ version: 1, body: "first" }), v({ version: 1, body: "dup" }), decision(9, "approved"), decision(1, "approved", "n_zzz")];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "first");
		assert.equal(deriveExplanations(events).has("n_zzz"), false);
	});

	it("keeps nodes separate", () => {
		const map = deriveExplanations([v({ nodeId: "n_a" }), v({ nodeId: "n_b", body: "B" })]);
		assert.equal(map.size, 2);
		assert.equal(map.get("n_b")?.current?.body, "B");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanations.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/explanations.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ext/explanations.ts
/**
 * Explanation events (node-knowledge spec: REQ-node-01, REQ-node-02).
 * Versioned events per node, derived state: the CURRENT explanation is the
 * latest ACCEPTED version; a PROPOSED version (an agent text written over a
 * user-authored one) becomes current only after an `approved` decision.
 * Pure: no IO, no clock.
 */

export type ExplanationAuthor = "agent" | "user";

export type ExplanationEvent =
	| {
			type: "version";
			nodeId: string;
			version: number;
			body: string;
			author: ExplanationAuthor;
			/** Snapshot hashes the text is grounded in; [] when none. */
			sourceRefs: string[];
			/** Hash of the style guide the writer used; "user" for user text. */
			styleVersion: string;
			/** concludingFingerprint at write time (explanation-rules.ts). */
			fingerprint: string;
			/** True when generated without source text ("no source context"). */
			noSource: boolean;
			/** True only for an agent text awaiting the user's decision. */
			proposed: boolean;
			at: string;
	  }
	| { type: "decision"; nodeId: string; version: number; decision: "approved" | "rejected"; at: string };

export interface ExplanationVersion {
	nodeId: string;
	version: number;
	body: string;
	author: ExplanationAuthor;
	sourceRefs: string[];
	styleVersion: string;
	fingerprint: string;
	noSource: boolean;
	at: string;
}

export interface NodeExplanation {
	nodeId: string;
	current: ExplanationVersion | null;
	/** Highest undecided proposed version newer than `current`; else null. */
	proposal: ExplanationVersion | null;
	/** Highest version number ever written (proposals included); 0 if none. */
	latestVersion: number;
}

function isNonEmptyString(x: unknown): x is string {
	return typeof x === "string" && x !== "";
}

export function parseExplanationEvent(raw: unknown): ExplanationEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isNonEmptyString(r.nodeId) || typeof r.at !== "string") return null;
	if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) return null;
	if (r.type === "decision") {
		if (r.decision !== "approved" && r.decision !== "rejected") return null;
		return { type: "decision", nodeId: r.nodeId, version: r.version, decision: r.decision, at: r.at };
	}
	if (r.type === "version") {
		if (typeof r.body !== "string" || r.body.trim() === "") return null;
		if (r.author !== "agent" && r.author !== "user") return null;
		if (!Array.isArray(r.sourceRefs) || !r.sourceRefs.every((s) => typeof s === "string")) return null;
		if (typeof r.styleVersion !== "string" || typeof r.fingerprint !== "string") return null;
		if (typeof r.noSource !== "boolean" || typeof r.proposed !== "boolean") return null;
		if (r.proposed && r.author !== "agent") return null;
		return {
			type: "version",
			nodeId: r.nodeId,
			version: r.version,
			body: r.body,
			author: r.author,
			sourceRefs: [...(r.sourceRefs as string[])],
			styleVersion: r.styleVersion,
			fingerprint: r.fingerprint,
			noSource: r.noSource,
			proposed: r.proposed,
			at: r.at,
		};
	}
	return null;
}

interface Slot {
	version: ExplanationVersion;
	proposed: boolean;
	decision?: "approved" | "rejected";
}

/** Replay the events. First line for a (node, version) wins; decisions only bind proposed versions. */
export function deriveExplanations(events: readonly ExplanationEvent[]): Map<string, NodeExplanation> {
	const byNode = new Map<string, Map<number, Slot>>();
	for (const e of events) {
		if (e.type !== "version") continue;
		let slots = byNode.get(e.nodeId);
		if (slots === undefined) {
			slots = new Map();
			byNode.set(e.nodeId, slots);
		}
		if (slots.has(e.version)) continue;
		slots.set(e.version, {
			proposed: e.proposed,
			version: {
				nodeId: e.nodeId,
				version: e.version,
				body: e.body,
				author: e.author,
				sourceRefs: [...e.sourceRefs],
				styleVersion: e.styleVersion,
				fingerprint: e.fingerprint,
				noSource: e.noSource,
				at: e.at,
			},
		});
	}
	for (const e of events) {
		if (e.type !== "decision") continue;
		const slot = byNode.get(e.nodeId)?.get(e.version);
		if (slot !== undefined && slot.proposed) slot.decision = e.decision;
	}
	const out = new Map<string, NodeExplanation>();
	for (const [nodeId, slots] of byNode) {
		const ordered = [...slots.values()].sort((a, b) => a.version.version - b.version.version);
		let current: ExplanationVersion | null = null;
		for (const s of ordered) if (!s.proposed || s.decision === "approved") current = s.version;
		let proposal: ExplanationVersion | null = null;
		for (const s of ordered) {
			if (s.proposed && s.decision === undefined && s.version.version > (current?.version ?? 0)) proposal = s.version;
		}
		const last = ordered[ordered.length - 1];
		out.set(nodeId, { nodeId, current, proposal, latestVersion: last?.version.version ?? 0 });
	}
	return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanations.test.ts`
Expected: all tests pass, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/explanations.ts tests/ext-explanations.test.ts
git commit -m "feat(ext): add explanation events and derivation" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fingerprint, staleness, complexity (REQ-node-03, REQ-node-06)

**Files:**
- Create: `src/core/ext/explanation-rules.ts`
- Test: `tests/ext-explanation-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-explanation-rules.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	concludingFingerprint,
	explanationForm,
	isComplex,
	isStale,
	premiseDepth,
} from "../src/core/ext/explanation-rules.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("concludingFingerprint", () => {
	it("is empty for a node no chain concludes", () => {
		assert.equal(concludingFingerprint("n_a", [c(["n_a"], "n_b")]), "");
	});

	it("ignores premise order, duplicates and chain order", () => {
		const one = concludingFingerprint("n_x", [c(["n_b", "n_a"], "n_x"), c(["n_c"], "n_x")]);
		const two = concludingFingerprint("n_x", [c(["n_c"], "n_x"), c(["n_a", "n_b", "n_a"], "n_x")]);
		assert.equal(one, two);
		assert.equal(one, "n_a,n_b|n_c");
	});

	it("changes when an argument is added or a premise changes, and ignores other conclusions", () => {
		const base = [c(["n_a"], "n_x")];
		const before = concludingFingerprint("n_x", base);
		assert.notEqual(concludingFingerprint("n_x", [...base, c(["n_b"], "n_x")]), before);
		assert.notEqual(concludingFingerprint("n_x", [c(["n_z"], "n_x")]), before);
		assert.equal(concludingFingerprint("n_x", [...base, c(["n_b"], "n_other")]), before);
	});
});

describe("isStale (REQ-node-03)", () => {
	it("is stale exactly when the stored fingerprint differs from the current chains", () => {
		const chains = [c(["n_a"], "n_x")];
		assert.equal(isStale({ fingerprint: "n_a" }, "n_x", chains), false);
		assert.equal(isStale({ fingerprint: "" }, "n_x", chains), true);
		assert.equal(isStale({ fingerprint: "n_a" }, "n_x", [...chains, c(["n_b"], "n_x")]), true);
	});
});

describe("premiseDepth and isComplex (REQ-node-06)", () => {
	const ladder = [c(["n_a"], "n_b"), c(["n_b"], "n_c"), c(["n_c"], "n_d")];

	it("depth counts the longest premise path", () => {
		assert.equal(premiseDepth("n_a", ladder), 0);
		assert.equal(premiseDepth("n_b", ladder), 1);
		assert.equal(premiseDepth("n_c", ladder), 2);
		assert.equal(premiseDepth("n_d", ladder), 3);
	});

	it("depth 3 is complex, depth 2 is not", () => {
		assert.equal(isComplex("n_d", ladder), true);
		assert.equal(isComplex("n_c", ladder), false);
	});

	it("a chain with 3 premises is complex, with 2 it is not, duplicates do not count", () => {
		assert.equal(isComplex("n_x", [c(["n_a", "n_b", "n_c"], "n_x")]), true);
		assert.equal(isComplex("n_x", [c(["n_a", "n_b"], "n_x")]), false);
		assert.equal(isComplex("n_x", [c(["n_a", "n_a", "n_b"], "n_x")]), false);
	});

	it("an alternative argument with 3 premises makes the node complex", () => {
		assert.equal(isComplex("n_x", [c(["n_a"], "n_x"), c(["n_b", "n_c", "n_d"], "n_x")]), true);
	});

	it("terminates on a cycle", () => {
		const loop = [c(["n_x"], "n_y"), c(["n_y"], "n_x")];
		assert.equal(Number.isFinite(premiseDepth("n_x", loop)), true);
	});

	it("explanationForm maps complexity to the long form", () => {
		assert.equal(explanationForm("n_d", ladder), "long");
		assert.equal(explanationForm("n_a", ladder), "short");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-rules.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/explanation-rules.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ext/explanation-rules.ts
/**
 * Pure rules of node explanations (node-knowledge spec).
 *  - FINGERPRINT (REQ-node-03): a canonical string of the chains that
 *    conclude a node. Chain ids are not stable (the merger rewrites the
 *    ledger), premises and conclusions are, so the fingerprint is built from
 *    those. Stored with each explanation; a different value now means STALE.
 *  - COMPLEXITY (REQ-node-06): a node is complex when some chain concluding
 *    it has at least 3 distinct premises, or when the longest premise path
 *    below it has length at least 3.
 */

import type { GraphChain } from "../contracts.ts";

type ChainLike = Pick<GraphChain, "premises" | "conclusion">;

export const COMPLEX_MIN_PREMISES = 3;
export const COMPLEX_MIN_DEPTH = 3;

export type ExplanationForm = "short" | "long";

/**
 * Each concluding chain becomes its distinct premise ids sorted (default
 * string order) and joined by ","; the chain strings are de-duplicated,
 * sorted and joined by "|". A node no chain concludes yields "".
 */
export function concludingFingerprint(nodeId: string, chains: readonly ChainLike[]): string {
	const lines = new Set<string>();
	for (const chain of chains) {
		if (chain.conclusion === nodeId) lines.add([...new Set(chain.premises)].sort().join(","));
	}
	return [...lines].sort().join("|");
}

export function isStale(current: { fingerprint: string }, nodeId: string, chains: readonly ChainLike[]): boolean {
	return current.fingerprint !== concludingFingerprint(nodeId, chains);
}

/**
 * Longest premise path below a node: 0 when no chain concludes it, else
 * 1 + the deepest premise over all its concluding chains. Cycle-safe
 * (a premise already on the current path is skipped); the graph is meant to
 * be a DAG, so the cut only guarantees termination.
 */
export function premiseDepth(nodeId: string, chains: readonly ChainLike[]): number {
	const premisesOf = new Map<string, string[]>();
	for (const chain of chains) {
		const bucket = premisesOf.get(chain.conclusion);
		if (bucket === undefined) premisesOf.set(chain.conclusion, [...chain.premises]);
		else bucket.push(...chain.premises);
	}
	const memo = new Map<string, number>();
	const visit = (id: string, path: ReadonlySet<string>): number => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		const premises = premisesOf.get(id);
		if (premises === undefined) return 0;
		const next = new Set(path).add(id);
		let best = 0;
		for (const premise of premises) {
			if (next.has(premise)) continue;
			best = Math.max(best, 1 + visit(premise, next));
		}
		memo.set(id, best);
		return best;
	};
	return visit(nodeId, new Set());
}

export function isComplex(nodeId: string, chains: readonly ChainLike[]): boolean {
	for (const chain of chains) {
		if (chain.conclusion === nodeId && new Set(chain.premises).size >= COMPLEX_MIN_PREMISES) return true;
	}
	return premiseDepth(nodeId, chains) >= COMPLEX_MIN_DEPTH;
}

export function explanationForm(nodeId: string, chains: readonly ChainLike[]): ExplanationForm {
	return isComplex(nodeId, chains) ? "long" : "short";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-rules.test.ts`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/explanation-rules.ts tests/ext-explanation-rules.test.ts
git commit -m "feat(ext): add explanation fingerprint, staleness and complexity rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Deterministic checks, links, back-links (REQ-node-07, 08, 15)

**Files:**
- Create: `src/core/ext/explanation-check.ts`
- Test: `tests/ext-explanation-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-explanation-check.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkExplanation,
	extractNodeLinks,
	linkifyNodeLinks,
	MAX_SENTENCE_WORDS,
	mentionedBy,
	NODE_HREF_PREFIX,
} from "../src/core/ext/explanation-check.ts";

const ids = new Set(["n_a", "n_b"]);
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("extractNodeLinks", () => {
	it("returns each linked id once, in order", () => {
		assert.deepEqual(extractNodeLinks("See [[n_b]] and [[n_a]], then [[n_b]] again."), ["n_b", "n_a"]);
	});
	it("ignores single brackets and links with spaces", () => {
		assert.deepEqual(extractNodeLinks("[n_a] and [[not a link]]"), []);
	});
});

describe("checkExplanation (REQ-node-07, REQ-node-08)", () => {
	it("passes a clean text", () => {
		assert.deepEqual(checkExplanation("A implies [[n_a]]. It is short.", ids), { errors: [], warnings: [] });
	});

	it("rejects an unresolved link as an error", () => {
		const result = checkExplanation("Needs [[n_missing]].", ids);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0] ?? "", /n_missing/);
	});

	it("rejects an empty text and placeholders", () => {
		assert.equal(checkExplanation("   ", ids).errors.length, 1);
		for (const bad of ["TODO write this.", "This is TBD.", "Lorem ipsum dolor.", "Step [...] here.", "[insert example] now."]) {
			assert.equal(checkExplanation(bad, ids).errors.length, 1, bad);
		}
	});

	it("does not flag the ordinary word todo", () => {
		assert.deepEqual(checkExplanation("Es todo lo que hace falta.", ids).errors, []);
	});

	it("warns, never errors, on a sentence longer than the limit", () => {
		const long = `${words(MAX_SENTENCE_WORDS + 5)}.`;
		const result = checkExplanation(long, ids);
		assert.deepEqual(result.errors, []);
		assert.equal(result.warnings.length, 1);
		assert.equal(checkExplanation(`${words(MAX_SENTENCE_WORDS)}.`, ids).warnings.length, 0);
	});

	it("does not count formulas, code, headings or link ids as words", () => {
		const text = `## Heading with many many many many many many many many many many many many many many many many many many many many many many many many many many words\n\nWe get $${words(40)}$ and [[n_a]].\n\n\`\`\`\n${words(60)}.\n\`\`\``;
		assert.deepEqual(checkExplanation(text, ids).warnings, []);
	});

	it("rejects a nonsense limit", () => {
		assert.throws(() => checkExplanation("x.", ids, 0), RangeError);
	});
});

describe("mentionedBy (REQ-node-15: derived, never stored)", () => {
	it("lists the nodes whose current explanation links to the target, sorted, excluding itself", () => {
		const bodies = new Map([
			["n_c", "Uses [[n_a]]."],
			["n_b", "Uses [[n_a]] and [[n_c]]."],
			["n_a", "Mentions itself [[n_a]]."],
			["n_d", "No link."],
		]);
		assert.deepEqual(mentionedBy("n_a", bodies), ["n_b", "n_c"]);
		assert.deepEqual(mentionedBy("n_c", bodies), ["n_b"]);
		assert.deepEqual(mentionedBy("n_zzz", bodies), []);
	});
});

describe("linkifyNodeLinks", () => {
	it("turns a known link into a markdown link with the node name and hides unknown ones", () => {
		const out = linkifyNodeLinks("See [[n_a]] and [[n_x]].", { n_a: "Alpha [1]" });
		assert.equal(out, `See [Alpha 1](${NODE_HREF_PREFIX}n_a) and (unknown node).`);
	});
	it("does not trust inherited object keys", () => {
		assert.equal(linkifyNodeLinks("[[constructor]]", {}), "(unknown node)");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-check.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/explanation-check.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ext/explanation-check.ts
/**
 * Deterministic checks and link handling for explanations (REQ-node-07,
 * REQ-node-08, REQ-node-15). Pure and browser-safe (no node: imports): the
 * panel uses extractNodeLinks/linkifyNodeLinks on the client too.
 *
 * Errors BLOCK a text (unresolved link, placeholder, empty). Warnings never
 * block (sentence length), because rigid length rules would harm
 * intuition-first explanations.
 */

/** One limit for every language until a real case needs a table. */
export const MAX_SENTENCE_WORDS = 25;

/** href prefix of a rendered node link; the panel intercepts clicks on it. */
export const NODE_HREF_PREFIX = "#node:";

const linkPattern = () => /\[\[([^\[\]\s]+)\]\]/g;
const PLACEHOLDER_CAPS = /\b(?:TODO|TBD|FIXME|XXX)\b/;
const PLACEHOLDER_TEXT = /lorem ipsum|\[\.\.\.\]|\[insert[^\]]*\]|<placeholder>/i;

export interface ExplanationCheck {
	errors: string[];
	warnings: string[];
}

/** Each linked node id once, in order of first appearance. */
export function extractNodeLinks(body: string): string[] {
	const out: string[] = [];
	for (const match of body.matchAll(linkPattern())) {
		const id = match[1];
		if (id !== undefined && !out.includes(id)) out.push(id);
	}
	return out;
}

/** Prose only: code, formulas, headings and list markers removed; a link counts as one word. */
function prose(body: string): string {
	return body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " formula ")
		.replace(/\$[^$\n]+\$/g, " formula ")
		.replace(linkPattern(), "link")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n")
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
}

function sentencesOf(body: string): string[] {
	return prose(body)
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

export function checkExplanation(
	body: string,
	validIds: ReadonlySet<string>,
	maxSentenceWords: number = MAX_SENTENCE_WORDS,
): ExplanationCheck {
	if (!Number.isInteger(maxSentenceWords) || maxSentenceWords < 1) {
		throw new RangeError(`checkExplanation: maxSentenceWords must be a positive integer, got ${maxSentenceWords}`);
	}
	if (body.trim() === "") return { errors: ["the explanation is empty"], warnings: [] };
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const id of extractNodeLinks(body)) {
		if (!validIds.has(id)) errors.push(`link [[${id}]] does not resolve to an existing node`);
	}
	if (PLACEHOLDER_CAPS.test(body) || PLACEHOLDER_TEXT.test(body)) errors.push("the explanation contains a placeholder");
	for (const sentence of sentencesOf(body)) {
		const count = sentence.split(/\s+/).filter((w) => w !== "").length;
		if (count > maxSentenceWords) {
			warnings.push(`sentence of ${count} words (limit ${maxSentenceWords}): "${sentence.slice(0, 50)}"`);
		}
	}
	return { errors, warnings };
}

/**
 * Back-links: ids of the nodes whose CURRENT explanation links to `nodeId`.
 * Derived on every call from the bodies, never stored. Sorted, no self.
 */
export function mentionedBy(nodeId: string, currentBodies: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	for (const [id, body] of currentBodies) {
		if (id !== nodeId && extractNodeLinks(body).includes(nodeId)) out.push(id);
	}
	return out.sort();
}

/** Render `[[id]]` as a markdown link `[name](#node:id)`; unknown ids become "(unknown node)". */
export function linkifyNodeLinks(body: string, names: Readonly<Record<string, string>>): string {
	return body.replace(linkPattern(), (_match, id: string) => {
		if (!Object.hasOwn(names, id)) return "(unknown node)";
		const name = (names[id] ?? id).replace(/[\[\]]/g, "");
		return `[${name}](${NODE_HREF_PREFIX}${id})`;
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-check.test.ts`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/explanation-check.ts tests/ext-explanation-check.test.ts
git commit -m "feat(ext): add explanation checks, link extraction and back-links" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Batches of neighbouring nodes (REQ-node-04)

**Files:**
- Create: `src/core/ext/explanation-batches.ts`
- Test: `tests/ext-explanation-batches.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-explanation-batches.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BATCH_SIZE, planBatches } from "../src/core/ext/explanation-batches.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("planBatches (REQ-node-04)", () => {
	it("groups connected nodes together instead of cutting by id order", () => {
		// n1-n3 are connected, n2-n4 are connected; plain id order would give [n1,n2],[n3,n4]
		const batches = planBatches(["n1", "n2", "n3", "n4"], [c(["n1"], "n3"), c(["n2"], "n4")], 2);
		assert.deepEqual(batches, [
			["n1", "n3"],
			["n2", "n4"],
		]);
	});

	it("walks a chain breadth-first from the smallest id and cuts into batches of the given size", () => {
		const chains = [c(["a"], "b"), c(["b"], "c"), c(["c"], "d")];
		assert.deepEqual(planBatches(["a", "b", "c", "d", "e"], chains, 3), [
			["a", "b", "c"],
			["d", "e"],
		]);
	});

	it("only connects nodes that are both requested", () => {
		assert.deepEqual(planBatches(["a", "c"], [c(["a"], "b"), c(["b"], "c")], 1), [["a"], ["c"]]);
	});

	it("de-duplicates, handles empty input and defaults the size", () => {
		assert.deepEqual(planBatches([], []), []);
		assert.deepEqual(planBatches(["a", "a"], []), [["a"]]);
		const many = Array.from({ length: DEFAULT_BATCH_SIZE + 1 }, (_, i) => `n${String(i).padStart(2, "0")}`);
		const batches = planBatches(many, []);
		assert.equal(batches.length, 2);
		assert.equal(batches[0]?.length, DEFAULT_BATCH_SIZE);
	});

	it("covers every node exactly once", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		const flat = planBatches(ids, [c(["a", "b"], "c"), c(["c"], "g")], 3).flat();
		assert.deepEqual([...flat].sort(), ids);
	});

	it("rejects a batch size below 1", () => {
		assert.throws(() => planBatches(["a"], [], 0), RangeError);
		assert.throws(() => planBatches(["a"], [], 1.5), RangeError);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-batches.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/explanation-batches.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ext/explanation-batches.ts
/**
 * Batches of NEIGHBOURING nodes for a chapter run (REQ-node-04). One model
 * call writes one batch, so nodes that explain each other should share a
 * call. Rule: order the requested ids by a breadth-first walk over the
 * undirected premise/conclusion adjacency among the requested ids (each
 * component starts at its smallest id, neighbours visited in id order), then
 * cut that order into batches of `batchSize`. Deterministic.
 */

import type { GraphChain } from "../contracts.ts";

export const DEFAULT_BATCH_SIZE = 6;

export function planBatches(
	nodeIds: readonly string[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	batchSize: number = DEFAULT_BATCH_SIZE,
): string[][] {
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new RangeError(`planBatches: batchSize must be a positive integer, got ${batchSize}`);
	}
	const ids = [...new Set(nodeIds)].sort();
	const inSet = new Set(ids);
	const adjacent = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
	for (const chain of chains) {
		if (!inSet.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (!inSet.has(premise) || premise === chain.conclusion) continue;
			adjacent.get(premise)?.add(chain.conclusion);
			adjacent.get(chain.conclusion)?.add(premise);
		}
	}
	const order: string[] = [];
	const seen = new Set<string>();
	for (const start of ids) {
		if (seen.has(start)) continue;
		seen.add(start);
		const queue = [start];
		while (queue.length > 0) {
			const id = queue.shift();
			if (id === undefined) break;
			order.push(id);
			for (const next of [...(adjacent.get(id) ?? [])].sort()) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
	}
	const batches: string[][] = [];
	for (let i = 0; i < order.length; i += batchSize) batches.push(order.slice(i, i + batchSize));
	return batches;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-batches.test.ts`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/explanation-batches.ts tests/ext-explanation-batches.test.ts
git commit -m "feat(ext): add batching of neighbouring nodes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ports, store adapter, test fixtures (REQ-node-01)

**Files:**
- Create: `src/core/ext/node-knowledge-ports.ts`
- Create: `src/store/ext/explanations-store.ts`
- Create: `tests/helpers/ext-node-fixtures.ts`
- Test: `tests/ext-explanations-store.test.ts`

- [ ] **Step 1: Write the ports file**

```ts
// src/core/ext/node-knowledge-ports.ts
/**
 * Ports of the node-knowledge feature (same hexagonal rule as ports.ts):
 * core codes against these types, adapters live in src/store/ext/ and
 * src/agent/ext/, wiring happens in src/server/ext/.
 */

import type { ExplanationEvent } from "./explanations.ts";
import type { ExplanationForm } from "./explanation-rules.ts";

export interface ExplanationsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: ExplanationEvent): void;
	/** Valid events in append order. */
	readEvents(): ExplanationEvent[];
}

/** Text a generation is grounded in; `refs` are snapshot hashes (may be empty). */
export interface SourceContext {
	text: string;
	refs: string[];
}

/** What the writer needs to know about one node. */
export interface WriterNode {
	id: string;
	name: string;
	statement: string;
	aliases: string[];
	form: ExplanationForm;
	/** One entry per chain concluding this node: that chain's premises. */
	arguments: Array<Array<{ id: string; name: string; statement: string }>>;
	/** Nodes that use this node as a premise. */
	usedIn: Array<{ id: string; name: string }>;
}

export interface WriterRequest {
	nodes: WriterNode[];
	source: SourceContext | null;
	/** nodeId -> problems found in the previous attempt (empty on the first). */
	feedback: Record<string, string[]>;
}

export interface WriterResult {
	/** nodeId -> markdown body (with `[[node id]]` inline links). */
	bodies: Record<string, string>;
	costUsd: number;
	/** Hash of the style guide used. */
	styleVersion: string;
}

export interface ExplanationWriter {
	write(request: WriterRequest): Promise<WriterResult>;
}

/** The single daily cost ceiling of the umbrella spec (REQ-cost-01, REQ-node-16). */
export interface CostGate {
	allowed(): boolean;
	record(usd: number): void;
}
```

- [ ] **Step 2: Write the store adapter**

```ts
// src/store/ext/explanations-store.ts
import { parseExplanationEvent } from "../../core/ext/explanations.ts";
import type { ExplanationsStore } from "../../core/ext/node-knowledge-ports.ts";
import { createLedger } from "./ledger.ts";

export function createExplanationsStore(dir: string): ExplanationsStore {
	const ledger = createLedger(dir, "explanations.jsonl", parseExplanationEvent);
	return {
		appendEvent: (event) => ledger.append(event),
		readEvents: () => ledger.readAll(),
	};
}
```

- [ ] **Step 3: Write the shared test fixtures**

```ts
// tests/helpers/ext-node-fixtures.ts
/**
 * Builders and fakes shared by the node-knowledge tests: graph nodes and
 * chains, an in-memory explanations store, a scripted writer and cost gates.
 */

import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { ExplanationEvent } from "../../src/core/ext/explanations.ts";
import type {
	CostGate,
	ExplanationsStore,
	ExplanationWriter,
	WriterRequest,
} from "../../src/core/ext/node-knowledge-ports.ts";
import type { GraphStore } from "../../src/core/ports.ts";
import { createMemoryGraphStore } from "./memory-graph-store.ts";

export const T0 = "2026-11-04T10:00:00.000Z";

export function node(id: string, name: string = id, statement: string = `${name} holds.`): GraphNode {
	return { id, name, statement, aliases: [], createdAt: T0, provenance: [] };
}

export function chain(id: string, premises: string[], conclusion: string): GraphChain {
	return { id, premises, conclusion, provenance: [], createdAt: T0 };
}

export function graphWith(nodes: GraphNode[], chains: GraphChain[]): GraphStore {
	const store = createMemoryGraphStore();
	for (const n of nodes) store.appendNode(n);
	for (const c of chains) store.appendChain(c);
	return store;
}

export function memoryExplanations(): ExplanationsStore & { events: ExplanationEvent[] } {
	const events: ExplanationEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export interface FakeWriter extends ExplanationWriter {
	requests: WriterRequest[];
}

/** bodyFor(nodeId, attempt) -> body; attempt counts earlier requests that contained the node. */
export function fakeWriter(
	bodyFor: (nodeId: string, attempt: number) => string,
	costUsd = 0.01,
): FakeWriter {
	const requests: WriterRequest[] = [];
	const attempts = new Map<string, number>();
	return {
		requests,
		async write(request) {
			requests.push(request);
			const bodies: Record<string, string> = {};
			for (const n of request.nodes) {
				const attempt = attempts.get(n.id) ?? 0;
				attempts.set(n.id, attempt + 1);
				bodies[n.id] = bodyFor(n.id, attempt);
			}
			return { bodies, costUsd, styleVersion: "style-test" };
		},
	};
}

/** Allows generation until `limit` costs have been recorded. */
export function limitedGate(limit: number): CostGate & { spent: number[] } {
	const spent: number[] = [];
	return { spent, allowed: () => spent.length < limit, record: (usd) => void spent.push(usd) };
}

export const openGate = (): CostGate & { spent: number[] } => limitedGate(Number.POSITIVE_INFINITY);
export const closedGate = (): CostGate & { spent: number[] } => limitedGate(0);
```

- [ ] **Step 4: Write the failing store test**

```ts
// tests/ext-explanations-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveExplanations, type ExplanationEvent } from "../src/core/ext/explanations.ts";
import { createExplanationsStore } from "../src/store/ext/explanations-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const version: ExplanationEvent = {
	type: "version",
	nodeId: "n_a",
	version: 1,
	body: "A holds.",
	author: "agent",
	sourceRefs: [],
	styleVersion: "s1",
	fingerprint: "",
	noSource: true,
	proposed: false,
	at: "2026-11-04T10:00:00.000Z",
};

describe("explanations store", () => {
	it("persists events to explanations.jsonl and derives the explanation back", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		store.appendEvent(version);
		store.appendEvent({ ...version, version: 2, body: "A holds, newer." });
		assert.equal(fs.existsSync(path.join(dir, "explanations.jsonl")), true);
		const map = deriveExplanations(createExplanationsStore(dir).readEvents());
		assert.equal(map.get("n_a")?.current?.body, "A holds, newer.");
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		assert.throws(() => store.appendEvent({ ...version, body: "" }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "explanations.jsonl")), false);
	});

	it("skips a corrupt line and keeps the rest", () => {
		const dir = tmp();
		const store = createExplanationsStore(dir);
		store.appendEvent(version);
		fs.appendFileSync(path.join(dir, "explanations.jsonl"), "{torn\n");
		assert.equal(store.readEvents().length, 1);
	});
});
```

- [ ] **Step 5: Run it, then typecheck the new files**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanations-store.test.ts && npm run typecheck 2>&1 | tail -5`
Expected: store tests `fail 0`; typecheck prints no new errors (the fixtures file type-checks against `GraphStore.appendNode/appendChain`).

- [ ] **Step 6: Commit**

```bash
git add src/core/ext/node-knowledge-ports.ts src/store/ext/explanations-store.ts tests/helpers/ext-node-fixtures.ts tests/ext-explanations-store.test.ts
git commit -m "feat(ext): add explanation ports, ledger adapter and test fixtures" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Generation, edit and decision service (REQ-node-02, 03, 04, 05, 08, 09, 16)

**Files:**
- Create: `src/core/ext/explanation-service.ts`
- Test: `tests/ext-explanation-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-explanation-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveExplanations } from "../src/core/ext/explanations.ts";
import {
	decideProposal,
	generateExplanations,
	MAX_REGENERATIONS,
	saveUserExplanation,
	type ExplanationDeps,
} from "../src/core/ext/explanation-service.ts";
import {
	chain,
	closedGate,
	fakeWriter,
	graphWith,
	limitedGate,
	memoryExplanations,
	node,
	openGate,
	T0,
	type FakeWriter,
} from "./helpers/ext-node-fixtures.ts";

function setup(over: { writer?: FakeWriter; gate?: ExplanationDeps["cost"]; batchSize?: number } = {}) {
	const graph = graphWith([node("n_a"), node("n_b")], [chain("arg_1", ["n_a"], "n_b")]);
	const explanations = memoryExplanations();
	const writer = over.writer ?? fakeWriter((id) => `${id} is explained.`);
	const cost = over.gate ?? openGate();
	// read-only view of the graph: the service must not need any append method (REQ-int-02)
	const deps: ExplanationDeps = {
		graph: { readNodes: () => graph.readNodes(), readChains: () => graph.readChains() },
		explanations,
		writer,
		cost,
		now: () => T0,
		batchSize: over.batchSize,
	};
	return { graph, explanations, writer, cost, deps };
}

describe("generateExplanations", () => {
	it("writes one version per node, with fingerprint and no-source flag", async () => {
		const s = setup();
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_a", "n_b"]);
		assert.equal(s.writer.requests.length, 1);
		assert.equal(s.explanations.events.length, 2);
		const b = deriveExplanations(s.explanations.events).get("n_b")?.current;
		assert.equal(b?.version, 1);
		assert.equal(b?.fingerprint, "n_a");
		assert.equal(b?.noSource, true);
		assert.deepEqual(b?.sourceRefs, []);
		assert.equal(b?.author, "agent");
		assert.equal(b?.styleVersion, "style-test");
	});

	it("records the source references and clears no-source when a source is given (REQ-node-09)", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a"], source: { text: "chapter text", refs: ["h1"] } }, s.deps);
		const a = deriveExplanations(s.explanations.events).get("n_a")?.current;
		assert.equal(a?.noSource, false);
		assert.deepEqual(a?.sourceRefs, ["h1"]);
		assert.equal(s.writer.requests[0]?.source?.text, "chapter text");
	});

	it("gives the writer each node's arguments, users and form", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		const nodes = s.writer.requests[0]?.nodes ?? [];
		const b = nodes.find((n) => n.id === "n_b");
		assert.deepEqual(b?.arguments, [[{ id: "n_a", name: "n_a", statement: "n_a holds." }]]);
		assert.deepEqual(nodes.find((n) => n.id === "n_a")?.usedIn, [{ id: "n_b", name: "n_b" }]);
		assert.equal(b?.form, "short");
	});

	it("skips unknown nodes and nodes whose explanation is current", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		const again = await generateExplanations({ nodeIds: ["n_a", "n_zzz"], source: null }, s.deps);
		assert.deepEqual(again.skipped, [
			{ nodeId: "n_a", reason: "current" },
			{ nodeId: "n_zzz", reason: "unknown_node" },
		]);
		assert.equal(s.writer.requests.length, 1);
	});

	it("regenerates a stale agent explanation as a plain new version (REQ-node-03)", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		s.graph.appendNode(node("n_c"));
		s.graph.appendChain(chain("arg_2", ["n_c"], "n_b"));
		const result = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_b"]);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.version, 2);
		assert.equal(b?.current?.fingerprint, "n_a|n_c");
	});

	it("never overwrites a user version: the agent text is a proposal (REQ-node-02)", async () => {
		const s = setup();
		s.explanations.appendEvent({
			type: "version", nodeId: "n_b", version: 1, body: "My own words.", author: "user",
			sourceRefs: [], styleVersion: "user", fingerprint: "", noSource: false, proposed: false, at: T0,
		});
		const result = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(result.proposed, ["n_b"]);
		assert.deepEqual(result.written, []);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.body, "My own words.");
		assert.equal(b?.proposal?.body, "n_b is explained.");
		// a second opening does not pay for the same proposal again
		const again = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(again.skipped, [{ nodeId: "n_b", reason: "pending_proposal" }]);
		assert.equal(s.writer.requests.length, 1);
	});

	it("rejects a text with an unresolved link, regenerates twice, then gives up (REQ-node-08)", async () => {
		const s = setup({ writer: fakeWriter(() => "See [[n_missing]].") });
		const result = await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		assert.equal(s.writer.requests.length, 1 + MAX_REGENERATIONS);
		assert.equal(MAX_REGENERATIONS, 2);
		assert.deepEqual(result.written, []);
		assert.equal(result.rejected[0]?.nodeId, "n_a");
		assert.match(result.rejected[0]?.errors[0] ?? "", /n_missing/);
		assert.equal(s.explanations.events.length, 0);
		assert.deepEqual(s.writer.requests[0]?.feedback, {});
		assert.match(s.writer.requests[1]?.feedback["n_a"]?.[0] ?? "", /n_missing/);
	});

	it("recovers when a regeneration is valid and only re-asks for the failed nodes", async () => {
		const s = setup({ writer: fakeWriter((id, attempt) => (id === "n_a" && attempt === 0 ? "See [[n_missing]]." : `${id} ok.`)) });
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_b", "n_a"]);
		assert.equal(s.writer.requests.length, 2);
		assert.deepEqual(s.writer.requests[1]?.nodes.map((n) => n.id), ["n_a"]);
	});

	it("does not call the writer at all when the cost ceiling is reached (REQ-node-05, REQ-node-16)", async () => {
		const gate = closedGate();
		const s = setup({ gate });
		const result = await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		assert.equal(result.ceilingReached, true);
		assert.equal(s.writer.requests.length, 0);
		assert.equal(s.explanations.events.length, 0);
	});

	it("records every call's cost and stops mid-run when the ceiling closes", async () => {
		const gate = limitedGate(1);
		const s = setup({ gate, batchSize: 1 });
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(gate.spent, [0.01]);
		assert.equal(result.ceilingReached, true);
		assert.equal(result.written.length, 1);
	});

	it("sends one call per batch of neighbouring nodes (REQ-node-04)", async () => {
		const ids = ["n_a", "n_b", "n_c", "n_d", "n_e"];
		const graph = graphWith(ids.map((i) => node(i)), []);
		const explanations = memoryExplanations();
		const writer = fakeWriter((id) => `${id} ok.`);
		await generateExplanations(
			{ nodeIds: ids, source: null },
			{ graph, explanations, writer, cost: openGate(), now: () => T0, batchSize: 2 },
		);
		assert.deepEqual(writer.requests.map((r) => r.nodes.length), [2, 2, 1]);
	});
});

describe("saveUserExplanation (REQ-node-02)", () => {
	it("appends a non-proposed user version with the current fingerprint", () => {
		const s = setup();
		const saved = saveUserExplanation("n_b", "In my words, B follows from [[n_a]].", s.deps);
		assert.equal(saved.version, 1);
		const b = deriveExplanations(s.explanations.events).get("n_b")?.current;
		assert.equal(b?.author, "user");
		assert.equal(b?.fingerprint, "n_a");
	});

	it("refuses unresolved links, empty text and unknown nodes", () => {
		const s = setup();
		assert.throws(() => saveUserExplanation("n_b", "See [[n_missing]].", s.deps), /n_missing/);
		assert.throws(() => saveUserExplanation("n_b", "  ", s.deps), /empty/);
		assert.throws(() => saveUserExplanation("n_zzz", "Text.", s.deps), /unknown node/);
	});
});

describe("decideProposal", () => {
	async function withProposal() {
		const s = setup();
		saveUserExplanation("n_b", "Mine.", s.deps);
		await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		return s;
	}

	it("approving makes the proposal current", async () => {
		const s = await withProposal();
		decideProposal("n_b", "approved", s.deps);
		assert.equal(deriveExplanations(s.explanations.events).get("n_b")?.current?.body, "n_b is explained.");
	});

	it("rejecting keeps the user version and clears the proposal", async () => {
		const s = await withProposal();
		decideProposal("n_b", "rejected", s.deps);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.body, "Mine.");
		assert.equal(b?.proposal, null);
	});

	it("refuses when no proposal is pending", () => {
		const s = setup();
		assert.throws(() => decideProposal("n_b", "approved", s.deps), /no pending proposal/);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-service.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/explanation-service.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/ext/explanation-service.ts
/**
 * Explanation generation, user edits and proposal decisions. Core only: the
 * model call, the clock-free storage and the cost ceiling arrive as ports.
 * The graph is READ-ONLY here (REQ-int-02: extension code never writes the
 * content ledgers) and an explanation never touches trust (REQ-node-09):
 * the only thing this module ever appends is explanation events.
 *
 * Flow of generateExplanations:
 *   1. pick the nodes that need text: no explanation, or a stale one, and no
 *      pending proposal for the current chains;
 *   2. cut them into batches of neighbours (explanation-batches.ts);
 *   3. per batch: ceiling check, one writer call, deterministic checks, and
 *      up to MAX_REGENERATIONS re-asks for the failed nodes only;
 *   4. append one version event per accepted text. Over a user-authored
 *      current version the agent text is stored as `proposed`.
 */

import { getGraph } from "../graph.ts";
import type { GraphStore } from "../ports.ts";
import { planBatches } from "./explanation-batches.ts";
import { checkExplanation } from "./explanation-check.ts";
import { concludingFingerprint, explanationForm, isStale } from "./explanation-rules.ts";
import { deriveExplanations } from "./explanations.ts";
import type {
	CostGate,
	ExplanationsStore,
	ExplanationWriter,
	SourceContext,
	WriterNode,
} from "./node-knowledge-ports.ts";

/** Regenerations after the first attempt (REQ-node-08: at most twice). */
export const MAX_REGENERATIONS = 2;

export interface ExplanationDeps {
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	explanations: ExplanationsStore;
	writer: ExplanationWriter;
	cost: CostGate;
	now?: () => string;
	batchSize?: number;
}

export interface GenerateRequest {
	nodeIds: readonly string[];
	/** Chapter text for a chapter run; null when there is none ("no source context"). */
	source: SourceContext | null;
}

export interface GenerateResult {
	/** Nodes whose new text became current. */
	written: string[];
	/** Nodes whose new text awaits the user's approval. */
	proposed: string[];
	skipped: Array<{ nodeId: string; reason: "unknown_node" | "current" | "pending_proposal" }>;
	rejected: Array<{ nodeId: string; errors: string[] }>;
	ceilingReached: boolean;
}

export async function generateExplanations(request: GenerateRequest, deps: ExplanationDeps): Promise<GenerateResult> {
	const now = deps.now ?? (() => new Date().toISOString());
	const { nodes, chains } = getGraph(deps.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const validIds = new Set(byId.keys());
	const derived = deriveExplanations(deps.explanations.readEvents());
	const result: GenerateResult = { written: [], proposed: [], skipped: [], rejected: [], ceilingReached: false };

	const todo: string[] = [];
	for (const nodeId of new Set(request.nodeIds)) {
		if (!byId.has(nodeId)) {
			result.skipped.push({ nodeId, reason: "unknown_node" });
			continue;
		}
		const entry = derived.get(nodeId);
		if (entry?.current !== null && entry?.current !== undefined && !isStale(entry.current, nodeId, chains)) {
			result.skipped.push({ nodeId, reason: "current" });
			continue;
		}
		if (entry?.proposal !== null && entry?.proposal !== undefined && entry.proposal.fingerprint === concludingFingerprint(nodeId, chains)) {
			result.skipped.push({ nodeId, reason: "pending_proposal" });
			continue;
		}
		todo.push(nodeId);
	}

	const describeNode = (nodeId: string): WriterNode => {
		const n = byId.get(nodeId);
		if (n === undefined) throw new Error(`generateExplanations: unknown node ${nodeId}`);
		const ref = (id: string) => ({ id, name: byId.get(id)?.name ?? id, statement: byId.get(id)?.statement ?? "" });
		const usedIn = new Map<string, string>();
		for (const c of chains) {
			if (c.premises.includes(nodeId)) usedIn.set(c.conclusion, byId.get(c.conclusion)?.name ?? c.conclusion);
		}
		return {
			id: n.id,
			name: n.name,
			statement: n.statement,
			aliases: [...n.aliases],
			form: explanationForm(nodeId, chains),
			arguments: chains.filter((c) => c.conclusion === nodeId).map((c) => c.premises.map(ref)),
			usedIn: [...usedIn].map(([id, name]) => ({ id, name })),
		};
	};

	for (const batch of planBatches(todo, chains, deps.batchSize)) {
		let pending = batch;
		let feedback: Record<string, string[]> = {};
		for (let attempt = 0; attempt <= MAX_REGENERATIONS && pending.length > 0; attempt++) {
			if (!deps.cost.allowed()) {
				result.ceilingReached = true;
				return result;
			}
			const out = await deps.writer.write({ nodes: pending.map(describeNode), source: request.source, feedback });
			deps.cost.record(out.costUsd);
			const failed: string[] = [];
			feedback = {};
			for (const nodeId of pending) {
				const body = Object.hasOwn(out.bodies, nodeId) ? out.bodies[nodeId] : undefined;
				const problems = body === undefined ? ["the writer returned no text for this node"] : checkExplanation(body, validIds).errors;
				if (body === undefined || problems.length > 0) {
					failed.push(nodeId);
					feedback[nodeId] = problems;
					continue;
				}
				const entry = derived.get(nodeId);
				const proposed = entry?.current?.author === "user";
				deps.explanations.appendEvent({
					type: "version",
					nodeId,
					version: (entry?.latestVersion ?? 0) + 1,
					body,
					author: "agent",
					sourceRefs: request.source?.refs ?? [],
					styleVersion: out.styleVersion,
					fingerprint: concludingFingerprint(nodeId, chains),
					noSource: request.source === null,
					proposed,
					at: now(),
				});
				(proposed ? result.proposed : result.written).push(nodeId);
			}
			pending = failed;
		}
		for (const nodeId of pending) result.rejected.push({ nodeId, errors: feedback[nodeId] ?? [] });
	}
	return result;
}

export function saveUserExplanation(
	nodeId: string,
	body: string,
	deps: Pick<ExplanationDeps, "graph" | "explanations" | "now">,
): { version: number } {
	const { nodes, chains } = getGraph(deps.graph);
	if (!nodes.some((n) => n.id === nodeId)) throw new Error(`unknown node ${nodeId}`);
	const check = checkExplanation(body, new Set(nodes.map((n) => n.id)));
	if (check.errors.length > 0) throw new Error(`explanation refused: ${check.errors.join("; ")}`);
	const latest = deriveExplanations(deps.explanations.readEvents()).get(nodeId)?.latestVersion ?? 0;
	const version = latest + 1;
	deps.explanations.appendEvent({
		type: "version",
		nodeId,
		version,
		body,
		author: "user",
		sourceRefs: [],
		styleVersion: "user",
		fingerprint: concludingFingerprint(nodeId, chains),
		noSource: false,
		proposed: false,
		at: (deps.now ?? (() => new Date().toISOString()))(),
	});
	return { version };
}

export function decideProposal(
	nodeId: string,
	decision: "approved" | "rejected",
	deps: Pick<ExplanationDeps, "explanations" | "now">,
): { version: number } {
	const proposal = deriveExplanations(deps.explanations.readEvents()).get(nodeId)?.proposal;
	if (proposal === null || proposal === undefined) throw new Error(`no pending proposal for ${nodeId}`);
	deps.explanations.appendEvent({
		type: "decision",
		nodeId,
		version: proposal.version,
		decision,
		at: (deps.now ?? (() => new Date().toISOString()))(),
	});
	return { version: proposal.version };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-service.test.ts`
Expected: `fail 0`. If the "recovers" test fails on order of `written`, check that failed nodes are appended after the first-pass successes (this is the expected order `["n_b", "n_a"]`).

- [ ] **Step 5: Typecheck, then commit**

```bash
npm run typecheck 2>&1 | tail -5
git add src/core/ext/explanation-service.ts tests/ext-explanation-service.test.ts
git commit -m "feat(ext): add explanation generation, user edit and proposal decisions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: typecheck prints no new errors.

---

### Task 8: Neighbourhood and panel history (REQ-node-13)

**Files:**
- Create: `src/core/ext/neighbourhood.ts`
- Create: `src/core/ext/panel-history.ts`
- Test: `tests/ext-neighbourhood.test.ts`
- Test: `tests/ext-panel-history.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ext-neighbourhood.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighbourhood, radialPositions } from "../src/core/ext/neighbourhood.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });
// e -> a -> (with b) -> x -> d ; z is far away
const chains = [c(["n_e"], "n_a"), c(["n_a", "n_b"], "n_x"), c(["n_x"], "n_d"), c(["n_z"], "n_y")];

describe("neighbourhood (REQ-node-13)", () => {
	it("depth 1 holds the centre and its direct premises and conclusions", () => {
		const h = neighbourhood("n_x", chains, 1);
		assert.deepEqual(h.nodes, [
			{ id: "n_x", depth: 0 },
			{ id: "n_a", depth: 1 },
			{ id: "n_b", depth: 1 },
			{ id: "n_d", depth: 1 },
		]);
	});

	it("depth 2 adds the next ring and the edges among included nodes", () => {
		const h = neighbourhood("n_x", chains, 2);
		assert.deepEqual(h.nodes.filter((n) => n.depth === 2), [{ id: "n_e", depth: 2 }]);
		assert.equal(h.nodes.some((n) => n.id === "n_z"), false);
		assert.deepEqual(
			[...h.edges].sort((p, q) => (p.from + p.to < q.from + q.to ? -1 : 1)),
			[
				{ from: "n_a", to: "n_x" },
				{ from: "n_b", to: "n_x" },
				{ from: "n_e", to: "n_a" },
				{ from: "n_x", to: "n_d" },
			],
		);
	});

	it("a node with no chains is alone; a premise repeated in two chains gives one edge", () => {
		assert.deepEqual(neighbourhood("n_q", chains, 2), { nodes: [{ id: "n_q", depth: 0 }], edges: [] });
		const twice = neighbourhood("n_b", [c(["n_a"], "n_b"), c(["n_a"], "n_b")], 1);
		assert.equal(twice.edges.length, 1);
	});
});

describe("radialPositions", () => {
	it("puts the centre at the origin and each ring at depth times the radius", () => {
		const h = neighbourhood("n_x", chains, 2);
		const pos = radialPositions(h.nodes, 50);
		assert.deepEqual(pos["n_x"], { x: 0, y: 0 });
		for (const n of h.nodes) {
			const p = pos[n.id];
			assert.ok(p !== undefined);
			assert.ok(Math.abs(Math.hypot(p.x, p.y) - n.depth * 50) < 1e-9, n.id);
		}
	});
});
```

```ts
// tests/ext-panel-history.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EMPTY_HISTORY,
	historyBack,
	historyCanBack,
	historyCanForward,
	historyCurrent,
	historyForward,
	historyOpen,
} from "../src/core/ext/panel-history.ts";

describe("panel history (REQ-node-13)", () => {
	it("starts empty", () => {
		assert.equal(historyCurrent(EMPTY_HISTORY), null);
		assert.equal(historyCanBack(EMPTY_HISTORY), false);
		assert.equal(historyCanForward(EMPTY_HISTORY), false);
	});

	it("opening nodes builds a trail that back and forward walk", () => {
		let h = historyOpen(historyOpen(historyOpen(EMPTY_HISTORY, "a"), "b"), "c");
		assert.equal(historyCurrent(h), "c");
		h = historyBack(historyBack(h));
		assert.equal(historyCurrent(h), "a");
		assert.equal(historyCanBack(h), false);
		assert.equal(historyCanForward(h), true);
		h = historyForward(h);
		assert.equal(historyCurrent(h), "b");
	});

	it("opening after going back drops the forward entries", () => {
		let h = historyOpen(historyOpen(historyOpen(EMPTY_HISTORY, "a"), "b"), "c");
		h = historyOpen(historyBack(historyBack(h)), "z");
		assert.deepEqual(h.entries, ["a", "z"]);
		assert.equal(historyCanForward(h), false);
	});

	it("re-opening the current node changes nothing; back at the start is a no-op", () => {
		const h = historyOpen(EMPTY_HISTORY, "a");
		assert.equal(historyOpen(h, "a"), h);
		assert.equal(historyBack(h), h);
		assert.equal(historyForward(h), h);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/ext-neighbourhood.test.ts tests/ext-panel-history.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementations**

```ts
// src/core/ext/neighbourhood.ts
/**
 * The panel's mini-graph data (REQ-node-13): the nodes within `maxDepth`
 * steps of a centre over the undirected premise-conclusion adjacency of the
 * chains, plus the premise -> conclusion edges among them. Derived from
 * chains on every call, never stored. Pure and browser-safe. The radial
 * layout is deliberately trivial (rings by depth): upstream's force layout
 * is tied to the full graph view and is not reused.
 */

import type { GraphChain } from "../contracts.ts";

export interface NeighbourhoodResult {
	nodes: Array<{ id: string; depth: number }>;
	edges: Array<{ from: string; to: string }>;
}

export function neighbourhood(
	centreId: string,
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	maxDepth: 1 | 2,
): NeighbourhoodResult {
	const adjacent = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		let set = adjacent.get(a);
		if (set === undefined) adjacent.set(a, (set = new Set()));
		set.add(b);
	};
	for (const chain of chains) {
		for (const premise of chain.premises) {
			if (premise === chain.conclusion) continue;
			link(premise, chain.conclusion);
			link(chain.conclusion, premise);
		}
	}
	const depth = new Map<string, number>([[centreId, 0]]);
	let frontier = [centreId];
	for (let d = 1; d <= maxDepth; d++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const neighbour of [...(adjacent.get(id) ?? [])].sort()) {
				if (depth.has(neighbour)) continue;
				depth.set(neighbour, d);
				next.push(neighbour);
			}
		}
		frontier = next;
	}
	const nodes = [...depth].map(([id, d]) => ({ id, depth: d })).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const edges: Array<{ from: string; to: string }> = [];
	const seen = new Set<string>();
	for (const chain of chains) {
		if (!depth.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (premise === chain.conclusion || !depth.has(premise)) continue;
			const key = `${premise}\u0000${chain.conclusion}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ from: premise, to: chain.conclusion });
		}
	}
	return { nodes, edges };
}

/** Centre at (0,0); the nodes of depth d evenly spaced on a ring of radius d * ringRadius. */
export function radialPositions(
	nodes: ReadonlyArray<{ id: string; depth: number }>,
	ringRadius: number,
): Record<string, { x: number; y: number }> {
	const out: Record<string, { x: number; y: number }> = {};
	const rings = new Map<number, string[]>();
	for (const n of nodes) {
		const ring = rings.get(n.depth);
		if (ring === undefined) rings.set(n.depth, [n.id]);
		else ring.push(n.id);
	}
	for (const [d, ids] of rings) {
		if (d === 0) {
			for (const id of ids) out[id] = { x: 0, y: 0 };
			continue;
		}
		ids.forEach((id, i) => {
			const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2;
			out[id] = { x: Math.cos(angle) * d * ringRadius, y: Math.sin(angle) * d * ringRadius };
		});
	}
	return out;
}
```

```ts
// src/core/ext/panel-history.ts
/**
 * Back and forward history of the node panel (REQ-node-13). Immutable and
 * pure: every function returns a new value (or the same one when nothing
 * changes). Browser-safe.
 */

export interface PanelHistory {
	entries: readonly string[];
	/** Index of the current entry; -1 when empty. */
	index: number;
}

export const EMPTY_HISTORY: PanelHistory = { entries: [], index: -1 };

export function historyCurrent(h: PanelHistory): string | null {
	return h.entries[h.index] ?? null;
}

export const historyCanBack = (h: PanelHistory): boolean => h.index > 0;
export const historyCanForward = (h: PanelHistory): boolean => h.index < h.entries.length - 1;

/** Open a node; forward entries are dropped; re-opening the current node is a no-op. */
export function historyOpen(h: PanelHistory, nodeId: string): PanelHistory {
	if (historyCurrent(h) === nodeId) return h;
	return { entries: [...h.entries.slice(0, h.index + 1), nodeId], index: h.index + 1 };
}

export function historyBack(h: PanelHistory): PanelHistory {
	return historyCanBack(h) ? { entries: h.entries, index: h.index - 1 } : h;
}

export function historyForward(h: PanelHistory): PanelHistory {
	return historyCanForward(h) ? { entries: h.entries, index: h.index + 1 } : h;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `NODE_ENV=test npx tsx --test tests/ext-neighbourhood.test.ts tests/ext-panel-history.test.ts`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/neighbourhood.ts src/core/ext/panel-history.ts tests/ext-neighbourhood.test.ts tests/ext-panel-history.test.ts
git commit -m "feat(ext): add neighbourhood mini-graph data and panel history" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Panel data types and assembly (REQ-node-12, 13, 14, 15, 05)

**Files:**
- Create: `src/core/ext/node-panel-types.ts`
- Create: `src/core/ext/node-panel.ts`
- Test: `tests/ext-node-panel.test.ts`

- [ ] **Step 1: Write the types file (browser-safe, no runtime imports)**

```ts
// src/core/ext/node-panel-types.ts
/**
 * Data of the node panel (node-knowledge spec: REQ-node-12, REQ-node-13,
 * REQ-node-14). Types plus one const; nothing here imports server code, so
 * the browser shell can use it through the core barrel. `PanelSources` is
 * the seam through which other children's data arrives (trust, lectures,
 * cards, review): every member is optional and an absent one yields an
 * empty section.
 */

export type NodeAction =
	| "createCard"
	| "pin"
	| "retire"
	| "startReview"
	| "askInChat"
	| "useAsGoalTarget"
	| "verifyNow";

export const NODE_ACTIONS: readonly NodeAction[] = [
	"createCard",
	"pin",
	"retire",
	"startReview",
	"askInChat",
	"useAsGoalTarget",
	"verifyNow",
];

export interface NodeRef {
	id: string;
	name: string;
}

export type PanelTrustLevel = "unverified" | "sourced" | "contested" | "refuted";

export interface PanelEvidence {
	sourceId: string;
	locator: string;
	quote: string;
	stance: "supports" | "contradicts";
	tier: "primary" | "secondary" | "unvetted";
	snapshotHash: string;
}

export interface PanelTrust {
	level: PanelTrustLevel;
	evidence: PanelEvidence[];
}

export interface PanelLecture {
	lectureId: string;
	title: string;
}

export interface PanelCard {
	cardId: string;
	question: string;
	status: string;
}

export interface PanelReview {
	dueAt: string | null;
	reps: number;
	pinned: boolean;
	retired: boolean;
}

export interface PanelGoal {
	id: string;
	title: string;
	status: "active" | "paused" | "reached";
	isTarget: boolean;
}

/** Data other child specs supply; each member optional (absent = empty section). */
export interface PanelSources {
	trust?(nodeId: string): PanelTrust;
	lecturesCiting?(nodeId: string): PanelLecture[];
	cards?(nodeId: string): PanelCard[];
	review?(nodeId: string): PanelReview | null;
}

export type ExplanationState = "current" | "stale" | "missing";

export interface ExplanationView {
	state: ExplanationState;
	/** True when a missing or stale text cannot be generated now: the daily ceiling is reached. */
	ceiling: boolean;
	form: "short" | "long";
	current: { version: number; body: string; author: "agent" | "user"; noSource: boolean } | null;
	proposal: { version: number; body: string } | null;
	/** Names of the nodes linked from `current` and `proposal`, by id. */
	linkNames: Record<string, string>;
}

export interface NodePanelData {
	node: { id: string; name: string; statement: string; aliases: string[] };
	explanation: ExplanationView;
	trust: PanelTrust;
	/** One entry per chain concluding the node; more than one means alternative arguments. */
	concluding: Array<{ chainId: string; premises: NodeRef[] }>;
	usedAsPremise: Array<{ chainId: string; coPremises: NodeRef[]; conclusion: NodeRef }>;
	citingLectures: PanelLecture[];
	/** Nodes whose current explanation links here (derived, never stored). */
	mentionedBy: NodeRef[];
	cards: PanelCard[];
	review: PanelReview | null;
	goals: PanelGoal[];
	/** Depth 0 to 2 around the node; the view filters to the chosen depth. */
	neighbourhood: { nodes: Array<NodeRef & { depth: number }>; edges: Array<{ from: string; to: string }> };
	availableActions: NodeAction[];
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/ext-node-panel.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExplanationEvent } from "../src/core/ext/explanations.ts";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import { buildNodePanel, type PanelInput } from "../src/core/ext/node-panel.ts";
import { chain, graphWith, node, T0 } from "./helpers/ext-node-fixtures.ts";

// n_e -> n_a ; (n_a, n_b) -> n_c ; n_a -> n_c (alternative) ; n_c -> n_d
const graph = graphWith(
	["n_a", "n_b", "n_c", "n_d", "n_e"].map((i) => node(i, i.toUpperCase())),
	[
		chain("arg_1", ["n_a", "n_b"], "n_c"),
		chain("arg_2", ["n_a"], "n_c"),
		chain("arg_3", ["n_c"], "n_d"),
		chain("arg_4", ["n_e"], "n_a"),
	],
);

const version = (nodeId: string, body: string, fingerprint: string): ExplanationEvent => ({
	type: "version", nodeId, version: 1, body, author: "agent", sourceRefs: [], styleVersion: "s",
	fingerprint, noSource: false, proposed: false, at: T0,
});

function input(over: Partial<PanelInput> = {}): PanelInput {
	return {
		graph,
		explanationEvents: [],
		goalEvents: [],
		sources: {},
		costAllowed: true,
		availableActions: ["askInChat", "useAsGoalTarget"],
		...over,
	};
}

describe("buildNodePanel", () => {
	it("returns null for an unknown node", () => {
		assert.equal(buildNodePanel("n_zzz", input()), null);
	});

	it("shows the statement and, with no sources, an unverified trust level and empty sections", () => {
		const p = buildNodePanel("n_c", input());
		assert.equal(p?.node.statement, "N_C holds.");
		assert.deepEqual(p?.trust, { level: "unverified", evidence: [] });
		assert.deepEqual([p?.citingLectures, p?.cards, p?.review, p?.goals], [[], [], null, []]);
		assert.deepEqual(p?.availableActions, ["askInChat", "useAsGoalTarget"]);
	});

	it("lists concluding chains (alternatives) and the chains it is a premise of", () => {
		const p = buildNodePanel("n_c", input());
		assert.deepEqual(p?.concluding.map((c) => c.chainId), ["arg_1", "arg_2"]);
		assert.deepEqual(p?.concluding[0]?.premises, [{ id: "n_a", name: "N_A" }, { id: "n_b", name: "N_B" }]);
		assert.deepEqual(p?.usedAsPremise, [{ chainId: "arg_3", coPremises: [], conclusion: { id: "n_d", name: "N_D" } }]);
		const a = buildNodePanel("n_a", input());
		assert.deepEqual(a?.usedAsPremise.find((u) => u.chainId === "arg_1")?.coPremises, [{ id: "n_b", name: "N_B" }]);
	});

	it("explanation state: missing, with ceiling flag when generation is blocked (REQ-node-05)", () => {
		assert.deepEqual(buildNodePanel("n_c", input())?.explanation.state, "missing");
		assert.equal(buildNodePanel("n_c", input())?.explanation.ceiling, false);
		assert.equal(buildNodePanel("n_c", input({ costAllowed: false }))?.explanation.ceiling, true);
	});

	it("explanation state: current when the fingerprint matches, stale when it does not (REQ-node-03)", () => {
		const fingerprint = "n_a|n_a,n_b";
		const fresh = buildNodePanel("n_c", input({ explanationEvents: [version("n_c", "C because [[n_a]].", fingerprint)] }));
		assert.equal(fresh?.explanation.state, "current");
		assert.equal(fresh?.explanation.ceiling, false);
		assert.deepEqual(fresh?.explanation.linkNames, { n_a: "N_A" });
		const stale = buildNodePanel("n_c", input({ explanationEvents: [version("n_c", "Old.", "other")], costAllowed: false }));
		assert.equal(stale?.explanation.state, "stale");
		assert.equal(stale?.explanation.ceiling, true);
		assert.equal(stale?.explanation.current?.body, "Old.");
	});

	it("complex nodes get the long form (REQ-node-06)", () => {
		assert.equal(buildNodePanel("n_c", input())?.explanation.form, "short");
		const deep = graphWith(
			["n_1", "n_2", "n_3", "n_4"].map((i) => node(i)),
			[chain("a1", ["n_1"], "n_2"), chain("a2", ["n_2"], "n_3"), chain("a3", ["n_3"], "n_4")],
		);
		assert.equal(buildNodePanel("n_4", input({ graph: deep }))?.explanation.form, "long");
	});

	it("derives back-links from other nodes' current explanations (REQ-node-15)", () => {
		const events = [version("n_d", "D uses [[n_c]].", "n_c"), version("n_b", "B alone.", "")];
		const p = buildNodePanel("n_c", input({ explanationEvents: events }));
		assert.deepEqual(p?.mentionedBy, [{ id: "n_d", name: "N_D" }]);
	});

	it("shows a pending proposal separately from the current text", () => {
		const events: ExplanationEvent[] = [
			{ ...version("n_c", "Mine.", "n_a|n_a,n_b"), author: "user" },
			{ ...version("n_c", "Agent text [[n_b]].", "n_a|n_a,n_b"), version: 2, proposed: true },
		];
		const p = buildNodePanel("n_c", input({ explanationEvents: events }));
		assert.equal(p?.explanation.current?.body, "Mine.");
		assert.equal(p?.explanation.proposal?.body, "Agent text [[n_b]].");
		assert.deepEqual(p?.explanation.linkNames, { n_b: "N_B" });
	});

	it("includes the goals whose scope holds the node, marking targets", () => {
		const goalEvents: GoalEvent[] = [
			{ type: "created", goalId: "goal_1", title: "Master D", origin: "user", originRef: "", targetNodeIds: ["n_d"], priority: 3, at: T0 },
		];
		const c = buildNodePanel("n_c", input({ goalEvents }));
		assert.deepEqual(c?.goals, [{ id: "goal_1", title: "Master D", status: "active", isTarget: false }]);
		assert.equal(buildNodePanel("n_d", input({ goalEvents }))?.goals[0]?.isTarget, true);
		assert.deepEqual(buildNodePanel("n_zzz2", input({ goalEvents })), null);
	});

	it("passes through what the sources supply", () => {
		const p = buildNodePanel("n_c", input({
			sources: {
				trust: () => ({ level: "sourced", evidence: [{ sourceId: "s1", locator: "p. 3", quote: "q", stance: "supports", tier: "primary", snapshotHash: "h" }] }),
				lecturesCiting: () => [{ lectureId: "l1", title: "Lecture 1" }],
				cards: () => [{ cardId: "c1", question: "Why?", status: "active" }],
				review: () => ({ dueAt: T0, reps: 2, pinned: false, retired: false }),
			},
		}));
		assert.equal(p?.trust.level, "sourced");
		assert.equal(p?.citingLectures[0]?.title, "Lecture 1");
		assert.equal(p?.cards[0]?.question, "Why?");
		assert.equal(p?.review?.reps, 2);
	});

	it("neighbourhood reaches depth 2 around the node", () => {
		const p = buildNodePanel("n_c", input());
		const ids = (d: number) => p?.neighbourhood.nodes.filter((n) => n.depth === d).map((n) => n.id).sort();
		assert.deepEqual(ids(1), ["n_a", "n_b", "n_d"]);
		assert.deepEqual(ids(2), ["n_e"]);
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-panel.test.ts`
Expected: FAIL, "Cannot find module '../src/core/ext/node-panel.ts'".

- [ ] **Step 4: Write the implementation**

```ts
// src/core/ext/node-panel.ts
/**
 * buildNodePanel: assembles the panel's data for one node from the graph,
 * the explanation and goal events and the optional PanelSources. Pure given
 * its inputs (core/graph.ts getGraph is the shared reader). SERVER-SIDE
 * module: it is deliberately not in the browser barrel because core/graph.ts
 * imports node:crypto; the browser uses node-panel-types.ts instead.
 */

import { getGraph } from "../graph.ts";
import type { GraphStore } from "../ports.ts";
import { extractNodeLinks, mentionedBy } from "./explanation-check.ts";
import { explanationForm, isStale } from "./explanation-rules.ts";
import { deriveExplanations, type ExplanationEvent } from "./explanations.ts";
import { deriveGoals, goalScope, type GoalEvent } from "./goals.ts";
import { neighbourhood } from "./neighbourhood.ts";
import type {
	ExplanationView,
	NodeAction,
	NodePanelData,
	NodeRef,
	PanelSources,
} from "./node-panel-types.ts";

export interface PanelInput {
	graph: Pick<GraphStore, "readNodes" | "readChains">;
	explanationEvents: readonly ExplanationEvent[];
	goalEvents: readonly GoalEvent[];
	sources: PanelSources;
	/** False when the daily cost ceiling is reached (REQ-node-05). */
	costAllowed: boolean;
	availableActions: readonly NodeAction[];
}

export function buildNodePanel(nodeId: string, input: PanelInput): NodePanelData | null {
	const { nodes, chains } = getGraph(input.graph);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const node = byId.get(nodeId);
	if (node === undefined) return null;
	const ref = (id: string): NodeRef => ({ id, name: byId.get(id)?.name ?? id });

	const derived = deriveExplanations(input.explanationEvents);
	const entry = derived.get(nodeId);
	const current = entry?.current ?? null;
	const proposal = entry?.proposal ?? null;
	const state = current === null ? "missing" : isStale(current, nodeId, chains) ? "stale" : "current";

	const linkNames: Record<string, string> = {};
	for (const body of [current?.body, proposal?.body]) {
		if (body === undefined) continue;
		for (const id of extractNodeLinks(body)) {
			const linked = byId.get(id);
			if (linked !== undefined) linkNames[id] = linked.name;
		}
	}
	const explanation: ExplanationView = {
		state,
		ceiling: state !== "current" && !input.costAllowed,
		form: explanationForm(nodeId, chains),
		current: current && { version: current.version, body: current.body, author: current.author, noSource: current.noSource },
		proposal: proposal && { version: proposal.version, body: proposal.body },
		linkNames,
	};

	const currentBodies = new Map<string, string>();
	for (const [id, e] of derived) if (e.current !== null && byId.has(id)) currentBodies.set(id, e.current.body);

	const goals = deriveGoals(input.goalEvents).flatMap((g) =>
		goalScope(g.targetNodeIds, chains).includes(nodeId)
			? [{ id: g.id, title: g.title, status: g.status, isTarget: g.targetNodeIds.includes(nodeId) }]
			: [],
	);

	const hood = neighbourhood(nodeId, chains, 2);
	return {
		node: { id: node.id, name: node.name, statement: node.statement, aliases: [...node.aliases] },
		explanation,
		trust: input.sources.trust?.(nodeId) ?? { level: "unverified", evidence: [] },
		concluding: chains.filter((c) => c.conclusion === nodeId).map((c) => ({ chainId: c.id, premises: c.premises.map(ref) })),
		usedAsPremise: chains
			.filter((c) => c.premises.includes(nodeId))
			.map((c) => ({
				chainId: c.id,
				coPremises: c.premises.filter((p) => p !== nodeId).map(ref),
				conclusion: ref(c.conclusion),
			})),
		citingLectures: input.sources.lecturesCiting?.(nodeId) ?? [],
		mentionedBy: mentionedBy(nodeId, currentBodies).map(ref),
		cards: input.sources.cards?.(nodeId) ?? [],
		review: input.sources.review?.(nodeId) ?? null,
		goals,
		neighbourhood: { nodes: hood.nodes.map((n) => ({ ...ref(n.id), depth: n.depth })), edges: hood.edges },
		availableActions: [...input.availableActions],
	};
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-panel.test.ts`
Expected: `fail 0`. The test `buildNodePanel("n_zzz2", ...)` returns `null` (unknown node) by design.

- [ ] **Step 6: Typecheck, then commit**

```bash
npm run typecheck 2>&1 | tail -5
git add src/core/ext/node-panel-types.ts src/core/ext/node-panel.ts tests/ext-node-panel.test.ts
git commit -m "feat(ext): add node panel data types and assembly" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: typecheck prints no new errors.

---

### Task 10: Style guide and the explanation writer (REQ-node-04, 06, 07, 09)

**Files:**
- Create: `src/agent/ext/prompts/explanation-style.md`
- Create: `src/agent/ext/explanation-writer.ts`
- Test: `tests/ext-explanation-writer.test.ts`

- [ ] **Step 1: Write the default style guide**

````markdown
<!-- src/agent/ext/prompts/explanation-style.md -->
# Explanation style guide

You write explanations of single propositions of a knowledge graph for one learner.
Write in the language of the proposition's statement. Never mix languages.

The register is controlled language, in the spirit of ASD-STE100 but not rigid:

- Write short sentences. Put one idea in each sentence.
- Use one word for one thing. Do not vary a technical term for style.
- Define a term the first time you use it. Define it in the sentence where it first appears.
- Remove ambiguity. Name the subject of each sentence. Avoid "it" and "this" when the referent is not in the same sentence.
- Prefer active verbs and concrete nouns. Avoid filler and hedging.
- An intuition first is allowed where it helps. Keep it to two or three sentences and say that it is an intuition.
- Write formulas in LaTeX between dollar signs. Keep the prose around them short.

Never invent facts. If source text is given, stay inside it. If it is not given, say only what the statement and the arguments support.
````

- [ ] **Step 2: Write the failing test**

```ts
// tests/ext-explanation-writer.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import {
	buildWriterPrompt,
	createExplanationWriter,
	loadStyleGuide,
	STRUCTURE_RULES,
} from "../src/agent/ext/explanation-writer.ts";
import type { WriterRequest } from "../src/core/ext/node-knowledge-ports.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (payload: unknown, id = "submit-call"): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("submit_explanations", payload as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const request: WriterRequest = {
	nodes: [
		{
			id: "n_b", name: "Beta", statement: "Beta follows from alpha.", aliases: ["B"], form: "long",
			arguments: [[{ id: "n_a", name: "Alpha", statement: "Alpha holds." }]],
			usedIn: [{ id: "n_c", name: "Gamma" }],
		},
	],
	source: null,
	feedback: {},
};

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(text: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-style-"));
	dirs.push(d);
	const f = path.join(d, "style.md");
	fs.writeFileSync(f, text);
	return f;
}

describe("loadStyleGuide (REQ-node-07)", () => {
	it("prefers the first non-empty file, falls back past a missing or blank one", () => {
		const blank = tmpFile("   \n");
		const mine = tmpFile("MY STYLE");
		assert.equal(loadStyleGuide(["/nonexistent/x.md", blank, mine]), "MY STYLE");
	});
	it("ships a default guide with the controlled-language principles", () => {
		assert.match(loadStyleGuide(), /short sentences/i);
	});
	it("throws when no file is usable", () => {
		assert.throws(() => loadStyleGuide(["/nonexistent/x.md"]), /style guide/i);
	});
});

describe("buildWriterPrompt", () => {
	it("names each node with its statement, arguments, linkable ids and form", () => {
		const prompt = buildWriterPrompt(request);
		assert.match(prompt, /NODE n_b/);
		assert.match(prompt, /Beta follows from alpha\./);
		assert.match(prompt, /Alpha holds\./);
		assert.match(prompt, /\[\[n_a\]\]/);
		assert.match(prompt, /\[\[n_c\]\]/);
		assert.match(prompt, /long form/i);
	});

	it("says there is no source text when none is given, and quotes it when given (REQ-node-09)", () => {
		assert.match(buildWriterPrompt(request), /No source text is available/);
		assert.match(buildWriterPrompt({ ...request, source: { text: "THE CHAPTER", refs: ["h"] } }), /THE CHAPTER/);
	});

	it("repeats the previous problems of a node on a regeneration (REQ-node-08)", () => {
		const prompt = buildWriterPrompt({ ...request, feedback: { n_b: ["link [[n_x]] does not resolve to an existing node"] } });
		assert.match(prompt, /previous attempt was refused/i);
		assert.match(prompt, /n_x/);
	});
});

describe("createExplanationWriter", () => {
	it("returns the submitted bodies, the style version and the priced cost", async () => {
		const seen: { system: string; user: string }[] = [];
		const engine = fauxEngine([
			(context) => {
				const text = (m: { content: unknown } | undefined) =>
					m === undefined ? "" : typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
				seen.push({
					system: text(context.messages.find((m) => m.role === "system")),
					user: text(context.messages.find((m) => m.role === "user")),
				});
				return fauxAssistantMessage(
					[fauxToolCall("submit_explanations", { explanations: [{ nodeId: "n_b", body: "Beta holds because [[n_a]]." }] } as ToolCall["arguments"], { id: "c1" })],
					{ stopReason: "toolUse" },
				);
			},
		]);
		const writer = createExplanationWriter({ engine, priceCall: () => 0.25, styleGuide: () => "STYLE-GUIDE-TEXT" });
		const result = await writer.write(request);
		assert.deepEqual(result.bodies, { n_b: "Beta holds because [[n_a]]." });
		assert.equal(result.costUsd, 0.25);
		assert.match(result.styleVersion, /^[0-9a-f]{12}$/);
		assert.match(seen[0]?.system ?? "", /STYLE-GUIDE-TEXT/);
		assert.ok((seen[0]?.system ?? "").includes(STRUCTURE_RULES));
		assert.match(seen[0]?.user ?? "", /NODE n_b/);
	});

	it("a different style guide gives a different style version", async () => {
		const run = async (style: string) => {
			const engine = fauxEngine([submit({ explanations: [{ nodeId: "n_b", body: "Text." }] })]);
			return (await createExplanationWriter({ engine, priceCall: () => 0, styleGuide: () => style }).write(request)).styleVersion;
		};
		assert.notEqual(await run("one"), await run("two"));
	});

	it("refuses a submit that misses a requested node or names an unknown one, and the model retries", async () => {
		const engine = fauxEngine([
			submit({ explanations: [{ nodeId: "n_other", body: "Wrong." }] }, "bad"),
			submit({ explanations: [{ nodeId: "n_b", body: "Right." }] }, "good"),
		]);
		const writer = createExplanationWriter({ engine, priceCall: () => 0.1, styleGuide: () => "S" });
		const result = await writer.write(request);
		assert.deepEqual(result.bodies, { n_b: "Right." });
		assert.ok(Math.abs(result.costUsd - 0.2) < 1e-9, "both model calls are priced");
	});

	it("treats an unpriced call as zero cost", async () => {
		const engine = fauxEngine([submit({ explanations: [{ nodeId: "n_b", body: "Text." }] })]);
		const result = await createExplanationWriter({ engine, priceCall: () => null, styleGuide: () => "S" }).write(request);
		assert.equal(result.costUsd, 0);
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-writer.test.ts`
Expected: FAIL, "Cannot find module '../src/agent/ext/explanation-writer.ts'".

- [ ] **Step 4: Write the implementation**

```ts
// src/agent/ext/explanation-writer.ts
/**
 * The explanation writer (agent layer): one submit call per batch through
 * the shared runSubmitAgent seam. It knows nothing about storage or cost
 * policy: the engine and the call pricing arrive as arguments (the agent
 * layer may not import server or store). Link and placeholder validation is
 * NOT done here: the core service owns the deterministic checks and the
 * "regenerate at most twice" rule (REQ-node-08); this module only refuses a
 * submit that does not cover exactly the requested nodes.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../../config.ts";
import type { CallUsage } from "../../core/contracts.ts";
import type { ExplanationWriter, WriterRequest } from "../../core/ext/node-knowledge-ports.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "../subagents/submit-agent.ts";

const DEFAULT_STYLE_FILE = path.join(PATHS.root, "src", "agent", "ext", "prompts", "explanation-style.md");
/** The user's editable copy; present and non-blank means it replaces the default. */
const OVERRIDE_STYLE_FILE = path.join(PROMPTS_OVERRIDE_DIR, "ext", "explanation-style.md");

/** First non-blank file wins; read fresh on every call so edits land immediately. */
export function loadStyleGuide(files: readonly string[] = [OVERRIDE_STYLE_FILE, DEFAULT_STYLE_FILE]): string {
	for (const file of files) {
		try {
			const text = fs.readFileSync(file, "utf-8");
			if (text.trim() !== "") return text;
		} catch {
			// missing file: try the next
		}
	}
	throw new Error("explanation style guide is missing: expected src/agent/ext/prompts/explanation-style.md");
}

/** Structure and link rules; code, not the editable style guide (the checks depend on them). */
export const STRUCTURE_RULES = [
	"STRUCTURE. Write each explanation in Markdown with these parts, in this order:",
	"1. Optionally, a short intuition (two or three sentences, labelled as an intuition).",
	"2. The precise explanation of the statement.",
	"3. Why it holds: tie it to the premises of the arguments you are given.",
	"4. An example.",
	"5. Common confusions.",
	"Use the SHORT form (about one paragraph per part) or the LONG form (several paragraphs per part, including every premise of every argument) as each node says.",
	"LINKS. When you mention another node of the graph, write its id between double square brackets, for example [[n_abc123def456]], and only use ids from that node's LINKABLE list. Never write any other id.",
	"Never leave placeholders such as TODO, TBD or [...]. Submit exactly one explanation for every requested node with submit_explanations.",
].join("\n");

const submitSchema = Type.Object({
	explanations: Type.Array(
		Type.Object({
			nodeId: Type.String({ description: "The id of the node, exactly as given after NODE." }),
			body: Type.String({ description: "The explanation in Markdown." }),
		}),
	),
});
type Submit = Static<typeof submitSchema>;

export function buildWriterPrompt(request: WriterRequest): string {
	const parts: string[] = [];
	if (request.source === null) {
		parts.push("No source text is available. Explain from the statements and arguments below only.");
	} else {
		parts.push("SOURCE TEXT. Ground every explanation in this text and stay inside it:", request.source.text);
	}
	parts.push("");
	for (const n of request.nodes) {
		parts.push(`NODE ${n.id}: ${n.name}`);
		parts.push(`Statement: ${n.statement}`);
		if (n.aliases.length > 0) parts.push(`Other phrasings: ${n.aliases.join(" | ")}`);
		parts.push(n.form === "long" ? "Write the long form." : "Write the short form.");
		n.arguments.forEach((premises, i) => {
			parts.push(`Argument ${i + 1}: ${premises.map((p) => `${p.name} [${p.id}] (${p.statement})`).join("; ")} together imply this node.`);
		});
		const linkable = [...n.arguments.flat().map((p) => ({ id: p.id, name: p.name })), ...n.usedIn];
		const unique = [...new Map(linkable.map((l) => [l.id, l])).values()];
		if (unique.length > 0) parts.push(`LINKABLE: ${unique.map((l) => `[[${l.id}]] ${l.name}`).join("; ")}`);
		const problems = request.feedback[n.id];
		if (problems !== undefined && problems.length > 0) {
			parts.push(`Your previous attempt was refused. Fix: ${problems.join("; ")}`);
		}
		parts.push("");
	}
	return parts.join("\n");
}

export function createExplanationWriter(opts: {
	engine: PiEngine;
	/** Prices one model call; null = unknown (counted as zero). server/pricing.ts callCost fits. */
	priceCall: (call: Partial<CallUsage>, modelId: string) => number | null;
	/** Test seam; defaults to loadStyleGuide. */
	styleGuide?: () => string;
	signal?: AbortSignal;
}): ExplanationWriter {
	return {
		async write(request) {
			const style = (opts.styleGuide ?? (() => loadStyleGuide()))();
			const wanted = new Set(request.nodes.map((n) => n.id));
			let costUsd = 0;
			const submitted = await runSubmitAgent<Submit>({
				role: "teacher",
				toolName: "submit_explanations",
				toolDescription: "Submit one explanation per requested node.",
				parameters: submitSchema,
				fill: (input) => input as Submit,
				systemPrompt: `${style.trim()}\n\n${STRUCTURE_RULES}`,
				prompt: buildWriterPrompt(request),
				engine: opts.engine,
				signal: opts.signal,
				onStep: (usage, model) => {
					costUsd +=
						opts.priceCall(
							{
								inputTokens: usage.input,
								outputTokens: usage.output,
								cacheReadTokens: usage.cacheRead,
								cacheWriteTokens: usage.cacheWrite,
								cacheWrite1hTokens: usage.cacheWrite1h,
								reasoningTokens: usage.reasoning,
							},
							model,
						) ?? 0;
				},
				neverSubmitted: "The explanation writer ended without submitting explanations.",
				validate: (value) => {
					const ids = value.explanations.map((e) => e.nodeId);
					const unknown = ids.find((id) => !wanted.has(id));
					if (unknown !== undefined) return `explanations: "${unknown}" is not one of the requested nodes.`;
					const missing = [...wanted].find((id) => !ids.includes(id));
					if (missing !== undefined) return `explanations: the requested node "${missing}" has no explanation.`;
					if (new Set(ids).size !== ids.length) return "explanations: each node must appear exactly once.";
					return null;
				},
			});
			const bodies: Record<string, string> = {};
			for (const e of submitted.explanations) bodies[e.nodeId] = e.body;
			return {
				bodies,
				costUsd,
				styleVersion: createHash("sha256").update(style).digest("hex").slice(0, 12),
			};
		},
	};
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-explanation-writer.test.ts`
Expected: `fail 0`. If the retry test shows a cost of 0.1 instead of 0.2, the failed first call was not billed by `runSubmitAgent` (`usageWasAdmitted`); in that case assert `> 0.1` is wrong, so replace the assertion with `assert.ok(result.costUsd >= 0.1)` and keep the rest.

- [ ] **Step 6: Typecheck and lint (import law), then commit**

```bash
npm run typecheck 2>&1 | tail -5
npx eslint src/agent/ext src/core/ext src/store/ext 2>&1 | tail -8
git add src/agent/ext tests/ext-explanation-writer.test.ts
git commit -m "feat(ext): add explanation writer with editable style guide" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: no errors; the import law holds (the agent file imports `core` and `config.ts`, never `store` or `server`).

---

### Task 11: Server factory (REQ-node-05, 12, 14, 16)

**Files:**
- Create: `src/server/ext/node-knowledge.ts`
- Test: `tests/ext-node-knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-node-knowledge.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import { createNodeKnowledge, NodeKnowledgeError, type NodeKnowledgeDeps } from "../src/server/ext/node-knowledge.ts";
import { chain, closedGate, fakeWriter, graphWith, memoryExplanations, node, openGate, T0 } from "./helpers/ext-node-fixtures.ts";

function memoryGoals(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

function setup(over: Partial<NodeKnowledgeDeps> = {}) {
	const graphStore = graphWith([node("n_a", "Alpha"), node("n_b", "Beta")], [chain("arg_1", ["n_a"], "n_b")]);
	const explanations = memoryExplanations();
	const goalsStore = memoryGoals();
	const writer = fakeWriter((id) => `${id} is explained.`);
	const deps: NodeKnowledgeDeps = {
		graphStore,
		explanations,
		goalsStore,
		writer,
		cost: openGate(),
		sources: {},
		handlers: {},
		now: () => T0,
		...over,
	};
	return { knowledge: createNodeKnowledge(deps), explanations, goalsStore, writer, deps };
}

async function status(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
	} catch (e) {
		return e instanceof NodeKnowledgeError ? e.status : undefined;
	}
	return undefined;
}

describe("createNodeKnowledge", () => {
	it("panel: 404 for an unknown node; the built-in actions are always available", async () => {
		const s = setup();
		assert.equal(await status(() => s.knowledge.panel("n_zzz")), 404);
		assert.deepEqual(s.knowledge.panel("n_a").availableActions, ["askInChat", "useAsGoalTarget"]);
	});

	it("panel: an action is available only when its handler is installed (REQ-node-14)", () => {
		const s = setup({ handlers: { verifyNow: async () => undefined, pin: async () => undefined } });
		assert.deepEqual(s.knowledge.panel("n_a").availableActions, ["pin", "askInChat", "useAsGoalTarget", "verifyNow"]);
	});

	it("panel reports the ceiling when the gate is closed (REQ-node-05)", () => {
		const s = setup({ cost: closedGate() });
		const p = s.knowledge.panel("n_b");
		assert.equal(p.explanation.state, "missing");
		assert.equal(p.explanation.ceiling, true);
	});

	it("ensureExplanation writes the text, then the panel shows it as current", async () => {
		const s = setup();
		const result = await s.knowledge.ensureExplanation("n_b");
		assert.deepEqual(result.written, ["n_b"]);
		const p = s.knowledge.panel("n_b");
		assert.equal(p.explanation.state, "current");
		assert.equal(p.explanation.current?.noSource, true);
	});

	it("ensureExplanation uses the node's verification quotes as source context", async () => {
		const s = setup({
			sources: {
				trust: () => ({
					level: "sourced",
					evidence: [
						{ sourceId: "s1", locator: "p. 1", quote: "Alpha implies beta.", stance: "supports", tier: "primary", snapshotHash: "h1" },
						{ sourceId: "s2", locator: "p. 2", quote: "Beta follows.", stance: "supports", tier: "secondary", snapshotHash: "h1" },
					],
				}),
			},
		});
		await s.knowledge.ensureExplanation("n_b");
		assert.equal(s.writer.requests[0]?.source?.text, "Alpha implies beta.\n\nBeta follows.");
		assert.deepEqual(s.writer.requests[0]?.source?.refs, ["h1"]);
		assert.equal(s.knowledge.panel("n_b").explanation.current?.noSource, false);
	});

	it("two concurrent openings share one generation (single flight)", async () => {
		const s = setup();
		const [x, y] = await Promise.all([s.knowledge.ensureExplanation("n_b"), s.knowledge.ensureExplanation("n_b")]);
		assert.equal(s.writer.requests.length, 1);
		assert.deepEqual(x, y);
	});

	it("ensureExplanation: 404 for an unknown node, ceilingReached when closed", async () => {
		assert.equal(await status(() => setup().knowledge.ensureExplanation("n_zzz")), 404);
		const closed = setup({ cost: closedGate() });
		assert.equal((await closed.knowledge.ensureExplanation("n_b")).ceilingReached, true);
		assert.equal(closed.writer.requests.length, 0);
	});

	it("generateForNodes is the chapter-run entry: batches, with the chapter text", async () => {
		const s = setup();
		const result = await s.knowledge.generateForNodes({ nodeIds: ["n_a", "n_b"], source: { text: "Chapter.", refs: ["h"] } });
		assert.deepEqual(result.written, ["n_a", "n_b"]);
		assert.equal(s.writer.requests[0]?.source?.text, "Chapter.");
	});

	it("saveExplanation stores a user text; bad input is a 400, unknown node a 404", async () => {
		const s = setup();
		assert.deepEqual(s.knowledge.saveExplanation("n_b", "Beta because [[n_a]]."), { version: 1 });
		assert.equal(await status(() => s.knowledge.saveExplanation("n_b", "See [[n_x]].")), 400);
		assert.equal(await status(() => s.knowledge.saveExplanation("n_zzz", "Text.")), 404);
	});

	it("decide: approving a pending proposal; 409 when there is none", async () => {
		const s = setup();
		s.knowledge.saveExplanation("n_b", "Mine.");
		await s.knowledge.ensureExplanation("n_b");
		assert.equal(s.knowledge.panel("n_b").explanation.proposal?.body, "n_b is explained.");
		s.knowledge.decide("n_b", "approved");
		assert.equal(s.knowledge.panel("n_b").explanation.current?.body, "n_b is explained.");
		assert.equal(await status(() => s.knowledge.decide("n_b", "approved")), 409);
	});

	it("runAction useAsGoalTarget creates a goal targeting the existing node", async () => {
		const s = setup();
		await s.knowledge.runAction("n_b", "useAsGoalTarget");
		const goals = deriveGoals(s.goalsStore.readEvents());
		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0]?.targetNodeIds, ["n_b"]);
		assert.equal(goals[0]?.title, "Beta");
		assert.equal(s.knowledge.panel("n_b").goals[0]?.isTarget, true);
	});

	it("runAction calls an installed handler, 501 when absent, 400 for the client-side action", async () => {
		const called: string[] = [];
		const s = setup({ handlers: { verifyNow: async (id) => void called.push(id) } });
		await s.knowledge.runAction("n_a", "verifyNow");
		assert.deepEqual(called, ["n_a"]);
		assert.equal(await status(() => s.knowledge.runAction("n_a", "pin")), 501);
		assert.equal(await status(() => s.knowledge.runAction("n_a", "askInChat")), 400);
		assert.equal(await status(() => s.knowledge.runAction("n_zzz", "verifyNow")), 404);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-knowledge.test.ts`
Expected: FAIL, "Cannot find module '../src/server/ext/node-knowledge.ts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/server/ext/node-knowledge.ts
/**
 * The node-knowledge service factory: panel data, single-flight explanation
 * generation, user edits, proposal decisions and node actions, over injected
 * ports (graph, explanations, goals, writer, cost gate, panel sources,
 * action handlers). The live wiring is node-knowledge-live.ts; keeping the
 * factory free of the real stores makes it testable with memory fakes.
 */

import { createGoal } from "../../core/ext/goal-service.ts";
import {
	decideProposal,
	generateExplanations,
	saveUserExplanation,
	type GenerateRequest,
	type GenerateResult,
} from "../../core/ext/explanation-service.ts";
import { buildNodePanel } from "../../core/ext/node-panel.ts";
import { NODE_ACTIONS, type NodeAction, type NodePanelData, type PanelSources } from "../../core/ext/node-panel-types.ts";
import type { CostGate, ExplanationsStore, ExplanationWriter, SourceContext } from "../../core/ext/node-knowledge-ports.ts";
import type { GoalsStore } from "../../core/ext/ports.ts";
import type { GraphStore } from "../../core/ports.ts";

/** An expected failure with the HTTP status the route should return. */
export class NodeKnowledgeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "NodeKnowledgeError";
		this.status = status;
	}
}

/** Actions other children implement; absent handler = button disabled, route answers 501. */
export type NodeActionHandlers = Partial<Record<Exclude<NodeAction, "askInChat" | "useAsGoalTarget">, (nodeId: string) => Promise<unknown> | unknown>>;

export interface NodeKnowledgeDeps {
	graphStore: GraphStore;
	explanations: ExplanationsStore;
	goalsStore: GoalsStore;
	writer: ExplanationWriter;
	cost: CostGate;
	sources: PanelSources;
	handlers: NodeActionHandlers;
	now?: () => string;
	batchSize?: number;
}

export function createNodeKnowledge(deps: NodeKnowledgeDeps) {
	const inFlight = new Map<string, Promise<GenerateResult>>();

	const requireNode = (nodeId: string) => {
		if (!deps.graphStore.readNodes().some((n) => n.id === nodeId)) {
			throw new NodeKnowledgeError(404, `unknown node ${nodeId}`);
		}
	};
	const availableActions = (): NodeAction[] =>
		NODE_ACTIONS.filter((a) => a === "askInChat" || a === "useAsGoalTarget" || deps.handlers[a] !== undefined);
	const explanationDeps = () => ({
		graph: deps.graphStore,
		explanations: deps.explanations,
		writer: deps.writer,
		cost: deps.cost,
		now: deps.now,
		batchSize: deps.batchSize,
	});
	/** Outside a chapter run the node's verification quotes are the source text (REQ-node-09). */
	const sourceContextFor = (nodeId: string): SourceContext | null => {
		const evidence = deps.sources.trust?.(nodeId).evidence ?? [];
		if (evidence.length === 0) return null;
		return { text: evidence.map((e) => e.quote).join("\n\n"), refs: [...new Set(evidence.map((e) => e.snapshotHash))] };
	};

	return {
		panel(nodeId: string): NodePanelData {
			const data = buildNodePanel(nodeId, {
				graph: deps.graphStore,
				explanationEvents: deps.explanations.readEvents(),
				goalEvents: deps.goalsStore.readEvents(),
				sources: deps.sources,
				costAllowed: deps.cost.allowed(),
				availableActions: availableActions(),
			});
			if (data === null) throw new NodeKnowledgeError(404, `unknown node ${nodeId}`);
			return data;
		},

		/** First-opening generation (REQ-node-05): one shared run per node at a time. */
		ensureExplanation(nodeId: string): Promise<GenerateResult> {
			requireNode(nodeId);
			const running = inFlight.get(nodeId);
			if (running !== undefined) return running;
			const run = generateExplanations({ nodeIds: [nodeId], source: sourceContextFor(nodeId) }, explanationDeps()).finally(() =>
				inFlight.delete(nodeId),
			);
			inFlight.set(nodeId, run);
			return run;
		},

		/** The chapter-run entry (REQ-node-04): the lecture pipeline passes the chapter text. */
		generateForNodes(request: GenerateRequest): Promise<GenerateResult> {
			return generateExplanations(request, explanationDeps());
		},

		saveExplanation(nodeId: string, body: string): { version: number } {
			requireNode(nodeId);
			try {
				return saveUserExplanation(nodeId, body, explanationDeps());
			} catch (e) {
				throw new NodeKnowledgeError(400, e instanceof Error ? e.message : String(e));
			}
		},

		decide(nodeId: string, decision: "approved" | "rejected"): { version: number } {
			requireNode(nodeId);
			try {
				return decideProposal(nodeId, decision, explanationDeps());
			} catch (e) {
				throw new NodeKnowledgeError(409, e instanceof Error ? e.message : String(e));
			}
		},

		async runAction(nodeId: string, action: NodeAction): Promise<unknown> {
			requireNode(nodeId);
			if (action === "askInChat") throw new NodeKnowledgeError(400, "askInChat runs in the browser");
			if (action === "useAsGoalTarget") {
				const name = deps.graphStore.readNodes().find((n) => n.id === nodeId)?.name ?? nodeId;
				return createGoal(
					{ title: name, existingNodeId: nodeId, origin: "user", originRef: "" },
					{ graphStore: deps.graphStore, goalsStore: deps.goalsStore, now: deps.now },
				);
			}
			const handler = deps.handlers[action];
			if (handler === undefined) throw new NodeKnowledgeError(501, `action ${action} is not available yet`);
			return (await handler(nodeId)) ?? { ok: true };
		},
	};
}

export type NodeKnowledge = ReturnType<typeof createNodeKnowledge>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-knowledge.test.ts`
Expected: `fail 0`. In the "available only when handler installed" test the expected order follows `NODE_ACTIONS` (createCard, pin, retire, startReview, askInChat, useAsGoalTarget, verifyNow), hence `["pin", "askInChat", "useAsGoalTarget", "verifyNow"]`.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck 2>&1 | tail -5
npx eslint src/server/ext 2>&1 | tail -5
git add src/server/ext/node-knowledge.ts tests/ext-node-knowledge.test.ts
git commit -m "feat(ext): add node-knowledge service factory" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: no errors.

---

### Task 12: Live wiring, composition root and barrels (REQ-node-16, REQ-int-04)

**Files:**
- Modify: `src/server/ext/stores.ts`
- Create: `src/server/ext/panel-providers.ts`
- Create: `src/server/ext/node-knowledge-live.ts`
- Create: `src/server/ext/index.ts`
- Create: `src/core/ext/index.ts`
- Modify: `src/core/index.ts` (append one line)
- Modify: `src/server/index.ts` (append one line)
- Test: `tests/ext-node-knowledge-live.test.ts`

- [ ] **Step 1: Check the one external prerequisite**

```bash
test -f src/server/ext/cost-gate.ts && grep -n "export const costGate" src/server/ext/cost-gate.ts
```

Expected: one matching line. If the file is missing, the cost-ceiling plan (verification child) has not landed: do that plan's cost task first. Do not create a substitute gate here: REQ-node-16 requires the one shared ceiling. If `costGate` exists but its methods are not `allowed()` and `record(usd)`, add a small adapter object in step 4 below (and only there) that maps its real methods to the `CostGate` port.

- [ ] **Step 2: Add the explanations store to the extension composition root**

Edit `src/server/ext/stores.ts`: add the import and the entry.

```ts
// src/server/ext/stores.ts
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";
import { createExplanationsStore } from "../../store/ext/explanations-store.ts";

export const extStores = {
	goalsStore: createGoalsStore(EXT_PATHS.dir),
	explanationsStore: createExplanationsStore(EXT_PATHS.dir),
};

export type ExtStores = typeof extStores;
```

(If other plans already added entries to `extStores`, keep them and add only the two `explanationsStore` lines.)

- [ ] **Step 3: Write the default providers file**

```ts
// src/server/ext/panel-providers.ts
/**
 * Where the panel gets data and actions that belong to other children.
 * Today both are empty, so the panel shows unverified trust and no lectures,
 * cards or review state, and disables the buttons that need a handler.
 * Each later plan fills ITS entries here (one line each):
 *   - verification:   sources.trust, nodeHandlers.verifyNow
 *   - lectures:       sources.lecturesCiting
 *   - personal layer: sources.cards, sources.review, nodeHandlers.createCard / pin / retire / startReview
 */

import type { PanelSources } from "../../core/ext/node-panel-types.ts";
import type { NodeActionHandlers } from "./node-knowledge.ts";

export const panelSources: PanelSources = {};

export const nodeHandlers: NodeActionHandlers = {};
```

- [ ] **Step 4: Write the live wiring**

```ts
// src/server/ext/node-knowledge-live.ts
/**
 * Live wiring of the node-knowledge service: the real stores, the settings-
 * resolved model for the writer, upstream's call pricing and the shared
 * daily cost gate. Nothing here has logic worth a unit test; the factory it
 * calls is tested in tests/ext-node-knowledge.test.ts.
 */

import { piEngineForSpec } from "../../agent/models.ts";
import { createExplanationWriter } from "../../agent/ext/explanation-writer.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import type { ExplanationWriter } from "../../core/ext/node-knowledge-ports.ts";
import { callCost } from "../pricing.ts";
import { stores } from "../stores.ts";
import { costGate } from "./cost-gate.ts";
import { createNodeKnowledge, NodeKnowledgeError } from "./node-knowledge.ts";
import { nodeHandlers, panelSources } from "./panel-providers.ts";
import { extStores } from "./stores.ts";

/** The strong slot (role "teacher"): explanation quality is the product. Read fresh per call. */
const writer: ExplanationWriter = {
	async write(request) {
		const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
		if (!spec) {
			throw new NodeKnowledgeError(503, "No model is configured for the strong slot (settings → models).");
		}
		return createExplanationWriter({ engine: piEngineForSpec(spec, true), priceCall: callCost }).write(request);
	},
};

const knowledge = createNodeKnowledge({
	graphStore: stores.graphStore,
	explanations: extStores.explanationsStore,
	goalsStore: extStores.goalsStore,
	writer,
	cost: costGate,
	sources: panelSources,
	handlers: nodeHandlers,
});

export const nodePanel = knowledge.panel;
export const ensureNodeExplanation = knowledge.ensureExplanation;
/** Chapter-run entry for the lecture pipeline (REQ-node-04). */
export const generateNodeExplanations = knowledge.generateForNodes;
export const saveNodeExplanation = knowledge.saveExplanation;
export const decideNodeProposal = knowledge.decide;
export const runNodeAction = knowledge.runAction;
```

- [ ] **Step 5: Write the barrels and append the two upstream lines**

```ts
// src/server/ext/index.ts
export {
	decideNodeProposal,
	ensureNodeExplanation,
	generateNodeExplanations,
	nodePanel,
	runNodeAction,
	saveNodeExplanation,
} from "./node-knowledge-live.ts";
export { NodeKnowledgeError } from "./node-knowledge.ts";
```

```ts
// src/core/ext/index.ts
/**
 * Browser-safe barrel of the extension core. Only modules without node:
 * imports belong here (graph-reading modules such as node-panel.ts and
 * goal-service.ts stay out, like core/graph.ts stays out of core/index.ts).
 */
export * from "./explanation-check.ts";
export * from "./neighbourhood.ts";
export * from "./node-panel-types.ts";
export * from "./panel-history.ts";
```

Append to the end of `src/core/index.ts`:

```ts
export * from "./ext/index.ts";
```

Append to the end of `src/server/index.ts`:

```ts
export * from "./ext/index.ts";
```

- [ ] **Step 6: Write a wiring smoke test**

```ts
// tests/ext-node-knowledge-live.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as server from "../src/server/ext/index.ts";
import * as core from "../src/core/ext/index.ts";

describe("node-knowledge wiring", () => {
	it("the server barrel exports the entry points the routes and the lecture pipeline use", () => {
		for (const name of ["nodePanel", "ensureNodeExplanation", "generateNodeExplanations", "saveNodeExplanation", "decideNodeProposal", "runNodeAction"] as const) {
			assert.equal(typeof server[name], "function", name);
		}
		assert.equal(typeof server.NodeKnowledgeError, "function");
	});

	it("the core barrel is browser-safe: it exposes the client helpers and no graph reader", () => {
		assert.equal(typeof core.linkifyNodeLinks, "function");
		assert.equal(typeof core.neighbourhood, "function");
		assert.equal(typeof core.historyOpen, "function");
		assert.equal(core.NODE_ACTIONS.length, 7);
		assert.equal("buildNodePanel" in core, false);
	});
});
```

- [ ] **Step 7: Run tests, typecheck, lint**

```bash
NODE_ENV=test npx tsx --test tests/ext-node-knowledge-live.test.ts
npm run typecheck 2>&1 | tail -8
npm run lint 2>&1 | tail -8
```

Expected: test `fail 0`; typecheck and lint clean. A typecheck error "Module ... has already exported a member named X" means a name collides with another core export; rename the new export (prefix it) rather than editing the other module.

- [ ] **Step 8: Commit**

```bash
git add src/server/ext src/core/ext/index.ts src/core/index.ts src/server/index.ts tests/ext-node-knowledge-live.test.ts
git commit -m "feat(ext): wire node knowledge into the extension composition root and barrels" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Routes

**Files:**
- Create: `app/api/ext/error-response.ts`
- Create: `app/api/ext/nodes/[id]/panel/route.ts`
- Create: `app/api/ext/nodes/[id]/explanation/route.ts`
- Create: `app/api/ext/nodes/[id]/actions/route.ts`

Routes are thin transport (like `app/api/graph/nodes/[id]/route.ts`): they import only the `@/src/server` and `@/src/core` barrels (import law). They are exercised end to end in Task 18; the logic they call is tested in Task 11.

- [ ] **Step 1: Write the error helper**

```ts
// app/api/ext/error-response.ts
import { NodeKnowledgeError } from "@/src/server";

/** Expected failures carry their HTTP status; anything else is a real bug and is rethrown (500). */
export function errorResponse(error: unknown): Response {
	if (error instanceof NodeKnowledgeError) return Response.json({ error: error.message }, { status: error.status });
	throw error;
}
```

- [ ] **Step 2: Write the panel route**

```ts
// app/api/ext/nodes/[id]/panel/route.ts
import { nodePanel } from "@/src/server";
import { errorResponse } from "../../../error-response";

export const dynamic = "force-dynamic";

/** GET /api/ext/nodes/[id]/panel: everything the node panel shows for one node. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(nodePanel(id));
	} catch (error) {
		return errorResponse(error);
	}
}
```

- [ ] **Step 3: Write the explanation route**

```ts
// app/api/ext/nodes/[id]/explanation/route.ts
import { decideNodeProposal, ensureNodeExplanation, saveNodeExplanation } from "@/src/server";
import { errorResponse } from "../../../error-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/ext/nodes/[id]/explanation
 *   {"action":"generate"}            write the missing or stale text now (single flight)
 *   {"action":"save","body":"..."}   the user's own version
 *   {"action":"approve"|"reject"}    decide the pending agent proposal
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { action?: unknown; body?: unknown } | null;
	if (body === null) return Response.json({ error: "expected a JSON body" }, { status: 400 });
	try {
		switch (body.action) {
			case "generate":
				return Response.json(await ensureNodeExplanation(id));
			case "save":
				if (typeof body.body !== "string") return Response.json({ error: "body must be a string" }, { status: 400 });
				return Response.json(saveNodeExplanation(id, body.body));
			case "approve":
				return Response.json(decideNodeProposal(id, "approved"));
			case "reject":
				return Response.json(decideNodeProposal(id, "rejected"));
			default:
				return Response.json({ error: "unknown action" }, { status: 400 });
		}
	} catch (error) {
		return errorResponse(error);
	}
}
```

- [ ] **Step 4: Write the actions route**

```ts
// app/api/ext/nodes/[id]/actions/route.ts
import { NODE_ACTIONS, type NodeAction } from "@/src/core";
import { runNodeAction } from "@/src/server";
import { errorResponse } from "../../../error-response";

export const dynamic = "force-dynamic";

/** POST /api/ext/nodes/[id]/actions  {"action": NodeAction}. askInChat runs in the browser and is refused here. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
	const action = body?.action;
	if (typeof action !== "string" || !(NODE_ACTIONS as readonly string[]).includes(action)) {
		return Response.json({ error: "unknown action" }, { status: 400 });
	}
	try {
		return Response.json(await runNodeAction(id, action as NodeAction));
	} catch (error) {
		return errorResponse(error);
	}
}
```

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck 2>&1 | tail -8
npm run lint 2>&1 | tail -8
```

Expected: clean. The relative import `../../../error-response` from `app/api/ext/nodes/[id]/<route>/route.ts` resolves to `app/api/ext/error-response`; if lint complains about the import law for `@/src/server`, check that the import is exactly `@/src/server` (the barrel), not a deep path.

- [ ] **Step 6: Commit**

```bash
git add app/api/ext
git commit -m "feat(ext): add node panel, explanation and action routes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Presentational panel view (REQ-node-10, 11, 12, 13, 14, 05)

**Files:**
- Create: `components/ext/open-node.ts`
- Create: `components/ext/node-panel-view.tsx`
- Test: `tests/ext-node-panel-ui.test.tsx`

- [ ] **Step 1: Write the open helper**

```ts
// components/ext/open-node.ts
/**
 * The one call every view uses to open the node panel (REQ-node-10): the
 * graph view, the chat graph-context card, and later the lecture view and
 * review. A window event keeps callers decoupled from the panel host
 * (upstream uses the same "lh:" event idiom for its cross-component signals).
 */

export const OPEN_NODE_EVENT = "lh:open-node";

export function openNodePanel(nodeId: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(OPEN_NODE_EVENT, { detail: { nodeId } }));
}
```

- [ ] **Step 2: Write the failing UI test**

```tsx
// tests/ext-node-panel-ui.test.tsx
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NodePanelView, type NodePanelViewProps } from "../components/ext/node-panel-view.tsx";
import type { NodePanelData } from "../src/core/ext/node-panel-types.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

function data(over: Partial<NodePanelData> = {}): NodePanelData {
	return {
		node: { id: "n_c", name: "Gamma", statement: "Gamma holds.", aliases: ["G"] },
		explanation: {
			state: "current", ceiling: false, form: "short",
			current: { version: 1, body: "Gamma because [[n_a]].", author: "agent", noSource: true },
			proposal: null, linkNames: { n_a: "Alpha" },
		},
		trust: { level: "sourced", evidence: [{ sourceId: "s1", locator: "p. 3", quote: "Gamma is shown.", stance: "supports", tier: "primary", snapshotHash: "h" }] },
		concluding: [
			{ chainId: "arg_1", premises: [{ id: "n_a", name: "Alpha" }] },
			{ chainId: "arg_2", premises: [{ id: "n_b", name: "Beta" }] },
		],
		usedAsPremise: [{ chainId: "arg_3", coPremises: [], conclusion: { id: "n_d", name: "Delta" } }],
		citingLectures: [{ lectureId: "l1", title: "Lecture One" }],
		mentionedBy: [{ id: "n_d", name: "Delta" }],
		cards: [{ cardId: "c1", question: "Why gamma?", status: "active" }],
		review: { dueAt: null, reps: 2, pinned: false, retired: false },
		goals: [{ id: "g1", title: "Master Delta", status: "active", isTarget: false }],
		neighbourhood: {
			nodes: [
				{ id: "n_c", name: "Gamma", depth: 0 },
				{ id: "n_a", name: "Alpha", depth: 1 },
				{ id: "n_e", name: "Epsilon", depth: 2 },
			],
			edges: [{ from: "n_a", to: "n_c" }, { from: "n_e", to: "n_a" }],
		},
		availableActions: ["askInChat", "useAsGoalTarget"],
		...over,
	};
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const calls: string[] = [];

function props(over: Partial<NodePanelViewProps> = {}): NodePanelViewProps {
	return {
		data: data(), depth: 1, canBack: false, canForward: false, generating: false, error: null,
		onBack: () => calls.push("back"), onForward: () => calls.push("forward"), onClose: () => calls.push("close"),
		onNavigate: (id) => calls.push(`nav:${id}`), onDepth: (d) => calls.push(`depth:${d}`),
		onAction: (a) => calls.push(`action:${a}`), onGenerate: () => calls.push("generate"),
		onSaveEdit: (b) => calls.push(`save:${b}`), onDecide: (d, v) => calls.push(`decide:${d}:${v}`),
		...over,
	};
}
async function mount(p: NodePanelViewProps) {
	calls.length = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<NodePanelView {...p} />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (el: Element | null) => { assert.ok(el, "element to click exists"); await act(async () => { el.dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); };

it("shows the statement, trust with evidence, arguments, lectures, back-links, cards, review and goals (REQ-node-12)", async () => {
	await mount(props());
	const text = document.body.textContent ?? "";
	for (const expected of ["Gamma holds.", "sourced", "Gamma is shown.", "Alternative arguments", "Lecture One", "Delta", "Why gamma?", "Master Delta", "2"]) {
		assert.ok(text.includes(expected), `panel shows "${expected}"`);
	}
	assert.equal(q('[data-testid="panel-explanation"]')?.textContent?.includes("Gamma because"), true);
	assert.equal(q('[data-testid="explanation-nosource"]') !== null, true, "marks 'no source context'");
});

it("a single argument is not labelled alternative", async () => {
	await mount(props({ data: data({ concluding: [{ chainId: "arg_1", premises: [{ id: "n_a", name: "Alpha" }] }] }) }));
	assert.equal((document.body.textContent ?? "").includes("Alternative arguments"), false);
});

it("clicking a mini-graph neighbour navigates; depth 2 nodes appear only at depth 2 (REQ-node-13)", async () => {
	await mount(props());
	assert.equal(q('[data-testid="minigraph-node-n_e"]'), null);
	await click(q('[data-testid="minigraph-node-n_a"]'));
	assert.deepEqual(calls, ["nav:n_a"]);
	await click(q('[data-testid="minigraph-depth-2"]'));
	assert.deepEqual(calls, ["nav:n_a", "depth:2"]);
	await act(async () => { root!.render(<NodePanelView {...props({ depth: 2 })} />); });
	assert.notEqual(q('[data-testid="minigraph-node-n_e"]'), null);
});

it("back and forward buttons follow the history flags", async () => {
	await mount(props({ canBack: true, canForward: false }));
	assert.equal(q('[data-testid="panel-back"]')?.hasAttribute("disabled"), false);
	assert.equal(q('[data-testid="panel-forward"]')?.hasAttribute("disabled"), true);
	await click(q('[data-testid="panel-back"]'));
	assert.deepEqual(calls, ["back"]);
});

it("clicking an inline node link in the explanation navigates (renderBody is replaceable)", async () => {
	await mount(props({ renderBody: () => <a href="#node:n_a">Alpha</a> }));
	await click(document.querySelector('[data-testid="panel-explanation"] a'));
	assert.deepEqual(calls, ["nav:n_a"]);
});

it("actions: only the available ones are enabled (REQ-node-14)", async () => {
	await mount(props());
	assert.equal(q('[data-testid="action-askInChat"]')?.hasAttribute("disabled"), false);
	assert.equal(q('[data-testid="action-verifyNow"]')?.hasAttribute("disabled"), true);
	await click(q('[data-testid="action-useAsGoalTarget"]'));
	assert.deepEqual(calls, ["action:useAsGoalTarget"]);
});

it("a missing explanation at the ceiling shows the statement and says why (REQ-node-05)", async () => {
	const base = data();
	await mount(props({ data: { ...base, explanation: { ...base.explanation, state: "missing", ceiling: true, current: null } } }));
	assert.match(q('[data-testid="explanation-ceiling"]')?.textContent ?? "", /ceiling/i);
	assert.equal((document.body.textContent ?? "").includes("Gamma holds."), true);
});

it("a missing explanation offers generation, and shows progress while generating", async () => {
	const base = data();
	const missing = { ...base, explanation: { ...base.explanation, state: "missing" as const, current: null } };
	await mount(props({ data: missing }));
	await click(q('[data-testid="explanation-generate"]'));
	assert.deepEqual(calls, ["generate"]);
	await act(async () => { root!.render(<NodePanelView {...props({ data: missing, generating: true })} />); });
	assert.notEqual(q('[data-testid="explanation-generating"]'), null);
});

it("a pending proposal can be approved or rejected (REQ-node-02)", async () => {
	const base = data();
	await mount(props({ data: { ...base, explanation: { ...base.explanation, proposal: { version: 3, body: "New agent text." } } } }));
	assert.equal(q('[data-testid="explanation-proposal"]')?.textContent?.includes("New agent text."), true);
	await click(q('[data-testid="proposal-approve"]'));
	await click(q('[data-testid="proposal-reject"]'));
	assert.deepEqual(calls, ["decide:approved:3", "decide:rejected:3"]);
});

it("the user can edit the explanation", async () => {
	await mount(props());
	await click(q('[data-testid="explanation-edit"]'));
	const area = q('[data-testid="explanation-editor"]') as HTMLTextAreaElement | null;
	assert.ok(area);
	assert.equal(area.value, "Gamma because [[n_a]].");
	await act(async () => {
		area.value = "My words.";
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	await click(q('[data-testid="explanation-save"]'));
	assert.deepEqual(calls, ["save:My words."]);
});

it("shows an error message", async () => {
	await mount(props({ error: "No model is configured" }));
	assert.match(q('[data-testid="panel-error"]')?.textContent ?? "", /No model is configured/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-panel-ui.test.tsx`
Expected: FAIL, "Cannot find module '../components/ext/node-panel-view.tsx'".

- [ ] **Step 4: Write the view**

```tsx
// components/ext/node-panel-view.tsx
"use client";

import { useState, type ReactNode } from "react";
import {
	linkifyNodeLinks,
	NODE_ACTIONS,
	NODE_HREF_PREFIX,
	radialPositions,
	type NodeAction,
	type NodePanelData,
	type NodeRef,
} from "@/src/core";

/**
 * The node panel, presentational half (REQ-node-10 to REQ-node-14).
 * Functional markup only: the visual design is done in the UI session. The
 * body renderer is injected so the container can use the app's markdown and
 * math renderer while tests use the plain default.
 */

export interface NodePanelViewProps {
	data: NodePanelData;
	depth: 1 | 2;
	canBack: boolean;
	canForward: boolean;
	generating: boolean;
	error: string | null;
	onBack(): void;
	onForward(): void;
	onClose(): void;
	onNavigate(nodeId: string): void;
	onDepth(depth: 1 | 2): void;
	onAction(action: NodeAction): void;
	onGenerate(): void;
	onSaveEdit(body: string): void;
	onDecide(decision: "approved" | "rejected", version: number): void;
	renderBody?: (markdown: string) => ReactNode;
}

const ACTION_LABELS: Record<NodeAction, string> = {
	createCard: "Create card",
	pin: "Pin",
	retire: "Retire",
	startReview: "Start review",
	askInChat: "Ask in chat",
	useAsGoalTarget: "Use as goal target",
	verifyNow: "Verify now",
};

const RING = 52;

function Section({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
	return (
		<section data-testid={testId} className="border-t px-4 py-3">
			<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

function NodeButton({ node, onNavigate }: { node: NodeRef; onNavigate(id: string): void }) {
	return (
		<button type="button" className="underline decoration-dotted" onClick={() => onNavigate(node.id)}>
			{node.name}
		</button>
	);
}

function NodeList({ nodes, onNavigate }: { nodes: NodeRef[]; onNavigate(id: string): void }) {
	return (
		<>
			{nodes.map((n, i) => (
				<span key={n.id}>
					{i > 0 ? ", " : ""}
					<NodeButton node={n} onNavigate={onNavigate} />
				</span>
			))}
		</>
	);
}

export function NodePanelView(p: NodePanelViewProps) {
	const { data } = p;
	const { explanation: ex } = data;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const plain = (md: string): ReactNode => <div className="whitespace-pre-wrap">{md}</div>;
	const render = p.renderBody ?? plain;

	// Clicks on rendered node links bubble to this wrapper (the markdown renderer owns the anchors).
	const interceptNodeLinks = (e: { target: EventTarget | null; preventDefault(): void }) => {
		const anchor = (e.target as Element | null)?.closest?.("a");
		const href = anchor?.getAttribute("href");
		if (href?.startsWith(NODE_HREF_PREFIX)) {
			e.preventDefault();
			p.onNavigate(href.slice(NODE_HREF_PREFIX.length));
		}
	};
	const body = (markdown: string) => <div onClick={interceptNodeLinks}>{render(linkifyNodeLinks(markdown, ex.linkNames))}</div>;

	const visible = data.neighbourhood.nodes.filter((n) => n.depth <= p.depth);
	const visibleIds = new Set(visible.map((n) => n.id));
	const positions = radialPositions(visible, RING);

	return (
		<div data-testid="node-panel-view" className="text-sm">
			<header className="flex items-center gap-2 px-4 py-3">
				<button type="button" data-testid="panel-back" disabled={!p.canBack} onClick={p.onBack} aria-label="Back">←</button>
				<button type="button" data-testid="panel-forward" disabled={!p.canForward} onClick={p.onForward} aria-label="Forward">→</button>
				<h2 className="min-w-0 flex-1 truncate text-base font-medium">{data.node.name}</h2>
				<button type="button" data-testid="panel-close" onClick={p.onClose} aria-label="Close">×</button>
			</header>

			{p.error !== null ? (
				<div data-testid="panel-error" role="alert" className="px-4 pb-2 text-destructive">
					{p.error}
				</div>
			) : null}

			<Section title="Explanation" testId="panel-explanation">
				{ex.current !== null && !editing ? (
					<>
						<div className="mb-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
							<span>{ex.current.author === "user" ? "written by you" : "written by the agent"}</span>
							<span>{ex.form} form</span>
							{ex.state === "stale" ? <span data-testid="explanation-stale">out of date: the arguments changed</span> : null}
							{ex.current.noSource ? <span data-testid="explanation-nosource">no source context</span> : null}
						</div>
						{body(ex.current.body)}
						<button
							type="button"
							data-testid="explanation-edit"
							className="mt-1 text-xs underline"
							onClick={() => { setDraft(ex.current?.body ?? ""); setEditing(true); }}
						>
							Edit
						</button>
					</>
				) : null}

				{editing ? (
					<div>
						<textarea
							data-testid="explanation-editor"
							className="h-48 w-full rounded border bg-background p-2 font-mono text-xs"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
						/>
						<button type="button" data-testid="explanation-save" onClick={() => { p.onSaveEdit(draft); setEditing(false); }}>Save</button>{" "}
						<button type="button" onClick={() => setEditing(false)}>Cancel</button>
					</div>
				) : null}

				{ex.current === null && !editing ? (
					p.generating ? (
						<p data-testid="explanation-generating" className="text-muted-foreground">Writing the explanation…</p>
					) : ex.ceiling ? (
						<p data-testid="explanation-ceiling" className="text-muted-foreground">
							No explanation yet: the daily cost ceiling is reached, so none is written now. The statement below is all there is for the moment.
						</p>
					) : (
						<>
							<button type="button" data-testid="explanation-generate" onClick={p.onGenerate}>Generate explanation</button>{" "}
							<button type="button" onClick={() => { setDraft(""); setEditing(true); }}>Write my own</button>
						</>
					)
				) : null}

				{ex.state === "stale" && ex.ceiling ? (
					<p data-testid="explanation-ceiling" className="mt-1 text-xs text-muted-foreground">
						The daily cost ceiling is reached, so the out-of-date text is not rewritten now.
					</p>
				) : null}

				{ex.proposal !== null ? (
					<div data-testid="explanation-proposal" className="mt-2 rounded border p-2">
						<div className="mb-1 text-xs text-muted-foreground">The agent proposes a new version of your text.</div>
						{body(ex.proposal.body)}
						<button type="button" data-testid="proposal-approve" onClick={() => p.onDecide("approved", ex.proposal?.version ?? 0)}>Approve</button>{" "}
						<button type="button" data-testid="proposal-reject" onClick={() => p.onDecide("rejected", ex.proposal?.version ?? 0)}>Reject</button>
					</div>
				) : null}
			</Section>

			<Section title="Statement" testId="panel-statement">
				<p>{data.node.statement}</p>
				{data.node.aliases.length > 0 ? <p className="text-xs text-muted-foreground">Also: {data.node.aliases.join(" | ")}</p> : null}
				<p data-testid="panel-trust" className="mt-1">
					Trust: <strong>{data.trust.level}</strong>
				</p>
				{data.trust.evidence.map((e, i) => (
					<blockquote key={i} className="mt-1 border-l pl-2 text-xs">
						{e.quote}
						<div className="text-muted-foreground">
							{e.stance}, {e.tier}, {e.sourceId} {e.locator}
						</div>
					</blockquote>
				))}
			</Section>

			<Section title={data.concluding.length > 1 ? "Alternative arguments" : "Argument"} testId="panel-arguments">
				{data.concluding.length === 0 ? <p className="text-muted-foreground">No argument concludes this node.</p> : null}
				{data.concluding.map((c) => (
					<p key={c.chainId}>
						<NodeList nodes={c.premises} onNavigate={p.onNavigate} /> together imply this node.
					</p>
				))}
				{data.usedAsPremise.length > 0 ? <h4 className="mt-2 text-xs text-muted-foreground">Used as a premise</h4> : null}
				{data.usedAsPremise.map((u) => (
					<p key={u.chainId}>
						{u.coPremises.length > 0 ? <><NodeList nodes={u.coPremises} onNavigate={p.onNavigate} /> with this, </> : "Alone, "}
						gives <NodeButton node={u.conclusion} onNavigate={p.onNavigate} />.
					</p>
				))}
			</Section>

			<Section title="Lectures that cite it" testId="panel-lectures">
				{data.citingLectures.length === 0 ? <p className="text-muted-foreground">None.</p> : data.citingLectures.map((l) => <p key={l.lectureId}>{l.title}</p>)}
			</Section>

			<Section title="Mentioned in explanations of" testId="panel-mentions">
				{data.mentionedBy.length === 0 ? <p className="text-muted-foreground">None.</p> : <NodeList nodes={data.mentionedBy} onNavigate={p.onNavigate} />}
			</Section>

			<Section title="Cards and review" testId="panel-cards">
				{data.cards.length === 0 ? <p className="text-muted-foreground">No cards.</p> : data.cards.map((c) => <p key={c.cardId}>{c.question} ({c.status})</p>)}
				{data.review !== null ? (
					<p className="text-xs text-muted-foreground">
						Reviews: {data.review.reps}; due: {data.review.dueAt ?? "not scheduled"}
						{data.review.pinned ? "; pinned" : ""}
						{data.review.retired ? "; retired" : ""}
					</p>
				) : null}
			</Section>

			<Section title="Goals" testId="panel-goals">
				{data.goals.length === 0 ? <p className="text-muted-foreground">In no goal.</p> : data.goals.map((g) => <p key={g.id}>{g.title} ({g.status}{g.isTarget ? ", target" : ""})</p>)}
			</Section>

			<Section title="Neighbourhood" testId="panel-minigraph">
				<div className="mb-1 text-xs">
					<button type="button" data-testid="minigraph-depth-1" disabled={p.depth === 1} onClick={() => p.onDepth(1)}>Depth 1</button>{" "}
					<button type="button" data-testid="minigraph-depth-2" disabled={p.depth === 2} onClick={() => p.onDepth(2)}>Depth 2</button>
				</div>
				<svg viewBox="-170 -140 340 280" className="h-64 w-full" role="img" aria-label="Neighbourhood of this node">
					{data.neighbourhood.edges
						.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
						.map((e) => {
							const a = positions[e.from];
							const b = positions[e.to];
							return a && b ? <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.4} /> : null;
						})}
					{visible.map((n) => {
						const pos = positions[n.id];
						if (!pos) return null;
						return (
							<g
								key={n.id}
								data-testid={`minigraph-node-${n.id}`}
								transform={`translate(${pos.x} ${pos.y})`}
								style={{ cursor: n.depth === 0 ? "default" : "pointer" }}
								onClick={() => { if (n.depth !== 0) p.onNavigate(n.id); }}
							>
								<circle r={n.depth === 0 ? 10 : 7} fill="currentColor" fillOpacity={n.depth === 0 ? 0.9 : 0.5} />
								<text y={n.depth === 0 ? -14 : -11} textAnchor="middle" fontSize="9" fill="currentColor">
									{n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}
								</text>
							</g>
						);
					})}
				</svg>
			</Section>

			<Section title="Actions" testId="panel-actions">
				<div className="flex flex-wrap gap-2">
					{NODE_ACTIONS.map((a) => (
						<button
							key={a}
							type="button"
							data-testid={`action-${a}`}
							disabled={!data.availableActions.includes(a)}
							title={data.availableActions.includes(a) ? undefined : "Not available yet"}
							onClick={() => p.onAction(a)}
						>
							{ACTION_LABELS[a]}
						</button>
					))}
				</div>
			</Section>
		</div>
	);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/ext-node-panel-ui.test.tsx`
Expected: `fail 0`. If a test fails because linkedom lacks SVG `closest`/`getAttribute` behaviour, only the minigraph test is affected: check that `data-testid` is set on the `<g>` and that the click handler is attached to the same `<g>`; do not change production code to suit linkedom beyond that. If the whole file fails with a React/SVG namespace error, report it instead of redesigning the mini-graph.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck 2>&1 | tail -8
npm run lint 2>&1 | tail -8
git add components/ext/open-node.ts components/ext/node-panel-view.tsx tests/ext-node-panel-ui.test.tsx
git commit -m "feat(ext): add the node panel view" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: clean.

---

### Task 15: Panel container, host and layout mount (REQ-node-10, 11, 13, 05)

**Files:**
- Create: `components/ext/node-panel.tsx`
- Create: `components/ext/node-panel-host.tsx`
- Modify: `app/layout.tsx` (one import, one element)

The container is a thin client-side shell around fetch calls and the tested pure pieces (`panel-history`, the view); it is verified end to end in Task 18.

- [ ] **Step 1: Write the container**

```tsx
// components/ext/node-panel.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	EMPTY_HISTORY,
	historyBack,
	historyCanBack,
	historyCanForward,
	historyCurrent,
	historyForward,
	historyOpen,
	type NodeAction,
	type NodePanelData,
} from "@/src/core";
import { NodePanelView } from "./node-panel-view";

export interface PanelRequest {
	nodeId: string;
	seq: number;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(path, { cache: "no-store", ...init });
	const json: unknown = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
	return json;
}

const post = (nodeId: string, route: "explanation" | "actions", body: unknown) =>
	api(`/api/ext/nodes/${encodeURIComponent(nodeId)}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

export function NodePanel({ request, onClose }: { request: PanelRequest; onClose(): void }) {
	const [history, setHistory] = useState(() => historyOpen(EMPTY_HISTORY, request.nodeId));
	const [data, setData] = useState<NodePanelData | null>(null);
	const [depth, setDepth] = useState<1 | 2>(1);
	const [generating, setGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** One automatic generation per (node, state) per panel session: a refused text must not loop. */
	const attempted = useRef(new Set<string>());
	const nodeId = historyCurrent(history);

	useEffect(() => {
		setHistory((h) => historyOpen(h, request.nodeId));
	}, [request]);

	const load = useCallback(
		async (id: string) => (await api(`/api/ext/nodes/${encodeURIComponent(id)}/panel`)) as NodePanelData,
		[],
	);

	useEffect(() => {
		if (nodeId === null) return;
		let cancelled = false;
		setError(null);
		(async () => {
			try {
				let next = await load(nodeId);
				if (cancelled) return;
				setData(next);
				const key = `${nodeId}:${next.explanation.state}`;
				const needsText = next.explanation.state !== "current" && !next.explanation.ceiling && next.explanation.proposal === null;
				if (needsText && !attempted.current.has(key)) {
					attempted.current.add(key);
					setGenerating(true);
					await post(nodeId, "explanation", { action: "generate" });
					next = await load(nodeId);
					if (!cancelled) setData(next);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setGenerating(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [nodeId, load]);

	const refresh = useCallback(async () => {
		if (nodeId === null) return;
		try {
			setData(await load(nodeId));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [nodeId, load]);

	const guarded = async (run: () => Promise<unknown>) => {
		setError(null);
		try {
			await run();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	if (data === null || nodeId === null) {
		return <div className="p-4 text-sm">{error ?? "Loading…"}</div>;
	}

	const askInChat = async () => {
		const chat = (await api("/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: `About: ${data.node.name}`,
				graphContext: { propositions: [{ id: data.node.id, name: data.node.name, statement: data.node.statement }] },
			}),
		})) as { id: string };
		window.location.href = `/chat/${chat.id}?prompt=${encodeURIComponent(`Explain "${data.node.name}" to me and check what I understand.`)}`;
	};

	return (
		<NodePanelView
			data={data}
			depth={depth}
			canBack={historyCanBack(history)}
			canForward={historyCanForward(history)}
			generating={generating}
			error={error}
			onBack={() => setHistory(historyBack)}
			onForward={() => setHistory(historyForward)}
			onClose={onClose}
			onNavigate={(id) => setHistory((h) => historyOpen(h, id))}
			onDepth={setDepth}
			onAction={(action: NodeAction) =>
				void guarded(() => (action === "askInChat" ? askInChat() : post(nodeId, "actions", { action })))
			}
			onGenerate={() =>
				void guarded(async () => {
					setGenerating(true);
					try {
						await post(nodeId, "explanation", { action: "generate" });
					} finally {
						setGenerating(false);
					}
				})
			}
			onSaveEdit={(body) => void guarded(() => post(nodeId, "explanation", { action: "save", body }))}
			onDecide={(decision) =>
				void guarded(() => post(nodeId, "explanation", { action: decision === "approved" ? "approve" : "reject" }))
			}
			renderBody={(markdown) => <MessageResponse>{markdown}</MessageResponse>}
		/>
	);
}
```

- [ ] **Step 2: Write the host**

```tsx
// components/ext/node-panel-host.tsx
"use client";

import { useEffect, useState } from "react";
import { NodePanel, type PanelRequest } from "./node-panel";
import { OPEN_NODE_EVENT } from "./open-node";

/** Width reserved on the right; the page content keeps working beside it (REQ-node-11). */
const PANEL_WIDTH_PX = 416;

export function NodePanelHost() {
	const [request, setRequest] = useState<PanelRequest | null>(null);
	const open = request !== null;

	useEffect(() => {
		const onOpen = (event: Event) => {
			const nodeId = (event as CustomEvent<{ nodeId?: unknown }>).detail?.nodeId;
			if (typeof nodeId === "string" && nodeId !== "") {
				setRequest((prev) => ({ nodeId, seq: (prev?.seq ?? 0) + 1 }));
			}
		};
		window.addEventListener(OPEN_NODE_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_NODE_EVENT, onOpen);
	}, []);

	// Make room instead of covering the current view.
	useEffect(() => {
		if (!open) return;
		const before = document.body.style.paddingRight;
		document.body.style.paddingRight = `${PANEL_WIDTH_PX}px`;
		return () => {
			document.body.style.paddingRight = before;
		};
	}, [open]);

	if (request === null) return null;
	return (
		<aside
			data-testid="node-panel"
			className="lh-no-drag fixed right-0 top-0 z-30 h-dvh overflow-y-auto border-l bg-background"
			style={{ width: PANEL_WIDTH_PX }}
		>
			<NodePanel request={request} onClose={() => setRequest(null)} />
		</aside>
	);
}
```

- [ ] **Step 3: Mount the host in the root layout (touchpoint)**

Edit `app/layout.tsx`: add the import after the `UpdateBanner` import,

```tsx
import { NodePanelHost } from "@/components/ext/node-panel-host";
```

and add the element right after `<UpdateBanner />`:

```tsx
			<UpdateBanner />
			{/* Node panel (extension layer): opens beside the current view on "lh:open-node". */}
			<NodePanelHost />
```

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck 2>&1 | tail -8
npm run lint 2>&1 | tail -8
```

Expected: clean. (`components/**` imports only `@/src/core` from `src`, and `@/components/...` for UI parts, which the import law allows.)

- [ ] **Step 5: Commit**

```bash
git add components/ext/node-panel.tsx components/ext/node-panel-host.tsx app/layout.tsx
git commit -m "feat(ext): add node panel container, host and layout mount" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Entry points in the graph view and the chat card (REQ-node-10)

**Files:**
- Modify: `components/graph-view.tsx` (import plus one button in the detail card)
- Modify: `components/graph-context-card.tsx` (import plus the proposition name becomes a button)

The lecture view and review open the panel the same way (`openNodePanel(id)`); their plans add their own call sites.

- [ ] **Step 1: Find the exact anchors**

```bash
grep -n "selected.node.statement" components/graph-view.tsx
grep -n "^import" components/graph-view.tsx | tail -3
grep -n "graph-context-prop" components/graph-context-card.tsx
```

Expected: the statement line (about line 1625), the last import line, and the proposition `div` line.

- [ ] **Step 2: Edit the graph view detail card**

Add after the last import in `components/graph-view.tsx`:

```tsx
import { openNodePanel } from "@/components/ext/open-node";
```

Directly after the line `<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>` insert:

```tsx
					<button
						type="button"
						data-testid="open-node-panel"
						className="mt-2 text-xs underline"
						onClick={() => openNodePanel(selected.node.id)}
					>
						Open node panel
					</button>
```

- [ ] **Step 3: Edit the chat graph-context card**

In `components/graph-context-card.tsx` add after the existing imports:

```tsx
import { openNodePanel } from "@/components/ext/open-node";
```

and replace the name span inside each proposition row,

```tsx
							<span className="font-medium text-foreground/80">{p.name}</span>
```

with

```tsx
							<button
								type="button"
								data-testid={`graph-context-open-${p.id}`}
								className="cursor-pointer font-medium text-foreground/80 underline decoration-dotted"
								onClick={() => openNodePanel(p.id)}
							>
								{p.name}
							</button>
```

- [ ] **Step 4: Run the existing tests that touch these components, then typecheck and lint**

```bash
grep -ln "graph-context\|graph-view\|GraphContextCard" tests/*.ts tests/*.tsx
NODE_ENV=test npx tsx --test tests/graph-context.test.ts
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: the existing suites listed by `grep` pass (`fail 0`); add any other listed file to the `--test` command and run it too. Typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add components/graph-view.tsx components/graph-context-card.tsx
git commit -m "feat(ext): open the node panel from the graph view and the chat context card" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Contracts and touchpoints docs (REQ-node-17, REQ-port-01, REQ-int-04)

**Files:**
- Modify: `docs/ext/CONTRACTS.md` (append)
- Modify: `docs/ext/TOUCHPOINTS.md`

- [ ] **Step 1: Append the language-neutral contracts**

Append to `docs/ext/CONTRACTS.md`:

````markdown

## `explanations.jsonl`

Event `version`: `{type:"version", nodeId, version, body, author, sourceRefs, styleVersion, fingerprint, noSource, proposed, at}`
- `nodeId`: non-empty string. `version`: integer >= 1, unique per node (the first line for a pair wins).
- `body`: non-blank Markdown with math in `$...$` and inline node links `[[<node id>]]`.
- `author`: `agent` | `user`. `sourceRefs`: array of snapshot hashes (may be empty). `styleVersion`: string
  (first 12 hex digits of the SHA-256 of the style guide text for the agent, `"user"` for user text).
- `fingerprint`: string, the concluding-chains fingerprint at write time (may be empty). `noSource`: boolean,
  true when generated without source text ("no source context"). `proposed`: boolean; true only when `author` is `agent`.
- `at`: ISO-8601 timestamp.

Event `decision`: `{type:"decision", nodeId, version, decision, at}` with `decision` in `approved` | `rejected`.
It binds only a version whose `proposed` is true; any other decision is ignored.

Derivation (`deriveExplanations`), per node:
- accepted version: `proposed` is false, or an `approved` decision exists for it;
- current explanation: the accepted version with the highest number, else none;
- pending proposal: the highest-numbered `proposed` version with no decision whose number is greater than the current's, else none;
- `latestVersion`: the highest version number written, proposals and rejected ones included (next version = latest + 1).

Writing rules: an agent text over a current version whose `author` is `user` is written with `proposed = true`;
in every other case `proposed = false`. The agent never writes a `decision`. A user edit is a `version` with `author = "user"`,
`proposed = false`, `styleVersion = "user"`, `sourceRefs = []`, `noSource = false` and the current fingerprint.
An explanation never changes a node's trust level; no explanation event carries trust data.

## Concluding-chains fingerprint and staleness

`concludingFingerprint(nodeId, chains)`: for every chain whose `conclusion` is `nodeId`, take its distinct premise ids, sort them
in code-unit order and join with `,`; de-duplicate these strings, sort them in code-unit order and join with `|`.
A node that no chain concludes yields the empty string. Chain ids are not used (the merger rewrites them).
An explanation is **stale** when its stored `fingerprint` differs from the current value. A stale explanation stays readable and is
regenerated at the next opening: as a plain new version when the current is agent-authored, as a proposal when it is user-authored.
Generation is skipped when a pending proposal already carries the current fingerprint.

## Complexity and form

`premiseDepth(n)`: 0 if no chain concludes `n`; otherwise 1 plus the maximum of `premiseDepth(p)` over all premises `p` of all chains
concluding `n`; a premise already on the current path is skipped (cycle cut).
A node is **complex** when some chain concluding it has at least 3 distinct premises, or `premiseDepth(n) >= 3`.
Complex nodes get the `long` form, all others the `short` form.

## Deterministic checks

`checkExplanation(body, validIds, maxSentenceWords = 25)` returns `errors` and `warnings`.
- Errors (the text is refused): empty or blank body; a link `[[id]]` (id: one or more characters other than `[`, `]` and whitespace)
  whose id is not an existing node; a placeholder (`TODO`, `TBD`, `FIXME`, `XXX` as whole upper-case words; `lorem ipsum`, `[...]`,
  `[insert ...]`, `<placeholder>` case-insensitively).
- Warnings (never refuse): a sentence longer than `maxSentenceWords` words. Sentences are the prose with fenced code, `$$...$$` and
  `$...$` formulas (counted as one word), headings and list markers removed, and each link counted as one word, split after `.`, `!`, `?`
  followed by whitespace and at line breaks.
- A refused agent text is regenerated with the problems as feedback, at most 2 times (3 attempts); then it is dropped and nothing is written.

## Back-links and batching

- Back-links are never stored. `mentionedBy(n)` = ids of the nodes, other than `n`, whose current explanation body links to `n`, sorted.
  Citing lectures come from lecture records, never from this ledger.
- Batching (`planBatches`): sort the requested ids; breadth-first over the undirected premise-conclusion adjacency among them, each
  component starting at its smallest id and neighbours visited in sorted order; cut the visiting order into batches of 6.

## Neighbourhood

`neighbourhood(centre, chains, depth)` with depth 1 or 2: the nodes within `depth` steps over the undirected premise-conclusion
adjacency (centre depth 0), sorted by depth then id, and the distinct `premise -> conclusion` edges whose endpoints are both included.
Derived on every call, never stored.
````

- [ ] **Step 2: Update the touchpoints list**

In `docs/ext/TOUCHPOINTS.md`, extend the check command so new files under `app/api/ext/` and `components/ext/` are not reported, add the rows, and remove the items from "Planned" that this plan used.

Replace the check command with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!components/ext/**'
```

Add these rows to the table:

```markdown
| `src/core/index.ts` | one line: `export * from "./ext/index.ts"` (browser-safe ext barrel) | Node knowledge |
| `src/server/index.ts` | one line: `export * from "./ext/index.ts"` (ext server barrel for routes) | Node knowledge |
| `app/layout.tsx` | mounts `<NodePanelHost />` | Node knowledge |
| `components/graph-view.tsx` | "Open node panel" button in the node detail card | Node knowledge |
| `components/graph-context-card.tsx` | proposition name opens the node panel | Node knowledge |
```

In the "Planned (not yet touched)" paragraph, delete the mention of `src/server/index.ts and src/core/index.ts (barrel exports when routes and UI arrive)`.

- [ ] **Step 3: Check the touchpoint rule holds**

```bash
git fetch upstream --quiet 2>/dev/null; git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!components/ext/**'
```

Expected: only these files are listed (plus `package.json` from the Foundation and any rows other children added): `src/core/index.ts`, `src/server/index.ts`, `app/layout.tsx`, `components/graph-view.tsx`, `components/graph-context-card.tsx`. Any other file means an unlisted upstream edit: revert it.

- [ ] **Step 4: Commit**

```bash
git add docs/ext/CONTRACTS.md docs/ext/TOUCHPOINTS.md
git commit -m "docs(ext): add node knowledge contracts and touchpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Final verification, sanity mutations and manual smoke test

**Files:** none created (temporary mutations are reverted).

- [ ] **Step 1: Full test suite, typecheck and lint against the Task 1 baseline**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm test 2>&1 | tail -12
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: the only failing tests are the two upstream `claude-code` tests that assume the `claude` CLI is absent (recorded in the umbrella spec); everything else passes; typecheck and lint clean or equal to the Task 1 baseline.

- [ ] **Step 2: Hand mutation check (mutation-testing practice, baseline profile)**

For each mutation: apply, run the named test file, confirm at least one failure, then revert with `git checkout -- <file>`.

```bash
# 1. complexity threshold off by one
sed -i '' 's/new Set(chain.premises).size >= COMPLEX_MIN_PREMISES/new Set(chain.premises).size > COMPLEX_MIN_PREMISES/' src/core/ext/explanation-rules.ts
NODE_ENV=test npx tsx --test tests/ext-explanation-rules.test.ts 2>&1 | grep -E "^# (pass|fail)|fail "; git checkout -- src/core/ext/explanation-rules.ts

# 2. a rejected proposal treated as accepted
sed -i '' 's/s.decision === "approved") current = s.version/s.decision !== "rejected") current = s.version/' src/core/ext/explanations.ts
NODE_ENV=test npx tsx --test tests/ext-explanations.test.ts 2>&1 | grep -E "^# (pass|fail)|fail "; git checkout -- src/core/ext/explanations.ts

# 3. agent text overwrites a user version instead of proposing
sed -i '' 's/entry?.current?.author === "user"/entry?.current?.author === "agent"/' src/core/ext/explanation-service.ts
NODE_ENV=test npx tsx --test tests/ext-explanation-service.test.ts 2>&1 | grep -E "^# (pass|fail)|fail "; git checkout -- src/core/ext/explanation-service.ts

# 4. unresolved links accepted
sed -i '' 's/if (!validIds.has(id)) errors.push/if (validIds.has(id)) errors.push/' src/core/ext/explanation-check.ts
NODE_ENV=test npx tsx --test tests/ext-explanation-check.test.ts 2>&1 | grep -E "^# (pass|fail)|fail "; git checkout -- src/core/ext/explanation-check.ts
```

Expected: each of the four runs reports at least one failing test. A mutation that no test catches means a missing test: add one before finishing. (If `sed` finds no match because the line was reformatted, edit the operator by hand.) Afterwards `git status --short` must be clean.

- [ ] **Step 3: Seed a scratch data directory**

```bash
export LH_DATA_DIR="$(mktemp -d)"
cat > "$LH_DATA_DIR/seed.ts" <<'EOF'
import { graphStore } from "src/store/graph.ts";
const at = "2026-11-04T10:00:00.000Z";
const node = (id: string, name: string, statement: string) => ({ id, name, statement, aliases: [], createdAt: at, provenance: [] });
graphStore.appendNode(node("n_seed_a", "Alpha", "Alpha holds."));
graphStore.appendNode(node("n_seed_b", "Beta", "Beta follows from alpha."));
graphStore.appendChain({ id: "arg_seed_1", premises: ["n_seed_a"], conclusion: "n_seed_b", provenance: [], createdAt: at });
EOF
npx tsx "$LH_DATA_DIR/seed.ts" && ls "$LH_DATA_DIR/graph"
```

Expected: `nodes.jsonl` and `chains.jsonl` listed. (If `appendNode` has a different required shape, copy the shape from `tests/helpers/memory-graph-store.ts`'s fixtures.)

- [ ] **Step 4: Start the app and check the API**

```bash
npm run dev > "$LH_DATA_DIR/dev.log" 2>&1 &
sleep 8
curl -s localhost:3000/api/ext/nodes/n_seed_b/panel | head -c 600; echo
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/ext/nodes/n_nope/panel
curl -s -X POST localhost:3000/api/ext/nodes/n_seed_b/actions -H 'content-type: application/json' -d '{"action":"verifyNow"}'; echo
```

Expected: the first prints JSON with `"explanation":{"state":"missing","ceiling":false` and the statement; the second prints `404`; the third prints `{"error":"action verifyNow is not available yet"}`. If port 3000 is busy, use the port printed in `dev.log`.

- [ ] **Step 5: Manual panel check in the browser**

Open `http://localhost:3000`, open the graph view, click the node Beta, click "Open node panel". Check each item:

1. The panel appears on the right and the page content narrows (it is not covered); closing it restores the width.
2. With no model configured the panel shows the error "No model is configured for the strong slot" in red under the title, plus the statement, "Trust: unverified", "Argument" with Alpha as a link, and the mini-graph with Alpha and Beta.
3. Clicking Alpha in the argument or in the mini-graph re-centres the panel on Alpha; the back arrow returns to Beta; forward returns to Alpha.
4. "Depth 2" re-renders the mini-graph without error.
5. "Use as goal target" creates a goal: reload the panel and the Goals section shows "Beta (active, target)"; `$LH_DATA_DIR/ext/goals.jsonl` has one `created` line.
6. "Write my own", type `Beta because [[n_seed_a]].`, Save: the text appears with an "Alpha" link; typing `[[n_nope]]` and saving shows the refusal error.
7. "Verify now" and "Create card" are disabled (no handler yet).
8. In a chat started from a graph pick, the graph-context card shows the proposition name as a dotted button that opens the panel.
9. If the strong model slot IS configured (spends real money, one short call): opening a node with no text shows "Writing the explanation…", then a text marked "no source context" with node names as links. Opening the same node again makes no new model call (`$LH_DATA_DIR/ext/explanations.jsonl` still has one line for it).

If the inline links in the generated or saved text render as plain text instead of links (the markdown renderer stripped the `#node:` href), change `NODE_HREF_PREFIX` in `src/core/ext/explanation-check.ts` to a scheme the renderer keeps, re-run `tests/ext-explanation-check.test.ts` (it uses the constant), and repeat item 6.

- [ ] **Step 6: Stop the server and clean up**

```bash
kill %1 2>/dev/null; rm -rf "$LH_DATA_DIR"; unset LH_DATA_DIR
git status --short
```

Expected: no output from `git status` (nothing left uncommitted).

- [ ] **Step 7: Final commit if anything was adjusted (otherwise none needed)**

```bash
git add -A && git commit -m "chore(ext): finish node knowledge verification" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec coverage by REQ id

| REQ | Where |
|---|---|
| REQ-node-01 | Tasks 2, 6 (events, ledger via `createLedger`, current = latest accepted) |
| REQ-node-02 | Tasks 2 (proposed + decision derivation), 7 (agent proposes over user text, `saveUserExplanation`, `decideProposal`), 14 (edit, approve, reject UI), 11/13 (routes) |
| REQ-node-03 | Tasks 3 (fingerprint, `isStale`), 7 (regenerate stale; proposal for user text), 9 (state), 15 (auto-generate on opening) |
| REQ-node-04 | Tasks 5 (batching), 7 (one call per batch, chapter text in `source`), 11/12 (`generateNodeExplanations` entry). The call from the lecture pipeline itself belongs to child 4 (see Assumed interfaces). |
| REQ-node-05 | Tasks 7 (ceiling stops before any call), 9 (`ceiling` flag), 11 (first-opening `ensureExplanation`), 14 (panel text states why), 15 |
| REQ-node-06 | Tasks 3 (complexity), 9 (`form` in panel), 10 (long/short instructions), 7 (form sent to writer) |
| REQ-node-07 | Tasks 4 (deterministic checks), 10 (editable style guide in the source language, override file) |
| REQ-node-08 | Tasks 4 (link check), 7 (max 2 regenerations with feedback) |
| REQ-node-09 | Tasks 7 (`noSource`, only explanation events appended, read-only graph), 11 (source from evidence quotes), 14 ("no source context" label) |
| REQ-node-10 | Tasks 14, 15, 16 (one view component, one open helper; graph and chat entry points; lecture and review call `openNodePanel`) |
| REQ-node-11 | Task 15 (aside plus body padding, never replaces the view) |
| REQ-node-12 | Tasks 9, 14 (all sections; trust, lectures, cards, review come through `PanelSources`, see Assumed interfaces) |
| REQ-node-13 | Tasks 8, 9, 14, 15 (mini-graph depth 1 and 2, re-centre, back and forward) |
| REQ-node-14 | Tasks 11 (`runAction`, availability), 13, 14, 15 (`useAsGoalTarget` and `askInChat` built in; the five others need handlers from child 1 and 2, buttons disabled until then) |
| REQ-node-15 | Tasks 4, 9 (`mentionedBy` derived on every call; citing lectures from `PanelSources`) |
| REQ-node-16 | Tasks 6, 7, 12 (`CostGate` port, every writer call recorded, one shared gate) |
| REQ-node-17 | Task 17 (events, staleness, complexity, checks, batching, neighbourhood in `docs/ext/CONTRACTS.md`) |
| REQ-int-01 to 04, REQ-port-01 (inherited) | Ledger via `createLedger` and the ext stamp (6); graph read-only in the service (7, tested); import law checked by lint (every task); touchpoints listed (17); contracts (17) |

**Gaps and partial coverage (stated, not hidden):**
- REQ-node-04: the trigger inside the chapter run is in child 4's pipeline; this plan delivers the entry point, batching and chapter-text grounding.
- REQ-node-12, 14: trust and evidence, citing lectures, cards, review state, and the actions create card, pin, retire, start review, verify now depend on data and handlers of children 1, 2 and 4; the panel renders them from `PanelSources` and `nodeHandlers` in `src/server/ext/panel-providers.ts`, empty today.
- REQ-node-16 depends on the cost-gate file from the cost-ceiling plan (Task 12 prerequisite check).
- Profile practices: architectural-mapping tags (`@node`/`@endnode`) are not added, following the Foundation, which added none; add them in a single sweep over `src/**/ext/` if the user wants them. Mutation testing is done by hand (Task 18 step 2) because the repo has no mutation tool installed.

### 2. Placeholder scan

No "TBD", "TODO", "implement later" or "similar to Task N" as plan text. The words appear only inside the placeholder-detection tests and regexes (Task 4) and the contract text (Task 17), as data.

### 3. Type consistency

Names defined once and reused identically: `ExplanationEvent`, `ExplanationVersion`, `NodeExplanation`, `deriveExplanations` (Task 2); `concludingFingerprint`, `isStale(current: {fingerprint}, nodeId, chains)`, `premiseDepth`, `isComplex`, `explanationForm` (3); `checkExplanation`, `extractNodeLinks`, `mentionedBy`, `linkifyNodeLinks`, `NODE_HREF_PREFIX`, `MAX_SENTENCE_WORDS` (4); `planBatches`, `DEFAULT_BATCH_SIZE` (5); `ExplanationsStore`, `SourceContext`, `WriterNode`, `WriterRequest`, `WriterResult`, `ExplanationWriter`, `CostGate` (6); `generateExplanations`, `saveUserExplanation`, `decideProposal`, `ExplanationDeps`, `GenerateRequest`, `GenerateResult`, `MAX_REGENERATIONS` (7); `neighbourhood`, `radialPositions`, `EMPTY_HISTORY`, `historyOpen/Back/Forward/Current/CanBack/CanForward` (8); `NodeAction`, `NODE_ACTIONS`, `NodeRef`, `PanelSources`, `ExplanationView`, `NodePanelData`, `buildNodePanel`, `PanelInput` (9); `createExplanationWriter`, `loadStyleGuide`, `buildWriterPrompt`, `STRUCTURE_RULES` (10); `createNodeKnowledge`, `NodeKnowledgeError`, `NodeActionHandlers`, `NodeKnowledgeDeps` (11); `nodePanel`, `ensureNodeExplanation`, `generateNodeExplanations`, `saveNodeExplanation`, `decideNodeProposal`, `runNodeAction` (12, used by routes in 13); `NodePanelViewProps`, `openNodePanel`, `OPEN_NODE_EVENT` (14, used in 15 and 16). The factory method names (`panel`, `ensureExplanation`, `generateForNodes`, `saveExplanation`, `decide`, `runAction`) match between Tasks 11 and 12. The fake writer in the fixtures matches `ExplanationWriter`. `PanelTrustLevel`, `PanelEvidence` and the other `Panel*` types are prefixed to avoid collisions with the verification and personal-layer plans in the shared core barrel.
