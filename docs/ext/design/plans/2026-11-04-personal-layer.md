# Personal Layer and Spaced Repetition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the personal layer to the LearnHarness fork: per-node FSRS state derived from review events, three review channels (fixed cards, dialogic review, exercises) feeding it, a time-budgeted daily plan, and goal completion decided by exercises.

**Architecture:** Pure logic in `src/core/ext/` (events, the single `ts-fsrs` wrapper, state replay, deck, daily plan, write and read services) over two new Foundation ledgers (`review.jsonl`, `cards.jsonl`). A `review` session kind runs a small agent (`src/agent/ext/`) whose tools present the plan head, record the learner-confirmed rating and draft cards; questions go through upstream's own `ask_user_question`, so the existing chat is the whole surface. A server factory (`src/server/ext/personal-layer.ts`) composes it behind thin routes under `app/api/ext/`. Upstream edits are a short, listed set (see "Upstream touchpoints").

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node 26, `node:test` via `tsx`, `ts-fsrs` 5.4.2 (new dependency), Next.js route handlers, `@earendil-works/pi-agent-core` (existing).

**Spec:** `docs/superpowers/specs/2026-11-04-personal-layer-spaced-repetition-design.md` (REQ-pl-01 to REQ-pl-17; parent REQ-goal-02, REQ-review-01 to 09, REQ-port-01). Umbrella: `2026-11-04-learning-platform-integration-design.md`.

**Working directory for every command:** `<repo>` (the fork, branch `ext`). Never run `git commit` outside the steps that say so.

**Command prefix for Node 26:** every test command below already starts with `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null`.

**Conventions:** tabs, double quotes, `import type` for types, `.ts` extensions in imports, `noUncheckedIndexedAccess` (use `!` on indexed reads in tests). Every commit message ends with a second `-m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`. Layer law (ESLint): `src/core` never imports `agent`/`server`/`store`; `src/agent` never imports `server`/`store`; `app/` imports only the `@/src/core` and `@/src/server` barrels.

---

## Decisions made in this plan (flag to change)

These resolve the spec's "Open items for the plan" and fill gaps. Each is small and reversible.

1. **`ts-fsrs` pinned to 5.4.2**, not the newer 6.0.0. Verified against the real packages: 6.0.0 deprecates the `fsrs()` class API in favour of `DefaultScheduler` and defaults to FSRS-7 (extra `stabilityFast` memory state), which would complicate the implicit-repetition formula. 5.4.2 is FSRS-6 with a plain `Card` (`stability`, `difficulty`, `due`, `last_review`). Only `src/core/ext/fsrs.ts` imports the library, so a later upgrade touches one file. Config: no fuzz and no learning steps (whole-day scheduling, deterministic, countable daily load).
2. **Goal priority** is the Foundation's integer 1 to 5 (higher = more important); a pinned node outside any goal gets the default 3.
3. **Rating scale** 1 Again, 2 Hard, 3 Good, 4 Easy. "Successful" review = rating >= 2; "failed" = rating 1 (FSRS treats Hard as recalled).
4. **Implicit repetition:** a successful dialogic review credits every premise that already has a state and is NOT flagged weak (a premise the dialogue found weak is not credited); a failed one penalises (a real Again) only the premises flagged weak. Premises are the union over the CURRENT chains concluding the node. A premise with no state is left alone.
5. **Daily budget** is time-based and shrinks as you review: `remaining = budget - time already spent today`, so the new-card quota does not refill as the due list empties. At the start of a day this equals the spec's formula. `capacity = floor(remaining / mean cost of the due items)` (cost = observed channel median, else 20 s fixed / 180 s dialogic). The spec's "zero when due > 1.5 x capacity" is already implied by `max(0, capacity - due)`; it is implemented as written anyway and documented as redundant.
6. **Derivable** is the literal rule: some chain concluding the node has every premise at recall >= 0.85 by the premises' OWN state (no recursion). Pinned nodes are never derivable.
7. **Fixed fallback without a card:** a node assigned to the fixed channel with no active card is not planned and is listed in the plan's `needsCard`; it is never silently dropped and never turned into a dialogic review.
8. **Per-goal retention** is stored as a `retention` event in `review.jsonl` (not in `goals.jsonl`), so the Foundation's goal parser is untouched. Range 0.7 to 0.97, default 0.9. State replay uses the CURRENT retention of the node's highest-priority goal (any status), so changing it re-derives due dates.
9. **Exercise interface** (child spec 4, written in parallel): `applyExerciseResult({goalId, results: [{nodeId, outcome: "passed"|"weak"|"failed"}]})` in `src/core/ext/review-service.ts`. `passed` becomes an `exercise` review with rating 3; `weak` and `failed` become rating 1 (due again). The goal becomes `reached` only if every result passed AND the set covers every target node. This is the only code that writes `reached`. "Most of the scope is solid" is `goalReadiness`: >= 80% of the scope at recall >= 0.85, shown in `GET /api/ext/review/plan`.
10. **No `mode` field** in review events (the parent spec listed `fact | argument`): the `channel` replaces it (fixed = fact, dialogic = argument).
11. **Cards are managed over HTTP** (`/api/ext/cards`) and by the node panel: the user writes cards and approves agent drafts there. The review agent can only `propose_card` (draft); it cannot activate one.
12. **The review session reuses the practice agent's construction** with its own tools and prompt (`AgentBuildOptions.instructions`, one optional field), so upstream's prompt-segment machinery is untouched. The chat renders a `review` session with the teaching layout (`app/chat/[id]/page.tsx` maps it); any visual treatment belongs to the UI redesign session.

## Assumed interfaces (siblings written in parallel)

- **Trust level** (source-verification plan, `src/core/ext/trust.ts`): `"unverified" | "sourced" | "contested" | "refuted"`. This plan declares the same union as `TrustLevel` in `review-queries.ts` and reads trust only through `trustOfNode(nodeId)` in `src/server/ext/personal-trust.ts`, which returns `"unverified"` until Task 15 wires the real service.
- **Node panel** (node-knowledge plan, `src/server/ext/panel-providers.ts`): `panelSources.cards`, `panelSources.review` and `nodeHandlers.pin | retire | startReview` are filled from `src/server/ext/personal-panel.ts` in Task 15. Shapes: `PanelCard = {cardId, question, status}`, `PanelReview = {dueAt, reps, pinned, retired}`.
- **Exercise sets** (lecture/exercises plan): calls `applyExerciseResult` (decision 9).
- **CostGate** (source-verification / research plans): not used here. REQ-cost-01 covers verification and research only; reviewing is deliberately unaffected by the ceiling.

## Upstream touchpoints added by this plan (added to `docs/ext/TOUCHPOINTS.md` in Task 14)

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `ts-fsrs` 5.4.2 |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"review"` |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"review"` |
| `src/store/chats.ts` | `createChat` stamps kind `"review"` |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.instructions?` (replaces the composed prompt) |
| `src/server/chat-handler.ts` | `isPracticeLike` helper (review sessions write no graph and compact like practice), the review agent branch, two imports |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for a `review` session |
| `src/server/index.ts` | one barrel line `export * from "./ext/index.ts";` (shared with sibling plans; skip if already present) |

## File structure

| File | Responsibility |
|---|---|
| `src/core/ext/fsrs.ts` | The only `ts-fsrs` import: new card, review, recall probability, implicit credit |
| `src/core/ext/review.ts` | `review.jsonl` event types, parser, rating/retention validators |
| `src/core/ext/cards.ts` | `cards.jsonl` event types, parser, `deriveCards`, `pickVariant` |
| `src/core/ext/review-state.ts` | `deriveMarks`, `deriveNodeStates` (pure replay) |
| `src/core/ext/deck.ts` | `claimNodes`, `isDerivable`, `premisesOf`, `computeDeck`, `goalReadiness` |
| `src/core/ext/daily-plan.ts` | `computeReviewStats`, `dailyPlan` |
| `src/core/ext/review-service.ts` | `snapshot` and every write: `recordReview`, cards, marks, retention, `applyExerciseResult` |
| `src/core/ext/review-queries.ts` | `computePlan`, `nextItem`, `goalReadinessReport`, `nodeReviewView` |
| `src/core/ext/ports.ts` | (modify) `ReviewStore`, `CardsStore` |
| `src/store/ext/paths.ts`, `review-store.ts`, `cards-store.ts` | (modify / create) file paths and ledger adapters |
| `src/agent/ext/review-tools.ts`, `review-instructions.ts`, `review-agent.ts` | The review session's tools, prompt, agent |
| `src/server/ext/personal-layer.ts`, `personal-trust.ts`, `personal-panel.ts`, `index.ts` | Server surface for routes, chat handler, node panel |
| `app/api/ext/review/{plan,session,marks}/route.ts`, `app/api/ext/cards/route.ts`, `app/api/ext/cards/[id]/route.ts` | Thin transport |
| `tests/ext-*.test.ts`, `tests/helpers/ext-memory-stores.ts` | One test file per module |

---

### Task 1: Environment check and the `ts-fsrs` dependency (first)

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Confirm branch, Node, Foundation and a clean tree**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
git branch --show-current
node --version
git status --short
ls src/core/ext src/store/ext src/server/ext tests/helpers docs/ext
```

Expected: `ext`; `v26.x`; no modified tracked files (untracked files of sibling plans are fine); the listings show `goal-service.ts goals.ts ports.ts`, `format.ts goals-store.ts ledger.ts paths.ts`, `stores.ts`, `memory-graph-store.ts`, `CONTRACTS.md TOUCHPOINTS.md`. If the Foundation files are missing, stop: this plan builds on them.

- [ ] **Step 2: Baseline of tests, typecheck and lint**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/ext-*.test.ts 2>&1 | tail -8
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: `fail 0` for the ext tests; typecheck and lint print no errors. Anything that already fails here is not caused by this plan; write it down, Task 16 compares against it.

- [ ] **Step 3: Verify the library before depending on it**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm view ts-fsrs@5.4.2 version engines
```

Expected: `version = '5.4.2'` and `engines = { node: '>=20.0.0' }`.

- [ ] **Step 4: Install it exactly**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm install --save-exact ts-fsrs@5.4.2
git diff --stat
```

Expected: only `package.json` and `package-lock.json` changed; `package.json` now has `"ts-fsrs": "5.4.2"` under `dependencies`.

- [ ] **Step 5: Smoke-check the API this plan uses**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
node --input-type=module -e '
import { fsrs, createEmptyCard, Rating } from "ts-fsrs";
const s = fsrs({ request_retention: 0.9, enable_fuzz: false, enable_short_term: false });
const now = new Date("2026-11-04T10:00:00Z");
const c = s.next(createEmptyCard(now), now, Rating.Good).card;
console.log(c.state, c.scheduled_days, c.stability, typeof s.forgetting_curve, typeof s.next_interval);
'
```

Expected: `2 3 2.3065 function function` (state Review, 3 days, stability 2.3065).

- [ ] **Step: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ts-fsrs 5.4.2" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 2: FSRS wrapper (REQ-pl-08, REQ-pl-09, REQ-pl-16)

**Files:**
- Create: `src/core/ext/fsrs.ts`
- Test: `tests/ext-fsrs.test.ts`

Contract: `reviewCard` is a real FSRS review (deterministic: no fuzz; no learning steps, so a first rating schedules whole days). `recallProbability` is 0 for a card never reviewed and uses FRACTIONAL elapsed days. `implicitCredit(card, at, retention, w)` sets `stability = old + w * (stabilityOfARealGoodReview - old)` and moves only stability, last review and due; difficulty and counters are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-fsrs.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { implicitCredit, newCard, recallProbability, reviewCard } from "../src/core/ext/fsrs.ts";

const T0 = "2026-11-04T10:00:00.000Z";
const DAY = 86_400_000;
const after = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

describe("fsrs wrapper", () => {
	it("a first Good review schedules whole days ahead (no learning steps)", () => {
		const card = reviewCard(newCard(T0), 3, T0, 0.9);
		assert.ok(card.stability > 0);
		assert.ok(card.scheduled_days >= 1);
		assert.equal(card.due.getTime(), Date.parse(T0) + card.scheduled_days * DAY);
	});

	it("is deterministic", () => {
		const a = reviewCard(reviewCard(newCard(T0), 3, T0, 0.9), 3, after(T0, 3), 0.9);
		const b = reviewCard(reviewCard(newCard(T0), 3, T0, 0.9), 3, after(T0, 3), 0.9);
		assert.deepEqual(a, b);
	});

	it("a higher desired retention schedules a nearer due date", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const lo = reviewCard(base, 3, after(T0, 3), 0.8);
		const hi = reviewCard(base, 3, after(T0, 3), 0.95);
		assert.ok(hi.scheduled_days < lo.scheduled_days);
	});

	it("recall probability is 0 for a card never reviewed, 1 at review time, and falls with time", () => {
		assert.equal(recallProbability(null, T0), 0);
		assert.equal(recallProbability(newCard(T0), T0), 0);
		const card = reviewCard(newCard(T0), 3, T0, 0.9);
		assert.equal(recallProbability(card, T0), 1);
		const later = recallProbability(card, after(T0, 5));
		assert.ok(later < 1 && later > 0);
		assert.ok(recallProbability(card, after(T0, 20)) < later);
	});

	it("implicit credit moves stability by w times the gap to a real Good review", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const at = after(T0, 3);
		const real = reviewCard(base, 3, at, 0.9).stability;
		const half = implicitCredit(base, at, 0.9, 0.5);
		const full = implicitCredit(base, at, 0.9, 1);
		assert.ok(Math.abs(half.stability - (base.stability + 0.5 * (real - base.stability))) < 1e-9);
		assert.ok(Math.abs(full.stability - real) < 1e-9);
		assert.equal(implicitCredit(base, at, 0.9, 0).stability, base.stability);
	});

	it("implicit credit leaves difficulty and counters alone, and restarts the clock", () => {
		const base = reviewCard(newCard(T0), 3, T0, 0.9);
		const at = after(T0, 3);
		const c = implicitCredit(base, at, 0.9, 0.5);
		assert.equal(c.difficulty, base.difficulty);
		assert.equal(c.reps, base.reps);
		assert.equal(c.lapses, base.lapses);
		assert.equal(c.last_review?.toISOString(), at);
		assert.ok(c.due.getTime() > Date.parse(at));
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-fsrs.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/fsrs.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/fsrs.ts
/**
 * The ONLY module that imports `ts-fsrs` (pinned 5.4.x: FSRS-6, plain Card
 * shape). Everything else in the extension talks to these four functions,
 * so a library change touches one file. Scheduling is deterministic: no
 * fuzz, and no minute-level learning steps (a first rating schedules whole
 * days, which keeps the daily load countable).
 */

import { createEmptyCard, fsrs, Rating, State, type Card, type FSRS, type Grade } from "ts-fsrs";

export type FsrsCard = Card;
export type RatingValue = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export const DEFAULT_RETENTION = 0.9;
const DAY_MS = 86_400_000;

const schedulers = new Map<number, FSRS>();
function schedulerFor(retention: number): FSRS {
	let s = schedulers.get(retention);
	if (s === undefined) {
		s = fsrs({ request_retention: retention, enable_fuzz: false, enable_short_term: false });
		schedulers.set(retention, s);
	}
	return s;
}

export function newCard(at: string): FsrsCard {
	return createEmptyCard(new Date(at));
}

/** One real FSRS review of `card` at `at` with `rating`. */
export function reviewCard(card: FsrsCard, rating: RatingValue, at: string, retention: number): FsrsCard {
	return schedulerFor(retention).next(card, new Date(at), rating as Grade).card;
}

/** Probability of recall at `now`, using FRACTIONAL elapsed days. 0 for a card never reviewed. */
export function recallProbability(card: FsrsCard | null, now: string): number {
	if (card === null || card.state === State.New || card.last_review === undefined) return 0;
	const elapsedDays = Math.max(0, (Date.parse(now) - card.last_review.getTime()) / DAY_MS);
	return schedulerFor(DEFAULT_RETENTION).forgetting_curve(elapsedDays, card.stability);
}

/**
 * Implicit repetition (REQ-pl-09): `newStability = old + weight * (computed - old)`
 * where `computed` is the stability a real "Good" review at `at` would give.
 * Only stability, last review and due move; difficulty and counters do not.
 */
export function implicitCredit(card: FsrsCard, at: string, retention: number, weight: number): FsrsCard {
	const s = schedulerFor(retention);
	const computed = s.next(card, new Date(at), Rating.Good).card.stability;
	const stability = card.stability + weight * (computed - card.stability);
	const interval = s.next_interval(stability, 0);
	return {
		...card,
		stability,
		last_review: new Date(at),
		elapsed_days: 0,
		scheduled_days: interval,
		due: new Date(Date.parse(at) + interval * DAY_MS),
	};
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-fsrs.test.ts`
Expected: PASS, `pass 6`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/fsrs.ts tests/ext-fsrs.test.ts
git commit -m "feat(ext): add FSRS wrapper with implicit credit" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 3: Review and card events (REQ-pl-01, REQ-pl-03, REQ-pl-04, REQ-pl-15)

**Files:**
- Create: `src/core/ext/review.ts`, `src/core/ext/cards.ts`
- Test: `tests/ext-review-events.test.ts`

Contract: `parseReviewEvent` accepts six event types (`review`, `implicit`, `pin`, `retire`, `channel`, `retention`); a `review` has a channel of `fixed | dialogic | exercise`, a rating 1 to 4 and a non-negative duration; only a `dialogic` review may carry `weakPremises` (REQ-pl-15). `parseCardEvent` rejects an agent-authored `created` that is not `draft` (REQ-pl-03). `deriveCards` replays in file order (first `created` wins, `status` for an unknown card is ignored). `pickVariant` returns the n-th active variant modulo the count (REQ-pl-01).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-review-events.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveCards, parseCardEvent, pickVariant, type CardEvent } from "../src/core/ext/cards.ts";
import { parseReviewEvent } from "../src/core/ext/review.ts";

const AT = "2026-11-04T10:00:00.000Z";

describe("parseReviewEvent", () => {
	const base = { type: "review", nodeId: "n_1", channel: "fixed", rating: 3, durationSec: 12, at: AT };

	it("accepts a valid review of each channel", () => {
		for (const channel of ["fixed", "dialogic", "exercise"]) {
			assert.ok(parseReviewEvent({ ...base, channel }));
		}
	});

	it("rejects bad rating, channel, duration, time", () => {
		assert.equal(parseReviewEvent({ ...base, rating: 5 }), null);
		assert.equal(parseReviewEvent({ ...base, rating: 0 }), null);
		assert.equal(parseReviewEvent({ ...base, channel: "magic" }), null);
		assert.equal(parseReviewEvent({ ...base, durationSec: -1 }), null);
		assert.equal(parseReviewEvent({ ...base, durationSec: Number.NaN }), null);
		assert.equal(parseReviewEvent({ ...base, at: "yesterday" }), null);
		assert.equal(parseReviewEvent({ ...base, nodeId: "" }), null);
	});

	it("only a dialogic review may carry weak premises (REQ-pl-15)", () => {
		assert.ok(parseReviewEvent({ ...base, channel: "dialogic", weakPremises: ["n_2"] }));
		assert.equal(parseReviewEvent({ ...base, channel: "fixed", weakPremises: ["n_2"] }), null);
		assert.equal(parseReviewEvent({ ...base, channel: "dialogic", weakPremises: [""] }), null);
	});

	it("parses implicit, pin, retire, channel and retention events", () => {
		assert.ok(parseReviewEvent({ type: "implicit", nodeId: "n_2", viaNodeId: "n_1", outcome: "credit", at: AT }));
		assert.equal(parseReviewEvent({ type: "implicit", nodeId: "n_2", viaNodeId: "n_1", outcome: "meh", at: AT }), null);
		assert.ok(parseReviewEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT }));
		assert.ok(parseReviewEvent({ type: "retire", nodeId: "n_1", retired: false, at: AT }));
		assert.ok(parseReviewEvent({ type: "channel", nodeId: "n_1", channel: null, at: AT }));
		assert.equal(parseReviewEvent({ type: "channel", nodeId: "n_1", channel: "exercise", at: AT }), null);
		assert.ok(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.85, at: AT }));
		assert.equal(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.99, at: AT }), null);
		assert.equal(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.5, at: AT }), null);
		assert.equal(parseReviewEvent(null), null);
		assert.equal(parseReviewEvent({ type: "unknown", at: AT }), null);
	});
});

describe("cards", () => {
	const created = (over: Partial<CardEvent & { type: "created" }>): unknown => ({
		type: "created", cardId: "card_1", nodeId: "n_1", question: "Q?", answer: "A.", author: "user", status: "active", at: AT, ...over,
	});

	it("an agent card must be born a draft (REQ-pl-03)", () => {
		assert.ok(parseCardEvent(created({ author: "agent", status: "draft" })));
		assert.equal(parseCardEvent(created({ author: "agent", status: "active" })), null);
		assert.ok(parseCardEvent(created({ author: "user", status: "active" })));
		assert.equal(parseCardEvent(created({ question: "" })), null);
	});

	it("derives the latest status and ignores strays", () => {
		const events: CardEvent[] = [
			parseCardEvent(created({ author: "agent", status: "draft" }))!,
			{ type: "status", cardId: "card_1", status: "active", at: AT },
			{ type: "status", cardId: "ghost", status: "retired", at: AT },
			parseCardEvent(created({ cardId: "card_1", question: "dup" }))!,
		];
		const cards = deriveCards(events);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]?.status, "active");
		assert.equal(cards[0]?.question, "Q?");
	});

	it("variants of a node rotate; drafts and retired variants never show (REQ-pl-01)", () => {
		const mk = (cardId: string, status: "draft" | "active", author: "user" | "agent" = "user") =>
			parseCardEvent(created({ cardId, status, author }))!;
		const cards = deriveCards([
			mk("c1", "active"),
			mk("c2", "active"),
			parseCardEvent(created({ cardId: "c3", author: "agent", status: "draft" }))!,
			mk("c4", "active"),
			{ type: "status", cardId: "c4", status: "retired", at: AT },
		]);
		assert.deepEqual([0, 1, 2, 3].map((n) => pickVariant(cards, "n_1", n)?.id), ["c1", "c2", "c1", "c2"]);
		assert.equal(pickVariant(cards, "n_other", 0), undefined);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-events.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/cards.ts'`.

- [ ] **Step 3: Implement the review events**

```ts
// src/core/ext/review.ts
/**
 * review.jsonl events (spec REQ-pl-04, REQ-pl-15). One ledger, six event
 * types: real reviews, implicit reviews of premises, and the user's
 * manual marks. Pure: types, parser, constants.
 */

export type Channel = "fixed" | "dialogic" | "exercise";
export type ReviewRating = 1 | 2 | 3 | 4;

export type ReviewEvent =
	| {
			type: "review";
			nodeId: string;
			channel: Channel;
			rating: ReviewRating;
			durationSec: number;
			at: string;
			question?: string;
			answer?: string;
			weakPremises?: string[];
	  }
	| { type: "implicit"; nodeId: string; viaNodeId: string; outcome: "credit" | "penalty"; at: string }
	| { type: "pin"; nodeId: string; pinned: boolean; at: string }
	| { type: "retire"; nodeId: string; retired: boolean; at: string }
	| { type: "channel"; nodeId: string; channel: "fixed" | "dialogic" | null; at: string }
	| { type: "retention"; goalId: string; retention: number; at: string };

export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.97;

const CHANNELS = new Set<string>(["fixed", "dialogic", "exercise"]);

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

export function isValidRating(r: unknown): r is ReviewRating {
	return r === 1 || r === 2 || r === 3 || r === 4;
}

export function isValidRetention(r: unknown): r is number {
	return typeof r === "number" && Number.isFinite(r) && r >= MIN_RETENTION && r <= MAX_RETENTION;
}

export function parseReviewEvent(raw: unknown): ReviewEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	const at = r.at;
	switch (r.type) {
		case "review": {
			if (!str(r.nodeId) || typeof r.channel !== "string" || !CHANNELS.has(r.channel)) return null;
			if (!isValidRating(r.rating)) return null;
			if (typeof r.durationSec !== "number" || !Number.isFinite(r.durationSec) || r.durationSec < 0) return null;
			if (r.question !== undefined && typeof r.question !== "string") return null;
			if (r.answer !== undefined && typeof r.answer !== "string") return null;
			if (r.weakPremises !== undefined) {
				if (!Array.isArray(r.weakPremises) || !r.weakPremises.every(str)) return null;
				if (r.channel !== "dialogic") return null; // REQ-pl-15: only dialogic events carry weak premises
			}
			return {
				type: "review",
				nodeId: r.nodeId,
				channel: r.channel as Channel,
				rating: r.rating,
				durationSec: r.durationSec,
				at,
				...(r.question !== undefined ? { question: r.question as string } : {}),
				...(r.answer !== undefined ? { answer: r.answer as string } : {}),
				...(r.weakPremises !== undefined ? { weakPremises: [...(r.weakPremises as string[])] } : {}),
			};
		}
		case "implicit":
			if (!str(r.nodeId) || !str(r.viaNodeId)) return null;
			if (r.outcome !== "credit" && r.outcome !== "penalty") return null;
			return { type: "implicit", nodeId: r.nodeId, viaNodeId: r.viaNodeId, outcome: r.outcome, at };
		case "pin":
			if (!str(r.nodeId) || typeof r.pinned !== "boolean") return null;
			return { type: "pin", nodeId: r.nodeId, pinned: r.pinned, at };
		case "retire":
			if (!str(r.nodeId) || typeof r.retired !== "boolean") return null;
			return { type: "retire", nodeId: r.nodeId, retired: r.retired, at };
		case "channel":
			if (!str(r.nodeId)) return null;
			if (r.channel !== null && r.channel !== "fixed" && r.channel !== "dialogic") return null;
			return { type: "channel", nodeId: r.nodeId, channel: r.channel, at };
		case "retention":
			if (!str(r.goalId) || !isValidRetention(r.retention)) return null;
			return { type: "retention", goalId: r.goalId, retention: r.retention, at };
		default:
			return null;
	}
}
```

- [ ] **Step 4: Implement the cards**

```ts
// src/core/ext/cards.ts
/**
 * cards.jsonl (REQ-pl-01 to REQ-pl-03): content variants of a node. A card
 * carries NO schedule; all variants of a node rotate under the node's one
 * FSRS state. Agent-authored cards are born `draft` and only a `status`
 * event (the user's approval) makes them schedulable.
 */

export type CardAuthor = "user" | "agent";
export type CardStatus = "draft" | "active" | "retired";

export type CardEvent =
	| {
			type: "created";
			cardId: string;
			nodeId: string;
			question: string;
			answer: string;
			author: CardAuthor;
			status: "draft" | "active";
			at: string;
	  }
	| { type: "status"; cardId: string; status: CardStatus; at: string };

export interface ContentCard {
	id: string;
	nodeId: string;
	question: string;
	answer: string;
	author: CardAuthor;
	status: CardStatus;
	createdAt: string;
}

const STATUSES = new Set<string>(["draft", "active", "retired"]);

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

export function parseCardEvent(raw: unknown): CardEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!str(r.cardId) || !str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "status") {
		if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
		return { type: "status", cardId: r.cardId, status: r.status as CardStatus, at: r.at };
	}
	if (r.type === "created") {
		if (!str(r.nodeId) || !str(r.question) || !str(r.answer)) return null;
		if (r.author !== "user" && r.author !== "agent") return null;
		if (r.status !== "draft" && r.status !== "active") return null;
		if (r.author === "agent" && r.status !== "draft") return null; // REQ-pl-03
		return {
			type: "created",
			cardId: r.cardId,
			nodeId: r.nodeId,
			question: r.question,
			answer: r.answer,
			author: r.author,
			status: r.status,
			at: r.at,
		};
	}
	return null;
}

/** Replay in file order. A duplicate `created` and a `status` for an unknown card are ignored. */
export function deriveCards(events: readonly CardEvent[]): ContentCard[] {
	const cards = new Map<string, ContentCard>();
	for (const e of events) {
		if (e.type === "created") {
			if (cards.has(e.cardId)) continue;
			cards.set(e.cardId, {
				id: e.cardId,
				nodeId: e.nodeId,
				question: e.question,
				answer: e.answer,
				author: e.author,
				status: e.status,
				createdAt: e.at,
			});
		} else {
			const card = cards.get(e.cardId);
			if (card !== undefined) card.status = e.status;
		}
	}
	return [...cards.values()];
}

export function activeCardsOf(cards: readonly ContentCard[], nodeId: string): ContentCard[] {
	return cards.filter((c) => c.nodeId === nodeId && c.status === "active");
}

/** Variants rotate: the n-th fixed review of a node shows variant n mod count. Undefined when there is no active card. */
export function pickVariant(cards: readonly ContentCard[], nodeId: string, fixedReviews: number): ContentCard | undefined {
	const active = activeCardsOf(cards, nodeId);
	return active.length === 0 ? undefined : active[fixedReviews % active.length];
}
```

- [ ] **Step 5: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-events.test.ts`
Expected: PASS, `pass 7`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/review.ts src/core/ext/cards.ts tests/ext-review-events.test.ts
git commit -m "feat(ext): add review and card event types" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 4: Ports, ledgers, paths and composition root (REQ-int-01 via the Foundation ledger)

**Files:**
- Modify: `src/core/ext/ports.ts`, `src/store/ext/paths.ts`, `src/server/ext/stores.ts`, `tests/ext-paths.test.ts`
- Create: `src/store/ext/review-store.ts`, `src/store/ext/cards-store.ts`
- Test: `tests/ext-review-stores.test.ts`

Contract: both adapters are `createLedger` over `review.jsonl` / `cards.jsonl`; they never write an event their parser rejects, skip corrupt lines on read, and inherit the Foundation's format stamp. Other plans edit these same three files; apply the additions below at the anchors and keep whatever else is there.

- [ ] **Step 1: Write the failing store test**

```ts
// tests/ext-review-stores.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveCards } from "../src/core/ext/cards.ts";
import { deriveMarks } from "../src/core/ext/review-state.ts";
import { createCardsStore } from "../src/store/ext/cards-store.ts";
import { extPathsFor } from "../src/store/ext/paths.ts";
import { createReviewStore } from "../src/store/ext/review-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const AT = "2026-11-04T10:00:00.000Z";

describe("review and cards stores", () => {
	it("paths place review.jsonl and cards.jsonl under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		assert.equal(p.review, path.join("/tmp/lh-data", "ext", "review.jsonl"));
		assert.equal(p.cards, path.join("/tmp/lh-data", "ext", "cards.jsonl"));
	});

	it("review events persist to review.jsonl and read back in order", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		store.appendEvent({ type: "review", nodeId: "n_1", channel: "fixed", rating: 3, durationSec: 9, at: AT });
		store.appendEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT });
		const events = createReviewStore(dir).readEvents();
		assert.equal(events.length, 2);
		assert.deepEqual([...deriveMarks(events).pinned], ["n_1"]);
		assert.equal(fs.readFileSync(path.join(dir, "review.jsonl"), "utf-8").trim().split("\n").length, 2);
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		assert.throws(() => store.appendEvent({ type: "review", nodeId: "n_1", channel: "fixed", rating: 9 as never, durationSec: 1, at: AT }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "review.jsonl")), false);
	});

	it("cards persist and an agent card cannot be written active", () => {
		const dir = tmp();
		const store = createCardsStore(dir);
		store.appendEvent({ type: "created", cardId: "card_1", nodeId: "n_1", question: "Q", answer: "A", author: "agent", status: "draft", at: AT });
		assert.throws(
			() => store.appendEvent({ type: "created", cardId: "card_2", nodeId: "n_1", question: "Q", answer: "A", author: "agent", status: "active", at: AT }),
			/rejected/,
		);
		assert.deepEqual(deriveCards(createCardsStore(dir).readEvents()).map((c) => c.id), ["card_1"]);
	});

	it("skips a corrupt line instead of failing", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		store.appendEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT });
		fs.appendFileSync(path.join(dir, "review.jsonl"), "{not json\n");
		store.appendEvent({ type: "pin", nodeId: "n_2", pinned: true, at: AT });
		assert.equal(createReviewStore(dir).readEvents().length, 2);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-stores.test.ts`
Expected: FAIL with `Cannot find module '../src/store/ext/review-store.ts'`.

- [ ] **Step 3: Add the ports**

In `src/core/ext/ports.ts`, add two imports below the existing import lines and append the two interfaces at the end of the file:

```ts
import type { CardEvent } from "./cards.ts";
import type { ReviewEvent } from "./review.ts";
```

```ts
export interface ReviewStore {
	/** Throws if the event is invalid. */
	appendEvent(event: ReviewEvent): void;
	/** Valid events in append order. */
	readEvents(): ReviewEvent[];
}

export interface CardsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: CardEvent): void;
	/** Valid events in append order. */
	readEvents(): CardEvent[];
}
```

- [ ] **Step 4: Add the paths**

In `src/store/ext/paths.ts`: after the line `	goals: string;` in `interface ExtPaths` add

```ts
	review: string;
	cards: string;
```

and after the line `		goals: path.join(dir, "goals.jsonl"),` in `extPathsFor` add

```ts
		review: path.join(dir, "review.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
```

In `tests/ext-paths.test.ts`, after the `p.goals` assertion add

```ts
		assert.equal(p.review, path.join("/tmp/lh-data", "ext", "review.jsonl"));
		assert.equal(p.cards, path.join("/tmp/lh-data", "ext", "cards.jsonl"));
```

- [ ] **Step 5: Write the adapters**

```ts
import type { ReviewStore } from "../../core/ext/ports.ts";
import { parseReviewEvent } from "../../core/ext/review.ts";
import { createLedger } from "./ledger.ts";

export function createReviewStore(dir: string): ReviewStore {
	const ledger = createLedger(dir, "review.jsonl", parseReviewEvent);
	return { appendEvent: (event) => ledger.append(event), readEvents: () => ledger.readAll() };
}
```

```ts
import { parseCardEvent } from "../../core/ext/cards.ts";
import type { CardsStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createCardsStore(dir: string): CardsStore {
	const ledger = createLedger(dir, "cards.jsonl", parseCardEvent);
	return { appendEvent: (event) => ledger.append(event), readEvents: () => ledger.readAll() };
}
```

- [ ] **Step 6: Add them to the composition root**

In `src/server/ext/stores.ts` add the imports

```ts
import { createCardsStore } from "../../store/ext/cards-store.ts";
import { createReviewStore } from "../../store/ext/review-store.ts";
```

and, inside the `extStores` object, after the `goalsStore` line:

```ts
	reviewStore: createReviewStore(EXT_PATHS.dir),
	cardsStore: createCardsStore(EXT_PATHS.dir),
```

- [ ] **Step 7: Run the tests and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-stores.test.ts tests/ext-paths.test.ts
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run typecheck 2>&1 | tail -5
```

Expected: PASS (`pass 6`); typecheck prints no errors.

- [ ] **Step: Commit**

```bash
git add src/core/ext/ports.ts src/store/ext src/server/ext/stores.ts tests/ext-review-stores.test.ts tests/ext-paths.test.ts
git commit -m "feat(ext): add review and cards ledgers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 5: Review state derivation (REQ-pl-04, REQ-pl-09, REQ-pl-16, umbrella REQ-review-01)

**Files:**
- Create: `src/core/ext/review-state.ts`
- Test: `tests/ext-review-state.test.ts`

Contract: `deriveNodeStates` replays `review.jsonl` in file order into ONE FSRS card per node, whatever the channel. Events for nodes `exists` rejects are ignored. An `implicit` credit applies `implicitCredit`; an `implicit` penalty is a real Again; an `implicit` event never creates a state. Same events and options give the same result. `deriveMarks` folds pin / retire / channel pin / per-goal retention, the latest event winning.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-review-state.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recallProbability } from "../src/core/ext/fsrs.ts";
import { deriveMarks, deriveNodeStates } from "../src/core/ext/review-state.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T10:00:00.000Z";
const at = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();
const opts = { retentionOf: () => 0.9, exists: () => true, implicitWeight: 0.5 };

const review = (nodeId: string, rating: 1 | 2 | 3 | 4, day: number, channel: "fixed" | "dialogic" | "exercise" = "fixed"): ReviewEvent => ({
	type: "review", nodeId, channel, rating, durationSec: 10, at: at(day),
});

describe("deriveNodeStates", () => {
	it("all channels update the node's single state (REQ-pl-04)", () => {
		const states = deriveNodeStates([review("n_1", 3, 0, "fixed"), review("n_1", 3, 3, "dialogic"), review("n_1", 3, 9, "exercise")], opts);
		assert.equal(states.size, 1);
		assert.equal(states.get("n_1")?.card.reps, 3);
		assert.equal(states.get("n_1")?.fixedReviews, 1);
	});

	it("ignores events for deleted nodes (umbrella REQ-review-01)", () => {
		const states = deriveNodeStates([review("n_gone", 3, 0), review("n_1", 3, 0)], { ...opts, exists: (id) => id === "n_1" });
		assert.deepEqual([...states.keys()], ["n_1"]);
	});

	it("is a pure replay: same events, same result (REQ-pl-16)", () => {
		const events = [review("n_1", 3, 0), review("n_1", 1, 4), review("n_2", 4, 1)];
		assert.deepEqual(deriveNodeStates(events, opts), deriveNodeStates(events, opts));
	});

	it("an implicit credit raises stability and an implicit event never creates a state", () => {
		const events: ReviewEvent[] = [
			review("n_1", 3, 0),
			{ type: "implicit", nodeId: "n_1", viaNodeId: "n_9", outcome: "credit", at: at(3) },
			{ type: "implicit", nodeId: "n_ghost", viaNodeId: "n_9", outcome: "credit", at: at(3) },
		];
		const without = deriveNodeStates(events.slice(0, 1), opts).get("n_1")!;
		const states = deriveNodeStates(events, opts);
		assert.ok(states.get("n_1")!.card.stability > without.card.stability);
		assert.equal(states.has("n_ghost"), false);
	});

	it("an implicit penalty acts as an Again", () => {
		const events: ReviewEvent[] = [
			review("n_1", 3, 0),
			{ type: "implicit", nodeId: "n_1", viaNodeId: "n_9", outcome: "penalty", at: at(3) },
		];
		const states = deriveNodeStates(events, opts);
		assert.equal(states.get("n_1")!.card.lapses, 1);
	});

	it("a failed review lowers later recall relative to a successful one", () => {
		const good = deriveNodeStates([review("n_1", 3, 0), review("n_1", 3, 3)], opts).get("n_1")!;
		const bad = deriveNodeStates([review("n_1", 3, 0), review("n_1", 1, 3)], opts).get("n_1")!;
		assert.ok(recallProbability(bad.card, at(10)) < recallProbability(good.card, at(10)));
	});
});

describe("deriveMarks", () => {
	it("the latest event wins for pin, retire, channel and goal retention", () => {
		const marks = deriveMarks([
			{ type: "pin", nodeId: "n_1", pinned: true, at: T0 },
			{ type: "pin", nodeId: "n_2", pinned: true, at: T0 },
			{ type: "pin", nodeId: "n_2", pinned: false, at: T0 },
			{ type: "retire", nodeId: "n_3", retired: true, at: T0 },
			{ type: "channel", nodeId: "n_1", channel: "dialogic", at: T0 },
			{ type: "channel", nodeId: "n_4", channel: "fixed", at: T0 },
			{ type: "channel", nodeId: "n_4", channel: null, at: T0 },
			{ type: "retention", goalId: "goal_a", retention: 0.8, at: T0 },
			{ type: "retention", goalId: "goal_a", retention: 0.85, at: T0 },
		]);
		assert.deepEqual([...marks.pinned], ["n_1"]);
		assert.deepEqual([...marks.retired], ["n_3"]);
		assert.deepEqual([...marks.channelPin], [["n_1", "dialogic"]]);
		assert.equal(marks.retention.get("goal_a"), 0.85);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-state.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/review-state.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/review-state.ts
/**
 * Review state is DERIVED, never stored (REQ-pl-04, REQ-pl-16): replay
 * review.jsonl in file order. `deriveMarks` folds the user's manual events;
 * `deriveNodeStates` folds the FSRS state per node. Both are pure and
 * deterministic for the same events and options.
 */

import { implicitCredit, newCard, reviewCard, type FsrsCard } from "./fsrs.ts";
import type { ReviewEvent } from "./review.ts";

export interface Marks {
	pinned: Set<string>;
	retired: Set<string>;
	/** Channel the user fixed for a node (absent = automatic assignment). */
	channelPin: Map<string, "fixed" | "dialogic">;
	/** Per-goal desired retention override (latest event wins). */
	retention: Map<string, number>;
}

export function deriveMarks(events: readonly ReviewEvent[]): Marks {
	const marks: Marks = { pinned: new Set(), retired: new Set(), channelPin: new Map(), retention: new Map() };
	for (const e of events) {
		if (e.type === "pin") {
			if (e.pinned) marks.pinned.add(e.nodeId);
			else marks.pinned.delete(e.nodeId);
		} else if (e.type === "retire") {
			if (e.retired) marks.retired.add(e.nodeId);
			else marks.retired.delete(e.nodeId);
		} else if (e.type === "channel") {
			if (e.channel === null) marks.channelPin.delete(e.nodeId);
			else marks.channelPin.set(e.nodeId, e.channel);
		} else if (e.type === "retention") {
			marks.retention.set(e.goalId, e.retention);
		}
	}
	return marks;
}

export interface NodeState {
	nodeId: string;
	card: FsrsCard;
	/** Number of real fixed-channel reviews (drives variant rotation). */
	fixedReviews: number;
}

export interface StateOptions {
	retentionOf(nodeId: string): number;
	/** Events for nodes this returns false for (deleted nodes) are ignored. */
	exists(nodeId: string): boolean;
	/** `w` of the implicit-repetition formula. */
	implicitWeight: number;
}

export const DEFAULT_IMPLICIT_WEIGHT = 0.5;

export function deriveNodeStates(events: readonly ReviewEvent[], opts: StateOptions): Map<string, NodeState> {
	const states = new Map<string, NodeState>();
	for (const e of events) {
		if (e.type === "review") {
			if (!opts.exists(e.nodeId)) continue;
			const prev = states.get(e.nodeId);
			const card = reviewCard(prev?.card ?? newCard(e.at), e.rating, e.at, opts.retentionOf(e.nodeId));
			states.set(e.nodeId, {
				nodeId: e.nodeId,
				card,
				fixedReviews: (prev?.fixedReviews ?? 0) + (e.channel === "fixed" ? 1 : 0),
			});
		} else if (e.type === "implicit") {
			if (!opts.exists(e.nodeId)) continue;
			const prev = states.get(e.nodeId);
			if (prev === undefined) continue; // an implicit event never creates a state
			const retention = opts.retentionOf(e.nodeId);
			const card =
				e.outcome === "credit"
					? implicitCredit(prev.card, e.at, retention, opts.implicitWeight)
					: reviewCard(prev.card, 1, e.at, retention);
			states.set(e.nodeId, { ...prev, card });
		}
	}
	return states;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-state.test.ts`
Expected: PASS, `pass 7`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/review-state.ts tests/ext-review-state.test.ts
git commit -m "feat(ext): derive per-node FSRS state from review events" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 6: Deck, derivability and per-goal retention (REQ-pl-08, REQ-pl-10, REQ-pl-13, umbrella REQ-review-02)

**Files:**
- Create: `src/core/ext/deck.ts`
- Test: `tests/ext-deck.test.ts`

Contract: `computeDeck` = scope of ACTIVE goals, minus retired, minus derivable, plus pinned, restricted to nodes that exist; paused goals contribute nothing. A node's priority and retention come from the highest-priority goal containing it (ties: earliest created). `isDerivable(node)` is true when some chain concluding it has every premise at recall >= 0.85 (a fact never is). `goalReadiness` is ready when at least 80% of the scope is at recall >= 0.85.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-deck.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimNodes, computeDeck, goalReadiness, isDerivable, premisesOf } from "../src/core/ext/deck.ts";
import type { Goal } from "../src/core/ext/goals.ts";
import type { Marks } from "../src/core/ext/review-state.ts";

const AT = "2026-11-04T10:00:00.000Z";
const goal = (id: string, targets: string[], over: Partial<Goal> = {}): Goal => ({
	id, title: id, origin: "user", originRef: "", targetNodeIds: targets, priority: 3, status: "active", createdAt: AT, updatedAt: AT, ...over,
});
const noMarks = (): Marks => ({ pinned: new Set(), retired: new Set(), channelPin: new Map(), retention: new Map() });
const chain = (premises: string[], conclusion: string) => ({ premises, conclusion });

describe("isDerivable (REQ-pl-10)", () => {
	const chains = [chain(["a", "b"], "c")];
	it("is true only when EVERY premise of some chain is at recall >= 0.85", () => {
		assert.equal(isDerivable("c", chains, () => 0.85), true);
		assert.equal(isDerivable("c", chains, (id) => (id === "a" ? 0.95 : 0.84)), false);
		assert.equal(isDerivable("c", chains, () => 0), false);
	});
	it("a fact (no chain) is never derivable", () => {
		assert.equal(isDerivable("a", chains, () => 1), false);
	});
	it("one solid alternative chain is enough", () => {
		const alt = [chain(["a", "b"], "c"), chain(["d"], "c")];
		assert.equal(isDerivable("c", alt, (id) => (id === "d" ? 0.9 : 0)), true);
	});
});

describe("computeDeck (umbrella REQ-review-02, REQ-pl-13)", () => {
	const chains = [chain(["a", "b"], "c")];
	const base = { chains, nodeIds: new Set(["a", "b", "c", "x"]), marks: noMarks(), recall: () => 0 };

	it("is the scope of active goals", () => {
		const deck = computeDeck({ ...base, goals: [goal("g1", ["c"])] });
		assert.deepEqual(deck.map((d) => d.nodeId), ["a", "b", "c"]);
		assert.equal(deck.find((d) => d.nodeId === "c")?.hasChain, true);
		assert.equal(deck.find((d) => d.nodeId === "a")?.hasChain, false);
	});

	it("excludes the nodes of a paused goal", () => {
		assert.deepEqual(computeDeck({ ...base, goals: [goal("g1", ["c"], { status: "paused" })] }), []);
	});

	it("drops a derivable node unless pinned, and drops retired unless pinned", () => {
		const solid = { ...base, goals: [goal("g1", ["c"])], recall: (id: string) => (id === "c" ? 0 : 0.9) };
		assert.deepEqual(computeDeck(solid).map((d) => d.nodeId), ["a", "b"]);
		const pinned = { ...solid, marks: { ...noMarks(), pinned: new Set(["c"]) } };
		assert.deepEqual(computeDeck(pinned).map((d) => d.nodeId), ["a", "b", "c"]);
		const retired = { ...base, goals: [goal("g1", ["c"])], marks: { ...noMarks(), retired: new Set(["a"]) } };
		assert.deepEqual(computeDeck(retired).map((d) => d.nodeId), ["b", "c"]);
	});

	it("adds a pinned node outside any goal, and ignores nodes that no longer exist", () => {
		const marks = { ...noMarks(), pinned: new Set(["x", "ghost"]) };
		assert.deepEqual(computeDeck({ ...base, goals: [], marks }).map((d) => d.nodeId), ["x"]);
	});

	it("carries the priority of the highest-priority goal containing the node", () => {
		const deck = computeDeck({ ...base, goals: [goal("g1", ["c"], { priority: 2 }), goal("g2", ["a"], { priority: 5 })] });
		assert.equal(deck.find((d) => d.nodeId === "a")?.priority, 5);
		assert.equal(deck.find((d) => d.nodeId === "b")?.priority, 2);
	});
});

describe("claimNodes (REQ-pl-08)", () => {
	it("a node in several goals takes the retention of its highest-priority goal", () => {
		const marks = { retention: new Map([["g_low", 0.8], ["g_high", 0.95]]) };
		const info = claimNodes([goal("g_low", ["a"], { priority: 1 }), goal("g_high", ["a"], { priority: 4 })], [], marks);
		assert.equal(info.get("a")?.retention, 0.95);
		assert.equal(info.get("a")?.priority, 4);
	});
	it("defaults to 0.9 and breaks priority ties by creation time", () => {
		const early = goal("g_early", ["a"], { createdAt: "2026-11-01T00:00:00.000Z" });
		const late = goal("g_late", ["a"], { createdAt: "2026-11-02T00:00:00.000Z" });
		const info = claimNodes([late, early], [], { retention: new Map([["g_late", 0.8]]) });
		assert.equal(info.get("a")?.retention, 0.9);
	});
});

describe("premisesOf and goalReadiness", () => {
	it("premisesOf unions the premises of all chains concluding the node, once each", () => {
		assert.deepEqual(premisesOf("c", [chain(["a", "b"], "c"), chain(["b", "d"], "c"), chain(["z"], "y")]), ["a", "b", "d"]);
	});
	it("a goal is ready when at least 80% of its scope is solid", () => {
		const scope = ["a", "b", "c", "d", "e"];
		assert.equal(goalReadiness(scope, (id) => (id === "e" ? 0 : 0.9)).ready, true);
		assert.equal(goalReadiness(scope, (id) => (id === "d" || id === "e" ? 0 : 0.9)).ready, false);
		assert.equal(goalReadiness([], () => 1).ready, false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-deck.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/deck.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/deck.ts
/**
 * The deck (umbrella REQ-review-02, spec REQ-pl-08, REQ-pl-10, REQ-pl-13):
 * scope of ACTIVE goals, minus derivable nodes, minus retired nodes, plus
 * pinned nodes — computed on demand, never stored. Paused goals contribute
 * nothing but their nodes keep their state (the state derivation never
 * looks at goal status).
 */

import type { GraphChain } from "../contracts.ts";
import { DEFAULT_GOAL_PRIORITY, goalScope, type Goal } from "./goals.ts";
import { DEFAULT_RETENTION } from "./fsrs.ts";
import type { Marks } from "./review-state.ts";

export const DERIVABLE_RECALL = 0.85;

type ChainLike = Pick<GraphChain, "premises" | "conclusion">;

export interface NodeGoalInfo {
	priority: number;
	retention: number;
}

/**
 * For each node in the scope of `goals`, the priority and desired retention
 * of the HIGHEST-PRIORITY goal containing it (ties: earliest created).
 * A goal without a retention override uses DEFAULT_RETENTION (REQ-pl-08).
 */
export function claimNodes(
	goals: readonly Goal[],
	chains: readonly ChainLike[],
	marks: Pick<Marks, "retention">,
): Map<string, NodeGoalInfo> {
	const ordered = [...goals].sort(
		(a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	const out = new Map<string, NodeGoalInfo>();
	for (const goal of ordered) {
		const retention = marks.retention.get(goal.id) ?? DEFAULT_RETENTION;
		for (const id of goalScope(goal.targetNodeIds, chains)) {
			if (!out.has(id)) out.set(id, { priority: goal.priority, retention });
		}
	}
	return out;
}

/** Some chain concluding `nodeId` has every premise at recall >= threshold (REQ-pl-10). */
export function isDerivable(
	nodeId: string,
	chains: readonly ChainLike[],
	recall: (nodeId: string) => number,
	threshold: number = DERIVABLE_RECALL,
): boolean {
	return chains.some(
		(c) => c.conclusion === nodeId && c.premises.length > 0 && c.premises.every((p) => recall(p) >= threshold),
	);
}

export function hasChain(nodeId: string, chains: readonly ChainLike[]): boolean {
	return chains.some((c) => c.conclusion === nodeId);
}

/** Distinct premises of every chain concluding `nodeId`, read from the CURRENT chains (umbrella REQ-review-05). */
export function premisesOf(nodeId: string, chains: readonly ChainLike[]): string[] {
	const out: string[] = [];
	for (const c of chains) {
		if (c.conclusion !== nodeId) continue;
		for (const p of c.premises) if (!out.includes(p)) out.push(p);
	}
	return out;
}

export interface DeckEntry {
	nodeId: string;
	priority: number;
	pinned: boolean;
	channelPin: "fixed" | "dialogic" | null;
	hasChain: boolean;
}

export interface DeckInput {
	goals: readonly Goal[];
	chains: readonly ChainLike[];
	/** Ids of nodes that currently exist; anything else is dropped. */
	nodeIds: ReadonlySet<string>;
	marks: Marks;
	recall: (nodeId: string) => number;
}

export function computeDeck(input: DeckInput): DeckEntry[] {
	const active = input.goals.filter((g) => g.status === "active");
	const claimed = claimNodes(active, input.chains, input.marks);
	const ids = new Set<string>(claimed.keys());
	for (const id of input.marks.pinned) ids.add(id);
	const out: DeckEntry[] = [];
	for (const id of [...ids].sort()) {
		if (!input.nodeIds.has(id)) continue;
		const pinned = input.marks.pinned.has(id);
		if (input.marks.retired.has(id) && !pinned) continue;
		if (!pinned && isDerivable(id, input.chains, input.recall)) continue;
		out.push({
			nodeId: id,
			priority: claimed.get(id)?.priority ?? DEFAULT_GOAL_PRIORITY,
			pinned,
			channelPin: input.marks.channelPin.get(id) ?? null,
			hasChain: hasChain(id, input.chains),
		});
	}
	return out;
}

/** Fraction of `scope` whose recall is at least the derivable threshold; ready when most is solid. */
export const READY_FRACTION = 0.8;
export function goalReadiness(
	scope: readonly string[],
	recall: (nodeId: string) => number,
): { solid: number; total: number; ready: boolean } {
	const total = scope.length;
	const solid = scope.filter((id) => recall(id) >= DERIVABLE_RECALL).length;
	return { solid, total, ready: total > 0 && solid / total >= READY_FRACTION };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-deck.test.ts`
Expected: PASS, `pass 12`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/deck.ts tests/ext-deck.test.ts
git commit -m "feat(ext): compute the review deck" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 7: Daily plan (REQ-pl-05, REQ-pl-11, REQ-pl-12, REQ-pl-16)

**Files:**
- Create: `src/core/ext/daily-plan.ts`
- Test: `tests/ext-daily-plan.test.ts`

Contract: `dailyPlan` is pure. Due = deck node with a state whose `card.due <= now`; new = deck node with no state. Order: goal priority desc, then forgetting risk desc (new nodes by priority then id). Channel: a user pin wins; else a node with a chain is dialogic while `dialogicCap - dialogicToday` lasts, then fixed; a fixed node with no active card goes to `needsCard`. `remaining = max(0, budget - spentToday)`; `capacity = floor(remaining / mean cost of due items)` (cost = observed channel median else 20 s / 180 s); `newQuota = 0` if `due > 1.5 * capacity`, else `max(0, capacity - due)`. Items beyond the remaining time are `deferred` in order, never dropped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-daily-plan.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeReviewStats, dailyPlan, DEFAULT_PLAN_PARAMS, type PlanInput } from "../src/core/ext/daily-plan.ts";
import type { DeckEntry } from "../src/core/ext/deck.ts";
import { newCard, reviewCard } from "../src/core/ext/fsrs.ts";
import type { NodeState } from "../src/core/ext/review-state.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T08:00:00.000Z";
const NOW = "2026-11-10T08:00:00.000Z"; // 6 days after T0: every card reviewed at T0 with Good is due
const DAY_START = "2026-11-10T00:00:00.000Z";

const entry = (nodeId: string, over: Partial<DeckEntry> = {}): DeckEntry => ({
	nodeId, priority: 3, pinned: false, channelPin: null, hasChain: false, ...over,
});
function reviewedAt(nodeId: string, at: string, rating: 1 | 2 | 3 | 4 = 3): NodeState {
	return { nodeId, card: reviewCard(newCard(at), rating, at, 0.9), fixedReviews: 1 };
}
function input(over: Partial<PlanInput> & { deck: DeckEntry[] }): PlanInput {
	return {
		now: NOW,
		states: new Map(),
		stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 0, dialogicToday: 0 },
		hasActiveCard: () => true,
		params: DEFAULT_PLAN_PARAMS,
		...over,
	};
}
const ids = (items: Array<{ nodeId: string }>) => items.map((i) => i.nodeId);

describe("computeReviewStats", () => {
	const ev = (channel: "fixed" | "dialogic" | "exercise", durationSec: number, at: string): ReviewEvent => ({
		type: "review", nodeId: "n", channel, rating: 3, durationSec, at,
	});
	it("takes medians per channel from real reviews only, and sums time since the day start", () => {
		const stats = computeReviewStats(
			[ev("fixed", 10, T0), ev("fixed", 30, T0), ev("fixed", 20, NOW), ev("dialogic", 100, NOW), ev("exercise", 0, NOW)],
			DAY_START,
		);
		assert.equal(stats.medianSec.fixed, 20);
		assert.equal(stats.medianSec.dialogic, 100);
		assert.equal(stats.spentTodaySec, 120);
		assert.equal(stats.dialogicToday, 1);
	});
	it("has no median before there is data", () => {
		assert.deepEqual(computeReviewStats([], DAY_START).medianSec, { fixed: null, dialogic: null });
	});
});

describe("dailyPlan quota (REQ-pl-11)", () => {
	it("defaults: 25 min / 20 s = 75 cards of capacity; new quota = capacity - due", () => {
		const deck = [...Array.from({ length: 80 }, (_, i) => entry(`n${String(i).padStart(3, "0")}`))];
		const states = new Map([["n000", reviewedAt("n000", T0)], ["n001", reviewedAt("n001", T0)]]);
		const plan = dailyPlan(input({ deck, states }));
		assert.equal(plan.capacity, 75);
		assert.equal(plan.due, 2);
		assert.equal(plan.newQuota, 73);
		assert.equal(plan.items.length, 75);
		assert.equal(plan.deferred.length, 0);
	});

	it("the quota is zero when due exceeds 1.5 x capacity", () => {
		const deck = Array.from({ length: 5 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const params = { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 }; // capacity 3 at 20 s; 5 due > 4.5
		const plan = dailyPlan(input({ deck: [...deck, entry("zz-new")], states, params }));
		assert.equal(plan.capacity, 3);
		assert.equal(plan.due, 5);
		assert.equal(plan.newQuota, 0);
		assert.equal(ids(plan.items).includes("zz-new"), false);
	});

	it("at due == capacity the quota is zero but nothing is deferred beyond the budget", () => {
		const deck = Array.from({ length: 3 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const plan = dailyPlan(input({ deck: [...deck, entry("zz-new")], states, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 } }));
		assert.equal(plan.newQuota, 0);
		assert.equal(plan.items.length, 3);
	});

	it("time already spent today shrinks the remaining budget", () => {
		const plan = dailyPlan(input({
			deck: [entry("a")],
			stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 1500 - 40, dialogicToday: 0 },
		}));
		assert.equal(plan.remainingSec, 40);
		assert.equal(plan.capacity, 2);
	});

	it("uses the observed median once it exists", () => {
		const plan = dailyPlan(input({
			deck: [entry("a")],
			stats: { medianSec: { fixed: 50, dialogic: null }, spentTodaySec: 0, dialogicToday: 0 },
		}));
		assert.equal(plan.capacity, 30);
	});
});

describe("dailyPlan order and deferral (REQ-pl-12)", () => {
	it("orders due items by goal priority, then by forgetting risk", () => {
		const deck = [entry("low-risk-hi", { priority: 5 }), entry("lo", { priority: 1 }), entry("high-risk-hi", { priority: 5 })];
		const states = new Map([
			["low-risk-hi", reviewedAt("low-risk-hi", "2026-11-08T08:00:00.000Z")],
			["lo", reviewedAt("lo", T0)],
			["high-risk-hi", reviewedAt("high-risk-hi", T0)],
		]);
		// make "low-risk-hi" due too: force its due date into the past
		states.get("low-risk-hi")!.card.due = new Date(Date.parse(NOW) - 1000);
		const plan = dailyPlan(input({ deck, states }));
		assert.deepEqual(ids(plan.items), ["high-risk-hi", "low-risk-hi", "lo"]);
	});

	it("defers what does not fit the time, in order, and never drops it", () => {
		const deck = Array.from({ length: 6 }, (_, i) => entry(`n${i}`));
		const states = new Map(deck.map((d) => [d.nodeId, reviewedAt(d.nodeId, T0)]));
		const plan = dailyPlan(input({ deck, states, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 60 } }));
		assert.equal(plan.items.length, 3);
		assert.equal(plan.deferred.length, 3);
		assert.deepEqual(ids([...plan.items, ...plan.deferred]).sort(), deck.map((d) => d.nodeId).sort());
	});

	it("does not list a card that is not yet due", () => {
		const states = new Map([["a", reviewedAt("a", NOW)]]);
		assert.deepEqual(dailyPlan(input({ deck: [entry("a")], states })).items, []);
	});

	it("is deterministic (REQ-pl-16)", () => {
		const deck = [entry("b"), entry("a")];
		assert.deepEqual(dailyPlan(input({ deck })), dailyPlan(input({ deck })));
	});
});

describe("dailyPlan channel assignment (REQ-pl-05)", () => {
	const chained = (n: number) => Array.from({ length: n }, (_, i) => entry(`c${i}`, { hasChain: true }));

	it("a fact is fixed; a chain-concluded node is dialogic up to the daily cap, then falls back to fixed", () => {
		const plan = dailyPlan(input({ deck: [entry("fact"), ...chained(7)] }));
		const channelOf = (id: string) => plan.items.find((i) => i.nodeId === id)?.channel;
		assert.equal(channelOf("fact"), "fixed");
		assert.equal(plan.items.filter((i) => i.channel === "dialogic").length, 5);
		assert.equal(channelOf("c4"), "dialogic");
		assert.equal(channelOf("c5"), "fixed");
	});

	it("dialogic reviews already done today use up the cap", () => {
		const plan = dailyPlan(input({
			deck: chained(3),
			stats: { medianSec: { fixed: null, dialogic: null }, spentTodaySec: 0, dialogicToday: 4 },
		}));
		assert.equal(plan.items.filter((i) => i.channel === "dialogic").length, 1);
	});

	it("a pinned channel wins, even beyond the cap", () => {
		const deck = [...chained(5), entry("f", { hasChain: true, channelPin: "fixed" }), entry("d", { channelPin: "dialogic" })];
		const plan = dailyPlan(input({ deck }));
		assert.equal(plan.items.find((i) => i.nodeId === "f")?.channel, "fixed");
		assert.equal(plan.items.find((i) => i.nodeId === "d")?.channel, "dialogic");
	});

	it("a node needing the fixed channel but with no active card is reported, not planned", () => {
		const plan = dailyPlan(input({ deck: [entry("nocard"), entry("ok")], hasActiveCard: (id) => id === "ok" }));
		assert.deepEqual(plan.needsCard, ["nocard"]);
		assert.deepEqual(ids(plan.items), ["ok"]);
	});

	it("a dialogic review costs its median, so fewer fit the budget", () => {
		const deck = chained(5);
		const plan = dailyPlan(input({ deck, params: { ...DEFAULT_PLAN_PARAMS, budgetSec: 360 } }));
		assert.equal(plan.items.length, 2); // 2 x 180 s
		assert.equal(plan.deferred.length, 3);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-daily-plan.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/daily-plan.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/core/ext/daily-plan.ts
/**
 * The daily plan (REQ-pl-05, REQ-pl-11, REQ-pl-12, REQ-pl-16): a PURE
 * function of the deck, the derived states, the review history, the time
 * and the parameters. The budget is time, not a card count:
 *
 *   remaining = budget - time already spent today
 *   capacity  = floor(remaining / mean cost of the due items)
 *   newQuota  = max(0, capacity - due), and 0 when due > backlogFactor * capacity
 *
 * With this capacity the backlog clause is already implied by max(0, ...)
 * (due > 1.5 x capacity means due > capacity); it is kept because REQ-pl-11
 * states it, so a future change of the capacity definition cannot drop it.
 *
 * Order: goal priority (high first), then forgetting risk (1 - recall).
 * Whatever does not fit the remaining time is DEFERRED, never dropped.
 */

import { recallProbability } from "./fsrs.ts";
import type { DeckEntry } from "./deck.ts";
import type { NodeState } from "./review-state.ts";
import type { ReviewEvent } from "./review.ts";

export interface PlanParams {
	budgetSec: number;
	dialogicCap: number;
	backlogFactor: number;
	defaultDurationSec: { fixed: number; dialogic: number };
}

export const DEFAULT_PLAN_PARAMS: PlanParams = {
	budgetSec: 25 * 60,
	dialogicCap: 5,
	backlogFactor: 1.5,
	defaultDurationSec: { fixed: 20, dialogic: 180 },
};

export interface ReviewStats {
	/** Median observed duration per channel; null until there is data. */
	medianSec: { fixed: number | null; dialogic: number | null };
	/** Seconds of real reviews since `dayStart`. */
	spentTodaySec: number;
	/** Dialogic reviews since `dayStart`. */
	dialogicToday: number;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Only real fixed/dialogic reviews with a positive duration count toward medians. */
export function computeReviewStats(events: readonly ReviewEvent[], dayStart: string): ReviewStats {
	const fixed: number[] = [];
	const dialogic: number[] = [];
	let spent = 0;
	let dialogicToday = 0;
	const start = Date.parse(dayStart);
	for (const e of events) {
		if (e.type !== "review") continue;
		if (e.channel === "fixed" && e.durationSec > 0) fixed.push(e.durationSec);
		if (e.channel === "dialogic" && e.durationSec > 0) dialogic.push(e.durationSec);
		if (Date.parse(e.at) >= start) {
			spent += e.durationSec;
			if (e.channel === "dialogic") dialogicToday += 1;
		}
	}
	return { medianSec: { fixed: median(fixed), dialogic: median(dialogic) }, spentTodaySec: spent, dialogicToday };
}

export interface PlanItem {
	nodeId: string;
	channel: "fixed" | "dialogic";
	reason: "due" | "new";
	priority: number;
	/** 1 - recall probability at plan time (1 for a new node). */
	risk: number;
}

export interface DailyPlan {
	/** In review order, fitting the remaining time. */
	items: PlanItem[];
	/** Valid but beyond today's time: tomorrow's problem, never dropped. */
	deferred: PlanItem[];
	/** Nodes assigned to the fixed channel that have no active card yet. */
	needsCard: string[];
	due: number;
	capacity: number;
	newQuota: number;
	remainingSec: number;
}

export interface PlanInput {
	now: string;
	deck: readonly DeckEntry[];
	states: ReadonlyMap<string, NodeState>;
	stats: ReviewStats;
	hasActiveCard: (nodeId: string) => boolean;
	params: PlanParams;
}

export function dailyPlan(input: PlanInput): DailyPlan {
	const { now, deck, states, stats, params } = input;
	const nowMs = Date.parse(now);
	const cost = (channel: "fixed" | "dialogic"): number =>
		stats.medianSec[channel] ?? params.defaultDurationSec[channel];

	const dueEntries: Array<{ entry: DeckEntry; risk: number }> = [];
	const newEntries: DeckEntry[] = [];
	for (const entry of deck) {
		const state = states.get(entry.nodeId);
		if (state === undefined) newEntries.push(entry);
		else if (state.card.due.getTime() <= nowMs) {
			dueEntries.push({ entry, risk: 1 - recallProbability(state.card, now) });
		}
	}
	dueEntries.sort(
		(a, b) => b.entry.priority - a.entry.priority || b.risk - a.risk || a.entry.nodeId.localeCompare(b.entry.nodeId),
	);
	newEntries.sort((a, b) => b.priority - a.priority || a.nodeId.localeCompare(b.nodeId));

	const needsCard: string[] = [];
	let dialogicLeft = Math.max(0, params.dialogicCap - stats.dialogicToday);
	/** REQ-pl-05: pin wins; a chain-concluded node is dialogic while the daily cap lasts; overflow falls back to fixed. */
	const assign = (entry: DeckEntry): "fixed" | "dialogic" | null => {
		let channel: "fixed" | "dialogic";
		if (entry.channelPin !== null) {
			channel = entry.channelPin;
			if (channel === "dialogic") dialogicLeft = Math.max(0, dialogicLeft - 1);
		} else if (entry.hasChain && dialogicLeft > 0) {
			channel = "dialogic";
			dialogicLeft -= 1;
		} else channel = "fixed";
		if (channel === "fixed" && !input.hasActiveCard(entry.nodeId)) {
			needsCard.push(entry.nodeId);
			return null;
		}
		return channel;
	};

	const due: PlanItem[] = [];
	for (const { entry, risk } of dueEntries) {
		const channel = assign(entry);
		if (channel !== null) due.push({ nodeId: entry.nodeId, channel, reason: "due", priority: entry.priority, risk });
	}

	const remainingSec = Math.max(0, params.budgetSec - stats.spentTodaySec);
	const meanCost =
		due.length === 0 ? cost("fixed") : due.reduce((sum, i) => sum + cost(i.channel), 0) / due.length;
	const capacity = Math.floor(remainingSec / meanCost);
	const newQuota = due.length > params.backlogFactor * capacity ? 0 : Math.max(0, capacity - due.length);

	const fresh: PlanItem[] = [];
	for (const entry of newEntries) {
		if (fresh.length >= newQuota) break;
		const channel = assign(entry);
		if (channel !== null) fresh.push({ nodeId: entry.nodeId, channel, reason: "new", priority: entry.priority, risk: 1 });
	}

	const items: PlanItem[] = [];
	const deferred: PlanItem[] = [];
	let used = 0;
	let full = false;
	for (const item of [...due, ...fresh]) {
		const c = cost(item.channel);
		if (!full && used + c <= remainingSec) {
			items.push(item);
			used += c;
		} else {
			full = true;
			deferred.push(item);
		}
	}
	return { items, deferred, needsCard, due: due.length, capacity, newQuota, remainingSec };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-daily-plan.test.ts`
Expected: PASS, `pass 16`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/daily-plan.ts tests/ext-daily-plan.test.ts
git commit -m "feat(ext): add the time-budgeted daily plan" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 8: Review service and queries (REQ-pl-02, REQ-pl-03, REQ-pl-05, REQ-pl-08, REQ-pl-09, REQ-pl-14, REQ-pl-15)

**Files:**
- Create: `tests/helpers/ext-memory-stores.ts`, `src/core/ext/review-service.ts`, `src/core/ext/review-queries.ts`
- Test: `tests/ext-review-service.test.ts`

Contract:
- `recordReview` validates BEFORE its first write (known node, rating 1 to 4, duration >= 0, weak premises only on a dialogic review and only from the node's current premises), appends one `review` event, then for a dialogic review one `implicit` event per affected premise that already has a state: rating >= 2 credits every non-weak premise, rating 1 penalises only the weak ones. It never writes the content graph (REQ-pl-15).
- `createUserCard` is `active` at once; `proposeAgentCard` is `draft`; only `approveCard` (draft only) activates; `retireCard` retires.
- `setPinned(true)` also clears retirement and `setRetired(true)` also clears the pin; `setChannelPin(node, null)` restores automatic assignment; `setGoalRetention` accepts 0.7 to 0.97 for a known goal.
- `applyExerciseResult` is the ONLY writer of a goal's `reached`: it validates goal (exists, active), a non-empty result and known nodes first, writes one `exercise` review per result (passed = 3, otherwise 1, duration 0), and appends `reached` only if all passed and every target is covered.
- `nextItem` returns the plan head with its premises read from the CURRENT chains, the fixed card to show (fixed channel only), trust and the last three questions asked on the node, or `empty` with the deferred count and the nodes needing a card.

- [ ] **Step 1: Write the test helper**

```ts
// tests/helpers/ext-memory-stores.ts
/** In-memory extension stores and a seeded graph for the personal-layer tests. */

import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { CardEvent } from "../../src/core/ext/cards.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { CardsStore, GoalsStore, ReviewStore } from "../../src/core/ext/ports.ts";
import type { ReviewEvent } from "../../src/core/ext/review.ts";
import type { QueryDeps } from "../../src/core/ext/review-queries.ts";
import { createMemoryGraphStore } from "./memory-graph-store.ts";

function memoryStore<T>(): { events: T[]; appendEvent: (e: T) => void; readEvents: () => T[] } {
	const events: T[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export const node = (id: string, name = id): GraphNode => ({
	id, name, statement: `${name} holds.`, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [],
});
export const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id, premises, conclusion, provenance: [], createdAt: "2026-11-01T00:00:00.000Z",
});

export interface Harness {
	deps: QueryDeps;
	review: ReviewStore & { events: ReviewEvent[] };
	cards: CardsStore & { events: CardEvent[] };
	goals: GoalsStore & { events: GoalEvent[] };
	clock: { now: string };
}

export function harness(opts: { nodes: GraphNode[]; chains?: GraphChain[]; now?: string }): Harness {
	const graphStore = createMemoryGraphStore();
	for (const n of opts.nodes) graphStore.appendNode(n);
	for (const c of opts.chains ?? []) graphStore.appendChain(c);
	const review = memoryStore<ReviewEvent>();
	const cards = memoryStore<CardEvent>();
	const goals = memoryStore<GoalEvent>();
	const clock = { now: opts.now ?? "2026-11-04T10:00:00.000Z" };
	let n = 0;
	return {
		deps: {
			graphStore, reviewStore: review, cardsStore: cards, goalsStore: goals,
			now: () => clock.now, newCardId: () => `card_t${++n}`,
		},
		review, cards, goals, clock,
	};
}

export function addGoal(h: Harness, goalId: string, targets: string[], priority = 3): void {
	h.goals.appendEvent({
		type: "created", goalId, title: goalId, origin: "user", originRef: "", targetNodeIds: targets, priority,
		at: "2026-11-01T00:00:00.000Z",
	});
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/ext-review-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveGoals } from "../src/core/ext/goals.ts";
import { computePlan, goalReadinessReport, nextItem } from "../src/core/ext/review-queries.ts";
import {
	applyExerciseResult, approveCard, createUserCard, proposeAgentCard, recordReview, retireCard,
	setChannelPin, setGoalRetention, setPinned, setRetired, snapshot,
} from "../src/core/ext/review-service.ts";
import { addGoal, chain, harness, node, type Harness } from "./helpers/ext-memory-stores.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T10:00:00.000Z";
const later = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();
const DAY_START = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;

/** a, b are facts; c is concluded from a and b. */
function world(): Harness {
	const h = harness({ nodes: [node("a"), node("b"), node("c")], chains: [chain("arg_1", ["a", "b"], "c")], now: T0 });
	addGoal(h, "goal_1", ["c"]);
	return h;
}
const fixedReview = (h: Harness, nodeId: string, rating = 3, durationSec = 15) =>
	recordReview({ nodeId, channel: "fixed", rating, durationSec }, h.deps);

describe("recordReview", () => {
	it("appends a review event and returns the next due date", () => {
		const h = world();
		const res = fixedReview(h, "a");
		assert.equal(h.review.events.length, 1);
		assert.equal(h.review.events[0]?.type, "review");
		assert.ok(Date.parse(res.dueAt) > Date.parse(T0));
	});

	it("rejects an unknown node, a bad rating and a negative duration without writing", () => {
		const h = world();
		assert.throws(() => fixedReview(h, "ghost"), /unknown node/);
		assert.throws(() => fixedReview(h, "a", 7), /rating/);
		assert.throws(() => fixedReview(h, "a", 3, -1), /durationSec/);
		assert.equal(h.review.events.length, 0);
	});

	it("rejects weak premises on a fixed review, or ones that are not premises of the node", () => {
		const h = world();
		assert.throws(() => recordReview({ nodeId: "c", channel: "fixed", rating: 3, durationSec: 5, weakPremises: ["a"] }, h.deps), /dialogic/);
		assert.throws(() => recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 5, weakPremises: ["zzz"] }, h.deps), /not a premise/);
		assert.equal(h.review.events.length, 0);
	});

	it("a successful dialogic review credits every premise that has a state and is not weak (REQ-pl-09)", () => {
		const h = world();
		fixedReview(h, "a");
		fixedReview(h, "b");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100, weakPremises: ["b"] }, h.deps);
		assert.deepEqual(res.credited, ["a"]);
		assert.deepEqual(res.penalised, []);
		const implicit = h.review.events.filter((e) => e.type === "implicit");
		assert.equal(implicit.length, 1);
		assert.deepEqual(implicit[0], { type: "implicit", nodeId: "a", viaNodeId: "c", outcome: "credit", at: later(3) });
	});

	it("a Hard (2) dialogic review still counts as a success for the premises", () => {
		const h = world();
		fixedReview(h, "a");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 2, durationSec: 100 }, h.deps);
		assert.deepEqual(res.credited, ["a"]);
	});

	it("a failed dialogic review penalises ONLY the premises flagged weak", () => {
		const h = world();
		fixedReview(h, "a");
		fixedReview(h, "b");
		h.clock.now = later(3);
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 1, durationSec: 100, weakPremises: ["b"] }, h.deps);
		assert.deepEqual(res.penalised, ["b"]);
		assert.deepEqual(res.credited, []);
		const snap = snapshot(h.deps, h.clock.now);
		assert.equal(snap.states.get("b")?.card.lapses, 1);
		assert.equal(snap.states.get("a")?.card.lapses, 0);
	});

	it("a failed dialogic review with no weak premise penalises nobody", () => {
		const h = world();
		fixedReview(h, "a");
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 1, durationSec: 100 }, h.deps);
		assert.deepEqual(res.penalised, []);
		assert.equal(h.review.events.filter((e) => e.type === "implicit").length, 0);
	});

	it("never credits a premise that has no state yet", () => {
		const h = world();
		const res = recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100 }, h.deps);
		assert.deepEqual(res.credited, []);
	});

	it("records the weak premises and the question on the dialogic event, and never writes the content graph (REQ-pl-15)", () => {
		const h = world();
		recordReview({ nodeId: "c", channel: "dialogic", rating: 2, durationSec: 100, question: "Why does b matter?", weakPremises: ["b"] }, h.deps);
		const ev = h.review.events[0];
		assert.equal(ev?.type === "review" && ev.question, "Why does b matter?");
		assert.deepEqual(ev?.type === "review" && ev.weakPremises, ["b"]);
		assert.equal(h.deps.graphStore.readNodes().length, 3);
		assert.equal(h.deps.graphStore.readChains().length, 1);
	});
});

describe("cards", () => {
	it("a user card is active at once; an agent card is a draft until approved (REQ-pl-02, REQ-pl-03)", () => {
		const h = world();
		const user = createUserCard({ nodeId: "a", question: "Q1", answer: "A1" }, h.deps);
		const agent = proposeAgentCard({ nodeId: "b", question: "Q2", answer: "A2" }, h.deps);
		assert.equal(computePlan(h.deps, DAY_START(T0)).snap.cards.find((c) => c.id === user)?.status, "active");
		const plan = () => computePlan(h.deps, DAY_START(T0)).plan;
		assert.equal(plan().items.some((i) => i.nodeId === "b"), false, "a draft is not scheduled");
		assert.ok(plan().needsCard.includes("b"));
		approveCard(agent, h.deps);
		assert.equal(plan().items.some((i) => i.nodeId === "b"), true);
		retireCard(agent, h.deps);
		assert.equal(plan().items.some((i) => i.nodeId === "b"), false);
	});

	it("only a draft can be approved; unknown cards and nodes are rejected", () => {
		const h = world();
		const user = createUserCard({ nodeId: "a", question: "Q", answer: "A" }, h.deps);
		assert.throws(() => approveCard(user, h.deps), /draft/);
		assert.throws(() => approveCard("nope", h.deps), /unknown card/);
		assert.throws(() => createUserCard({ nodeId: "ghost", question: "Q", answer: "A" }, h.deps), /unknown node/);
		assert.throws(() => proposeAgentCard({ nodeId: "ghost", question: "Q", answer: "A" }, h.deps), /unknown node/);
	});
});

describe("plan and next item", () => {
	it("serves a chain node through dialogic review with its premises, then a fact through its card (REQ-pl-06, REQ-pl-07)", () => {
		// ids chosen so the chain node sorts first among equal-priority new nodes
		const h = harness({ nodes: [node("c0"), node("p1"), node("p2")], chains: [chain("arg_1", ["p1", "p2"], "c0")], now: T0 });
		addGoal(h, "goal_1", ["c0"]);
		createUserCard({ nodeId: "p1", question: "What is p1?", answer: "It is p1." }, h.deps);
		createUserCard({ nodeId: "p2", question: "What is p2?", answer: "It is p2." }, h.deps);
		const first = nextItem(h.deps, DAY_START(T0));
		assert.equal(first.kind, "item");
		if (first.kind !== "item") return;
		assert.equal(first.nodeId, "c0");
		assert.equal(first.channel, "dialogic");
		assert.deepEqual(first.premises.map((p) => p.id), ["p1", "p2"]);
		assert.equal(first.card, undefined);
		assert.equal(first.trust, "unverified");
		recordReview({ nodeId: "c0", channel: "dialogic", rating: 3, durationSec: 100 }, h.deps);
		const second = nextItem(h.deps, DAY_START(T0));
		assert.equal(second.kind, "item");
		if (second.kind !== "item") return;
		assert.equal(second.channel, "fixed");
		assert.equal(second.card?.question, `What is ${second.nodeId}?`);
		assert.equal(second.remainingItems, 2);
	});

	it("tells the dialogic agent what it asked last time so it asks a new question", () => {
		const h = world();
		recordReview({ nodeId: "c", channel: "dialogic", rating: 3, durationSec: 100, question: "Q one" }, h.deps);
		h.clock.now = later(30);
		const item = nextItem(h.deps, DAY_START(h.clock.now));
		assert.equal(item.kind, "item");
		if (item.kind === "item" && item.nodeId === "c") assert.deepEqual(item.recentQuestions, ["Q one"]);
	});

	it("is empty when nothing is plannable, and reports the nodes that need a card", () => {
		const h = harness({ nodes: [node("a")], now: T0 });
		addGoal(h, "goal_1", ["a"]);
		const item = nextItem(h.deps, DAY_START(T0));
		assert.deepEqual(item, { kind: "empty", deferred: 0, needsCard: ["a"] });
	});

	it("paused goals leave the deck but keep their state (REQ-pl-13)", () => {
		const h = world();
		fixedReview(h, "a");
		h.goals.appendEvent({ type: "status", goalId: "goal_1", status: "paused", at: T0 });
		h.clock.now = later(30);
		const { plan, snap } = computePlan(h.deps, DAY_START(h.clock.now));
		assert.deepEqual(plan.items, []);
		assert.equal(snap.states.has("a"), true);
	});

	it("a derivable node leaves the deck unless pinned (REQ-pl-10)", () => {
		const h = world();
		fixedReview(h, "a", 4);
		fixedReview(h, "b", 4);
		const ids = () => computePlan(h.deps, DAY_START(T0)).plan.items.map((i) => i.nodeId);
		assert.equal(ids().includes("c"), false);
		setPinned("c", true, h.deps);
		assert.equal(ids().includes("c"), true);
	});

	it("a retired node leaves the deck; pinning brings it back (and the reverse)", () => {
		const h = world();
		createUserCard({ nodeId: "a", question: "Q", answer: "A" }, h.deps);
		const has = () => computePlan(h.deps, DAY_START(T0)).plan.items.some((i) => i.nodeId === "a");
		assert.equal(has(), true);
		setRetired("a", true, h.deps);
		assert.equal(has(), false);
		setPinned("a", true, h.deps);
		assert.equal(has(), true);
		setRetired("a", true, h.deps);
		assert.equal(has(), false);
	});

	it("a channel pin moves a chain node to the fixed channel", () => {
		const h = world();
		createUserCard({ nodeId: "c", question: "Q", answer: "A" }, h.deps);
		setChannelPin("c", "fixed", h.deps);
		const item = computePlan(h.deps, DAY_START(T0)).plan.items.find((i) => i.nodeId === "c");
		assert.equal(item?.channel, "fixed");
		setChannelPin("c", null, h.deps);
		assert.equal(computePlan(h.deps, DAY_START(T0)).plan.items.find((i) => i.nodeId === "c")?.channel, "dialogic");
	});

	it("events for a node deleted from the graph are ignored", () => {
		const h = world();
		fixedReview(h, "a");
		const graph = h.deps.graphStore as unknown as { rewriteLedgers(n: { nodes: ReturnType<typeof node>[] }): void };
		graph.rewriteLedgers({ nodes: [node("b"), node("c")] });
		assert.equal(snapshot(h.deps, T0).states.has("a"), false);
	});
});

describe("retention per goal (REQ-pl-08)", () => {
	it("a higher retention gives a nearer due date for the same history", () => {
		const dueWith = (retention: number | null): number => {
			const h = world();
			if (retention !== null) setGoalRetention("goal_1", retention, h.deps);
			fixedReview(h, "a");
			h.clock.now = later(3);
			fixedReview(h, "a");
			return snapshot(h.deps, h.clock.now).states.get("a")!.card.scheduled_days;
		};
		assert.ok(dueWith(0.95) < dueWith(null));
		assert.ok(dueWith(0.8) > dueWith(null));
	});
	it("rejects an out-of-range retention and an unknown goal", () => {
		const h = world();
		assert.throws(() => setGoalRetention("goal_1", 0.99, h.deps), /retention/);
		assert.throws(() => setGoalRetention("nope", 0.9, h.deps), /unknown goal/);
	});
});

describe("applyExerciseResult (REQ-pl-14)", () => {
	it("passing every target marks the goal reached and credits the nodes", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }, { nodeId: "a", outcome: "passed" }] }, h.deps);
		assert.equal(res.reached, true);
		assert.equal(deriveGoals(h.goals.events)[0]?.status, "reached");
		const ex = h.review.events.filter((e) => e.type === "review" && e.channel === "exercise");
		assert.equal(ex.length, 2);
		assert.equal(snapshot(h.deps, T0).states.has("c"), true);
	});

	it("a weak or failed node reopens it as due and does not reach the goal", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }, { nodeId: "a", outcome: "weak" }] }, h.deps);
		assert.equal(res.reached, false);
		assert.equal(deriveGoals(h.goals.events)[0]?.status, "active");
		const a = h.review.events.find((e) => e.type === "review" && e.nodeId === "a");
		assert.equal(a?.type === "review" && a.rating, 1);
	});

	it("a passed set that misses a target does not reach the goal", () => {
		const h = world();
		const res = applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "a", outcome: "passed" }] }, h.deps);
		assert.equal(res.reached, false);
	});

	it("validates before writing: unknown goal, unknown node, empty set, non-active goal", () => {
		const h = world();
		assert.throws(() => applyExerciseResult({ goalId: "nope", results: [{ nodeId: "c", outcome: "passed" }] }, h.deps), /unknown goal/);
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "ghost", outcome: "passed" }] }, h.deps), /unknown node/);
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [] }, h.deps), /at least one/);
		h.goals.appendEvent({ type: "status", goalId: "goal_1", status: "paused", at: T0 });
		assert.throws(() => applyExerciseResult({ goalId: "goal_1", results: [{ nodeId: "c", outcome: "passed" }] }, h.deps), /active/);
		assert.equal(h.review.events.length, 0);
	});
});

describe("goalReadinessReport", () => {
	it("reports the solid fraction of each active goal's scope", () => {
		const h = world();
		for (const id of ["a", "b", "c"]) fixedReview(h, id, 4);
		const [r] = goalReadinessReport(h.deps);
		assert.equal(r?.goalId, "goal_1");
		assert.equal(r?.total, 3);
		assert.equal(r?.solid, 3);
		assert.equal(r?.ready, true);
	});
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-service.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/review-queries.ts'`.

- [ ] **Step 4: Implement the service**

```ts
// src/core/ext/review-service.ts
/**
 * The write side of the personal layer. Every function validates BEFORE its
 * first write and appends events only to the extension ledgers (REQ-int-02:
 * the content graph is read-only here; learner errors never reach it,
 * REQ-pl-15).
 */

import { randomBytes } from "node:crypto";
import type { GraphStore } from "../ports.ts";
import { deriveCards, type ContentCard } from "./cards.ts";
import { claimNodes, premisesOf } from "./deck.ts";
import { deriveGoals, type Goal } from "./goals.ts";
import type { CardsStore, GoalsStore, ReviewStore } from "./ports.ts";
import { DEFAULT_IMPLICIT_WEIGHT, deriveMarks, deriveNodeStates, type Marks, type NodeState } from "./review-state.ts";
import { isValidRating, isValidRetention, type ReviewRating } from "./review.ts";
import { DEFAULT_RETENTION, recallProbability } from "./fsrs.ts";
import type { GraphChain, GraphNode } from "../contracts.ts";

export interface ReviewDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	goalsStore: GoalsStore;
	reviewStore: ReviewStore;
	cardsStore: CardsStore;
	now?: () => string;
	newCardId?: () => string;
	implicitWeight?: number;
}

export const nowOf = (deps: ReviewDeps): string => (deps.now ? deps.now() : new Date().toISOString());

/** Everything derived from the ledgers at one instant. */
export interface Snapshot {
	now: string;
	nodes: GraphNode[];
	nodeIds: Set<string>;
	chains: GraphChain[];
	goals: Goal[];
	marks: Marks;
	states: Map<string, NodeState>;
	cards: ContentCard[];
	recall: (nodeId: string) => number;
}

export function snapshot(deps: ReviewDeps, now: string): Snapshot {
	const nodes = deps.graphStore.readNodes();
	const nodeIds = new Set(nodes.map((n) => n.id));
	const chains = deps.graphStore.readChains();
	const goals = deriveGoals(deps.goalsStore.readEvents());
	const events = deps.reviewStore.readEvents();
	const marks = deriveMarks(events);
	// Retention uses EVERY goal (paused goals keep their nodes' state, REQ-pl-13).
	const info = claimNodes(goals, chains, marks);
	const states = deriveNodeStates(events, {
		retentionOf: (id) => info.get(id)?.retention ?? DEFAULT_RETENTION,
		exists: (id) => nodeIds.has(id),
		implicitWeight: deps.implicitWeight ?? DEFAULT_IMPLICIT_WEIGHT,
	});
	return {
		now,
		nodes,
		nodeIds,
		chains,
		goals,
		marks,
		states,
		cards: deriveCards(deps.cardsStore.readEvents()),
		recall: (id) => recallProbability(states.get(id)?.card ?? null, now),
	};
}

// ─── reviews ────────────────────────────────────────────────────────────────

export interface RecordReviewInput {
	nodeId: string;
	channel: "fixed" | "dialogic";
	rating: number;
	durationSec: number;
	question?: string;
	answer?: string;
	/** Dialogic only: premises the dialogue found weak (REQ-pl-15). */
	weakPremises?: string[];
}

export interface RecordReviewResult {
	dueAt: string;
	credited: string[];
	penalised: string[];
}

/**
 * One real review plus, for a dialogic review, its implicit events on the
 * premises (REQ-pl-09): success (rating >= 2, i.e. not "Again") credits
 * every premise NOT flagged weak; failure (rating 1) penalises ONLY the
 * premises flagged weak. A premise with no state yet is left alone.
 */
export function recordReview(input: RecordReviewInput, deps: ReviewDeps): RecordReviewResult {
	const now = nowOf(deps);
	const snap = snapshot(deps, now);
	if (!snap.nodeIds.has(input.nodeId)) throw new Error(`unknown node: ${input.nodeId}`);
	if (!isValidRating(input.rating)) throw new Error("rating must be 1, 2, 3 or 4");
	if (!Number.isFinite(input.durationSec) || input.durationSec < 0) throw new Error("durationSec must be >= 0");
	const weak = input.weakPremises ?? [];
	if (input.channel !== "dialogic" && weak.length > 0) throw new Error("only a dialogic review can flag weak premises");
	const premises = premisesOf(input.nodeId, snap.chains);
	for (const w of weak) if (!premises.includes(w)) throw new Error(`weak premise ${w} is not a premise of ${input.nodeId}`);
	const rating: ReviewRating = input.rating;

	deps.reviewStore.appendEvent({
		type: "review",
		nodeId: input.nodeId,
		channel: input.channel,
		rating,
		durationSec: input.durationSec,
		at: now,
		...(input.question !== undefined ? { question: input.question } : {}),
		...(input.answer !== undefined ? { answer: input.answer } : {}),
		...(input.channel === "dialogic" ? { weakPremises: weak } : {}),
	});

	const credited: string[] = [];
	const penalised: string[] = [];
	if (input.channel === "dialogic") {
		const targets = rating >= 2 ? premises.filter((p) => !weak.includes(p)) : weak;
		for (const p of targets) {
			if (!snap.states.has(p)) continue;
			deps.reviewStore.appendEvent({
				type: "implicit",
				nodeId: p,
				viaNodeId: input.nodeId,
				outcome: rating >= 2 ? "credit" : "penalty",
				at: now,
			});
			(rating >= 2 ? credited : penalised).push(p);
		}
	}
	const after = snapshot(deps, now).states.get(input.nodeId);
	return { dueAt: (after?.card.due ?? new Date(now)).toISOString(), credited, penalised };
}

// ─── cards ──────────────────────────────────────────────────────────────────

function newCardId(deps: ReviewDeps): string {
	return deps.newCardId ? deps.newCardId() : `card_${randomBytes(6).toString("hex")}`;
}

function requireNode(deps: ReviewDeps, nodeId: string): void {
	if (!deps.graphStore.readNodes().some((n) => n.id === nodeId)) throw new Error(`unknown node: ${nodeId}`);
}

/** REQ-pl-02: the user's own card is schedulable at once. */
export function createUserCard(input: { nodeId: string; question: string; answer: string }, deps: ReviewDeps): string {
	requireNode(deps, input.nodeId);
	const cardId = newCardId(deps);
	deps.cardsStore.appendEvent({ type: "created", cardId, ...input, author: "user", status: "active", at: nowOf(deps) });
	return cardId;
}

/** REQ-pl-03: an agent's card is a draft until the user approves it. */
export function proposeAgentCard(input: { nodeId: string; question: string; answer: string }, deps: ReviewDeps): string {
	requireNode(deps, input.nodeId);
	const cardId = newCardId(deps);
	deps.cardsStore.appendEvent({ type: "created", cardId, ...input, author: "agent", status: "draft", at: nowOf(deps) });
	return cardId;
}

function cardById(deps: ReviewDeps, cardId: string): ContentCard {
	const card = deriveCards(deps.cardsStore.readEvents()).find((c) => c.id === cardId);
	if (card === undefined) throw new Error(`unknown card: ${cardId}`);
	return card;
}

/** The user's approval of a draft. Only a draft can be approved. */
export function approveCard(cardId: string, deps: ReviewDeps): void {
	if (cardById(deps, cardId).status !== "draft") throw new Error("only a draft card can be approved");
	deps.cardsStore.appendEvent({ type: "status", cardId, status: "active", at: nowOf(deps) });
}

export function retireCard(cardId: string, deps: ReviewDeps): void {
	cardById(deps, cardId);
	deps.cardsStore.appendEvent({ type: "status", cardId, status: "retired", at: nowOf(deps) });
}

// ─── manual marks ───────────────────────────────────────────────────────────

export function setPinned(nodeId: string, pinned: boolean, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	const at = nowOf(deps);
	deps.reviewStore.appendEvent({ type: "pin", nodeId, pinned, at });
	if (pinned) deps.reviewStore.appendEvent({ type: "retire", nodeId, retired: false, at });
}

export function setRetired(nodeId: string, retired: boolean, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	const at = nowOf(deps);
	deps.reviewStore.appendEvent({ type: "retire", nodeId, retired, at });
	if (retired) deps.reviewStore.appendEvent({ type: "pin", nodeId, pinned: false, at });
}

/** REQ-pl-05: fix the channel of a node; null returns it to automatic assignment. */
export function setChannelPin(nodeId: string, channel: "fixed" | "dialogic" | null, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	deps.reviewStore.appendEvent({ type: "channel", nodeId, channel, at: nowOf(deps) });
}

/** REQ-pl-08: per-goal desired retention. */
export function setGoalRetention(goalId: string, retention: number, deps: ReviewDeps): void {
	if (!isValidRetention(retention)) throw new Error("retention must be between 0.7 and 0.97");
	if (!deriveGoals(deps.goalsStore.readEvents()).some((g) => g.id === goalId)) throw new Error(`unknown goal: ${goalId}`);
	deps.reviewStore.appendEvent({ type: "retention", goalId, retention, at: nowOf(deps) });
}

// ─── goal completion ────────────────────────────────────────────────────────

export type ExerciseOutcome = "passed" | "weak" | "failed";

export interface ExerciseResult {
	goalId: string;
	results: Array<{ nodeId: string; outcome: ExerciseOutcome }>;
}

/**
 * REQ-pl-14 — the ONLY writer of a goal's `reached` status. Each per-node
 * outcome becomes an `exercise` review event ("passed" is Good; "weak" and
 * "failed" are Again, which makes the node due again). The goal is marked
 * reached only if every result passed AND the set covers every target node.
 */
export function applyExerciseResult(input: ExerciseResult, deps: ReviewDeps): { reached: boolean } {
	const goal = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === input.goalId);
	if (goal === undefined) throw new Error(`unknown goal: ${input.goalId}`);
	if (goal.status !== "active") throw new Error("only an active goal can take an exercise result");
	if (input.results.length === 0) throw new Error("an exercise result needs at least one node");
	const known = new Set(deps.graphStore.readNodes().map((n) => n.id));
	for (const r of input.results) if (!known.has(r.nodeId)) throw new Error(`unknown node: ${r.nodeId}`);
	const at = nowOf(deps);
	for (const r of input.results) {
		deps.reviewStore.appendEvent({
			type: "review",
			nodeId: r.nodeId,
			channel: "exercise",
			rating: r.outcome === "passed" ? 3 : 1,
			durationSec: 0,
			at,
		});
	}
	const allPassed = input.results.every((r) => r.outcome === "passed");
	const covered = goal.targetNodeIds.every((t) => input.results.some((r) => r.nodeId === t));
	const reached = allPassed && covered;
	if (reached) deps.goalsStore.appendEvent({ type: "status", goalId: goal.id, status: "reached", at });
	return { reached };
}
```

- [ ] **Step 5: Implement the queries**

```ts
// src/core/ext/review-queries.ts
/**
 * The read side of the personal layer: today's plan, the next item the
 * review agent should run, and per-goal readiness. Nothing here writes.
 */

import { computeDeck, goalReadiness, premisesOf } from "./deck.ts";
import { computeReviewStats, dailyPlan, DEFAULT_PLAN_PARAMS, type DailyPlan, type PlanParams } from "./daily-plan.ts";
import { goalScope } from "./goals.ts";
import { pickVariant, activeCardsOf } from "./cards.ts";
import { nowOf, snapshot, type ReviewDeps, type Snapshot } from "./review-service.ts";

/**
 * ASSUMED INTERFACE (child spec 1, source verification, planned in
 * parallel): the trust level of a node derived from its latest
 * verification event. Until that spec lands the composition root passes
 * `() => "unverified"`.
 */
export type TrustLevel = "unverified" | "sourced" | "contested" | "refuted";

export interface QueryDeps extends ReviewDeps {
	params?: PlanParams;
	trustOf?: (nodeId: string) => TrustLevel;
}

export function computePlan(deps: QueryDeps, dayStart: string): { plan: DailyPlan; snap: Snapshot } {
	const snap = snapshot(deps, nowOf(deps));
	const deck = computeDeck({
		goals: snap.goals,
		chains: snap.chains,
		nodeIds: snap.nodeIds,
		marks: snap.marks,
		recall: snap.recall,
	});
	const stats = computeReviewStats(deps.reviewStore.readEvents(), dayStart);
	const plan = dailyPlan({
		now: snap.now,
		deck,
		states: snap.states,
		stats,
		hasActiveCard: (id) => activeCardsOf(snap.cards, id).length > 0,
		params: deps.params ?? DEFAULT_PLAN_PARAMS,
	});
	return { plan, snap };
}

export interface PremiseView {
	id: string;
	name: string;
	statement: string;
}

export type NextItem =
	| {
			kind: "item";
			nodeId: string;
			name: string;
			statement: string;
			trust: TrustLevel;
			channel: "fixed" | "dialogic";
			reason: "due" | "new";
			/** Read from the CURRENT chains (umbrella REQ-review-05). Empty for a fact. */
			premises: PremiseView[];
			/** Fixed channel only: the variant to show (the answer is for the agent, not the learner). */
			card?: { cardId: string; question: string; answer: string };
			/** The last questions asked on this node, so the agent asks a new one (REQ-pl-07). */
			recentQuestions: string[];
			remainingItems: number;
	  }
	| { kind: "empty"; deferred: number; needsCard: string[] };

export function nextItem(deps: QueryDeps, dayStart: string): NextItem {
	const { plan, snap } = computePlan(deps, dayStart);
	const first = plan.items[0];
	if (first === undefined) {
		return { kind: "empty", deferred: plan.deferred.length, needsCard: plan.needsCard };
	}
	const node = snap.nodes.find((n) => n.id === first.nodeId);
	if (node === undefined) return { kind: "empty", deferred: plan.deferred.length, needsCard: plan.needsCard };
	const premises: PremiseView[] = premisesOf(first.nodeId, snap.chains).flatMap((id) => {
		const p = snap.nodes.find((n) => n.id === id);
		return p === undefined ? [] : [{ id, name: p.name, statement: p.statement }];
	});
	const variant =
		first.channel === "fixed"
			? pickVariant(snap.cards, first.nodeId, snap.states.get(first.nodeId)?.fixedReviews ?? 0)
			: undefined;
	const recentQuestions = deps.reviewStore
		.readEvents()
		.flatMap((e) => (e.type === "review" && e.nodeId === first.nodeId && e.question !== undefined ? [e.question] : []))
		.slice(-3);
	return {
		kind: "item",
		nodeId: node.id,
		name: node.name,
		statement: node.statement,
		trust: deps.trustOf?.(node.id) ?? "unverified",
		channel: first.channel,
		reason: first.reason,
		premises,
		...(variant ? { card: { cardId: variant.id, question: variant.question, answer: variant.answer } } : {}),
		recentQuestions,
		remainingItems: plan.items.length,
	};
}

/** Per-goal readiness for the exercise set (spec: "when most of a goal's scope is solid"). */
export function goalReadinessReport(
	deps: ReviewDeps,
): Array<{ goalId: string; title: string; solid: number; total: number; ready: boolean }> {
	const snap = snapshot(deps, nowOf(deps));
	return snap.goals
		.filter((g) => g.status === "active")
		.map((g) => ({
			goalId: g.id,
			title: g.title,
			...goalReadiness(goalScope(g.targetNodeIds, snap.chains), snap.recall),
		}));
}

export interface NodeReviewView {
	dueAt: string | null;
	reps: number;
	pinned: boolean;
	retired: boolean;
}

/** Review state of one node for the node panel; null when it has no state and no manual mark. */
export function nodeReviewView(deps: ReviewDeps, nodeId: string): NodeReviewView | null {
	const snap = snapshot(deps, nowOf(deps));
	const state = snap.states.get(nodeId);
	const pinned = snap.marks.pinned.has(nodeId);
	const retired = snap.marks.retired.has(nodeId);
	if (state === undefined && !pinned && !retired) return null;
	return { dueAt: state ? state.card.due.toISOString() : null, reps: state?.card.reps ?? 0, pinned, retired };
}
```

- [ ] **Step 6: Run it and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-service.test.ts`
Expected: PASS, `pass 26`.

- [ ] **Step: Commit**

```bash
git add src/core/ext/review-service.ts src/core/ext/review-queries.ts tests/helpers/ext-memory-stores.ts tests/ext-review-service.test.ts
git commit -m "feat(ext): add review service, plan queries and exercise results" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 9: Review agent: tools, instructions, construction (REQ-pl-06, REQ-pl-07, REQ-pl-03)

**Files:**
- Modify: `src/agent/teacher-agent.ts` (upstream touchpoint: one optional field)
- Create: `src/agent/ext/review-tools.ts`, `src/agent/ext/review-instructions.ts`, `src/agent/ext/review-agent.ts`
- Test: `tests/ext-review-tools.test.ts`

Contract:
- `next_item` presents the plan head and remembers when (turn-local map; the stored record is the fallback across turns). `record_review` takes only `nodeId`, `rating` (1 to 4) and optional `question`, `answer`, `weakPremises`; the CHANNEL is the one `next_item` presented and the DURATION is measured (now minus the presentation, clamped to 1 to 900 s), so the model cannot mislabel either. A node that was not presented, or whose presentation is already recorded, is refused. A service rejection becomes a retryable error result.
- `propose_card` only drafts. Questions go through upstream's `ask_user_question` (no options = free recall; options = multiple choice), reused unchanged.
- The agent is `createPracticeAgent` with `tools` and the new `instructions` option; upstream's prompt directories, override keys and packaging are untouched.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-review-tools.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { REVIEW_INSTRUCTIONS } from "../src/agent/ext/review-instructions.ts";
import { createReviewAgent } from "../src/agent/ext/review-agent.ts";
import { reviewTools, type ReviewToolContext } from "../src/agent/ext/review-tools.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import type { NextItem } from "../src/core/ext/review-queries.ts";
import type { RecordReviewInput } from "../src/core/ext/review-service.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const ITEM = (nodeId: string, channel: "fixed" | "dialogic"): NextItem => ({
	kind: "item", nodeId, name: nodeId, statement: `${nodeId} holds.`, trust: "unverified", channel, reason: "due",
	premises: [], recentQuestions: [], remainingItems: 1,
});

function fixture(over: { next?: NextItem; messages?: LhMessage[]; recordThrows?: string } = {}) {
	let clock = 1_000_000;
	const recorded: RecordReviewInput[] = [];
	const drafts: Array<{ nodeId: string; question: string; answer: string }> = [];
	const ctx: ReviewToolContext = {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages: over.messages ?? [], kind: "review" }) },
		nextItem: () => over.next ?? ITEM("n_1", "fixed"),
		record: (input) => {
			if (over.recordThrows) throw new Error(over.recordThrows);
			recorded.push(input);
			return { dueAt: "2026-11-09T10:00:00.000Z", credited: ["n_2"], penalised: [] };
		},
		proposeCard: (input) => (drafts.push(input), "card_x"),
		nowMs: () => clock,
	};
	return { tools: reviewTools(ctx), recorded, drafts, advance: (ms: number) => (clock += ms), ctx };
}
const run = (t: { execute: (...a: any[]) => Promise<any> } | undefined, input: unknown) => t!.execute("call_1", input);
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("review tools registry", () => {
	it("has exactly next_item, record_review, propose_card and upstream's ask_user_question", () => {
		assert.deepEqual(Object.keys(fixture().tools).sort(), ["ask_user_question", "next_item", "propose_card", "record_review"]);
	});
});

describe("record_review", () => {
	it("records with the channel next_item presented and the measured duration (REQ-pl-04)", async () => {
		const f = fixture({ next: ITEM("n_1", "dialogic") });
		await run(f.tools.next_item, {});
		f.advance(95_400);
		const res = await run(f.tools.record_review, { nodeId: "n_1", rating: 3, question: "Why?", weakPremises: ["n_2"] });
		assert.equal(res.isError, undefined);
		assert.deepEqual(f.recorded, [{ nodeId: "n_1", channel: "dialogic", rating: 3, durationSec: 95, question: "Why?", weakPremises: ["n_2"] }]);
		assert.match(text(res), /Next review 2026-11-09/);
	});

	it("clamps the duration to [1, 900] seconds", async () => {
		const f = fixture();
		await run(f.tools.next_item, {});
		f.advance(10);
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		await run(f.tools.next_item, {});
		f.advance(99_999_000);
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		assert.deepEqual(f.recorded.map((r) => r.durationSec), [1, 900]);
	});

	it("refuses a node that next_item did not present, and writes nothing", async () => {
		const f = fixture();
		const res = await run(f.tools.record_review, { nodeId: "n_9", rating: 3 });
		assert.equal(res.isError, true);
		assert.equal(f.recorded.length, 0);
	});

	it("refuses to record the same presentation twice in a turn", async () => {
		const f = fixture();
		await run(f.tools.next_item, {});
		await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		const again = await run(f.tools.record_review, { nodeId: "n_1", rating: 3 });
		assert.equal(again.isError, true);
		assert.equal(f.recorded.length, 1);
	});

	it("finds a presentation from an earlier turn in the stored record, once", async () => {
		const result = (toolName: string, details: unknown, timestamp: number): LhMessage & ToolResultMessage => ({
			id: `m_${toolName}_${timestamp}`, role: "toolResult", toolCallId: "x", toolName,
			content: [{ type: "text", text: "" }], details: details as never, isError: false, timestamp,
		});
		const messages: LhMessage[] = [result("next_item", { kind: "item", nodeId: "n_1", channel: "fixed" }, 1_000_000 - 30_000)];
		const f = fixture({ messages });
		const ok = await run(f.tools.record_review, { nodeId: "n_1", rating: 4 });
		assert.equal(ok.isError, undefined);
		assert.equal(f.recorded[0]?.durationSec, 30);
		const used = fixture({ messages: [...messages, result("record_review", { nodeId: "n_1" }, 1_000_000 - 1000)] });
		const second = await run(used.tools.record_review, { nodeId: "n_1", rating: 4 });
		assert.equal(second.isError, true);
	});

	it("turns a service rejection into a retryable error result", async () => {
		const f = fixture({ recordThrows: "weak premise zzz is not a premise of n_1" });
		await run(f.tools.next_item, {});
		const res = await run(f.tools.record_review, { nodeId: "n_1", rating: 2, weakPremises: ["zzz"] });
		assert.equal(res.isError, true);
		assert.match(text(res), /not a premise/);
	});
});

describe("next_item and propose_card", () => {
	it("next_item returns the plan head as data (details carry kind, nodeId, channel)", async () => {
		const res = await run(fixture({ next: ITEM("n_7", "dialogic") }).tools.next_item, {});
		assert.deepEqual({ k: res.details.kind, n: res.details.nodeId, c: res.details.channel }, { k: "item", n: "n_7", c: "dialogic" });
	});
	it("next_item passes an empty plan through", async () => {
		const res = await run(fixture({ next: { kind: "empty", deferred: 2, needsCard: ["n_3"] } }).tools.next_item, {});
		assert.equal(res.details.kind, "empty");
	});
	it("propose_card drafts through the context and says it is inactive (REQ-pl-03)", async () => {
		const f = fixture();
		const res = await run(f.tools.propose_card, { nodeId: "n_1", question: "Q?", answer: "A." });
		assert.deepEqual(f.drafts, [{ nodeId: "n_1", question: "Q?", answer: "A." }]);
		assert.match(text(res), /inactive/);
	});
});

describe("review agent", () => {
	it("constructs with the review instructions and does not touch the composed practice prompt", () => {
		const agent = createReviewAgent(fixture().ctx, {
			engine: {
				model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		});
		assert.equal(typeof agent.prompt, "function");
		assert.notEqual(composeInstructions("practice"), REVIEW_INSTRUCTIONS);
	});

	it("the instructions name every tool the agent has and the three channels' rules (REQ-pl-07)", () => {
		for (const name of ["next_item", "record_review", "propose_card", "ask_user_question"]) assert.match(REVIEW_INSTRUCTIONS, new RegExp(name));
		assert.match(REVIEW_INSTRUCTIONS, /recentQuestions/);
		assert.match(REVIEW_INSTRUCTIONS, /weakPremises/);
		assert.match(REVIEW_INSTRUCTIONS, /Agree/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-tools.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/review-instructions.ts'`.

- [ ] **Step 3: Add the `instructions` option (upstream touchpoint)**

In `src/agent/teacher-agent.ts`, in `interface AgentBuildOptions`, insert before the `/** Native conversation identity` comment (right after the `promptSwitches?: Record<string, boolean>;` line):

```ts
	/** A complete system prompt that replaces the composed one (extension
	 *  agents, docs/ext/TOUCHPOINTS.md). Absent = the kind's composition. */
	instructions?: string;
```

and in `baseAgentOptions` replace

```ts
	const composedPrompt = opts.promptSwitches
		? composeInstructions(kind, opts.promptSwitches)
		: composedInstructions[kind]!;
```

with

```ts
	const composedPrompt =
		opts.instructions ??
		(opts.promptSwitches ? composeInstructions(kind, opts.promptSwitches) : composedInstructions[kind]!);
```

- [ ] **Step 4: Write the tools**

```ts
// src/agent/ext/review-tools.ts
/**
 * THE REVIEW AGENT'S TOOLS (personal-layer spec REQ-pl-06, REQ-pl-07).
 * `next_item` presents the head of today's plan; `record_review` writes the
 * learner-confirmed rating; `propose_card` drafts a card (never active).
 * Questions to the learner go through upstream's own `ask_user_question`
 * (free recall = no options; multiple choice = options), so the existing
 * chat UI is the whole surface.
 *
 * Duration is MEASURED, not declared: the time between the `next_item`
 * result that presented a node and the `record_review` for it. The tool
 * also decides the channel (from what `next_item` presented) so the model
 * cannot mislabel a review.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../core/native-messages.ts";
import type { NextItem } from "../../core/ext/review-queries.ts";
import type { RecordReviewInput, RecordReviewResult } from "../../core/ext/review-service.ts";
import { askUserQuestionTool } from "../tools.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import { healToolRecord } from "../tools/heal.ts";

export const MAX_REVIEW_SEC = 900; // an item left open longer than this counts as 15 minutes

export interface ReviewToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	nextItem(): NextItem;
	record(input: RecordReviewInput): RecordReviewResult;
	proposeCard(input: { nodeId: string; question: string; answer: string }): string;
	/** Epoch milliseconds; injectable for tests. */
	nowMs?: () => number;
}

interface Shown {
	at: number;
	channel: "fixed" | "dialogic";
}

/**
 * When was `nodeId` last presented and not yet recorded? Turn-local memory
 * first (the record only lands at turn end), then the stored record: scan
 * back for the newest `next_item` result for the node, stopping at a clean
 * `record_review` for it (that presentation is already used up).
 */
function findShown(ctx: ReviewToolContext, nodeId: string, local: Map<string, Shown>): Shown | undefined {
	const mine = local.get(nodeId);
	if (mine !== undefined) return mine;
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.isError) continue;
		const d = m.details as { kind?: string; nodeId?: string; channel?: string } | null | undefined;
		if (m.toolName === "record_review" && d?.nodeId === nodeId) return undefined;
		if (m.toolName === "next_item" && d?.kind === "item" && d.nodeId === nodeId) {
			if (d.channel !== "fixed" && d.channel !== "dialogic") return undefined;
			return { at: m.timestamp, channel: d.channel };
		}
	}
	return undefined;
}

const emptyInput = Type.Object({});

const recordInput = Type.Object({
	nodeId: Type.String({ minLength: 1, description: "The node id exactly as next_item presented it." }),
	rating: Type.Integer({
		minimum: 1,
		maximum: 4,
		description: "The rating the LEARNER confirmed: 1 Again, 2 Hard, 3 Good, 4 Easy.",
	}),
	question: Type.Optional(Type.String({ description: "Dialogic only: the question you asked, verbatim." })),
	answer: Type.Optional(Type.String({ description: "The learner's answer, in one or two sentences." })),
	weakPremises: Type.Optional(
		Type.Array(Type.String(), { description: "Dialogic only: ids of premises the dialogue found weak (subset of the item's premises)." }),
	),
});

const proposeInput = Type.Object({
	nodeId: Type.String({ minLength: 1 }),
	question: Type.String({ minLength: 1, description: "A self-contained question answerable from memory." }),
	answer: Type.String({ minLength: 1, description: "The reference answer." }),
});

export function reviewTools(ctx: ReviewToolContext): Record<string, AgentTool<any>> {
	const nowMs = ctx.nowMs ?? Date.now;
	const local = new Map<string, Shown>();

	const next_item: AgentTool<typeof emptyInput> = {
		name: "next_item",
		label: "next_item",
		description:
			"Present the next node of today's review plan, or report that nothing is left. Returns the node, its trust level, its premises read from the current graph, " +
			"the fixed card to show (fixed channel only) and the questions already asked on this node. Call it at the start and after every recorded review.",
		parameters: emptyInput,
		executionMode: "sequential",
		execute: async () => {
			const item = ctx.nextItem();
			if (item.kind === "item") local.set(item.nodeId, { at: nowMs(), channel: item.channel });
			return toToolResult(item);
		},
	};

	const record_review: AgentTool<typeof recordInput> = {
		name: "record_review",
		label: "record_review",
		description:
			"Record the review of the node next_item presented, with the rating the learner confirmed. The channel and the duration are set by the system. " +
			"For a dialogic item pass the question you asked and any weak premises.",
		parameters: recordInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const shown = findShown(ctx, input.nodeId, local);
			if (shown === undefined) {
				return invalidInputResult("record_review", [
					"this node was not presented by next_item, or its review is already recorded — call next_item",
				]);
			}
			const durationSec = Math.min(MAX_REVIEW_SEC, Math.max(1, Math.round((nowMs() - shown.at) / 1000)));
			try {
				const res = ctx.record({
					nodeId: input.nodeId,
					channel: shown.channel,
					rating: input.rating,
					durationSec,
					...(input.question !== undefined ? { question: input.question } : {}),
					...(input.answer !== undefined ? { answer: input.answer } : {}),
					...(input.weakPremises !== undefined ? { weakPremises: input.weakPremises } : {}),
				});
				local.delete(input.nodeId);
				return {
					...toToolResult(
						`Recorded (${shown.channel}, ${durationSec}s). Next review ${res.dueAt}. ` +
							`Credited premises: ${res.credited.join(", ") || "none"}. Penalised premises: ${res.penalised.join(", ") || "none"}.`,
					),
					details: { nodeId: input.nodeId },
				};
			} catch (e) {
				return invalidInputResult("record_review", [e instanceof Error ? e.message : String(e)]);
			}
		},
	};

	const propose_card: AgentTool<typeof proposeInput> = {
		name: "propose_card",
		label: "propose_card",
		description:
			"Draft a fixed card for a node. It is stored as a DRAFT and is not scheduled until the learner approves it outside this chat.",
		parameters: proposeInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			try {
				const cardId = ctx.proposeCard(input);
				return toToolResult(`Draft ${cardId} saved. It is inactive until the learner approves it.`);
			} catch (e) {
				return invalidInputResult("propose_card", [e instanceof Error ? e.message : String(e)]);
			}
		},
	};

	return healToolRecord({ next_item, record_review, propose_card, ask_user_question: askUserQuestionTool });
}
```

- [ ] **Step 5: Write the instructions**

```ts
// src/agent/ext/review-instructions.ts
/**
 * The review agent's system prompt. A TypeScript constant on purpose: it
 * rides AgentBuildOptions.instructions, so no upstream prompt directory,
 * override key or packaging rule changes (docs/ext/TOUCHPOINTS.md).
 */

export const REVIEW_INSTRUCTIONS = `You run the learner's daily review of a knowledge graph. One node at a time, you help them recall and reason, then record how it went. You teach nothing new here and you never edit the graph.

## The loop

1. Call next_item. If it reports nothing left, say so in one sentence (mention how many items were deferred to tomorrow and which nodes still need a card), and stop.
2. Run the item by its channel (below).
3. Call record_review with the rating the LEARNER confirmed. Then call next_item again, unless the learner asked to stop.

Ask ONE question per turn with ask_user_question, then end your turn: the answer arrives as the next message. No options means free recall; options mean multiple choice.

## Fixed items (channel "fixed")

Show card.question verbatim with ask_user_question and no options. When the answer arrives, show card.answer, say in one or two sentences how the learner's answer compares, then ask for the rating with ask_user_question and the options Again, Hard, Good, Easy (name your suggestion in the question text, the learner decides). Record with record_review. card.answer is for you until the learner has answered; never reveal it earlier.

## Dialogic items (channel "dialogic")

You get the node statement, its trust level and its premises. Ask a NEW question, never one of recentQuestions: something that makes the learner use the node (apply it, justify it from its premises, tell it from a near neighbour), not recite its statement. Reason with the learner across as many turns as it takes: ask follow-ups, give a hint only when they are stuck, and let them correct themselves. Stay inside what the statement and the premises say; if you are unsure of a fact, say so instead of asserting it.

Trust level: "unverified" means the statement comes from earlier sessions and has not been checked against a source; "contested" or "refuted" means a check disagreed with it. Tell the learner when the trust level is not "sourced" and the question depends on it, and do not rate them down for disagreeing with a refuted statement.

When you can judge, PROPOSE a rating and the weak premises in a single ask_user_question with the options "Agree", "Again", "Hard", "Good", "Easy". State your proposal and one reason in the question text: for example "I would say Good; the weak premise was <name>." If the learner picks a rating other than yours, and it is Again or Hard, ask in one more ask_user_question (multi-select) which premises were weak, offering the item's premises. Then call record_review with the confirmed rating, the question you asked, and weakPremises (premise ids from the item; empty when none).

Ratings: Again = could not recall or reason it; Hard = got there with real effort or help; Good = correct with a little effort; Easy = immediate and fluent.

## Cards

If the dialogue shows a question worth keeping, call propose_card. It is only a draft until the learner approves it outside this chat; never tell them it is active.

## Style

Be brief and direct. Maths in LaTeX with $...$ and $$...$$. Do not praise by reflex and do not lecture.`;
```

- [ ] **Step 6: Write the agent**

```ts
// src/agent/ext/review-agent.ts
/**
 * The review session's agent (spec: session kind `review`). It rides the
 * practice agent's construction (a bare registry, the question-stop rule,
 * ordinary final prose) with its OWN tools and instructions, so upstream's
 * prompt-segment machinery is untouched; the only upstream edit is the
 * optional `instructions` field of AgentBuildOptions.
 */

import { createPracticeAgent, type AgentBuildOptions } from "../teacher-agent.ts";
import { REVIEW_INSTRUCTIONS } from "./review-instructions.ts";
import { reviewTools, type ReviewToolContext } from "./review-tools.ts";

export function createReviewAgent(ctx: ReviewToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: reviewTools(ctx), instructions: REVIEW_INSTRUCTIONS },
	);
}
```

- [ ] **Step 7: Run the new test and the upstream agent tests**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-tools.test.ts tests/practice-agents.test.ts tests/prompt-overrides.test.ts
```

Expected: PASS (`pass 12` for the new file; the upstream files unchanged).

- [ ] **Step: Commit**

```bash
git add src/agent/teacher-agent.ts src/agent/ext tests/ext-review-tools.test.ts
git commit -m "feat(ext): add the review agent, tools and instructions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 10: Server surface and node-panel contribution (REQ-pl-05, REQ-pl-13)

**Files:**
- Create: `src/server/ext/personal-layer.ts`, `src/server/ext/personal-trust.ts`, `src/server/ext/personal-panel.ts`
- Create or modify: `src/server/ext/index.ts`
- Test: `tests/ext-personal-layer.test.ts`

Contract: `createPersonalLayer(deps)` is the only thing routes, the chat handler and the node panel talk to: `plan()` (items and deferred with node names, nodes needing a card, counts, per-goal readiness), `startReviewSession()` (creates a `review` chat), `listCards`, `createCard` (user card), `cardAction("approve" | "retire")`, `mark` (pin, retire, channel pin, goal retention), `nodeReview`, `reviewToolContext`. `trustOfNode` is the single place that will read verification (it returns `"unverified"` until Task 15).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-personal-layer.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersonalLayer, startOfLocalDay } from "../src/server/ext/personal-layer.ts";
import { createPersonalPanel } from "../src/server/ext/personal-panel.ts";
import { addGoal, chain, harness, node } from "./helpers/ext-memory-stores.ts";

const T0 = "2026-11-04T10:00:00.000Z";

function layer() {
	const h = harness({ nodes: [node("a", "Alpha"), node("b", "Beta")], chains: [chain("arg_1", ["a"], "b")], now: T0 });
	addGoal(h, "goal_1", ["b"]);
	const created: string[] = [];
	const l = createPersonalLayer({
		...h.deps,
		dayStart: () => "2026-11-04T00:00:00.000Z",
		createReviewChat: (title) => (created.push(title), { id: "chat_r1" }),
	});
	return { h, l, created };
}

describe("personal layer surface", () => {
	it("starts a review session by creating a review chat", () => {
		const { l, created } = layer();
		assert.deepEqual(l.startReviewSession(), { chatId: "chat_r1" });
		assert.equal(created.length, 1);
	});

	it("plan lists names, what needs a card, and goal readiness", () => {
		const { l } = layer();
		const p = l.plan();
		assert.deepEqual(p.needsCard, [{ nodeId: "a", name: "Alpha" }]);
		assert.deepEqual(p.items.map((i) => [i.nodeId, i.name, i.channel]), [["b", "Beta", "dialogic"]]);
		assert.equal(p.goals[0]?.goalId, "goal_1");
	});

	it("creating a card makes its node plannable; approve and retire act on drafts and cards", () => {
		const { l, h } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.equal(l.plan().items.some((i) => i.nodeId === "a"), true);
		assert.equal(l.listCards("a").length, 1);
		assert.equal(l.listCards("b").length, 0);
		assert.throws(() => l.cardAction(cardId, "approve"), /draft/);
		l.cardAction(cardId, "retire");
		assert.equal(l.plan().items.some((i) => i.nodeId === "a"), false);
		void h;
	});

	it("mark dispatches pin, retire, channel and retention", () => {
		const { l, h } = layer();
		l.mark({ nodeId: "a", pinned: true });
		l.mark({ nodeId: "a", retired: true });
		l.mark({ nodeId: "b", channel: "fixed" });
		l.mark({ goalId: "goal_1", retention: 0.85 });
		assert.deepEqual(h.review.events.map((e) => e.type), ["pin", "retire", "retire", "pin", "channel", "retention"]);
	});

	it("builds the review tool context over the same stores", async () => {
		const { l, h } = layer();
		const ctx = l.reviewToolContext("chat_r1", { getChat: () => null });
		const item = ctx.nextItem();
		assert.equal(item.kind === "item" && item.nodeId, "b");
		ctx.record({ nodeId: "b", channel: "dialogic", rating: 3, durationSec: 60 });
		assert.equal(h.review.events.length, 1);
		const cardId = ctx.proposeCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.equal(h.cards.events[0]?.type === "created" && h.cards.events[0].status, "draft");
		assert.ok(cardId.startsWith("card_"));
	});
});

describe("startOfLocalDay", () => {
	it("is local midnight of the given instant", () => {
		const d = new Date(startOfLocalDay(new Date("2026-11-04T15:30:00")));
		assert.equal(d.getHours(), 0);
		assert.equal(d.getMinutes(), 0);
		assert.equal(d.getDate(), 4);
	});
});

describe("node panel contribution", () => {
	it("nodeReview is null for an untouched node, then reports reps, due date and marks", () => {
		const { l } = layer();
		assert.equal(l.nodeReview("a"), null);
		l.mark({ nodeId: "a", pinned: true });
		assert.deepEqual(l.nodeReview("a"), { dueAt: null, reps: 0, pinned: true, retired: false });
		l.reviewToolContext("c", { getChat: () => null }).record({ nodeId: "a", channel: "fixed", rating: 3, durationSec: 5 });
		const v = l.nodeReview("a");
		assert.equal(v?.reps, 1);
		assert.ok(v?.dueAt && Date.parse(v.dueAt) > Date.parse(T0));
	});

	it("exposes cards, review and the pin / retire / startReview handlers in the panel's shapes", () => {
		const { l, h } = layer();
		const panel = createPersonalPanel(l);
		l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.deepEqual(panel.sources.cards("a"), [{ cardId: "card_t1", question: "Q?", status: "active" }]);
		panel.handlers.pin("b");
		panel.handlers.retire("a");
		assert.equal(panel.sources.review("b")?.pinned, true);
		assert.equal(panel.sources.review("a")?.retired, true);
		assert.deepEqual(panel.handlers.startReview("a"), { chatId: "chat_r1" });
		void h;
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-personal-layer.test.ts`
Expected: FAIL with `Cannot find module '../src/server/ext/personal-layer.ts'`.

- [ ] **Step 3: Write the trust seam**

```ts
// src/server/ext/personal-trust.ts
/**
 * ASSUMED INTERFACE (source-verification plan): the live trust level of a
 * node, shown to the review agent. Until verification is wired in, every
 * node reads "unverified". The verification integration task replaces the
 * body of this one function.
 */

import type { TrustLevel } from "../../core/ext/review-queries.ts";

export function trustOfNode(_nodeId: string): TrustLevel {
	return "unverified";
}
```

- [ ] **Step 4: Write the layer**

```ts
// src/server/ext/personal-layer.ts
/**
 * The personal layer's server surface (spec 2): one factory over injected
 * stores, so tests can drive it with memory stores, and one live instance
 * for the routes and the chat handler. Routes (app/api/ext/**) are thin
 * transport over `personalLayer`; the chat handler takes
 * `personalLayer.reviewToolContext` for `review` sessions.
 */

import type { ReviewToolContext } from "../../agent/ext/review-tools.ts";
import { deriveCards } from "../../core/ext/cards.ts";
import {
	computePlan,
	goalReadinessReport,
	nextItem,
	nodeReviewView,
	type QueryDeps,
} from "../../core/ext/review-queries.ts";
import {
	approveCard,
	createUserCard,
	proposeAgentCard,
	recordReview,
	retireCard,
	setChannelPin,
	setGoalRetention,
	setPinned,
	setRetired,
} from "../../core/ext/review-service.ts";
import { stores } from "../stores.ts";
import { trustOfNode } from "./personal-trust.ts";
import { extStores } from "./stores.ts";

/** Local midnight as an ISO instant: "today" for the daily budget and the dialogic cap. */
export function startOfLocalDay(now: Date = new Date()): string {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.toISOString();
}

export interface PersonalLayerDeps extends QueryDeps {
	/** Creates a `kind: "review"` chat record. */
	createReviewChat(title: string): { id: string };
	dayStart?: () => string;
}

export type MarkRequest =
	| { nodeId: string; pinned: boolean }
	| { nodeId: string; retired: boolean }
	| { nodeId: string; channel: "fixed" | "dialogic" | null }
	| { goalId: string; retention: number };

export function createPersonalLayer(deps: PersonalLayerDeps) {
	const dayStart = deps.dayStart ?? (() => startOfLocalDay());
	return {
		/** Today's plan with node names, plus per-goal readiness for the exercise set. */
		plan() {
			const { plan, snap } = computePlan(deps, dayStart());
			const nameOf = (id: string) => snap.nodes.find((n) => n.id === id)?.name ?? id;
			const view = (i: (typeof plan.items)[number]) => ({ ...i, name: nameOf(i.nodeId) });
			return {
				items: plan.items.map(view),
				deferred: plan.deferred.map(view),
				needsCard: plan.needsCard.map((id) => ({ nodeId: id, name: nameOf(id) })),
				due: plan.due,
				capacity: plan.capacity,
				newQuota: plan.newQuota,
				remainingSec: plan.remainingSec,
				goals: goalReadinessReport(deps),
			};
		},

		nodeReview(nodeId: string) {
			return nodeReviewView(deps, nodeId);
		},

		startReviewSession(): { chatId: string } {
			return { chatId: deps.createReviewChat("Daily review").id };
		},

		listCards(nodeId?: string) {
			const cards = deriveCards(deps.cardsStore.readEvents());
			return nodeId === undefined ? cards : cards.filter((c) => c.nodeId === nodeId);
		},

		createCard(input: { nodeId: string; question: string; answer: string }): { cardId: string } {
			return { cardId: createUserCard(input, deps) };
		},

		cardAction(cardId: string, action: "approve" | "retire"): void {
			if (action === "approve") approveCard(cardId, deps);
			else retireCard(cardId, deps);
		},

		mark(req: MarkRequest): void {
			if ("goalId" in req) setGoalRetention(req.goalId, req.retention, deps);
			else if ("pinned" in req) setPinned(req.nodeId, req.pinned, deps);
			else if ("retired" in req) setRetired(req.nodeId, req.retired, deps);
			else setChannelPin(req.nodeId, req.channel, deps);
		},

		reviewToolContext(chatId: string, chatStore: ReviewToolContext["chatStore"]): ReviewToolContext {
			return {
				chatId,
				chatStore,
				nextItem: () => nextItem(deps, dayStart()),
				record: (input) => recordReview(input, deps),
				proposeCard: (input) => proposeAgentCard(input, deps),
			};
		},
	};
}

export type PersonalLayer = ReturnType<typeof createPersonalLayer>;

export const personalLayer = createPersonalLayer({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	reviewStore: extStores.reviewStore,
	cardsStore: extStores.cardsStore,
	trustOf: trustOfNode,
	createReviewChat: (title) => stores.chatStore.createChat(title, "review"),
});
```

- [ ] **Step 5: Write the panel contribution**

```ts
// src/server/ext/personal-panel.ts
/**
 * What the personal layer contributes to the node panel (node-knowledge
 * plan: PanelSources.cards / .review and the pin / retire / startReview
 * action handlers). Structurally typed on purpose, so this file does not
 * depend on the node-knowledge types; the shapes match its PanelCard,
 * PanelReview and NodeActionHandlers. "Create card" has no handler here: a
 * card needs a question and an answer, which the panel's button supplies
 * through POST /api/ext/cards.
 */

import { personalLayer, type PersonalLayer } from "./personal-layer.ts";

export function createPersonalPanel(layer: PersonalLayer) {
	return {
		sources: {
			cards: (nodeId: string) =>
				layer.listCards(nodeId).map((c) => ({ cardId: c.id, question: c.question, status: c.status })),
			review: (nodeId: string) => layer.nodeReview(nodeId),
		},
		handlers: {
			pin: (nodeId: string) => layer.mark({ nodeId, pinned: true }),
			retire: (nodeId: string) => layer.mark({ nodeId, retired: true }),
			startReview: (_nodeId: string) => layer.startReviewSession(),
		},
	};
}

export const personalPanel = createPersonalPanel(personalLayer);
```

- [ ] **Step 6: Export from the ext server barrel**

If `src/server/ext/index.ts` does not exist, create it with:

```ts
// src/server/ext/index.ts
/** The extension layer's server barrel (re-exported by src/server/index.ts for app/ routes). */
export * from "./personal-layer.ts";
export * from "./personal-panel.ts";
```

If it exists (a sibling plan landed first), append those two `export *` lines and keep everything else.

- [ ] **Step 7: Run it and see it pass, then typecheck and lint the layer law**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-personal-layer.test.ts
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run typecheck 2>&1 | tail -5
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx eslint src/core/ext src/store/ext src/agent/ext src/server/ext 2>&1 | tail -10
```

Expected: PASS (`pass 8`); typecheck and eslint print no errors.

- [ ] **Step: Commit**

```bash
git add src/server/ext tests/ext-personal-layer.test.ts
git commit -m "feat(ext): add the personal-layer server surface" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 11: The `review` session kind (store side)

**Files:**
- Modify: `src/core/contracts/chat.ts`, `src/core/ports.ts`, `src/store/chats.ts` (upstream touchpoints)
- Test: `tests/ext-review-kind.test.ts`

Contract: `createChat(title, "review")` stamps `kind: "review"` on the record and the list; `"practice"` and the default (no `kind` field, reads as teach) are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ext-review-kind.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind review", () => {
	it("createChat(kind: 'review') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Daily review", "review");
		assert.equal(chat.kind, "review");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "review");
	});
	it("practice and the default are unchanged", () => {
		assert.equal(chatStore.createChat("p", "practice").kind, "practice");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-kind.test.ts`
Expected: FAIL (the first test: `undefined !== 'review'`).

- [ ] **Step 3: Widen the three declarations**

`src/core/contracts/chat.ts` — replace `export type ChatKind = "teach" | "practice";` with

```ts
export type ChatKind = "teach" | "practice" | "review";
```

`src/core/ports.ts` — replace `createChat(title: string, kind?: "practice"): ChatRecord;` with

```ts
	createChat(title: string, kind?: "practice" | "review"): ChatRecord;
```

`src/store/chats.ts` — replace `function createChat(title: string, kind?: "practice"): ChatRecord {` with

```ts
function createChat(title: string, kind?: "practice" | "review"): ChatRecord {
```

and replace `		...(kind === "practice" ? { kind: "practice" as const } : {}),` with

```ts
		...(kind ? { kind } : {}),
```

- [ ] **Step 4: Run it, the upstream kind test, and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-review-kind.test.ts tests/chat-kind.test.ts
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run typecheck 2>&1 | tail -10
```

Expected: tests PASS. Typecheck may report errors only in `app/chat/[id]/page.tsx` (the `Chat` prop `kind` does not accept `"review"`); Task 12 fixes it. An error anywhere else: stop and read it.

- [ ] **Step: Commit**

```bash
git add src/core/contracts/chat.ts src/core/ports.ts src/store/chats.ts tests/ext-review-kind.test.ts
git commit -m "feat(ext): add the review chat kind" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 12: Chat handler wiring and page mapping (REQ-pl-06, REQ-pl-07)

**Files:**
- Modify: `src/server/chat-handler.ts`, `app/chat/[id]/page.tsx` (upstream touchpoints)

Contract: a `review` session builds the review agent from turn one (the `buildAgent` test seam still wins), writes nothing to the graph (no extraction), and compacts like a practice session. Practice and teaching behaviour is unchanged. Apply each replacement exactly once.

- [ ] **Step 1: Imports and the helper**

After the line `import { piEngineForSpec, type PiEngine } from "../agent/models.ts";` add:

```ts
import { createReviewAgent } from "../agent/ext/review-agent.ts";
```

After the line `import { effectiveSettings, stores } from "./stores.ts";` add:

```ts
import { personalLayer } from "./ext/personal-layer.ts";
```

After the line `import type {CallUsage} from "../core/contracts.ts";` add:

```ts

/** Sessions that write nothing to the graph and compact like practice (practice, and the extension's review kind). */
const isPracticeLike = (kind: string | undefined): boolean => kind === "practice" || kind === "review";
```

- [ ] **Step 2: Replace the five practice-kind tests**

1. `kind: record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",` becomes `kind: isPracticeLike(record.kind) ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",`
2. `composeInstructions(record.kind === "practice" ? "practice" : "teacher")` becomes `composeInstructions(isPracticeLike(record.kind) ? "practice" : "teacher")`
3. `&& record.kind !== "practice" && extractionEnabled(effective.graph)` becomes `&& !isPracticeLike(record.kind) && extractionEnabled(effective.graph)`
4. `kind: freshRecord.kind === "practice" ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",` becomes `kind: isPracticeLike(freshRecord.kind) ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",`
5. `composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher")` becomes `composeInstructions(isPracticeLike(freshRecord.kind) ? "practice" : "teacher")`

- [ ] **Step 3: The agent branch**

Replace

```ts
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "practice"
			? createPracticeAgent(
```

with

```ts
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "review"
			? createReviewAgent(personalLayer.reviewToolContext(chatId, stores.chatStore), agentOpts)
		: record.kind === "practice"
			? createPracticeAgent(
```

- [ ] **Step 4: The page mapping**

In `app/chat/[id]/page.tsx` replace `kind={chat.kind ?? "teach"}` with

```tsx
			kind={chat.kind === "review" ? "teach" : (chat.kind ?? "teach")}
```

- [ ] **Step 5: Verify nothing else moved**

```bash
git diff --stat src/server/chat-handler.ts "app/chat/[id]/page.tsx"
grep -n 'kind === "practice"\|kind !== "practice"' src/server/chat-handler.ts
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run typecheck 2>&1 | tail -5
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/chat-flow.test.ts tests/practice-flow.test.ts tests/chat-kind.test.ts tests/chat-birth-stamp.test.ts tests/ext-review-kind.test.ts
```

Expected: a handful of changed lines in each file; the grep prints exactly one line (the `record.kind === "practice"` branch of the agent construction); typecheck prints no errors; tests PASS.

- [ ] **Step: Commit**

```bash
git add src/server/chat-handler.ts "app/chat/[id]/page.tsx"
git commit -m "feat(ext): run review sessions with the review agent" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 13: Routes and the server barrel line

**Files:**
- Create: `app/api/ext/review/plan/route.ts`, `app/api/ext/review/session/route.ts`, `app/api/ext/review/marks/route.ts`, `app/api/ext/cards/route.ts`, `app/api/ext/cards/[id]/route.ts`
- Modify: `src/server/index.ts` (upstream touchpoint, shared)

Contract: routes are transport only (they parse JSON, call `personalLayer`, map a thrown `Error` to a 400). The bodies are: `POST /api/ext/cards {nodeId, question, answer}`; `PATCH /api/ext/cards/:id {action: "approve" | "retire"}`; `POST /api/ext/review/marks` with one of `{nodeId, pinned}`, `{nodeId, retired}`, `{nodeId, channel: "fixed" | "dialogic" | null}`, `{goalId, retention}`.

- [ ] **Step 1: Read the Next.js route conventions (upstream AGENTS.md rule)**

```bash
ls node_modules/next/dist/docs 2>/dev/null | head -5
sed -n 1,40p AGENTS.md
```

Expected: the project's own conventions; the route files below follow the existing `app/api/graph/route.ts` style (named `GET`/`POST` exports, `Response.json`).

- [ ] **Step 2: Write the routes**

```ts
import { personalLayer } from "@/src/server";

export const dynamic = "force-dynamic";

/** Today's review plan (items, deferred, nodes needing a card) and per-goal readiness for the exercise set. */
export async function GET() {
	return Response.json(personalLayer.plan());
}
```

```ts
import { personalLayer } from "@/src/server";

/** Start a review session: creates a `kind: "review"` chat. The client then sends its first message as in any chat. */
export async function POST() {
	return Response.json(personalLayer.startReviewSession());
}
```

```ts
import { personalLayer, type MarkRequest } from "@/src/server";

/** Manual marks: pin, retire, channel pin of a node, or the desired retention of a goal. */
export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	let mark: MarkRequest | null = null;
	if (b && typeof b.goalId === "string" && typeof b.retention === "number") mark = { goalId: b.goalId, retention: b.retention };
	else if (b && typeof b.nodeId === "string" && typeof b.pinned === "boolean") mark = { nodeId: b.nodeId, pinned: b.pinned };
	else if (b && typeof b.nodeId === "string" && typeof b.retired === "boolean") mark = { nodeId: b.nodeId, retired: b.retired };
	else if (b && typeof b.nodeId === "string" && (b.channel === null || b.channel === "fixed" || b.channel === "dialogic")) {
		mark = { nodeId: b.nodeId, channel: b.channel };
	}
	if (mark === null) return Response.json({ error: "invalid mark" }, { status: 400 });
	try {
		personalLayer.mark(mark);
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
```

```ts
import { personalLayer } from "@/src/server";

export const dynamic = "force-dynamic";

/** All cards, optionally for one node: GET /api/ext/cards?nodeId=n_… */
export async function GET(req: Request) {
	const nodeId = new URL(req.url).searchParams.get("nodeId") ?? undefined;
	return Response.json({ cards: personalLayer.listCards(nodeId) });
}

/** The user writes a fixed card (active at once). */
export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as { nodeId?: unknown; question?: unknown; answer?: unknown } | null;
	if (!b || typeof b.nodeId !== "string" || typeof b.question !== "string" || typeof b.answer !== "string" || !b.question.trim() || !b.answer.trim()) {
		return Response.json({ error: "nodeId, question and answer are required" }, { status: 400 });
	}
	try {
		return Response.json(personalLayer.createCard({ nodeId: b.nodeId, question: b.question.trim(), answer: b.answer.trim() }));
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
```

```ts
import { personalLayer } from "@/src/server";

/** Approve an agent draft or retire a card: body { action: "approve" | "retire" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const b = (await req.json().catch(() => null)) as { action?: unknown } | null;
	if (!b || (b.action !== "approve" && b.action !== "retire")) {
		return Response.json({ error: 'action must be "approve" or "retire"' }, { status: 400 });
	}
	try {
		personalLayer.cardAction(id, b.action);
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
```

- [ ] **Step 3: Add the barrel line**

```bash
grep -n 'from "./ext/index.ts"' src/server/index.ts || printf '\n// The extension layer'"'"'s server surface (docs/ext/TOUCHPOINTS.md).\nexport * from "./ext/index.ts";\n' >> src/server/index.ts
tail -4 src/server/index.ts
```

Expected: the last lines contain `export * from "./ext/index.ts";` exactly once (if a sibling plan added it, the grep prints it and nothing is appended).

- [ ] **Step 4: Typecheck and lint (the `app/` import law)**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm run typecheck 2>&1 | tail -5
npx eslint app/api/ext src/server/index.ts 2>&1 | tail -10
```

Expected: no output from either.

- [ ] **Step 5: Smoke the routes against a throwaway data dir**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
export LH_DATA_DIR="$(mktemp -d)"
(npx next dev -p 3123 >/tmp/lh-dev.log 2>&1 &) ; sleep 12
curl -s localhost:3123/api/ext/review/plan
curl -s -X POST localhost:3123/api/ext/review/session
curl -s -X POST localhost:3123/api/ext/cards -H 'content-type: application/json' -d '{"nodeId":"nope","question":"Q","answer":"A"}'
pkill -f "next dev -p 3123"; rm -rf "$LH_DATA_DIR"
```

Expected, in order: a JSON plan with empty `items`, `deferred`, `needsCard`, `goals` and `due: 0`; `{"chatId":"chat_..."}`; `{"error":"unknown node: nope"}`.

- [ ] **Step: Commit**

```bash
git add app/api/ext src/server/index.ts
git commit -m "feat(ext): add personal-layer routes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 14: Contracts and touchpoints docs (REQ-pl-17, REQ-port-01, REQ-int-04)

**Files:**
- Modify: `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md`

- [ ] **Step 1: Append the language-neutral contracts**

Append to `docs/ext/CONTRACTS.md`:

````markdown

## `cards.jsonl`

Content variants of a node. A card has NO schedule; all active variants of a node rotate under the node's one FSRS state.

Event `created`: `{type:"created", cardId, nodeId, question, answer, author, status, at}`
- `cardId`, `nodeId`, `question`, `answer`: non-empty strings. `author`: `user` | `agent`. `status`: `draft` | `active`.
- An `agent` card MUST be created `draft`; a parser rejects an agent card created `active`.
- `at`: ISO-8601 timestamp.

Event `status`: `{type:"status", cardId, status, at}` with `status` in `draft` | `active` | `retired`.

Derivation (`deriveCards`): replay in file order; the first `created` for an id defines the card; later `created` for the same id are ignored; `status` for an unknown card is ignored; a `status` event sets the status. Approval of a draft is a `status: active` event. Active variants of a node, in creation order, are indexed `0..k-1`; the n-th fixed review of the node (n counted from 0) shows variant `n mod k`; no active variant means the node cannot be reviewed through the fixed channel.

## `review.jsonl`

Every event has `at` (ISO-8601). Readers skip events whose shape they reject.

- `review`: `{type:"review", nodeId, channel, rating, durationSec, at, question?, answer?, weakPremises?}`. `channel`: `fixed` | `dialogic` | `exercise`. `rating`: integer 1 Again, 2 Hard, 3 Good, 4 Easy. `durationSec`: number >= 0. `weakPremises`: array of non-empty node ids, allowed ONLY when `channel` is `dialogic`. Learner errors live here, never in the content graph.
- `implicit`: `{type:"implicit", nodeId, viaNodeId, outcome, at}`, `outcome` `credit` | `penalty`; `nodeId` is the premise, `viaNodeId` the reviewed conclusion.
- `pin`: `{type:"pin", nodeId, pinned: boolean, at}`. `retire`: `{type:"retire", nodeId, retired: boolean, at}`. `channel`: `{type:"channel", nodeId, channel, at}` with `channel` `fixed` | `dialogic` | `null` (null removes the pin). `retention`: `{type:"retention", goalId, retention, at}`, `retention` in [0.7, 0.97].
- Marks (`deriveMarks`): the latest event of each kind for a node (or goal, for `retention`) wins. Setting a pin also writes `retire: false`; setting a retirement also writes `pin: false`.

## Review state (`deriveNodeStates`)

Replay `review.jsonl` in file order into ONE FSRS card per node, whatever the channel; events for nodes that no longer exist in the content graph are ignored.
- Library and parameters: FSRS-6 (`ts-fsrs` 5.4.x), default weights, `request_retention` = the node's desired retention, fuzz OFF, learning steps OFF (a first rating schedules whole days).
- Desired retention of a node: among ALL goals whose scope contains the node, the goal with the highest `priority` (ties: earliest `createdAt`, then `goalId`); its latest `retention` event, else 0.9. A node in no goal uses 0.9. The CURRENT value is used for the whole replay.
- `review` event: a real FSRS review of the node's card at `at` with `rating` (an empty card if none).
- `implicit` `penalty`: a real FSRS review with rating 1 at `at`; ignored if the node has no state.
- `implicit` `credit`: ignored if the node has no state; else with `old` = the card's stability and `computed` = the stability a real rating-3 review at `at` would give, set `stability = old + w * (computed - old)` with `w = 0.5`, `last_review = at`, `elapsed_days = 0`, `scheduled_days = nextInterval(stability)` (the FSRS interval for the node's retention, elapsed 0) and `due = at + scheduled_days` days. Difficulty, reps and lapses are unchanged.
- Fixed-review count of a node: number of `review` events with `channel = fixed`.
- Recall probability at `now`: 0 if the node has no state; else the FSRS-6 forgetting curve at `stability` and FRACTIONAL elapsed days since `last_review` (never negative).

## Dialogic review and implicit repetition

When a `review` with `channel = dialogic` is recorded, the writer then appends implicit events, all with the same `at`. Premises = distinct premises of EVERY current chain concluding the node. Success = rating >= 2: one `credit` per premise that has a state and is NOT in `weakPremises`. Failure = rating 1: one `penalty` per premise in `weakPremises` that has a state. A fixed or exercise review emits none. `weakPremises` must be a subset of the premises.

## Deck, derivability, readiness

- `derivable(n)`: some chain with conclusion `n` and at least one premise has every premise at recall probability >= 0.85 (by the premises' own state; no recursion). A node concluded by no chain is never derivable.
- Deck = the union of the scopes (see Scope) of goals with status `active`, plus pinned nodes, minus retired nodes (unless pinned), minus derivable nodes (unless pinned), restricted to nodes that exist. Deck entry priority = priority of the highest-priority active goal containing the node (default 3 for a pinned node outside any goal).
- Readiness of a goal: `solid / total` where `total` = size of its scope and `solid` = members with recall >= 0.85; ready when `total > 0` and the fraction >= 0.8.

## Daily plan

Inputs: `now`, the deck, node states, review history, parameters (budget 1500 s, dialogic cap 5, backlog factor 1.5, default durations fixed 20 s and dialogic 180 s), a predicate "node has an active card", and `dayStart` (local midnight).
1. `median[channel]` = median `durationSec` over all `review` events of that channel (fixed, dialogic) with `durationSec > 0`, else the default. `spentToday` = sum of `durationSec` of `review` events with `at >= dayStart`. `dialogicToday` = count of dialogic `review` events with `at >= dayStart`.
2. A deck node is DUE if it has a state with `due <= now`, NEW if it has no state, otherwise skipped. Due order: priority desc, then risk (1 - recall) desc, then node id asc. New order: priority desc, then node id asc.
3. Channel assignment, in that order (due first, then the new nodes that are taken): a `channel` pin wins (a dialogic pin consumes one slot of `dialogicCap - dialogicToday` if any is left); else a node concluded by a chain is `dialogic` while slots remain; else `fixed`. A `fixed` node without an active card is listed in `needsCard` and not planned.
4. `remaining = max(0, budget - spentToday)`; `cost(channel) = median[channel]`; `meanCost` = mean of `cost` over the due items (the fixed cost if none); `capacity = floor(remaining / meanCost)`; `due` = number of planned due items; `newQuota = 0` if `due > 1.5 * capacity`, else `max(0, capacity - due)`. The first `newQuota` plannable new nodes are taken.
5. Queue = due items then taken new items. Walk it accumulating `cost`; items while the total stays within `remaining` form `items`; from the first item that does not fit, all remaining items are `deferred` in order. Nothing is dropped.

## Goal completion

`applyExerciseResult(goalId, results[{nodeId, outcome}])`, outcome `passed` | `weak` | `failed`. Preconditions (checked before any write): the goal exists and is `active`; `results` is non-empty; every node exists. Effects: one `review` event per result with `channel = exercise`, `durationSec = 0`, `rating` 3 for `passed` and 1 otherwise; then, if every result is `passed` AND every target node of the goal has a result, a `goals.jsonl` `status: reached` event. No other code path writes `reached`.
````

- [ ] **Step 2: Update the touchpoints**

In `docs/ext/TOUCHPOINTS.md`, add these rows to the table (below the existing rows):

```markdown
| `package.json`, `package-lock.json` | `ts-fsrs` 5.4.2 | Personal layer |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"review"` | Personal layer |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"review"` | Personal layer |
| `src/store/chats.ts` | `createChat` stamps kind `"review"` | Personal layer |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.instructions?` replaces the composed prompt | Personal layer |
| `src/server/chat-handler.ts` | `isPracticeLike` helper, the review agent branch, two imports | Personal layer |
| `app/chat/[id]/page.tsx` | passes `"teach"` to `Chat` for a `review` session | Personal layer |
| `src/server/index.ts` | barrel line `export * from "./ext/index.ts";` (shared with other plans) | Personal layer |
```

and delete the sentences in the "Planned (not yet touched)" paragraph that now apply (the `ChatRecord` `kind` union, `src/server/index.ts` barrel and the FSRS dependency), keeping the rest.

- [ ] **Step 3: Check the closed list against upstream**

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!app/api/ext/**' ':!components/ext/**'
```

Expected: every file printed appears in the table of `docs/ext/TOUCHPOINTS.md` (this plan's rows plus other plans' rows). A file printed that is in no row is an unlisted upstream edit: revert it or list it.

- [ ] **Step: Commit**

```bash
git add docs/ext
git commit -m "docs(ext): document personal-layer contracts and touchpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 15: Integration with sibling plans (do each part only if that plan has landed on `ext`)

**Files:**
- Modify: `src/server/ext/panel-providers.ts` (node-knowledge plan), `src/server/ext/personal-trust.ts` (this plan; source-verification plan)

- [ ] **Step 1: Check what has landed**

```bash
ls src/server/ext/panel-providers.ts src/server/ext/verification.ts 2>&1
```

For each file that does not exist, skip the matching step below and leave `personal-trust.ts` / `panel-providers.ts` as they are; the plan is complete without them. Record what was skipped in the commit message.

- [ ] **Step 2: Fill the node panel (only if `panel-providers.ts` exists)**

In `src/server/ext/panel-providers.ts` add `import { personalPanel } from "./personal-panel.ts";` and change the two exports to

```ts
export const panelSources: PanelSources = { ...personalPanel.sources };

export const nodeHandlers: NodeActionHandlers = { ...personalPanel.handlers };
```

If other plans already put entries in these objects, keep them and add `...personalPanel.sources` / `...personalPanel.handlers` as extra spread members. The "create card" button stays disabled (no `createCard` handler by design); cards are created through `POST /api/ext/cards`.

- [ ] **Step 3: Read real trust (only if `verification.ts` exists and exports `trustViews`)**

Replace the body of `src/server/ext/personal-trust.ts` with

```ts
// src/server/ext/personal-trust.ts
/** The live trust level of a node, shown to the review agent (source-verification plan). */

import type { TrustLevel } from "../../core/ext/review-queries.ts";
import { trustViews } from "./verification.ts";

export function trustOfNode(nodeId: string): TrustLevel {
	return trustViews([nodeId])[0]?.level ?? "unverified";
}
```

- [ ] **Step 4: Verify**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/ext-*.test.ts 2>&1 | tail -8
npm run typecheck 2>&1 | tail -5
npx eslint src/server/ext 2>&1 | tail -5
```

Expected: `fail 0`; no typecheck or lint output.

- [ ] **Step: Commit**

```bash
git add src/server/ext
git commit -m "feat(ext): wire personal layer into the node panel and trust" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 16: Full verification, mutation spot-check, manual smoke

**Files:** none changed (revert every mutation).

- [ ] **Step 1: Full suite, typecheck, lint against the Task 1 baseline**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: no failure beyond the two known upstream `claude-code` CLI tests (and anything written down in Task 1 Step 2); typecheck and lint print nothing new.

- [ ] **Step 2: Mutation spot-check (security profile: mutation testing)**

For each row: apply the change, run the test file, expect it to FAIL, then `git checkout -- <file>` to revert.

| File | Mutation | Test file that must fail |
|---|---|---|
| `src/core/ext/deck.ts` | `DERIVABLE_RECALL = 0.85` to `0.8` | `tests/ext-deck.test.ts` |
| `src/core/ext/review-service.ts` | `rating >= 2 ? premises.filter` to `rating >= 3 ? premises.filter` | `tests/ext-review-service.test.ts` |
| `src/core/ext/daily-plan.ts` | `entry.hasChain && dialogicLeft > 0` to `entry.hasChain && dialogicLeft >= 0` | `tests/ext-daily-plan.test.ts` |
| `src/core/ext/cards.ts` | remove the `if (r.author === "agent" && r.status !== "draft") return null;` line | `tests/ext-review-events.test.ts` |
| `src/core/ext/review-service.ts` | in `applyExerciseResult` change `allPassed && covered` to `allPassed` | `tests/ext-review-service.test.ts` |

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-deck.test.ts
git checkout -- src/core/ext/deck.ts
```

Expected for each: FAIL while mutated, PASS after the revert. A mutation that does not fail means a missing test: add one before finishing. (`backlogFactor` 1.5 to 2 is an equivalent mutant on purpose, see decision 5.)

- [ ] **Step 3: Manual smoke of a real review session (functional UI only)**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npm run dev:fresh
```

In the app: create a goal with a statement (Foundation `createGoal`; from a Node REPL or a test script if no UI exists yet), create a card for a fact node with `curl -X POST localhost:3000/api/ext/cards -H 'content-type: application/json' -d '{"nodeId":"<id>","question":"Q?","answer":"A."}'`, then `curl -X POST localhost:3000/api/ext/review/session` and open `/chat/<chatId>`. Send "Start the review." Expected: the agent calls `next_item`, asks the card question with the question dock, shows the answer after you reply, offers Again/Hard/Good/Easy, and after your pick `GET /api/ext/review/plan` no longer lists the node and `data/ext/review.jsonl` has one `review` line with `channel: "fixed"`. If the chat layout misbehaves for a `review` session (a visual problem), note it for the UI redesign session; do not fix it here.

---

## Self-review

**1. Spec coverage (REQ id to task):**

| REQ | Where |
|---|---|
| REQ-pl-01 variants of a node under one schedule | Task 3 (`cards.ts`, `pickVariant`), Task 5 (one state per node) |
| REQ-pl-02 user authors fixed cards | Task 8 `createUserCard`, Task 13 `POST /api/ext/cards` |
| REQ-pl-03 agent cards are drafts, unscheduled until approved | Task 3 (parser), Task 8 (`proposeAgentCard`, `approveCard`, plan test), Task 9 (`propose_card`) |
| REQ-pl-04 every event has a channel; all channels update one state | Task 3, Task 5 |
| REQ-pl-05 assignment, daily cap 5, overflow to fixed, user pin | Task 7 (assign), Task 8 (`setChannelPin`), Task 13 (marks route) |
| REQ-pl-06 fixed cards reviewed in chat through upstream's question tools | Task 9 (`ask_user_question` reused, instructions), Task 12 |
| REQ-pl-07 dialogic: node, trust, premises, new question each time, proposed rating and weak premises the user can override | Task 8 (`nextItem` payload, `recentQuestions`), Task 9 (tools + instructions) |
| REQ-pl-08 ts-fsrs, retention 0.9, per goal, highest-priority goal wins | Task 1, 2, 6 (`claimNodes`), 8 (`setGoalRetention`) |
| REQ-pl-09 implicit repetition formula, weak-only penalty | Task 2 (`implicitCredit`), 5, 8 (`recordReview`) |
| REQ-pl-10 derivable nodes have no card unless pinned | Task 6 |
| REQ-pl-11 time budget, medians, quota, 1.5 backlog rule | Task 7 |
| REQ-pl-12 order by priority then 1 - recall; overflow deferred | Task 7 |
| REQ-pl-13 paused goals excluded, state kept | Task 6, Task 8 (test) |
| REQ-pl-14 reached only after the exercise set is passed; weak result reopens | Task 8 (`applyExerciseResult`) |
| REQ-pl-15 weak premises recorded; learner errors never in the graph | Task 3 (parser rule), Task 8 (test asserts graph unchanged) |
| REQ-pl-16 plan and derivation pure and deterministic | Tasks 5 and 7 (determinism tests) |
| REQ-pl-17 contracts documented | Task 14 |
| Umbrella REQ-int-01/02/03/04, REQ-port-01 | Tasks 4 (stamp via ledger), 8 (extension ledgers only), 10 and 16 (lint), 14 (touchpoints, contracts) |
| Umbrella REQ-mode-01 (`review` among the modes) | Task 11 and 12 add the kind and the agent; the mode CONTROL itself belongs to the plan that owns REQ-mode-01. `POST /api/ext/review/session` is the programmatic entry meanwhile. |

**Gaps and caveats:** no REQ is without a task. The mode selector UI (REQ-mode-01) and any visual design are deliberately out. The spec's backlog clause (zero when `due > 1.5 x capacity`) is implemented but is implied by `max(0, capacity - due)`. The `review` chat in the teaching layout is not visually verified (Task 16 Step 3 is manual). Node-panel and trust wiring (Task 15) depend on sibling plans.

**2. Placeholder scan:** no "TBD", "TODO", "implement later" or "similar to Task N" in any step; every code step carries the full file; Task 12 gives exact old and new strings; Task 15 is conditional only on sibling files existing, and each branch carries its code.

**3. Type consistency:** `ReviewEvent`, `Channel`, `ReviewRating` (review.ts); `CardEvent`, `ContentCard` (cards.ts, distinct from the ts-fsrs `FsrsCard` in fsrs.ts); `NodeState`, `Marks` (review-state.ts); `DeckEntry`, `NodeGoalInfo` (deck.ts); `PlanParams`, `ReviewStats`, `PlanItem`, `DailyPlan`, `PlanInput` (daily-plan.ts); `ReviewDeps`, `Snapshot`, `RecordReviewInput`, `RecordReviewResult`, `ExerciseResult` (review-service.ts); `QueryDeps`, `NextItem`, `PremiseView`, `NodeReviewView`, `TrustLevel` (review-queries.ts); `ReviewToolContext` (review-tools.ts, satisfied by `PersonalLayer.reviewToolContext`); `MarkRequest`, `PersonalLayerDeps` (personal-layer.ts). Names used in later tasks match their definitions (`recordReview`, `computePlan`, `nextItem`, `goalReadinessReport`, `nodeReviewView`, `setPinned`, `setRetired`, `setChannelPin`, `setGoalRetention`, `createUserCard`, `proposeAgentCard`, `approveCard`, `retireCard`, `applyExerciseResult`); `PanelCard` / `PanelReview` shapes match the node-knowledge plan's. The whole code base in this plan was compiled (`tsc`), linted with the repo's ESLint layer rules and its tests run green against a scratch copy of the fork before the plan was written.

