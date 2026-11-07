# Lectures, Office Hours and Graded Exercises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the study stage to the LearnHarness fork: a book PDF becomes chapter graphs plus narrated lectures stored as structured documents and played natively in the app; `office_hours` sessions review the learner's own work Socratically and give a verdict only on request, built from code-checked quotations of a designated source; goal-level graded exercises decide when a goal is reached.

**Architecture:** Pure logic in `src/core/ext/lecture/` and `src/core/ext/practice/` (document schema, validator, retry-with-feedback, outline split, chapter detection rules, lecture overlay, verdict and exercise rules, events). The model calls are single schema-validated submissions through upstream's `runSubmitAgent` seam (`src/agent/ext/lecture/`, `src/agent/ext/practice/`), gated by the shared daily cost ceiling. Chapters run in parallel, the lectures of a chapter in sequence with a rolling summary; each chapter extracts its graph from the chapter text through upstream's notes import first. `office_hours` is a chat kind (the same precedent as the personal layer's `review` kind) with its own tools, of which `verdict` exists only when the learner's newest message is the command `/verdict`. Servers (`lecture-service.ts`, `practice-service.ts`) take every impure dependency by injection; `lecture-live.ts` and `practice-live.ts` are the only wiring. Lectures and exercise sets never touch the content ledgers.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node 26, `node:test` via `tsx`, TypeBox (`typebox`, existing), `pdfjs-dist` legacy build (existing, through upstream's `pdf-ops`), Next.js 16 app router, React 19, browser `speechSynthesis` in Electron. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-04-lecture-office-hours-exercises-design.md` (REQ-lec-01 to REQ-lec-19; parent REQ-cost-01, REQ-port-01, REQ-int-01 to 04, REQ-pl-14). Umbrella: `2026-11-04-learning-platform-integration-design.md`. Prior art: `/Users/riccardobolzonello/Developer/Codice/teacher` (lecture doctrine, chapter detection, office-hours rules).

**Working directory for every command:** `<repo>` (the fork, branch `ext`). Never run `git commit` outside the steps that say so.

**Command prefix for Node 26:** every test command below already starts with `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null`.

**Conventions:** tabs, double quotes, `import type` for types, `.ts` extensions in imports, `noUncheckedIndexedAccess` (use `!` on indexed reads in tests). Every commit message ends with a second `-m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`. Layer law (ESLint): `src/core` never imports `agent`/`server`/`store`; `src/agent` never imports `server`/`store`; `app/` and `components/` import only the `@/src/core` and `@/src/server` barrels (a component may mirror a small JSON shape locally instead, as `components/ext/trust-badge.tsx` does). The UI in this plan is functional only; the visual redesign is its own session.

**How the code in this plan was checked:** every source and test file below was typechecked and run against a clean export of the `ext` branch (with the personal-layer plan already landed) before being written here. The pass counts in the steps are the ones observed. Where a step edits a shared file, the old text is given so the edit can be applied exactly once.

---

## Prerequisites (state of `ext` this plan builds on)

- **Foundation, source verification (Tasks 1 to end) and personal layer (through its routes) are on `ext`.** This plan reads `src/core/ext/{quote,trust,sources,cost-gate,goals,review-service}.ts`, `src/store/ext/{ledger,snapshot-store}.ts`, `src/server/ext/{stores,verification,personal-layer}.ts` and the personal layer's `review` chat kind and `isPracticeLike` helper in `src/server/chat-handler.ts`. Task 1 Step 1 checks that they exist; if one is missing, stop and land that plan first.
- **Node knowledge (landed)** is on `ext` too: the browser-safe core barrel `src/core/ext/index.ts` (already exported by `src/core/index.ts`), `src/server/ext/panel-providers.ts` and `components/ext/open-node.ts`. This plan appends to the barrel and adds one member to the panel provider.

## Decisions made in this plan (flag to change)

These resolve the spec's "Open items for the plan" and fill gaps. Each is small and reversible.

1. **Speech** is the browser's `speechSynthesis` inside Electron. Task 1 measured it on this machine: Electron 44.9.3, 180 voices (including Italian), `start`, `boundary` (12 events for one sentence) and `end` all fire. The player falls back to a text mode (manual Next) when `speechSynthesis` is absent.
2. **Chapter text comes from upstream's `pdfExtract`** (the math-aware pipeline `readChapterText` wraps), and the chapter graph from upstream's `extraction.importNotes` under the label `<Book title>/<NN> <Chapter title>`, so the graph is extracted from the book text and never from generated discourse (REQ-lec-04). Task 1 measures the extracted math of the user's real PDF (`dispense_Prob_1.pdf`): no encoding damage; one visible defect (`∉` extracted as `6 ∈`), which the validator and the retry cannot fix and which is a known cost of text extraction.
3. **Lecture ids** are `lec_b<8 hex of the PDF path hash>_c<NN>_l<NN>`; a re-run of a chapter replaces that chapter's lectures. The book id comes from the absolute PDF path, so ingesting the same file twice is one run (single-flight).
4. **Verbatim rule** (REQ-lec-08): a block that shares a run of 12 consecutive words with the chapter text is rejected with feedback (at most 2 retries, REQ-lec-07). Editorial additions are blocks with role `note`, shown in italics and prefixed "Note" by the player.
5. **Cost** (REQ-lec-18): every model call of this stage goes through the verification stage's `CostGate` (`allowed()` before, `record(usd, source)` per billed step, sources `lecture` and `exercises`). One gap, stated: `importNotes` bills itself inside upstream's pipeline and is not metered by the gate; the gate is checked BEFORE each chapter import, so the ceiling still stops new chapters.
6. **`office_hours` is a chat kind**, like the personal layer's `review` kind. The verdict tool is registered only when the learner's newest message is the command `/verdict` (the chat handler persists the user message before it builds the agent, so the stored record is what the tools read). REQ-lec-13 (never say correct or incorrect) is enforced by the instructions only: the model cannot be forbidden from typing a word. The structural guarantee is the other half: no verdict tool without the command, and the verdict text comes from code.
7. **Verdict = code-checked quotations** (REQ-lec-14). The model proposes comparison items (`stepRef`, `sourceQuote`, `workQuote`, `stance`); code keeps an item only if `sourceQuote` occurs in the designated source (the verification stage's `checkQuote`: normalization, 20-character minimum) and, for `matches`/`differs`, `workQuote` occurs in the learner's work. Nothing kept: "not verifiable". All kept and all matching: "consistent with the designated source" (never "correct"). Anything else: "differs", listing the differing steps.
8. **Designated source** is pasted text (a solutions-manual passage, a textbook proof) snapshotted through the verification stage's `SnapshotStore`, or, for an exercise, its reference solution. Designating a library PDF page range is not in this plan (it would add a picker and a page reader for little gain; paste is enough for the stated use). Flag if you want it.
9. **"Non-immediate" exercises** (REQ-lec-15) is read as: an exercise must make the learner combine at least 2 nodes of the goal's scope and must not restate a node statement in its prompt (a recall question is rejected by code). The set is generated on demand from the practice page; it is not time-delayed. If "non-immediate" should also mean "not before N days after the lecture", that is a scheduling rule on top of this (flag).
10. **Grading** (REQ-lec-16, 17): a session opened from an exercise has the exercise's reference solution (steps `[s1] ...`, each citing nodes) as its designated source. Each verdict item names a step; a node's outcome is derived by code from the steps that cite it (`passed` all good, `failed` none good, `weak` mixed); a step with no surviving item counts for nothing. A grading is low confidence when the reference uses any node whose trust is not `sourced`; a low-confidence PASS is withheld from the results (a pass resting on unverified nodes does not advance a goal), weak and failed still count. When every exercise of the set has a verifiable grading, the results go once to the personal layer's `applyExerciseResult`, the only writer of a goal's `reached`.
11. **Formulas** render as raw LaTeX text in the functional UI (a `<pre>`); math rendering is part of the UI redesign.
12. **Lectures in the graph canvas** (REQ-lec-11): this plan delivers the derived overlay (`lectureService.overlay()` and `GET /api/ext/lectures/overlay`: lecture nodes plus `cites` edges) and the back-links; drawing the overlay inside upstream's graph canvas is a larger upstream edit and is NOT done here (stated gap, see Self-review).

## Assumed interfaces (siblings)

- **Verification stage (landed):** `CostGate`, `checkQuote`, `normalizeForMatch`, `MIN_QUOTE_CHARS`, `TrustLevel`, `SourceLibrary` (`add`, `list`, `setStatus`), `SnapshotStore.put`, `trustViews(nodeIds) => [{nodeId, level}]`.
- **Personal layer (landed):** `applyExerciseResult(input, deps)` in `src/core/ext/review-service.ts` with `ReviewDeps = {graphStore, goalsStore, reviewStore, cardsStore}`; the `review` chat kind and `isPracticeLike`.
- **Node knowledge (landed):** `PanelSources.lecturesCiting?(nodeId) => {lectureId, title}[]` in `src/server/ext/panel-providers.ts`, `openNodePanel(nodeId)` in `components/ext/open-node.ts`, and the browser-safe barrel `src/core/ext/index.ts`. Used in Tasks 13 and 14.

## Upstream touchpoints added by this plan (added to `docs/ext/TOUCHPOINTS.md` in Task 23)

| File | Change |
|---|---|
| `src/core/contracts/chat.ts` | `ChatKind` gains `"office_hours"` |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"office_hours"` |
| `src/store/chats.ts` | `createChat` type widened (the stamping line is already generic) |
| `src/server/chat-handler.ts` | `isPracticeLike` also accepts `office_hours`; the office-hours agent branch; two imports |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for an `office_hours` session |
| `src/core/ext/index.ts` | appended exports for the lecture player (`activeCue`, node-link helpers, `Lecture*` types) |
| `src/server/ext/panel-providers.ts` | one member, `lecturesCiting`, so a node's panel lists the lectures that cite it |

`src/agent/teacher-agent.ts` (`AgentBuildOptions.instructions`) and `src/server/index.ts` (the ext barrel line) were already added by the personal-layer and verification plans; this plan reuses them.

## File structure

| File | Responsibility |
|---|---|
| `src/core/ext/lecture/lecture.ts` | Lecture document types, structural parser, `[[n_id\|label]]` node links |
| `src/core/ext/lecture/validate.ts` | Lecture validator (existence, cues, exercise/reveal, verbatim), coverage report, feedback text |
| `src/core/ext/lecture/retry.ts` | Generate, validate, retry with feedback |
| `src/core/ext/lecture/split.ts`, `chapters.ts`, `build.ts` | Outline split by estimated words; chapter-start rules; draft to document |
| `src/core/ext/lecture/lecture-graph.ts`, `cues.ts` | Lecture overlay and back-links; active cue by character offset |
| `src/core/ext/lecture/book-source.ts` | Register the book as an active primary source |
| `src/core/ext/study-ports.ts` | `LecturesStore`, `SnapshotReader` |
| `src/core/ext/practice/{verdict,exercises,office-hours}.ts` | Verdict rules; exercise rules, grading, events; session designation events |
| `src/core/ext/index.ts` (existing) | Appended exports for the lecture player |
| `src/store/ext/{lectures-store,snapshot-reader}.ts` | `lectures/<id>/lecture.json` (atomic); read-only snapshot access |
| `src/agent/ext/lecture/{pdf-facts,structured,prompts,writers,chapter-run,book-run}.ts` | Bookmarks and chapter text; the shared model seam; the three writers; the chapter and book runs |
| `src/agent/ext/practice/{office-hours-instructions,office-hours-tools,office-hours-agent,exercise-writer}.ts` | The office-hours session and the exercise generator |
| `src/server/ext/{lecture-service,practice-service}.ts` | Services over injected dependencies |
| `src/server/ext/{cost-live,study-engine,lecture-live,practice-live,stores}.ts` | The only wiring |
| `app/api/ext/{lectures,exercises,office-hours}/...`, `app/lectures/...`, `app/practice/page.tsx`, `components/ext/{lecture-player,lectures-panel,practice-panel}.tsx` | Transport and functional UI |
| `scripts/ext-check-speech.cjs`, `scripts/ext-check-pdf-math.ts` | The environment checks of Task 1 |
| `tests/ext-*.test.ts`, `tests/helpers/{lecture-fixture,outline-pdf}.ts` | One test file per module |

---

# Part A: Book to lectures

## Task 1: Environment checks (first, as the spec requires)

**Files:**
- Create: `scripts/ext-check-speech.cjs`, `scripts/ext-check-pdf-math.ts`

**Contract:** two throwaway-but-kept scripts answer the spec's two environment risks before any design depends on them: does Electron's `speechSynthesis` have voices and word-boundary events, and is the math of a real book usable after extraction. Neither writes to `data/`.

- [ ] **Step 1: Confirm Node, branch, prerequisites and baseline**

```bash
cd <repo>
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && node -v && git branch --show-current
ls src/core/ext/quote.ts src/core/ext/cost-gate.ts src/core/ext/review-service.ts src/core/ext/index.ts src/server/ext/verification.ts src/server/ext/personal-layer.ts src/server/ext/panel-providers.ts components/ext/open-node.ts
grep -n "isPracticeLike" src/server/chat-handler.ts | head -2
NODE_ENV=test npx tsx --test tests/ext-*.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `v26.…`, `ext`, the five files listed, one `isPracticeLike` line, and `fail 0`. If a file is missing or a test fails, stop: a prerequisite plan has not landed.

- [ ] **Step 2: Record the baseline of the whole suite**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/*.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖" | head -12
```

Expected: a few failures that do not involve this work (observed: the `claude-code` provider tests, a Next compression test and a Google SDK offline test, 4 failures on a machine without the Claude CLI). Write the count and names down: Task 25 compares against them.

- [ ] **Step 3: Write the speech check**

```javascript
// scripts/ext-check-speech.cjs
// Environment check for the lecture player (child spec 4, REQ-lec-09): does the
// Electron renderer have a working speechSynthesis with word-boundary events?
// Run: npx electron scripts/ext-check-speech.cjs
// Exit 0 = usable (voices present, speech ends, boundary events fire).
// It speaks one short sentence aloud.
const { app, BrowserWindow } = require("electron");

const probe = `(async () => {
	if (!("speechSynthesis" in window)) return { supported: false };
	const voices = await new Promise((resolve) => {
		const have = speechSynthesis.getVoices();
		if (have.length > 0) return resolve(have);
		const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 3000);
		speechSynthesis.onvoiceschanged = () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); };
	});
	const events = { start: false, boundary: 0, end: false, error: null };
	await new Promise((resolve) => {
		const u = new SpeechSynthesisUtterance("Hello. This is a test of speech synthesis in the lecture player.");
		u.onstart = () => { events.start = true; };
		u.onboundary = () => { events.boundary += 1; };
		u.onend = () => { events.end = true; resolve(); };
		u.onerror = (e) => { events.error = e.error; resolve(); };
		speechSynthesis.speak(u);
		setTimeout(resolve, 15000);
	});
	return { supported: true, voices: voices.length, sample: voices.slice(0, 3).map((v) => v.name + " (" + v.lang + ")"), events };
})()`;

app.whenReady().then(async () => {
	const win = new BrowserWindow({ show: false });
	await win.loadURL("data:text/html,<html><body>probe</body></html>");
	let result;
	try {
		result = await win.webContents.executeJavaScript(probe);
	} catch (e) {
		result = { supported: false, error: String(e) };
	}
	const usable = result.supported === true && result.voices > 0 && result.events.end === true && result.events.boundary > 0;
	console.log(JSON.stringify({ electron: process.versions.electron, usable, ...result }, null, 2));
	app.exit(usable ? 0 : 1);
});
```

- [ ] **Step 4: Run it**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx electron scripts/ext-check-speech.cjs; echo "exit $?"
```

Expected (observed on this machine): a JSON object with `"usable": true`, `"voices"` greater than 0 (180 observed, `Alice (it-IT)` among them), `"events": {"start": true, "boundary": 12, "end": true, "error": null}`, then `exit 0`, and a short sentence spoken aloud. If it prints `"usable": false` or exits 1, STOP and tell the user: the player's speech approach (decision 1) must change before Task 14 (for example to a text-only player or a different engine); everything before Task 14 is unaffected.

- [ ] **Step 5: Write the PDF math check**

```typescript
// scripts/ext-check-pdf-math.ts
/**
 * Environment check for lecture generation (child spec 4): is the math in a
 * book's extracted text usable? Lectures and chapter graphs are built from
 * exactly this text (pdfExtract, the pipeline readChapterText uses).
 *
 * Usage: npx tsx scripts/ext-check-pdf-math.ts <pdf> <pages>      e.g. 10-14
 * Prints the damage counters and the lines with the most mathematical
 * content; read the sample yourself: the counters catch encoding damage,
 * only your eyes catch a garbled formula. Exit 1 when damage exceeds 1%.
 * Nothing is written to disk.
 */
import { pdfExtract } from "../src/agent/subagents/pdf-ops.ts";

const [pdf, pages] = process.argv.slice(2);
if (pdf === undefined || pages === undefined) throw new Error("usage: ext-check-pdf-math.ts <pdf> <pages, e.g. 10-14>");

const text = await pdfExtract(pdf, pages);
const visible = text.replace(/\s/g, "");
const count = (re: RegExp): number => (text.match(re) ?? []).length;
const damage = {
	replacementChars: count(/�/g),
	privateUse: count(/[-]/g),
	cidTokens: count(/\(cid:\d+\)/g),
	controlChars: count(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g),
};
const damaged = damage.replacementChars + damage.privateUse + damage.cidTokens * 7 + damage.controlChars;
const MATH = /[∑∏∫∂∇∞≤≥≠≈∈∉⊂⊆∪∩∀∃→⇒⇔±×÷√αβγδεθλμπσφωΩΣΔ]|\\[a-zA-Z]+|\$[^$]+\$|[_^]\{/g;
const mathy = text
	.split("\n")
	.map((line) => ({ line, score: (line.match(MATH) ?? []).length }))
	.filter((x) => x.score > 0)
	.sort((a, b) => b.score - a.score)
	.slice(0, 15);

const ratio = visible.length === 0 ? 1 : damaged / visible.length;
console.log(JSON.stringify({ pdf, pages, chars: visible.length, ...damage, damageRatio: Number(ratio.toFixed(4)), mathLines: mathy.length }, null, 2));
console.log("\nMost mathematical lines (read them):");
for (const { line } of mathy) console.log(`  ${line.trim().slice(0, 160)}`);
process.exit(visible.length > 0 && ratio <= 0.01 ? 0 : 1);
```

- [ ] **Step 6: Run it on the user's real PDF**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsx scripts/ext-check-pdf-math.ts "<local>/dispense_Prob_1.pdf" 10-12; echo "exit $?"
```

Expected (observed): `"damageRatio": 0`, `"mathLines": 15`, then lines such as `Definizione 2.1.1 Sia Ω un insieme non vuoto. Sia C ⊆ P(Ω). Diciamo che è una` and `(−∞, 1] ∪ (4, +∞) 6 ∈ C.`; `exit 0`. Read the sample: the one visible defect is `∉` coming out as `6 ∈`. If your own book shows widespread garbling (symbols replaced by `?`, formulas split across lines beyond reading), tell the user before Task 10: lecture quality depends on this text (spec risk 2).

- [ ] **Step 7: Commit**

```bash
git add scripts/ext-check-speech.cjs scripts/ext-check-pdf-math.ts
git commit -m "chore(ext): add environment checks for speech synthesis and PDF math" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 2: The lecture document (REQ-lec-06)

**Files:**
- Create: `src/core/ext/lecture/lecture.ts`, `tests/helpers/lecture-fixture.ts`
- Test: `tests/ext-lecture-doc.test.ts`

**Contract:** `Lecture` is the content of `data/ext/lectures/<id>/lecture.json`: slides (elements `text` | `formula` | `list`, whose text may carry node links `[[n_id]]` or `[[n_id|label]]`), and an ordered list of blocks with roles `narrate` | `note` | `exercise` | `reveal`, the graph nodes each block covers, narration cues (`atChar`, element id, `box` | `underline`) and, for an `exercise`, `seconds`. `parseLecture` is a structural check only (null for anything this build does not understand); semantic rules are the validator's (Task 3). Ids are `lec_b<8 hex>_c<NN>_l<NN>`.

- [ ] **Step 1: Write the fixture and the failing test**

`tests/helpers/lecture-fixture.ts`

```typescript
// tests/helpers/lecture-fixture.ts
import { LECTURE_VERSION, type Block, type Lecture } from "../../src/core/ext/lecture/lecture.ts";

export const NODE_A = "n_aaaa1111";
export const NODE_B = "n_bbbb2222";

/** A small valid lecture: two slides, narrate -> exercise -> reveal -> note. */
export function makeLecture(overrides: Partial<Lecture> = {}): Lecture {
	const blocks: Block[] = [
		{ id: "b1", role: "narrate", slideId: "s1", text: "A sigma algebra is a family closed under complements and countable unions.", nodeIds: [NODE_A], cues: [{ atChar: 2, target: "e1", style: "box" }] },
		{ id: "b2", role: "exercise", slideId: "s1", text: "Try it yourself on a three element set.", nodeIds: [], cues: [], seconds: 60 },
		{ id: "b3", role: "reveal", slideId: "s1", text: "Yes, the four listed sets are closed under both operations.", nodeIds: [NODE_A], cues: [] },
		{ id: "b4", role: "note", slideId: "s2", text: "You will meet this again with Brownian motion.", nodeIds: [], cues: [] },
	];
	return {
		version: LECTURE_VERSION,
		id: "lec_b0123abcd_c02_l01",
		bookId: "b0123abcd",
		bookTitle: "Probability 1",
		chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 },
		order: 1,
		title: "Sigma algebras",
		summary: "We defined sigma algebras.",
		chapterSourceId: "src_0123456789ab",
		createdAt: "2026-11-04T10:00:00.000Z",
		slides: [
			{ id: "s1", heading: "Sigma algebra", elements: [{ id: "e1", type: "text", content: "A [[n_aaaa1111|sigma algebra]] is a family of sets." }] },
			{ id: "s2", heading: "Looking ahead", elements: [{ id: "e2", type: "list", items: ["Brownian motion", "[[n_bbbb2222]]"] }] },
		],
		blocks,
		...overrides,
	};
}
```

`tests/ext-lecture-doc.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isValidLectureId,
	lectureId,
	lectureNodeRefs,
	parseLecture,
	parseNodeLinks,
	stripNodeLinks,
	textNodeRefs,
} from "../src/core/ext/lecture/lecture.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

describe("lecture ids", () => {
	it("formats and validates", () => {
		assert.equal(lectureId("b0123abcd", 2, 1), "lec_b0123abcd_c02_l01");
		assert.equal(isValidLectureId("lec_b0123abcd_c02_l01"), true);
	});
	it("rejects path-like and malformed ids", () => {
		for (const bad of ["../x", "lec_b0123abcd_c02_l01/../../x", "lec_B0123ABCD_c02_l01", "", "lec_b0123abcd_c2_l1", 7, null]) {
			assert.equal(isValidLectureId(bad), false, String(bad));
		}
	});
});

describe("parseLecture", () => {
	it("round-trips a valid lecture through JSON", () => {
		const l = makeLecture();
		assert.deepEqual(parseLecture(JSON.parse(JSON.stringify(l))), l);
	});
	it("rejects a wrong version, a bad id, an exercise without seconds, a negative cue", () => {
		assert.equal(parseLecture({ ...makeLecture(), version: 2 }), null);
		assert.equal(parseLecture({ ...makeLecture(), id: "x" }), null);
		const noSeconds = makeLecture();
		delete noSeconds.blocks[1]!.seconds;
		assert.equal(parseLecture(noSeconds), null);
		const neg = makeLecture();
		neg.blocks[0]!.cues[0]!.atChar = -1;
		assert.equal(parseLecture(neg), null);
	});
	it("rejects non-objects", () => {
		for (const v of [null, 3, "x", [], undefined]) assert.equal(parseLecture(v), null);
	});
});

describe("node links", () => {
	it("splits text and links in order and never loses text", () => {
		const text = "see [[n_aaaa1111|sigma]] and [[n_bbbb2222]] now";
		const parts = parseNodeLinks(text);
		assert.deepEqual(parts, [
			{ kind: "text", text: "see " },
			{ kind: "node", nodeId: NODE_A, label: "sigma" },
			{ kind: "text", text: " and " },
			{ kind: "node", nodeId: NODE_B, label: null },
			{ kind: "text", text: " now" },
		]);
		assert.equal(stripNodeLinks(text), "see sigma and n_bbbb2222 now");
	});
	it("ignores malformed links", () => {
		assert.deepEqual(parseNodeLinks("[[notanode]] [[n_ x]]"), [{ kind: "text", text: "[[notanode]] [[n_ x]]" }]);
	});
	it("lists refs once each", () => {
		assert.deepEqual(textNodeRefs("[[n_aaaa1111]] [[n_aaaa1111|again]]"), [NODE_A]);
	});
});

describe("lectureNodeRefs", () => {
	it("unions block citations and slide links, first appearance order", () => {
		assert.deepEqual(lectureNodeRefs(makeLecture()), [NODE_A, NODE_B]);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-doc.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/lecture/lecture.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/lecture/lecture.ts`

```typescript
// src/core/ext/lecture/lecture.ts
/**
 * The lecture document (child spec 4, REQ-lec-06): what
 * data/ext/lectures/<id>/lecture.json holds. Pure types, a structural parser
 * and the inline node-link markup `[[n_…]]` / `[[n_…|label]]` (the same markup
 * as node explanations). Semantic rules (do the cited nodes exist, is the
 * discourse rephrased...) live in validate.ts.
 */

export const LECTURE_VERSION = 1;

export type SlideElementType = "text" | "formula" | "list";
export interface SlideElement {
	id: string;
	type: SlideElementType;
	/** text / formula: the content (may carry node links). */
	content?: string;
	/** list: one string per item (may carry node links). */
	items?: string[];
}
export interface Slide {
	id: string;
	heading: string;
	elements: SlideElement[];
}

/** narrate: spoken discourse. note: editorial addition (REQ-lec-08), a visually distinct aside.
 *  exercise: timed prompt (`seconds`). reveal: the discussion that must follow an exercise. */
export type BlockRole = "narrate" | "note" | "exercise" | "reveal";
export type CueStyle = "box" | "underline";
/** From character offset `atChar` of the block text on, highlight slide element `target`. */
export interface Cue {
	atChar: number;
	target: string;
	style: CueStyle;
}
export interface Block {
	id: string;
	role: BlockRole;
	slideId: string;
	text: string;
	/** Graph nodes this block covers (a narrate block must cite at least one). */
	nodeIds: string[];
	cues: Cue[];
	/** exercise only: thinking time. */
	seconds?: number;
}

export interface Lecture {
	version: typeof LECTURE_VERSION;
	id: string;
	bookId: string;
	bookTitle: string;
	chapter: { index: number; title: string; pageStart: number; pageEnd: number };
	/** 1-based position of this lecture inside its chapter. */
	order: number;
	title: string;
	/** 3-4 sentence recap handed to the next lecture of the chapter. */
	summary: string;
	/** The notes-source id (src_…) the chapter graph was extracted under. */
	chapterSourceId: string;
	createdAt: string;
	slides: Slide[];
	blocks: Block[];
}

const LECTURE_ID_RE = /^lec_b[0-9a-f]{8}_c\d{2,3}_l\d{2,3}$/;
export function isValidLectureId(id: unknown): id is string {
	return typeof id === "string" && LECTURE_ID_RE.test(id);
}
const pad = (n: number): string => String(n).padStart(2, "0");
export function lectureId(bookId: string, chapterIndex: number, order: number): string {
	return `lec_${bookId}_c${pad(chapterIndex)}_l${pad(order)}`;
}

// ── structural parser ───────────────────────────────────────────────────────

const ELEMENT_TYPES = new Set<string>(["text", "formula", "list"]);
const ROLES = new Set<string>(["narrate", "note", "exercise", "reveal"]);
const STYLES = new Set<string>(["box", "underline"]);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function parseElement(raw: unknown): SlideElement | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.type) || !ELEMENT_TYPES.has(raw.type)) return null;
	if (raw.type === "list") {
		if (!Array.isArray(raw.items) || !raw.items.every(isStr)) return null;
		return { id: raw.id, type: "list", items: [...raw.items] };
	}
	if (!isStr(raw.content)) return null;
	return { id: raw.id, type: raw.type as SlideElementType, content: raw.content };
}

function parseSlide(raw: unknown): Slide | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.heading) || !Array.isArray(raw.elements)) return null;
	const elements: SlideElement[] = [];
	for (const e of raw.elements) {
		const parsed = parseElement(e);
		if (parsed === null) return null;
		elements.push(parsed);
	}
	return { id: raw.id, heading: raw.heading, elements };
}

function parseBlock(raw: unknown): Block | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.role) || !ROLES.has(raw.role)) return null;
	if (!isNonEmpty(raw.slideId) || !isNonEmpty(raw.text)) return null;
	if (!Array.isArray(raw.nodeIds) || !raw.nodeIds.every(isNonEmpty)) return null;
	if (!Array.isArray(raw.cues)) return null;
	const cues: Cue[] = [];
	for (const c of raw.cues) {
		if (!isObj(c) || !isInt(c.atChar) || c.atChar < 0 || !isNonEmpty(c.target) || !isStr(c.style) || !STYLES.has(c.style)) return null;
		cues.push({ atChar: c.atChar, target: c.target, style: c.style as CueStyle });
	}
	const block: Block = { id: raw.id, role: raw.role as BlockRole, slideId: raw.slideId, text: raw.text, nodeIds: [...raw.nodeIds], cues };
	if (raw.role === "exercise") {
		if (!isInt(raw.seconds) || raw.seconds <= 0) return null;
		block.seconds = raw.seconds;
	}
	return block;
}

/** Structural check only. null = not a lecture this build understands. */
export function parseLecture(raw: unknown): Lecture | null {
	if (!isObj(raw) || raw.version !== LECTURE_VERSION || !isValidLectureId(raw.id)) return null;
	if (!isNonEmpty(raw.bookId) || !isStr(raw.bookTitle) || !isNonEmpty(raw.title) || !isStr(raw.summary)) return null;
	if (!isNonEmpty(raw.chapterSourceId) || !isNonEmpty(raw.createdAt) || !isInt(raw.order) || raw.order < 1) return null;
	const ch = raw.chapter;
	if (!isObj(ch) || !isInt(ch.index) || !isStr(ch.title) || !isInt(ch.pageStart) || !isInt(ch.pageEnd)) return null;
	if (!Array.isArray(raw.slides) || !Array.isArray(raw.blocks)) return null;
	const slides: Slide[] = [];
	for (const s of raw.slides) {
		const parsed = parseSlide(s);
		if (parsed === null) return null;
		slides.push(parsed);
	}
	const blocks: Block[] = [];
	for (const b of raw.blocks) {
		const parsed = parseBlock(b);
		if (parsed === null) return null;
		blocks.push(parsed);
	}
	return {
		version: LECTURE_VERSION,
		id: raw.id,
		bookId: raw.bookId,
		bookTitle: raw.bookTitle,
		chapter: { index: ch.index, title: ch.title, pageStart: ch.pageStart, pageEnd: ch.pageEnd },
		order: raw.order,
		title: raw.title,
		summary: raw.summary,
		chapterSourceId: raw.chapterSourceId,
		createdAt: raw.createdAt,
		slides,
		blocks,
	};
}

// ── inline node links ───────────────────────────────────────────────────────

const NODE_LINK_RE = /\[\[(n_[A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g;

export type TextPart = { kind: "text"; text: string } | { kind: "node"; nodeId: string; label: string | null };

/** Split text into plain parts and node links, in order. Never loses text. */
export function parseNodeLinks(text: string): TextPart[] {
	const parts: TextPart[] = [];
	let last = 0;
	for (const m of text.matchAll(NODE_LINK_RE)) {
		const at = m.index ?? 0;
		if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
		const label = m[2];
		parts.push({ kind: "node", nodeId: m[1]!, label: label === undefined || label === "" ? null : label });
		last = at + m[0].length;
	}
	if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
	return parts;
}

/** Node ids linked inside one text, in order of appearance, without repeats. */
export function textNodeRefs(text: string): string[] {
	const out: string[] = [];
	for (const p of parseNodeLinks(text)) if (p.kind === "node" && !out.includes(p.nodeId)) out.push(p.nodeId);
	return out;
}

/** Strip the link markup, keeping the visible words (for narration and verbatim checks). */
export function stripNodeLinks(text: string): string {
	return parseNodeLinks(text)
		.map((p) => (p.kind === "text" ? p.text : (p.label ?? p.nodeId)))
		.join("");
}

function slideTexts(slide: Slide): string[] {
	return slide.elements.flatMap((e) => (e.type === "list" ? (e.items ?? []) : [e.content ?? ""]));
}

/** Every node id the lecture cites: block citations and slide links, first appearance order, no repeats. */
export function lectureNodeRefs(lecture: Lecture): string[] {
	const out: string[] = [];
	const add = (id: string): void => {
		if (!out.includes(id)) out.push(id);
	};
	for (const b of lecture.blocks) for (const id of b.nodeIds) add(id);
	for (const s of lecture.slides) for (const t of slideTexts(s)) for (const id of textNodeRefs(t)) add(id);
	return out;
}

/** All slide texts of a lecture (used by the validator for link checks). */
export function lectureSlideTexts(lecture: Lecture): string[] {
	return lecture.slides.flatMap(slideTexts);
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-doc.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 9`, `fail 0`, and no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/lecture/lecture.ts tests/helpers/lecture-fixture.ts tests/ext-lecture-doc.test.ts
git commit -m "feat(ext): add the lecture document schema and parser" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Lecture validator and retry with feedback (REQ-lec-07, REQ-lec-08)

**Files:**
- Create: `src/core/ext/lecture/validate.ts`, `src/core/ext/lecture/retry.ts`
- Test: `tests/ext-lecture-validate.test.ts`, `tests/ext-lecture-retry.test.ts`

**Contract:** `validateLecture(lecture, {existingNodeIds, chapterText})` returns every violation, in a stable order, empty when valid: no slides or blocks; duplicate slide or block ids; a block on an unknown slide; a `narrate` block citing no node; any cited or linked node id that does not exist; a cue past the end of its text or on an element that is not on the block's slide; an `exercise` not followed by a `reveal`, a `reveal` not preceded by an `exercise`; a block sharing a run of 12 consecutive words with the chapter text (verbatim). `uncoveredChapterNodes` is the coverage report. `generateWithFeedback` makes at most `maxRetries + 1` attempts, handing the previous violations to the next one; an error thrown by an attempt propagates (an abort or a missing model is not retried).

- [ ] **Step 1: Write the failing tests**

`tests/ext-lecture-validate.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedbackFromErrors, firstSharedRun, uncoveredChapterNodes, validateLecture } from "../src/core/ext/lecture/validate.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

const CTX = { existingNodeIds: new Set([NODE_A, NODE_B]), chapterText: "Completely unrelated source material about something else entirely." };

describe("validateLecture", () => {
	it("accepts the fixture lecture", () => {
		assert.deepEqual(validateLecture(makeLecture(), CTX), []);
	});
	it("rejects a block that cites a non-existent node", () => {
		const l = makeLecture();
		l.blocks[0]!.nodeIds = ["n_ghost000"];
		assert.match(validateLecture(l, CTX).join("\n"), /unknown node n_ghost000/);
	});
	it("rejects a slide link to a non-existent node", () => {
		const l = makeLecture();
		l.slides[0]!.elements[0]!.content = "see [[n_ghost000]]";
		assert.match(validateLecture(l, CTX).join("\n"), /slide links unknown node n_ghost000/);
	});
	it("rejects a narrate block with no citation but allows a note without one", () => {
		const l = makeLecture();
		l.blocks[0]!.nodeIds = [];
		const errors = validateLecture(l, CTX);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /narrate block b1 cites no node/);
	});
	it("rejects an exercise without a reveal and a reveal without an exercise", () => {
		const l = makeLecture();
		l.blocks[2]!.role = "note";
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /exercise block b2 must be followed by a reveal/);
		const l2 = makeLecture();
		l2.blocks[1]!.role = "narrate";
		l2.blocks[1]!.nodeIds = [NODE_A];
		assert.match(validateLecture(l2, CTX).join("\n"), /reveal block b3 must follow an exercise/);
	});
	it("rejects cues on unknown elements or past the text", () => {
		const l = makeLecture();
		l.blocks[0]!.cues = [{ atChar: 1, target: "nope", style: "box" }, { atChar: 9999, target: "e1", style: "box" }];
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /unknown element nope/);
		assert.match(text, /past the end/);
	});
	it("rejects unknown slide ids and duplicate ids", () => {
		const l = makeLecture();
		l.blocks[3]!.slideId = "zzz";
		l.blocks[3]!.id = "b1";
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /unknown slide zzz/);
		assert.match(text, /duplicate block id b1/);
	});
	it("rejects empty lectures", () => {
		const text = validateLecture(makeLecture({ slides: [], blocks: [] }), CTX).join("\n");
		assert.match(text, /no slides/);
		assert.match(text, /no blocks/);
	});
});

describe("verbatim rule (REQ-lec-08)", () => {
	const source = "A sigma algebra is a family of subsets closed under complements and countable unions of its members.";
	it("flags a 12-word copy even with different case and punctuation", () => {
		const l = makeLecture();
		l.blocks[0]!.text = "Remember: a SIGMA algebra, is a family of subsets closed under complements, and countable unions of its members!";
		const errors = validateLecture(l, { ...CTX, chapterText: source });
		assert.match(errors.join("\n"), /copies the source verbatim/);
	});
	it("does not flag a short shared phrase", () => {
		const l = makeLecture();
		l.blocks[0]!.text = "A sigma algebra is a family of subsets, nothing more.";
		assert.deepEqual(validateLecture(l, { ...CTX, chapterText: source }), []);
	});
	it("the boundary is exactly 12 shared words", () => {
		const src = "one two three four five six seven eight nine ten eleven twelve thirteen";
		assert.notEqual(firstSharedRun("one two three four five six seven eight nine ten eleven twelve", src), null);
		assert.equal(firstSharedRun("one two three four five six seven eight nine ten eleven", src), null);
	});
	it("firstSharedRun edge cases (exact run, no match, too short)", () => {
		assert.equal(firstSharedRun("a b c", "a b c", 3), "a b c");
		assert.equal(firstSharedRun("x", "a b c", 3), null);
		assert.equal(firstSharedRun("a b", "a b c d", 3), null);
	});
});

describe("coverage and feedback", () => {
	it("reports chapter nodes cited by no lecture", () => {
		assert.deepEqual(uncoveredChapterNodes([makeLecture()], [NODE_A, NODE_B, "n_orphan00"]), ["n_orphan00"]);
		assert.deepEqual(uncoveredChapterNodes([], [NODE_A]), [NODE_A]);
	});
	it("formats feedback with one line per error", () => {
		const fb = feedbackFromErrors(["a", "b"]);
		assert.match(fb, /- a\n- b$/);
	});
});
```

`tests/ext-lecture-retry.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateWithFeedback } from "../src/core/ext/lecture/retry.ts";

const feedback = (errors: string[]): string => errors.join("|");

describe("generateWithFeedback", () => {
	it("returns the first valid attempt without feedback", async () => {
		const seen: (string | null)[] = [];
		const r = await generateWithFeedback({ attempt: async (f) => (seen.push(f), 1), validate: () => [], feedback, maxRetries: 2 });
		assert.deepEqual(r, { ok: true, value: 1, attempts: 1 });
		assert.deepEqual(seen, [null]);
	});
	it("retries with the previous errors as feedback and stops at success", async () => {
		const seen: (string | null)[] = [];
		let n = 0;
		const r = await generateWithFeedback({
			attempt: async (f) => (seen.push(f), ++n),
			validate: (v) => (v < 3 ? [`bad${v}`] : []),
			feedback,
			maxRetries: 2,
		});
		assert.deepEqual(r, { ok: true, value: 3, attempts: 3 });
		assert.deepEqual(seen, [null, "bad1", "bad2"]);
	});
	it("gives up after exactly maxRetries retries", async () => {
		let n = 0;
		const r = await generateWithFeedback({ attempt: async () => ++n, validate: () => ["no"], feedback, maxRetries: 2 });
		assert.equal(n, 3);
		assert.deepEqual(r, { ok: false, value: 3, errors: ["no"], attempts: 3 });
	});
	it("does not swallow errors thrown by the attempt", async () => {
		await assert.rejects(
			generateWithFeedback({ attempt: async () => { throw new Error("aborted"); }, validate: () => [], feedback, maxRetries: 2 }),
			/aborted/,
		);
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-validate.test.ts tests/ext-lecture-retry.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/lecture/validate.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/lecture/validate.ts`

```typescript
// src/core/ext/lecture/validate.ts
/**
 * The lecture validator (REQ-lec-07, REQ-lec-08): pure rules that reject a
 * generated lecture with feedback the writer can act on, plus the chapter
 * coverage report. Contracts: docs/ext/CONTRACTS.md "Lecture validator".
 */

import { lectureNodeRefs, lectureSlideTexts, stripNodeLinks, textNodeRefs, type Lecture } from "./lecture.ts";

/** A narrated run of this many consecutive words found in the chapter text is a verbatim copy. */
export const VERBATIM_RUN_WORDS = 12;

export interface ValidationContext {
	/** Every node id in the graph. */
	existingNodeIds: ReadonlySet<string>;
	/** The chapter's plain text, the source the discourse must not copy. */
	chapterText: string;
}

const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The first run of `n` consecutive words of `text` that also occurs in `source`, or null. */
export function firstSharedRun(text: string, source: string, n: number = VERBATIM_RUN_WORDS): string | null {
	const src = words(source);
	if (src.length < n) return null;
	const grams = new Set<string>();
	for (let i = 0; i + n <= src.length; i++) grams.add(src.slice(i, i + n).join(" "));
	const tw = words(text);
	for (let i = 0; i + n <= tw.length; i++) {
		const gram = tw.slice(i, i + n).join(" ");
		if (grams.has(gram)) return gram;
	}
	return null;
}

/** All rule violations, in a stable order. Empty = valid. */
export function validateLecture(lecture: Lecture, ctx: ValidationContext): string[] {
	const errors: string[] = [];
	if (lecture.slides.length === 0) errors.push("the lecture has no slides");
	if (lecture.blocks.length === 0) errors.push("the lecture has no blocks");

	const slideIds = new Set<string>();
	const elementsBySlide = new Map<string, Set<string>>();
	for (const s of lecture.slides) {
		if (slideIds.has(s.id)) errors.push(`duplicate slide id ${s.id}`);
		slideIds.add(s.id);
		elementsBySlide.set(s.id, new Set(s.elements.map((e) => e.id)));
	}
	const blockIds = new Set<string>();
	lecture.blocks.forEach((b, i) => {
		if (blockIds.has(b.id)) errors.push(`duplicate block id ${b.id}`);
		blockIds.add(b.id);
		if (!slideIds.has(b.slideId)) errors.push(`block ${b.id} points at unknown slide ${b.slideId}`);
		if (b.role === "narrate" && b.nodeIds.length === 0) errors.push(`narrate block ${b.id} cites no node`);
		for (const id of b.nodeIds) if (!ctx.existingNodeIds.has(id)) errors.push(`block ${b.id} cites unknown node ${id}`);
		for (const c of b.cues) {
			if (c.atChar > b.text.length) errors.push(`block ${b.id} has a cue past the end of its text (${c.atChar})`);
			if (slideIds.has(b.slideId) && !elementsBySlide.get(b.slideId)!.has(c.target)) {
				errors.push(`block ${b.id} has a cue on unknown element ${c.target} of slide ${b.slideId}`);
			}
		}
		const next = lecture.blocks[i + 1];
		if (b.role === "exercise" && next?.role !== "reveal") errors.push(`exercise block ${b.id} must be followed by a reveal block`);
		if (b.role === "reveal" && lecture.blocks[i - 1]?.role !== "exercise") errors.push(`reveal block ${b.id} must follow an exercise block`);
		const copied = firstSharedRun(stripNodeLinks(b.text), ctx.chapterText);
		if (copied !== null) errors.push(`block ${b.id} copies the source verbatim ("${copied.split(" ").slice(0, 8).join(" ")} ..."): rephrase it`);
	});

	for (const t of lectureSlideTexts(lecture)) {
		for (const id of textNodeRefs(t)) if (!ctx.existingNodeIds.has(id)) errors.push(`a slide links unknown node ${id}`);
	}
	return [...new Set(errors)];
}

/** Chapter nodes cited by none of the lectures (REQ-lec-07 report). */
export function uncoveredChapterNodes(lectures: readonly Lecture[], chapterNodeIds: readonly string[]): string[] {
	const covered = new Set<string>();
	for (const l of lectures) for (const id of lectureNodeRefs(l)) covered.add(id);
	return chapterNodeIds.filter((id) => !covered.has(id));
}

/** The feedback paragraph handed to the writer on a retry. */
export function feedbackFromErrors(errors: readonly string[]): string {
	return `The previous attempt was rejected for these reasons. Fix every one of them:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
```

`src/core/ext/lecture/retry.ts`

```typescript
// src/core/ext/lecture/retry.ts
/**
 * generate -> validate -> retry with feedback (REQ-lec-07): at most
 * `maxRetries` retries after the first attempt (so maxRetries + 1 attempts).
 * Errors thrown by `attempt` are not retried: they propagate (aborts, missing models).
 */

export type RetryOutcome<T> =
	| { ok: true; value: T; attempts: number }
	| { ok: false; value: T; errors: string[]; attempts: number };

export async function generateWithFeedback<T>(opts: {
	attempt: (feedback: string | null) => Promise<T>;
	/** Rule violations; empty = accepted. */
	validate: (value: T) => string[];
	/** Turns violations into the feedback text for the next attempt. */
	feedback: (errors: string[]) => string;
	maxRetries: number;
}): Promise<RetryOutcome<T>> {
	let feedback: string | null = null;
	let value!: T;
	let errors: string[] = [];
	for (let attempts = 1; attempts <= opts.maxRetries + 1; attempts++) {
		value = await opts.attempt(feedback);
		errors = opts.validate(value);
		if (errors.length === 0) return { ok: true, value, attempts };
		feedback = opts.feedback(errors);
	}
	return { ok: false, value, errors, attempts: opts.maxRetries + 1 };
}
```

- [ ] **Step 4: Run them and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-validate.test.ts tests/ext-lecture-retry.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 18` (14 + 4), `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/lecture/validate.ts src/core/ext/lecture/retry.ts tests/ext-lecture-validate.test.ts tests/ext-lecture-retry.test.ts
git commit -m "feat(ext): add the lecture validator and retry-with-feedback" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Outline split, chapter rules and the draft builder (REQ-lec-01, REQ-lec-06)

**Files:**
- Create: `src/core/ext/lecture/split.ts`, `src/core/ext/lecture/chapters.ts`, `src/core/ext/lecture/build.ts`
- Test: `tests/ext-lecture-split.test.ts`, `tests/ext-lecture-build.test.ts`

**Contract:**
- `splitOutline(blocks, target = 2000)` packs outline blocks, in order, into lectures by estimated spoken words per kind (`definition` 150, `theorem` 375, `example` 100, `motivation` 120, `remark` 80), never by page count (teacher measured 36x variation in words per page). A block alone larger than the target still gets its own lecture.
- `validateChapterStarts`, `normalizeBookmarks`, `chaptersFromStarts`, `buildChapterDetectExcerpt` are the chapter-detection rules: bookmarks first (sorted, de-duplicated by page), an LLM fallback over a page excerpt only when there are none; `plainChapterText` strips upstream's `--- Page N ---` markers.
- `buildLecture(draft, meta)` turns a writer's draft into the stored document (ids, version, chapter, summary) and strips `seconds` from non-exercise blocks.

- [ ] **Step 1: Write the failing tests**

`tests/ext-lecture-split.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitOutline, TARGET_WORDS, type OutlineBlock } from "../src/core/ext/lecture/split.ts";
import { buildChapterDetectExcerpt, chaptersFromStarts, normalizeBookmarks, plainChapterText, validateChapterStarts } from "../src/core/ext/lecture/chapters.ts";

const b = (kind: OutlineBlock["kind"], title: string = kind): OutlineBlock => ({ title, kind, summary: "s" });

describe("splitOutline", () => {
	it("keeps a small chapter in one lecture", () => {
		assert.equal(splitOutline([b("definition"), b("example")]).length, 1);
	});
	it("splits when the estimate would pass the target, preserving order", () => {
		const blocks = Array.from({ length: 8 }, (_, i) => b("theorem", `t${i}`)); // 8 x 375 = 3000
		const lectures = splitOutline(blocks);
		assert.deepEqual(lectures.map((l) => l.length), [5, 3]); // 5 x 375 = 1875 <= 2000
		assert.deepEqual(lectures.flat().map((x) => x.title), blocks.map((x) => x.title));
	});
	it("gives an oversize block its own lecture and never produces an empty one", () => {
		const lectures = splitOutline([b("theorem")], 100);
		assert.equal(lectures.length, 1);
		assert.deepEqual(splitOutline([], TARGET_WORDS), []);
	});
	it("is independent of any page count (outline only)", () => {
		const a = splitOutline([b("definition"), b("theorem"), b("example")]);
		assert.equal(a.length, 1);
	});
});

describe("chapters", () => {
	it("derives page ranges and indexes", () => {
		const ch = chaptersFromStarts([{ title: " One ", page: 1 }, { title: "Two", page: 11 }, { title: "Three", page: 30 }], 50);
		assert.deepEqual(ch, [
			{ index: 1, title: "One", pageStart: 1, pageEnd: 10 },
			{ index: 2, title: "Two", pageStart: 11, pageEnd: 29 },
			{ index: 3, title: "Three", pageStart: 30, pageEnd: 50 },
		]);
	});
	it("rejects out-of-range, non-increasing and empty proposals", () => {
		assert.match(validateChapterStarts([], 10).join(), /no chapters/);
		assert.match(validateChapterStarts([{ title: "A", page: 0 }], 10).join(), /outside 1\.\.10/);
		assert.match(validateChapterStarts([{ title: "A", page: 5 }, { title: "B", page: 5 }], 10).join(), /strictly increase/);
		assert.match(validateChapterStarts([{ title: " ", page: 2 }], 10).join(), /empty title/);
		assert.deepEqual(validateChapterStarts([{ title: "A", page: 1 }, { title: "B", page: 9 }], 10), []);
	});
	it("normalizes bookmarks: drops blanks, repeated pages and going backwards", () => {
		const out = normalizeBookmarks([
			{ title: "A", page: 1 }, { title: "A.1", page: 1 }, { title: "", page: 3 }, { title: "B", page: 7 }, { title: "stray", page: 2 },
		]);
		assert.deepEqual(out, [{ title: "A", page: 1 }, { title: "B", page: 7 }]);
	});
	it("builds the detect excerpt and strips page headers", () => {
		const ex = buildChapterDetectExcerpt(["p1 text", "p2 text", "", "Chapter 3\nbody"], 2);
		assert.equal(ex, "===== PAGE 1 =====\np1 text\n===== PAGE 2 =====\np2 text\n[page 4] Chapter 3");
		assert.equal(plainChapterText("--- Page 3 ---\nhello\n--- Page 4 ---\nworld"), "hello\nworld");
	});
});
```

`tests/ext-lecture-build.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLecture } from "../src/core/ext/lecture/build.ts";
import { parseLecture } from "../src/core/ext/lecture/lecture.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

describe("buildLecture", () => {
	const base = makeLecture();
	const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };
	const meta = {
		bookId: "b0123abcd",
		bookTitle: "Probability 1",
		chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 },
		order: 1,
		chapterSourceId: "src_0123456789ab",
		createdAt: "2026-11-04T10:00:00.000Z",
	};
	it("attaches identity and produces a parseable lecture", () => {
		const l = buildLecture(draft, meta);
		assert.equal(l.id, "lec_b0123abcd_c02_l01");
		assert.deepEqual(parseLecture(JSON.parse(JSON.stringify(l))), base);
	});
	it("drops stray `seconds` from non-exercise blocks", () => {
		const d = { ...draft, blocks: draft.blocks.map((b) => (b.role === "narrate" ? { ...b, seconds: 30 } : b)) };
		const l = buildLecture(d, meta);
		assert.equal("seconds" in l.blocks[0]!, false);
		assert.equal(l.blocks[1]!.seconds, 60);
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-split.test.ts tests/ext-lecture-build.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/lecture/split.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/lecture/split.ts`

```typescript
// src/core/ext/lecture/split.ts
/**
 * Lecture split from the chapter OUTLINE, never from page count (REQ-lec-01;
 * teacher doctrine: words per page varies ~36x). Each outline block has an
 * estimated discourse length by kind; blocks are packed in order until a
 * lecture would exceed the target.
 */

export type OutlineKind = "definition" | "theorem" | "example" | "motivation" | "remark";
export interface OutlineBlock {
	title: string;
	kind: OutlineKind;
	summary: string;
}

export const TARGET_WORDS = 2000;
/** Estimated spoken words per block kind (teacher's calibration). */
export const WORDS_BY_KIND: Record<OutlineKind, number> = {
	definition: 150,
	theorem: 375,
	example: 100,
	motivation: 120,
	remark: 80,
};

export function estimatedWords(block: OutlineBlock): number {
	return WORDS_BY_KIND[block.kind];
}

/** Greedy in-order packing. A block alone larger than the target still gets its own lecture. */
export function splitOutline(blocks: readonly OutlineBlock[], target: number = TARGET_WORDS): OutlineBlock[][] {
	const lectures: OutlineBlock[][] = [];
	let current: OutlineBlock[] = [];
	let words = 0;
	for (const block of blocks) {
		const w = estimatedWords(block);
		if (current.length > 0 && words + w > target) {
			lectures.push(current);
			current = [];
			words = 0;
		}
		current.push(block);
		words += w;
	}
	if (current.length > 0) lectures.push(current);
	return lectures;
}
```

`src/core/ext/lecture/chapters.ts`

```typescript
// src/core/ext/lecture/chapters.ts
/**
 * Chapters of a book (REQ-lec-01): from PDF bookmarks, or from an LLM guess
 * validated by the same rules. Pure. Pages are 1-based and inclusive.
 */

export interface ChapterStart {
	title: string;
	page: number;
}
export interface Chapter {
	/** 1-based. */
	index: number;
	title: string;
	pageStart: number;
	pageEnd: number;
}

/** Problems with a proposed chapter list; empty = usable. */
export function validateChapterStarts(starts: readonly ChapterStart[], pageCount: number): string[] {
	const errors: string[] = [];
	if (starts.length === 0) errors.push("no chapters proposed");
	starts.forEach((s, i) => {
		if (s.title.trim() === "") errors.push(`chapter ${i + 1} has an empty title`);
		if (!Number.isInteger(s.page) || s.page < 1 || s.page > pageCount) errors.push(`chapter "${s.title}" starts at page ${s.page}, outside 1..${pageCount}`);
		const prev = starts[i - 1];
		if (prev !== undefined && s.page <= prev.page) errors.push(`chapter "${s.title}" does not start after "${prev.title}" (pages must strictly increase)`);
	});
	return errors;
}

/** Each chapter runs to the page before the next one; the last to the end of the book. Input must be valid. */
export function chaptersFromStarts(starts: readonly ChapterStart[], pageCount: number): Chapter[] {
	return starts.map((s, i) => ({
		index: i + 1,
		title: s.title.trim(),
		pageStart: s.page,
		pageEnd: i + 1 < starts.length ? starts[i + 1]!.page - 1 : pageCount,
	}));
}

/** Bookmarks arrive in outline order and may repeat a page (a chapter and its first section). Keep the first per page, drop out-of-order ones. */
export function normalizeBookmarks(raw: readonly ChapterStart[]): ChapterStart[] {
	const out: ChapterStart[] = [];
	for (const b of raw) {
		const prev = out[out.length - 1];
		if (b.title.trim() === "") continue;
		if (prev !== undefined && b.page <= prev.page) continue;
		out.push({ title: b.title.trim(), page: b.page });
	}
	return out;
}

/** The excerpt the LLM fallback sees: first pages whole, then the first line of every other page. */
export function buildChapterDetectExcerpt(pages: readonly string[], wholePages: number = 6): string {
	const parts: string[] = [];
	pages.forEach((text, i) => {
		const n = i + 1;
		if (n <= wholePages) {
			parts.push(`===== PAGE ${n} =====\n${text.trim()}`);
			return;
		}
		const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
		if (first !== undefined) parts.push(`[page ${n}] ${first}`);
	});
	return parts.join("\n");
}

/** Plain text of pdfExtract's markdown: the `--- Page N ---` headers removed. */
export function plainChapterText(markdown: string): string {
	return markdown.replace(/^--- Page \d+ ---\n?/gm, "").trim();
}
```

`src/core/ext/lecture/build.ts`

```typescript
// src/core/ext/lecture/build.ts
/**
 * From the writer's submission (LectureDraft) to the stored document (REQ-lec-06):
 * attaches identity and provenance, nothing else. Structural validity is
 * checked afterwards by parseLecture, semantic validity by validateLecture.
 */

import { LECTURE_VERSION, lectureId, type Block, type Lecture, type Slide } from "./lecture.ts";
import type { Chapter } from "./chapters.ts";

export interface LectureDraft {
	title: string;
	summary: string;
	slides: Slide[];
	blocks: Block[];
}

export interface LectureMeta {
	bookId: string;
	bookTitle: string;
	chapter: Chapter;
	order: number;
	chapterSourceId: string;
	createdAt: string;
}

export function buildLecture(draft: LectureDraft, meta: LectureMeta): Lecture {
	return {
		version: LECTURE_VERSION,
		id: lectureId(meta.bookId, meta.chapter.index, meta.order),
		bookId: meta.bookId,
		bookTitle: meta.bookTitle,
		chapter: { index: meta.chapter.index, title: meta.chapter.title, pageStart: meta.chapter.pageStart, pageEnd: meta.chapter.pageEnd },
		order: meta.order,
		title: draft.title,
		summary: draft.summary,
		chapterSourceId: meta.chapterSourceId,
		createdAt: meta.createdAt,
		slides: draft.slides,
		// `seconds` belongs to exercise blocks only.
		blocks: draft.blocks.map((b) => {
			if (b.role === "exercise") return b;
			const { seconds: _seconds, ...rest } = b;
			return rest;
		}),
	};
}
```

- [ ] **Step 4: Run them and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-split.test.ts tests/ext-lecture-build.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 10` (8 + 2), `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/lecture/split.ts src/core/ext/lecture/chapters.ts src/core/ext/lecture/build.ts tests/ext-lecture-split.test.ts tests/ext-lecture-build.test.ts
git commit -m "feat(ext): add outline split, chapter rules and the lecture builder" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Lecture overlay, back-links and cues (REQ-lec-09, REQ-lec-11, REQ-lec-12)

**Files:**
- Create: `src/core/ext/lecture/lecture-graph.ts`, `src/core/ext/lecture/cues.ts`
- Test: `tests/ext-lecture-graph.test.ts`

**Contract:** `lectureOverlay(lectures, existingNodeIds)` derives one special node `{id, title, kind: "lecture"}` per lecture and one `{from: lectureId, to: nodeId, type: "cites"}` edge per cited node that exists (citations: block `nodeIds` and slide links). Nothing is stored and nothing is written to the content ledgers. `citingLectures(nodeId, lectures)` is the back-link list for a node's panel. `activeCue(cues, charIndex)` is the last cue at or before the character offset the speech engine reports.

- [ ] **Step 1: Write the failing test**

`tests/ext-lecture-graph.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citingLectures, lectureOverlay } from "../src/core/ext/lecture/lecture-graph.ts";
import { activeCue } from "../src/core/ext/lecture/cues.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

describe("lecture overlay (REQ-lec-11)", () => {
	it("derives one special node per lecture and cites edges to existing nodes only", () => {
		const o = lectureOverlay([makeLecture()], new Set([NODE_A]));
		assert.deepEqual(o.nodes, [{ id: "lec_b0123abcd_c02_l01", title: "Sigma algebras", kind: "lecture" }]);
		assert.deepEqual(o.edges, [{ from: "lec_b0123abcd_c02_l01", to: NODE_A, type: "cites" }]);
	});
	it("derives edges for slide links too", () => {
		const o = lectureOverlay([makeLecture()], new Set([NODE_A, NODE_B]));
		assert.deepEqual(o.edges.map((e) => e.to), [NODE_A, NODE_B]);
	});
});

describe("back-links (REQ-lec-12)", () => {
	it("lists citing lectures in id order and none for an uncited node", () => {
		const second = makeLecture({ id: "lec_b0123abcd_c01_l01", title: "Earlier" });
		const r = citingLectures(NODE_A, [makeLecture(), second]);
		assert.deepEqual(r.map((x) => x.title), ["Earlier", "Sigma algebras"]);
		assert.deepEqual(citingLectures("n_nobody00", [makeLecture()]), []);
	});
});

describe("activeCue", () => {
	const cues = [
		{ atChar: 0, target: "a", style: "box" as const },
		{ atChar: 10, target: "b", style: "underline" as const },
	];
	it("returns the last cue at or before the offset", () => {
		assert.equal(activeCue(cues, 0)?.target, "a");
		assert.equal(activeCue(cues, 9)?.target, "a");
		assert.equal(activeCue(cues, 10)?.target, "b");
		assert.equal(activeCue(cues, 500)?.target, "b");
	});
	it("returns null before the first cue and for no cues", () => {
		assert.equal(activeCue([{ atChar: 5, target: "a", style: "box" }], 2), null);
		assert.equal(activeCue([], 3), null);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-graph.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/lecture/lecture-graph.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/lecture/lecture-graph.ts`

```typescript
// src/core/ext/lecture/lecture-graph.ts
/**
 * Lectures as special graph nodes (REQ-lec-11) and back-links (REQ-lec-12):
 * everything derived from lecture.json, nothing stored, nothing written to
 * the content ledgers.
 */

import { lectureNodeRefs, type Lecture } from "./lecture.ts";

export interface LectureGraphNode {
	id: string;
	title: string;
	kind: "lecture";
}
export interface LectureGraphEdge {
	from: string;
	to: string;
	type: "cites";
}
export interface LectureOverlay {
	nodes: LectureGraphNode[];
	edges: LectureGraphEdge[];
}

/** One special node per lecture, one `cites` edge per cited node that exists. */
export function lectureOverlay(lectures: readonly Lecture[], existingNodeIds: ReadonlySet<string>): LectureOverlay {
	const nodes: LectureGraphNode[] = [];
	const edges: LectureGraphEdge[] = [];
	for (const l of lectures) {
		nodes.push({ id: l.id, title: l.title, kind: "lecture" });
		for (const id of lectureNodeRefs(l)) if (existingNodeIds.has(id)) edges.push({ from: l.id, to: id, type: "cites" });
	}
	return { nodes, edges };
}

export interface CitingLecture {
	id: string;
	title: string;
	bookTitle: string;
	chapterTitle: string;
}

/** Back-links: the lectures that cite `nodeId`, in book/chapter/lecture order. */
export function citingLectures(nodeId: string, lectures: readonly Lecture[]): CitingLecture[] {
	return lectures
		.filter((l) => lectureNodeRefs(l).includes(nodeId))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((l) => ({ id: l.id, title: l.title, bookTitle: l.bookTitle, chapterTitle: l.chapter.title }));
}
```

`src/core/ext/lecture/cues.ts`

```typescript
// src/core/ext/lecture/cues.ts
/**
 * Cue-synchronised highlighting (REQ-lec-09): the speech engine reports the
 * character offset being spoken (`boundary` events); the active cue is the
 * last one at or before that offset.
 */

import type { Cue } from "./lecture.ts";

export function activeCue(cues: readonly Cue[], charIndex: number): Cue | null {
	let best: Cue | null = null;
	for (const c of cues) if (c.atChar <= charIndex && (best === null || c.atChar >= best.atChar)) best = c;
	return best;
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-graph.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 5`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/lecture/lecture-graph.ts src/core/ext/lecture/cues.ts tests/ext-lecture-graph.test.ts
git commit -m "feat(ext): add the lecture overlay, back-links and cue lookup" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Lecture store and snapshot reader (REQ-lec-06)

**Files:**
- Create: `src/core/ext/study-ports.ts`, `src/store/ext/lectures-store.ts`, `src/store/ext/snapshot-reader.ts`
- Test: `tests/ext-lectures-store.test.ts`

**Contract:** `LecturesStore` (`save`, `get`, `list`, `remove`) over `data/ext/lectures/<id>/lecture.json`, written atomically (`writeFileAtomicSync`), under the extension's format stamp (a newer stamp refuses reads and writes; the first write creates it). `save` throws on a lecture the parser rejects; `list` skips unreadable or invalid files; ids that are not valid lecture ids never reach the filesystem. `SnapshotReader.get(sha256)` reads `snapshots/<sha256>.txt` written by the verification stage's `SnapshotStore.put`; it validates the hash shape and returns null for anything unknown.

- [ ] **Step 1: Write the failing test**

`tests/ext-lectures-store.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLecturesStore } from "../src/store/ext/lectures-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("lectures store", () => {
	it("saves, gets, lists in id order and removes", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		const b = makeLecture({ id: "lec_b0123abcd_c02_l02", order: 2 });
		store.save(b);
		store.save(makeLecture());
		assert.deepEqual(store.list().map((l) => l.id), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c02_l02"]);
		assert.deepEqual(store.get("lec_b0123abcd_c02_l02"), b);
		store.remove("lec_b0123abcd_c02_l02");
		assert.equal(store.get("lec_b0123abcd_c02_l02"), null);
	});
	it("creates the format stamp on first save and not on read", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		assert.deepEqual(store.list(), []);
		assert.equal(fs.existsSync(path.join(dir, "format.json")), false);
		store.save(makeLecture());
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf-8")).version, CURRENT_EXT_FORMAT_VERSION);
	});
	it("refuses an invalid lecture and never reads outside its folder", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		assert.throws(() => store.save({ ...makeLecture(), id: "../evil" }), /not a valid lecture/);
		assert.equal(store.get("../../etc/passwd"), null);
		store.remove("../..");
		assert.ok(fs.existsSync(dir));
	});
	it("skips a corrupt lecture file", () => {
		const dir = tmp();
		const store = createLecturesStore(dir);
		store.save(makeLecture());
		fs.writeFileSync(path.join(dir, "lectures", "lec_b0123abcd_c02_l01", "lecture.json"), "{broken");
		assert.deepEqual(store.list(), []);
	});
	it("throws on a stamp newer than this build", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION + 1 }));
		assert.throws(() => createLecturesStore(dir).list(), /format version/);
	});
});

describe("snapshot reader", () => {
	it("reads what the verification snapshot store wrote, and refuses malformed hashes", async () => {
		const { createSnapshotStore } = await import("../src/store/ext/snapshot-store.ts");
		const { createSnapshotReader } = await import("../src/store/ext/snapshot-reader.ts");
		const dir = tmp();
		const hash = createSnapshotStore(dir).put("solution text");
		const reader = createSnapshotReader(dir);
		assert.equal(reader.get(hash), "solution text");
		assert.equal(reader.get("../../x"), null);
		assert.equal(reader.get("a".repeat(64)), null);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lectures-store.test.ts`
Expected: FAIL with `Cannot find module '../src/store/ext/lectures-store.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/study-ports.ts`

```typescript
// src/core/ext/study-ports.ts
/**
 * Ports of the lecture / office-hours / exercise stage (child spec 4).
 * Core codes against these types; adapters live in src/store/ext/ and the
 * composition happens in src/server/ext/. The cost gate, trust levels and
 * the source library are the verification stage's (cost-gate.ts, trust.ts,
 * sources.ts) and are not redeclared here.
 */

import type { Lecture } from "./lecture/lecture.ts";

export interface LecturesStore {
	/** Writes data/ext/lectures/<id>/lecture.json atomically. Throws on an invalid lecture. */
	save(lecture: Lecture): void;
	get(id: string): Lecture | null;
	/** Every readable lecture, by id. Unreadable or invalid files are skipped. */
	list(): Lecture[];
	/** Removes a lecture directory. No-op for an unknown id. */
	remove(id: string): void;
}

/** Reads a snapshot written by the verification stage's SnapshotStore.put (data/ext/snapshots/<sha256>.txt). */
export interface SnapshotReader {
	get(sha256: string): string | null;
}
```

`src/store/ext/lectures-store.ts`

```typescript
// src/store/ext/lectures-store.ts
/**
 * data/ext/lectures/<id>/lecture.json: one atomically written file per lecture
 * (a document, not an event ledger). Same stamp doctrine as the ledgers.
 */

import fs from "node:fs";
import path from "node:path";
import { isValidLectureId, parseLecture, type Lecture } from "../../core/ext/lecture/lecture.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createLecturesStore(extDir: string): LecturesStore {
	const root = path.join(extDir, "lectures");
	const fileOf = (id: string): string => path.join(root, id, "lecture.json");

	function get(id: string): Lecture | null {
		if (!isValidLectureId(id)) return null;
		assertExtFormat(extDir);
		try {
			return parseLecture(JSON.parse(fs.readFileSync(fileOf(id), "utf-8")));
		} catch {
			return null;
		}
	}

	return {
		save(lecture) {
			if (parseLecture(lecture) === null) throw new Error(`lectures store: ${lecture.id} is not a valid lecture`);
			assertExtFormat(extDir);
			ensureExtFormat(extDir);
			fs.mkdirSync(path.join(root, lecture.id), { recursive: true });
			writeFileAtomicSync(fileOf(lecture.id), JSON.stringify(lecture, null, "\t") + "\n", { allowInPlaceFallback: true });
		},
		get,
		list() {
			assertExtFormat(extDir);
			let names: string[];
			try {
				names = fs.readdirSync(root);
			} catch {
				return [];
			}
			return names
				.filter(isValidLectureId)
				.sort()
				.map(get)
				.filter((l): l is Lecture => l !== null);
		},
		remove(id) {
			if (!isValidLectureId(id)) return;
			fs.rmSync(path.join(root, id), { recursive: true, force: true });
		},
	};
}
```

`src/store/ext/snapshot-reader.ts`

```typescript
// src/store/ext/snapshot-reader.ts
/** Read side of data/ext/snapshots/<sha256>.txt (the write side is snapshot-store.ts). */

import fs from "node:fs";
import path from "node:path";
import type { SnapshotReader } from "../../core/ext/study-ports.ts";
import { assertExtFormat } from "./format.ts";

const HASH_RE = /^[0-9a-f]{64}$/;

export function createSnapshotReader(dir: string): SnapshotReader {
	return {
		get(sha256) {
			if (!HASH_RE.test(sha256)) return null;
			assertExtFormat(dir);
			try {
				return fs.readFileSync(path.join(dir, "snapshots", `${sha256}.txt`), "utf-8");
			} catch {
				return null;
			}
		},
	};
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lectures-store.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 6`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/study-ports.ts src/store/ext/lectures-store.ts src/store/ext/snapshot-reader.ts tests/ext-lectures-store.test.ts
git commit -m "feat(ext): add the lectures store and the snapshot reader" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 7: The book as an active primary source (REQ-lec-02)

**Files:**
- Create: `src/core/ext/lecture/book-source.ts`
- Test: `tests/ext-book-source.test.ts`

**Contract:** `registerBookAsPrimary(library, pdfPath, label)` adds a `pdf` entry (`addedBy: "user"`, tier `primary`, status `active`: the user chose to ingest this book) to the verification stage's source library, or, when the path is already in the library, promotes that entry to active primary through `setStatus`. It is idempotent. It never touches an entry of another locator.

- [ ] **Step 1: Write the failing test**

`tests/ext-book-source.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSourceLibrary } from "../src/core/ext/sources.ts";
import { registerBookAsPrimary } from "../src/core/ext/lecture/book-source.ts";
import { memSourcesStore } from "./helpers/ext-fakes.ts";

describe("registerBookAsPrimary (REQ-lec-02)", () => {
	it("adds the book as an active primary pdf source", () => {
		const lib = createSourceLibrary(memSourcesStore());
		registerBookAsPrimary(lib, "/books/prob.pdf", "Probability 1");
		const [e] = lib.list();
		assert.deepEqual([e!.kind, e!.locator, e!.tier, e!.status, e!.label, e!.addedBy], ["pdf", "/books/prob.pdf", "primary", "active", "Probability 1", "user"]);
	});
	it("is idempotent", () => {
		const lib = createSourceLibrary(memSourcesStore());
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		assert.equal(lib.list().length, 1);
	});
	it("promotes an existing proposed secondary entry", () => {
		const lib = createSourceLibrary(memSourcesStore());
		lib.propose([{ kind: "pdf", locator: "/books/prob.pdf", label: "P" }]);
		assert.equal(lib.list()[0]!.status, "proposed");
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		assert.deepEqual([lib.list()[0]!.status, lib.list()[0]!.tier], ["active", "primary"]);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-book-source.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/lecture/book-source.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/lecture/book-source.ts`

```typescript
// src/core/ext/lecture/book-source.ts
/**
 * REQ-lec-02: ingesting a book registers it as an ACTIVE PRIMARY source of the
 * verification stage's library. The user starting the ingest is the act that
 * makes it active (addedBy "user"). Idempotent per PDF path; an existing entry
 * (even a proposed or secondary one) is promoted.
 */

import type { SourceLibrary } from "../sources.ts";

export function registerBookAsPrimary(library: SourceLibrary, pdfPath: string, label: string): void {
	const existing = library.list().find((e) => e.kind === "pdf" && e.locator === pdfPath);
	if (existing === undefined) {
		library.add({ kind: "pdf", locator: pdfPath, tier: "primary", label, addedBy: "user" });
		return;
	}
	if (existing.status !== "active" || existing.tier !== "primary") library.setStatus(existing.id, "active", "primary");
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-book-source.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 3`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/lecture/book-source.ts tests/ext-book-source.test.ts
git commit -m "feat(ext): register an ingested book as an active primary source" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 8: PDF bookmarks and chapter text (REQ-lec-01)

**Files:**
- Create: `tests/helpers/outline-pdf.ts`, `src/agent/ext/lecture/pdf-facts.ts`
- Test: `tests/ext-pdf-facts.test.ts`

**Contract:** `readBookmarks(pdfPath)` returns the page count and the chapter-level bookmarks (the top level of the PDF outline, or the level below when the top is only a few "Part" entries), normalized. `readPageTexts` returns the plain text of every page (for the no-bookmarks fallback excerpt). `readChapterText(pdfPath, chapter)` returns the chapter's text through upstream's math-aware `pdfExtract`, page markers stripped. The test builds a real two-chapter PDF with an outline in memory (`tests/helpers/outline-pdf.ts`), so the bookmark reading is exercised against real pdfjs, not a mock.

- [ ] **Step 1: Write the helper and the failing test**

`tests/helpers/outline-pdf.ts`

```typescript
// tests/helpers/outline-pdf.ts
/** A valid N-page text PDF (ASCII only, one line per page) with an optional bookmark outline. */
export function buildOutlinePdf(pageTexts: string[], outline: { title: string; page: number }[] = []): Uint8Array {
	const n = pageTexts.length;
	const fontId = 3 + n * 2;
	const rootId = fontId + 1;
	const objects: string[] = [];
	objects[1] = `<</Type/Catalog/Pages 2 0 R${outline.length > 0 ? ` /Outlines ${rootId} 0 R` : ""}>>`;
	objects[2] = `<</Type/Pages/Kids[${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}]/Count ${n}>>`;
	pageTexts.forEach((text, i) => {
		const pageId = 3 + i * 2;
		const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
		objects[pageId] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${pageId + 1} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
		objects[pageId + 1] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
	});
	objects[fontId] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
	if (outline.length > 0) {
		const first = rootId + 1;
		const last = rootId + outline.length;
		objects[rootId] = `<</Type/Outlines/First ${first} 0 R/Last ${last} 0 R/Count ${outline.length}>>`;
		outline.forEach((o, i) => {
			const id = rootId + 1 + i;
			const links = `${i > 0 ? `/Prev ${id - 1} 0 R` : ""}${i + 1 < outline.length ? `/Next ${id + 1} 0 R` : ""}`;
			objects[id] = `<</Title(${o.title})/Parent ${rootId} 0 R${links}/Dest[${3 + (o.page - 1) * 2} 0 R/Fit]>>`;
		});
	}
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = pdf.length;
		pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
	return new Uint8Array(Buffer.from(pdf, "latin1"));
}
```

`tests/ext-pdf-facts.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readBookmarks, readChapterText, readPageTexts } from "../src/agent/ext/lecture/pdf-facts.ts";
import { buildOutlinePdf } from "./helpers/outline-pdf.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, bytes: Uint8Array): string => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, bytes);
	return p;
};

describe("pdf facts", () => {
	it("reads chapter bookmarks with their pages", async () => {
		const pdf = write("a.pdf", buildOutlinePdf(["intro", "one", "two", "three", "four"], [
			{ title: "Chapter One", page: 2 }, { title: "Chapter Two", page: 4 }, { title: "Chapter Three", page: 5 },
		]));
		const { pageCount, bookmarks } = await readBookmarks(pdf);
		assert.equal(pageCount, 5);
		assert.deepEqual(bookmarks, [{ title: "Chapter One", page: 2 }, { title: "Chapter Two", page: 4 }, { title: "Chapter Three", page: 5 }]);
	});
	it("returns no bookmarks for a PDF without an outline", async () => {
		const pdf = write("b.pdf", buildOutlinePdf(["x", "y"]));
		assert.deepEqual((await readBookmarks(pdf)).bookmarks, []);
	});
	it("reads page texts", async () => {
		const pdf = write("c.pdf", buildOutlinePdf(["alpha page", "beta page"]));
		const pages = await readPageTexts(pdf);
		assert.equal(pages.length, 2);
		assert.match(pages[0]!, /alpha page/);
		assert.match(pages[1]!, /beta page/);
	});
	it("extracts a chapter's plain text without page headers", async () => {
		const pdf = write("d.pdf", buildOutlinePdf(["alpha page", "beta page", "gamma page"]));
		const text = await readChapterText(pdf, { index: 1, title: "t", pageStart: 1, pageEnd: 2 });
		assert.match(text, /alpha page/);
		assert.match(text, /beta page/);
		assert.doesNotMatch(text, /gamma/);
		assert.doesNotMatch(text, /--- Page/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-pdf-facts.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/lecture/pdf-facts.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/lecture/pdf-facts.ts`

```typescript
// src/agent/ext/lecture/pdf-facts.ts
/**
 * What the chapter run needs from a PDF beyond upstream's pdf-ops: the
 * bookmarks (outline) and the plain text of a page range. Uses the same
 * pdfjs build and font setup as pdf-ops.
 */

import * as fs from "node:fs/promises";
import { normalizeBookmarks, plainChapterText, type Chapter, type ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import { pdfExtract, standardFontsDir } from "../../subagents/pdf-ops.ts";

async function open(pdfPath: string) {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(pdfPath));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	return { doc: await task.promise, task };
}

interface OutlineItem {
	title: string;
	dest: unknown;
	items: OutlineItem[];
}

/** The chapter-level bookmarks: the top level, or the level below when the top level is only a few "Part" entries. */
export async function readBookmarks(pdfPath: string): Promise<{ pageCount: number; bookmarks: ChapterStart[] }> {
	const { doc, task } = await open(pdfPath);
	try {
		const outline = (await doc.getOutline()) as OutlineItem[] | null;
		let level: OutlineItem[] = outline ?? [];
		if (level.length < 3) {
			const next = level.flatMap((i) => i.items);
			if (next.length >= 3) level = next;
		}
		const found: ChapterStart[] = [];
		for (const item of level) {
			let dest = item.dest;
			if (typeof dest === "string") dest = await doc.getDestination(dest);
			if (!Array.isArray(dest) || dest.length === 0) continue;
			const target: unknown = dest[0];
			let pageIndex: number;
			if (typeof target === "number") pageIndex = target;
			else {
				try {
					pageIndex = await doc.getPageIndex(target as { num: number; gen: number });
				} catch {
					continue;
				}
			}
			found.push({ title: item.title, page: pageIndex + 1 });
		}
		return { pageCount: doc.numPages, bookmarks: normalizeBookmarks(found) };
	} finally {
		await task.destroy();
	}
}

/** Text of every page, for the no-bookmarks fallback excerpt (cheap: plain text items). */
export async function readPageTexts(pdfPath: string): Promise<string[]> {
	const { doc, task } = await open(pdfPath);
	try {
		const pages: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const content = await (await doc.getPage(i)).getTextContent();
			let text = "";
			for (const item of content.items) {
				if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
			}
			pages.push(text);
		}
		return pages;
	} finally {
		await task.destroy();
	}
}

/** The plain text of one chapter, via the math-aware extraction pdf-ops uses everywhere else. */
export async function readChapterText(pdfPath: string, chapter: Chapter): Promise<string> {
	return plainChapterText(await pdfExtract(pdfPath, `${chapter.pageStart}-${chapter.pageEnd}`));
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-pdf-facts.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 4`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/outline-pdf.ts src/agent/ext/lecture/pdf-facts.ts tests/ext-pdf-facts.test.ts
git commit -m "feat(ext): read PDF bookmarks and chapter text" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 9: The model seam and the three writers (REQ-lec-03, REQ-lec-08, REQ-lec-18)

**Files:**
- Create: `src/agent/ext/lecture/structured.ts`, `src/agent/ext/lecture/prompts.ts`, `src/agent/ext/lecture/writers.ts`
- Test: `tests/ext-lecture-writers.test.ts`

**Contract:**
- `runStructured` is the one place this stage calls a model: a single schema-validated submission through upstream's `runSubmitAgent` (the extractor's seam), `assertWithinCeiling(gate)` BEFORE the call (it throws `CostCeilingError`, which callers treat as "stop", never as "retry"), and `gate.record(priceStep(model, usage), costSource)` for every billed step.
- `detectChaptersWithLlm` (only when a PDF has no usable bookmarks), `writeOutline` and `writeLectureDraft` are thin schemas over it, role `teacher`. The chapter proposal is validated inside the model turn (`validateChapterStarts`), so a bad proposal is retried by the submit agent itself.
- The prompts carry the teacher project's doctrine: continuous prose, the formal definition stated in full, intuition, proof idea, look-ahead; rephrase, never copy; editorial material only in `note` blocks; a timed toy `exercise` right after the main idea, always followed by a `reveal`; node links `[[n_id|words]]` on slides; `narrate` blocks list the node ids they cover; about 2000 words; open from the previous lecture's summary.

- [ ] **Step 1: Write the failing test**

`tests/ext-lecture-writers.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../src/agent/ext/lecture/writers.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { lecturePrompt } from "../src/agent/ext/lecture/prompts.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (name: string, input: unknown): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall(name, input as never, { id: `${name}-1` })], { stopReason: "toolUse" });

function gate(blocked = false): CostGate & { recorded: { usd: number; source: string }[] } {
	const g = {
		recorded: [] as { usd: number; source: string }[],
		allowed: () => !blocked,
		record: (usd: number, source: string) => void g.recorded.push({ usd, source }),
	};
	return g;
}
const priceStep = () => 0.5;
const chapter = { index: 1, title: "One", pageStart: 1, pageEnd: 9 };

describe("writers", () => {
	it("writeOutline returns the submitted blocks and records usage on the gate", async () => {
		const blocks = [{ title: "Sigma algebra", kind: "definition", summary: "s" }];
		const g = gate();
		const out = await writeOutline({ engine: fauxEngine([submit("submit_outline", { blocks })]), gate: g, priceStep }, chapter, "text");
		assert.deepEqual(out, blocks);
		assert.deepEqual(g.recorded[0], { usd: 0.5, source: "lecture" });
	});
	it("writeLectureDraft returns the draft", async () => {
		const l = makeLecture();
		const draft = { title: l.title, summary: l.summary, slides: l.slides, blocks: l.blocks };
		const out = await writeLectureDraft(
			{ engine: fauxEngine([submit("submit_lecture", draft)]), gate: gate(), priceStep },
			{ bookTitle: "B", chapter, order: 1, lectureCount: 1, blocks: [], nodes: [], previousSummary: null, chapterText: "t", feedback: null },
		);
		assert.equal(out.title, l.title);
		assert.equal(out.blocks.length, 4);
	});
	it("refuses to call the model once the cost ceiling is reached", async () => {
		const engine = fauxEngine([submit("submit_outline", { blocks: [{ title: "a", kind: "remark", summary: "s" }] })]);
		await assert.rejects(writeOutline({ engine, gate: gate(true), priceStep }, chapter, "t"), (e: unknown) => e instanceof CostCeilingError);
	});
	it("chapter detection retries inside the model turn when the proposal is invalid", async () => {
		const engine = fauxEngine([
			submit("submit_chapters", { chapters: [{ title: "A", page: 99 }] }),
			submit("submit_chapters", { chapters: [{ title: "A", page: 1 }, { title: "B", page: 5 }] }),
		]);
		const out = await detectChaptersWithLlm({ engine, gate: gate(), priceStep }, "excerpt", 10);
		assert.deepEqual(out, [{ title: "A", page: 1 }, { title: "B", page: 5 }]);
	});
});

describe("lecturePrompt", () => {
	it("carries the node ids, the previous summary, the outline and the feedback", () => {
		const p = lecturePrompt({
			bookTitle: "Book", chapter, order: 2, lectureCount: 3,
			blocks: [{ title: "T", kind: "theorem", summary: "S" }],
			nodes: [{ id: "n_abc123", name: "Name", statement: "Stmt" }],
			previousSummary: "Earlier we saw X.", chapterText: "SOURCE", feedback: "FIX THIS",
		});
		for (const needle of ["lecture 2 of 3", "[n_abc123] Name: Stmt", "Earlier we saw X.", "(theorem) T: S", "SOURCE", "FIX THIS"]) assert.ok(p.includes(needle), needle);
	});
	it("says the first lecture has no previous summary", () => {
		const p = lecturePrompt({ bookTitle: "B", chapter, order: 1, lectureCount: 1, blocks: [], nodes: [], previousSummary: null, chapterText: "t", feedback: null });
		assert.match(p, /this is the first lecture/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-writers.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/lecture/writers.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/lecture/structured.ts`

```typescript
// src/agent/ext/lecture/structured.ts
/**
 * One schema-validated model submission (upstream's runSubmitAgent) with the
 * cost gate fed per billed step. The shared seam of every writer in this stage.
 */

import type { TSchema } from "typebox";
import type { ModelRole } from "../../../../config.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import type { PiEngine } from "../../models.ts";
import { runSubmitAgent } from "../../subagents/submit-agent.ts";

/** Thrown when the daily ceiling is reached; callers stop the unit of work, they do not retry. */
export class CostCeilingError extends Error {
	constructor(reason: string) {
		super(`cost ceiling reached: ${reason}`);
		this.name = "CostCeilingError";
	}
}

/** USD of one billed model step; injected by the server (upstream's pricing lives there). */
export type StepPricer = (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number;

export function assertWithinCeiling(gate: CostGate): void {
	if (!gate.allowed()) throw new CostCeilingError("the daily ceiling for background model work is spent");
}

export async function runStructured<T>(opts: {
	engine: PiEngine;
	role: ModelRole;
	gate: CostGate;
	priceStep: StepPricer;
	/** Label recorded with each spend. */
	costSource: string;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	systemPrompt: string;
	prompt: string;
	signal?: AbortSignal;
	/** Semantic check at the submit seam; a string makes the model retry inside its turn budget. */
	validate?: (value: T) => string | null;
}): Promise<T> {
	assertWithinCeiling(opts.gate);
	return runSubmitAgent<T>({
		role: opts.role,
		toolName: opts.toolName,
		toolDescription: opts.toolDescription,
		parameters: opts.parameters,
		fill: (input) => input as T,
		systemPrompt: opts.systemPrompt,
		prompt: opts.prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) =>
			opts.gate.record(
				opts.priceStep(model, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }),
				opts.costSource,
			),
		neverSubmitted: `the model ended without calling ${opts.toolName}`,
		...(opts.validate ? { validate: opts.validate } : {}),
	});
}
```

`src/agent/ext/lecture/prompts.ts`

```typescript
// src/agent/ext/lecture/prompts.ts
/**
 * Prompts of the lecture writers (pure strings). Doctrine from the teacher
 * project (CLAUDE.md, formato-lezione-spec.md): continuous prose, full formal
 * definitions, editorial additions tagged, never verbatim, timed toy
 * exercises, split from the outline.
 */

import type { Chapter } from "../../../core/ext/lecture/chapters.ts";
import type { OutlineBlock } from "../../../core/ext/lecture/split.ts";

export interface PromptNode {
	id: string;
	name: string;
	statement: string;
}

export const OUTLINE_SYSTEM = `You prepare the lesson plan of one textbook chapter.
Read the chapter and list its conceptual blocks IN THE ORDER the chapter presents them. For each block give a short title, a kind and a one-sentence summary.
Kinds: "definition" (a definition and its immediate comments), "theorem" (a theorem, lemma or proposition together with its proof), "example", "motivation" (introductory or connecting discussion), "remark".
Cover the whole chapter. Do not invent content that is not in the chapter. Write titles and summaries in the language of the chapter.
Submit the list with the submit_outline tool.`;

export function outlinePrompt(chapter: Chapter, chapterText: string): string {
	return `Chapter ${chapter.index}: ${chapter.title}\n\n--- CHAPTER TEXT ---\n${chapterText}`;
}

export const LECTURE_SYSTEM = `You write ONE lecture of a narrated university course from a textbook chapter. A lecture is a structured document: slides (what is shown) and blocks (what is said, in order). Submit it with the submit_lecture tool.

Language: write everything in the language of the chapter text.

Blocks:
- role "narrate": spoken discourse in continuous prose (no bullet points). For each concept: the formal definition stated in full, then the intuition, then for theorems the idea of the proof, then a look ahead.
- role "note": an editorial addition that is NOT in the source (motivation, a link to a later topic, an aside). All editorial material goes in note blocks and only there.
- role "exercise": a short toy example the listener works on for "seconds" (between 30 and 180), placed right after the main idea of a concept. It MUST be followed immediately by a block with role "reveal": the discussion of the solution.
- REPHRASE the source. Never copy sentences from the chapter text: a run of 12 or more consecutive words copied from it is rejected automatically.
- Every "narrate" block lists in nodeIds the graph nodes (given in the task) whose statement it states or explains. Use ONLY ids from that list. Try to cover all the nodes of your outline blocks across the lecture.
- Aim for about 2000 words of narrated text in total.

Slides:
- Each slide has a unique id, a heading and elements. Each element has a unique id (across the lecture) and a type: "text" (content), "formula" (content is LaTeX without delimiters) or "list" (items). Inline math in text and list items uses $...$.
- Mention a graph concept on a slide as [[node_id|visible words]] (for example [[n_ab12cd|sigma algebra]]). Only ids from the node list.
- Every block names the slide it is spoken over (slideId).

Cues: a block may highlight a slide element while it is spoken. A cue has atChar (the character offset in the block text where the highlight starts), target (an element id on that block's slide) and style "box" or "underline". Blocks without highlights have an empty cues list.

summary: 3 to 4 sentences recapping this lecture. The next lecture opens from it.
If a summary of the previous lecture is given, open by connecting to it in one or two sentences.`;

const nodeLines = (nodes: readonly PromptNode[]): string => nodes.map((n) => `- [${n.id}] ${n.name}: ${n.statement}`).join("\n");

export function lecturePrompt(input: {
	bookTitle: string;
	chapter: Chapter;
	order: number;
	lectureCount: number;
	blocks: readonly OutlineBlock[];
	nodes: readonly PromptNode[];
	previousSummary: string | null;
	chapterText: string;
	feedback: string | null;
}): string {
	const outline = input.blocks.map((b, i) => `${i + 1}. (${b.kind}) ${b.title}: ${b.summary}`).join("\n");
	const parts = [
		`Book: ${input.bookTitle}`,
		`Chapter ${input.chapter.index}: ${input.chapter.title}`,
		`You are writing lecture ${input.order} of ${input.lectureCount} of this chapter.`,
		`Outline blocks this lecture must cover, in order:\n${outline}`,
		`Previous lecture summary: ${input.previousSummary ?? "(this is the first lecture)"}`,
		`Graph nodes of this chapter (cite by id):\n${nodeLines(input.nodes)}`,
		`--- CHAPTER TEXT (source; rephrase, never copy) ---\n${input.chapterText}`,
	];
	if (input.feedback !== null) parts.push(input.feedback);
	return parts.join("\n\n");
}

export const CHAPTER_DETECT_SYSTEM = `You identify the top-level chapters of a book from an excerpt of its PDF. Chapters, not sections inside them.
Give each chapter its title and the 1-based PDF page number of the page where its heading appears. Pages must strictly increase and lie inside the book. If unsure about a page, use the page where the heading appears in the body text, not in the table of contents.
Submit with the submit_chapters tool.`;

export function chapterDetectPrompt(excerpt: string, pageCount: number): string {
	return `The book has ${pageCount} pages.\n\n--- EXCERPT ---\n${excerpt}`;
}
```

`src/agent/ext/lecture/writers.ts`

```typescript
// src/agent/ext/lecture/writers.ts
/**
 * The three model calls of a chapter run: chapter detection (fallback), the
 * chapter outline and one lecture. Each is a single schema-validated
 * submission (runStructured). Semantic validation of a lecture happens in the
 * chapter run (validate.ts + retry with feedback), not here.
 */

import { Type } from "typebox";
import type { Chapter, ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import { validateChapterStarts } from "../../../core/ext/lecture/chapters.ts";
import type { LectureDraft } from "../../../core/ext/lecture/build.ts";
import type { OutlineBlock } from "../../../core/ext/lecture/split.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import type { PiEngine } from "../../models.ts";
import {
	CHAPTER_DETECT_SYSTEM,
	LECTURE_SYSTEM,
	OUTLINE_SYSTEM,
	chapterDetectPrompt,
	lecturePrompt,
	outlinePrompt,
	type PromptNode,
} from "./prompts.ts";
import { runStructured, type StepPricer } from "./structured.ts";

export interface WriterDeps {
	engine: PiEngine;
	gate: CostGate;
	priceStep: StepPricer;
	signal?: AbortSignal;
}

const lit = <T extends string>(...v: T[]) => Type.Union(v.map((x) => Type.Literal(x)));

const ChaptersSchema = Type.Object({
	chapters: Type.Array(Type.Object({ title: Type.String(), page: Type.Integer() }), { minItems: 1 }),
});

export async function detectChaptersWithLlm(deps: WriterDeps, excerpt: string, pageCount: number): Promise<ChapterStart[]> {
	const out = await runStructured<{ chapters: ChapterStart[] }>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_chapters",
		toolDescription: "Submit the list of top-level chapters with their start pages.",
		parameters: ChaptersSchema,
		systemPrompt: CHAPTER_DETECT_SYSTEM,
		prompt: chapterDetectPrompt(excerpt, pageCount),
		validate: (v) => {
			const errors = validateChapterStarts(v.chapters, pageCount);
			return errors.length === 0 ? null : errors.join("; ");
		},
	});
	return out.chapters;
}

const OutlineSchema = Type.Object({
	blocks: Type.Array(
		Type.Object({
			title: Type.String(),
			kind: lit("definition", "theorem", "example", "motivation", "remark"),
			summary: Type.String(),
		}),
		{ minItems: 1 },
	),
});

export async function writeOutline(deps: WriterDeps, chapter: Chapter, chapterText: string): Promise<OutlineBlock[]> {
	const out = await runStructured<{ blocks: OutlineBlock[] }>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_outline",
		toolDescription: "Submit the ordered conceptual blocks of the chapter.",
		parameters: OutlineSchema,
		systemPrompt: OUTLINE_SYSTEM,
		prompt: outlinePrompt(chapter, chapterText),
	});
	return out.blocks;
}

const LectureSchema = Type.Object({
	title: Type.String(),
	summary: Type.String(),
	slides: Type.Array(
		Type.Object({
			id: Type.String(),
			heading: Type.String(),
			elements: Type.Array(
				Type.Object({
					id: Type.String(),
					type: lit("text", "formula", "list"),
					content: Type.Optional(Type.String()),
					items: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
		{ minItems: 1 },
	),
	blocks: Type.Array(
		Type.Object({
			id: Type.String(),
			role: lit("narrate", "note", "exercise", "reveal"),
			slideId: Type.String(),
			text: Type.String(),
			nodeIds: Type.Array(Type.String()),
			cues: Type.Array(Type.Object({ atChar: Type.Integer({ minimum: 0 }), target: Type.String(), style: lit("box", "underline") })),
			seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })),
		}),
		{ minItems: 1 },
	),
});

export interface LectureWriteInput {
	bookTitle: string;
	chapter: Chapter;
	order: number;
	lectureCount: number;
	blocks: readonly OutlineBlock[];
	nodes: readonly PromptNode[];
	previousSummary: string | null;
	chapterText: string;
	feedback: string | null;
}

export async function writeLectureDraft(deps: WriterDeps, input: LectureWriteInput): Promise<LectureDraft> {
	return runStructured<LectureDraft>({
		...deps,
		costSource: "lecture",
		role: "teacher",
		toolName: "submit_lecture",
		toolDescription: "Submit the lecture: slides and blocks.",
		parameters: LectureSchema,
		systemPrompt: LECTURE_SYSTEM,
		prompt: lecturePrompt(input),
	});
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-writers.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 6`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/lecture/structured.ts src/agent/ext/lecture/prompts.ts src/agent/ext/lecture/writers.ts tests/ext-lecture-writers.test.ts
git commit -m "feat(ext): add the lecture writers over the gated submit seam" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 10: The chapter run (REQ-lec-03, 04, 05, 07, 08, 18)

**Files:**
- Create: `src/agent/ext/lecture/chapter-run.ts`
- Test: `tests/ext-chapter-run.test.ts`

**Contract:** `runChapter(book, chapter, deps)`, every dependency injected:
1. **Graph first, from the chapter text.** `readChapterText` then, unless the chapter's source already has nodes, the gate is checked and `importChapterGraph({filePath: "<Book>/<NN> <Title>", text})` runs (upstream's notes import). A chapter whose graph is empty fails clearly.
2. **Outline, then split.** `writeOutline`, then `splitOutline` into lecture-sized groups.
3. **Lectures in sequence**, each handed the previous lecture's `summary`, the chapter's nodes and its outline group. Each draft goes through `buildLecture`, `validateLecture` (against the chapter's node ids and the chapter text) and `generateWithFeedback` with at most 2 retries; a lecture still invalid after 3 attempts fails the chapter and is not saved.
4. **Saved lectures replace the chapter's earlier ones** (other chapters untouched). A `CostCeilingError` anywhere ends the chapter as `stopped_cost`, keeping the lectures already saved.
5. **Coverage report:** `uncoveredNodeIds` are the chapter's nodes no saved lecture cites.

- [ ] **Step 1: Write the failing test**

`tests/ext-chapter-run.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { buildLecture } from "../src/core/ext/lecture/build.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { chapterSourcePath, runChapter, type ChapterProgress, type ChapterRunDeps } from "../src/agent/ext/lecture/chapter-run.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

const book = { bookId: "b0123abcd", bookTitle: "Probability 1" };
const chapter = { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 };
const SRC = "src_0123456789ab";

const node = (id: string): Pick<GraphNode, "id" | "name" | "statement" | "provenance"> => ({ id, name: id, statement: `statement of ${id}`, provenance: [{ chatId: SRC, messageId: "" }] });
const base = makeLecture();
const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };

function harness(over: Partial<ChapterRunDeps> = {}) {
	const store = new Map<string, Lecture>();
	const calls = { imports: 0, outlines: 0, writes: [] as (string | null)[], prevSummaries: [] as (string | null)[] };
	let imported = false;
	const progress: ChapterProgress[] = [];
	const gate: CostGate = { allowed: () => true, record: () => {} };
	const deps: ChapterRunDeps = {
		gate,
		lectures: {
			save: (l) => void store.set(l.id, l),
			list: () => [...store.values()],
			remove: (id) => void store.delete(id),
		},
		importChapterGraph: async () => { calls.imports++; imported = true; },
		findSourceId: () => (imported ? SRC : null),
		readNodes: () => (imported ? [node(NODE_A), node(NODE_B)] : []),
		readChapterText: async () => "Unrelated chapter source text that is never copied by the lecture.",
		writeOutline: async () => { calls.outlines++; return [{ title: "T", kind: "definition", summary: "s" }]; },
		writeLecture: async (input) => { calls.writes.push(input.feedback); calls.prevSummaries.push(input.previousSummary); return draft; },
		now: () => "2026-11-04T10:00:00.000Z",
		onProgress: (p) => void progress.push(p),
		...over,
	};
	return { deps, store, calls, progress };
}

describe("runChapter", () => {
	it("extracts the graph from the chapter text first, then writes and saves the lecture", async () => {
		const h = harness();
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.deepEqual(r.lectureIds, ["lec_b0123abcd_c02_l01"]);
		assert.equal(h.calls.imports, 1);
		assert.equal(h.store.get("lec_b0123abcd_c02_l01")?.chapterSourceId, SRC);
		assert.deepEqual(r.uncoveredNodeIds, []);
		assert.deepEqual(h.progress.map((p) => p.state).slice(0, 4), ["queued", "graph", "outline", "writing"]);
	});
	it("does not re-import a chapter whose graph already exists", async () => {
		let imports = 0;
		const h = harness({ findSourceId: () => SRC, readNodes: () => [node(NODE_A), node(NODE_B)], importChapterGraph: async () => void imports++ });
		await runChapter(book, chapter, h.deps);
		assert.equal(imports, 0);
	});
	it("retries a lecture that cites an unknown node, with the validator's feedback, then accepts", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		const answers = [bad, draft];
		const h = harness();
		h.deps.writeLecture = async (input) => { h.calls.writes.push(input.feedback); return answers.shift()!; };
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.equal(h.calls.writes.length, 2);
		assert.equal(h.calls.writes[0], null);
		assert.match(h.calls.writes[1]!, /unknown node n_ghost000/);
	});
	it("fails the chapter after exactly 3 attempts and saves nothing for that lecture", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		let writes = 0;
		const h = harness({ writeLecture: async () => (writes++, bad) });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(writes, 3);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /stayed invalid after 3 attempts/);
		assert.equal(h.store.size, 0);
	});
	it("rejects a lecture that copies the chapter text verbatim", async () => {
		const source = "A sigma algebra is a family of sets closed under complements and countable unions of its members always.";
		const copy = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, text: source } : b)) };
		const h = harness({ readChapterText: async () => source, writeLecture: async () => copy });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /copies the source verbatim/);
	});
	it("writes lectures in sequence, handing each the previous summary, and reports uncovered chapter nodes", async () => {
		const h = harness({
			writeOutline: async () => Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })), // 3000 words -> 2 lectures
			readNodes: () => [node(NODE_A), node(NODE_B), node("n_orphan00")],
			findSourceId: () => SRC,
		});
		h.deps.writeLecture = async (input) => {
			h.calls.prevSummaries.push(input.previousSummary);
			return { ...draft, summary: `summary ${input.order}` };
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.deepEqual(h.calls.prevSummaries, [null, "summary 1"]);
		assert.equal(r.lectureIds.length, 2);
		assert.deepEqual(r.uncoveredNodeIds, ["n_orphan00"]);
	});
	it("replaces earlier lectures of the same chapter and keeps other chapters", async () => {
		const h = harness();
		h.store.set("lec_b0123abcd_c02_l09", makeLecture({ id: "lec_b0123abcd_c02_l09", order: 9 }));
		h.store.set("lec_b0123abcd_c03_l01", makeLecture({ id: "lec_b0123abcd_c03_l01", chapter: { ...chapter, index: 3 } }));
		await runChapter(book, chapter, h.deps);
		assert.deepEqual([...h.store.keys()].sort(), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c03_l01"]);
	});
	it("stops with stopped_cost when the ceiling is reached, before any model call", async () => {
		const h = harness({ gate: { allowed: () => false, record: () => {} } });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.calls.imports + h.calls.outlines + h.calls.writes.length, 0);
	});
	it("treats a ceiling reached inside a writer as stopped_cost and keeps lectures already saved", async () => {
		const h = harness({
			writeOutline: async () => Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })),
		});
		let n = 0;
		h.deps.writeLecture = async () => { if (++n === 2) throw new CostCeilingError("spent"); return draft; };
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.store.size, 1);
	});
	it("fails clearly when the chapter graph is empty", async () => {
		const h = harness({ readNodes: () => [], findSourceId: () => SRC });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /graph is empty/);
	});
	it("labels the import with book and chapter", () => {
		assert.equal(chapterSourcePath(book, chapter), "Probability 1/02 Measurable spaces");
	});
	it("buildLecture output is what gets saved", async () => {
		const h = harness();
		await runChapter(book, chapter, h.deps);
		const meta = { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order: 1, chapterSourceId: SRC, createdAt: "2026-11-04T10:00:00.000Z" };
		assert.deepEqual(h.store.get("lec_b0123abcd_c02_l01"), buildLecture(draft, meta));
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-chapter-run.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/lecture/chapter-run.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/lecture/chapter-run.ts`

```typescript
// src/agent/ext/lecture/chapter-run.ts
/**
 * One chapter run (REQ-lec-03, 04, 05, 07, 08, 18). In order:
 *   1. the chapter graph is extracted from the CHAPTER TEXT through upstream's
 *      notes path (never from generated discourse);
 *   2. an outline is written and split into lectures by estimated length;
 *   3. the lectures are written in sequence (each gets the previous summary),
 *      each validated and retried with feedback at most twice;
 *   4. coverage is reported: chapter nodes no lecture cites.
 * Every dependency is injected, so the flow is tested without a model.
 */

import type { GraphNode } from "../../../core/contracts.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import { buildLecture, type LectureDraft } from "../../../core/ext/lecture/build.ts";
import type { Chapter } from "../../../core/ext/lecture/chapters.ts";
import { parseLecture, type Lecture } from "../../../core/ext/lecture/lecture.ts";
import { generateWithFeedback } from "../../../core/ext/lecture/retry.ts";
import { splitOutline, type OutlineBlock } from "../../../core/ext/lecture/split.ts";
import { feedbackFromErrors, uncoveredChapterNodes, validateLecture } from "../../../core/ext/lecture/validate.ts";
import type { LecturesStore } from "../../../core/ext/study-ports.ts";
import { CostCeilingError, assertWithinCeiling } from "./structured.ts";
import type { LectureWriteInput } from "./writers.ts";

export const MAX_LECTURE_RETRIES = 2;

export type ChapterState = "queued" | "graph" | "outline" | "writing" | "done" | "failed" | "stopped_cost";

export interface ChapterProgress {
	chapter: Chapter;
	state: ChapterState;
	lectures: number;
	uncovered: number;
	error?: string;
}

export interface ChapterResult {
	state: "done" | "failed" | "stopped_cost";
	lectureIds: string[];
	/** Chapter node ids no saved lecture cites (REQ-lec-07). */
	uncoveredNodeIds: string[];
	error?: string;
}

export interface BookRef {
	bookId: string;
	bookTitle: string;
}

export interface ChapterRunDeps {
	gate: CostGate;
	lectures: Pick<LecturesStore, "save" | "list" | "remove">;
	/** Upstream's notes import (extraction.importNotes). Billed by the pipeline itself. */
	importChapterGraph(input: { filePath: string; text: string }): Promise<void>;
	/** The notes-source id of an imported file path, or null. */
	findSourceId(filePath: string): string | null;
	/** The merged graph's nodes (getGraph(...).nodes). */
	readNodes(): ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement" | "provenance">>;
	readChapterText(chapter: Chapter): Promise<string>;
	writeOutline(chapter: Chapter, chapterText: string): Promise<OutlineBlock[]>;
	writeLecture(input: LectureWriteInput): Promise<LectureDraft>;
	now(): string;
	onProgress?(p: ChapterProgress): void;
}

/** The label the chapter graph is imported under (also its provenance label in the graph). */
export function chapterSourcePath(book: BookRef, chapter: Chapter): string {
	return `${book.bookTitle}/${String(chapter.index).padStart(2, "0")} ${chapter.title}`;
}

export async function runChapter(book: BookRef, chapter: Chapter, deps: ChapterRunDeps): Promise<ChapterResult> {
	const saved: Lecture[] = [];
	let uncovered: string[] = [];
	const report = (state: ChapterState, error?: string): void =>
		deps.onProgress?.({ chapter, state, lectures: saved.length, uncovered: uncovered.length, ...(error ? { error } : {}) });
	const result = (state: ChapterResult["state"], error?: string): ChapterResult => {
		report(state, error);
		return { state, lectureIds: saved.map((l) => l.id), uncoveredNodeIds: uncovered, ...(error ? { error } : {}) };
	};

	try {
		report("queued");
		assertWithinCeiling(deps.gate);
		const chapterText = await deps.readChapterText(chapter);

		// 1. the chapter graph, from the chapter text
		report("graph");
		const filePath = chapterSourcePath(book, chapter);
		const nodesOf = (sourceId: string) => deps.readNodes().filter((n) => n.provenance.some((p) => p.chatId === sourceId));
		let sourceId = deps.findSourceId(filePath);
		if (sourceId === null || nodesOf(sourceId).length === 0) {
			assertWithinCeiling(deps.gate);
			await deps.importChapterGraph({ filePath, text: chapterText });
			sourceId = deps.findSourceId(filePath);
		}
		if (sourceId === null) return result("failed", "the chapter graph import left no source record");
		const chapterNodes = nodesOf(sourceId);
		if (chapterNodes.length === 0) return result("failed", "the chapter graph is empty: no node was extracted from the chapter text");
		const chapterNodeIds = chapterNodes.map((n) => n.id);
		const existingNodeIds = new Set(deps.readNodes().map((n) => n.id));

		// 2. outline and split
		report("outline");
		const outline = await deps.writeOutline(chapter, chapterText);
		const groups = splitOutline(outline);
		for (const old of deps.lectures.list()) if (old.bookId === book.bookId && old.chapter.index === chapter.index) deps.lectures.remove(old.id);

		// 3. lectures in sequence
		report("writing");
		let previousSummary: string | null = null;
		for (let i = 0; i < groups.length; i++) {
			const order = i + 1;
			const outcome = await generateWithFeedback<Lecture>({
				maxRetries: MAX_LECTURE_RETRIES,
				attempt: async (feedback) => {
					assertWithinCeiling(deps.gate);
					const draft = await deps.writeLecture({
						bookTitle: book.bookTitle,
						chapter,
						order,
						lectureCount: groups.length,
						blocks: groups[i]!,
						nodes: chapterNodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
						previousSummary,
						chapterText,
						feedback,
					});
					return buildLecture(draft, { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order, chapterSourceId: sourceId!, createdAt: deps.now() });
				},
				validate: (lecture) =>
					parseLecture(JSON.parse(JSON.stringify(lecture))) === null
						? ["the lecture structure is malformed (check ids, roles, cues, and that exercise blocks carry seconds)"]
						: validateLecture(lecture, { existingNodeIds, chapterText }),
				feedback: feedbackFromErrors,
			});
			if (!outcome.ok) {
				return result("failed", `lecture ${order} stayed invalid after ${outcome.attempts} attempts: ${outcome.errors.join("; ")}`);
			}
			deps.lectures.save(outcome.value);
			saved.push(outcome.value);
			previousSummary = outcome.value.summary;
			uncovered = uncoveredChapterNodes(saved, chapterNodeIds);
			report("writing");
		}

		uncovered = uncoveredChapterNodes(saved, chapterNodeIds);
		return result("done");
	} catch (err) {
		if (err instanceof CostCeilingError) return result("stopped_cost", err.message);
		return result("failed", err instanceof Error ? err.message : String(err));
	}
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-chapter-run.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 12`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/lecture/chapter-run.ts tests/ext-chapter-run.test.ts
git commit -m "feat(ext): add the chapter run (graph first, then validated lectures)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 11: The book run (REQ-lec-01, 02, 05)

**Files:**
- Create: `src/agent/ext/lecture/book-run.ts`
- Test: `tests/ext-book-run.test.ts`

**Contract:** `runBook(book, deps)` detects chapters (`detectChapters`: valid bookmarks first, the model only when there are none or they are invalid, its proposal validated), registers the book as a source once (when a library exists), then runs every chapter through `mapPool` with at most 3 in flight (`MAX_PARALLEL_CHAPTERS`) and results in chapter order. `mapPool` never exceeds its limit and handles an empty list.

- [ ] **Step 1: Write the failing test**

`tests/ext-book-run.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectChapters, mapPool, runBook, type BookRunDeps } from "../src/agent/ext/lecture/book-run.ts";

const done = { state: "done" as const, lectureIds: [], uncoveredNodeIds: [] };

function deps(over: Partial<BookRunDeps> = {}): BookRunDeps {
	return {
		readBookmarks: async () => ({ pageCount: 30, bookmarks: [{ title: "A", page: 1 }, { title: "B", page: 11 }] }),
		readPageTexts: async () => ["p1", "p2"],
		detectChaptersWithLlm: async () => { throw new Error("must not be called"); },
		runChapter: async () => done,
		...over,
	};
}

describe("detectChapters", () => {
	it("uses valid bookmarks without calling the model", async () => {
		const ch = await detectChapters(deps());
		assert.deepEqual(ch.map((c) => [c.title, c.pageStart, c.pageEnd]), [["A", 1, 10], ["B", 11, 30]]);
	});
	it("falls back to the model when there are no bookmarks, validating its answer", async () => {
		const d = deps({
			readBookmarks: async () => ({ pageCount: 10, bookmarks: [] }),
			detectChaptersWithLlm: async (excerpt, pages) => (assert.match(excerpt, /PAGE 1/), assert.equal(pages, 10), [{ title: "X", page: 1 }]),
		});
		assert.equal((await detectChapters(d)).length, 1);
	});
	it("rejects an invalid model proposal", async () => {
		const d = deps({ readBookmarks: async () => ({ pageCount: 10, bookmarks: [] }), detectChaptersWithLlm: async () => [{ title: "X", page: 50 }] });
		await assert.rejects(detectChapters(d), /chapter detection failed/);
	});
	it("falls back too when the bookmarks themselves are invalid", async () => {
		const d = deps({ readBookmarks: async () => ({ pageCount: 10, bookmarks: [{ title: "A", page: 99 }] }), detectChaptersWithLlm: async () => [{ title: "Z", page: 2 }] });
		assert.equal((await detectChapters(d))[0]!.title, "Z");
	});
});

describe("runBook", () => {
	it("registers the source once and runs every chapter, keeping order", async () => {
		let registered = 0;
		const r = await runBook({ bookId: "b1", bookTitle: "T" }, deps({ registerSource: () => void registered++, runChapter: async (c) => ({ ...done, lectureIds: [c.title] }) }));
		assert.equal(registered, 1);
		assert.deepEqual(r.chapters.map((c) => c.result.lectureIds[0]), ["A", "B"]);
	});
	it("works without a source library", async () => {
		await runBook({ bookId: "b1", bookTitle: "T" }, deps());
	});
});

describe("mapPool", () => {
	it("never exceeds the limit and returns results in input order", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return n * 10;
		});
		assert.equal(peak, 2);
		assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
	});
	it("handles an empty list", async () => {
		assert.deepEqual(await mapPool([], 3, async (x) => x), []);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-book-run.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/lecture/book-run.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/lecture/book-run.ts`

```typescript
// src/agent/ext/lecture/book-run.ts
/**
 * A whole book (REQ-lec-01, 02, 05): chapters from the bookmarks (LLM fallback
 * when absent), the book registered as an active primary source, chapters run
 * in parallel up to a limit.
 */

import { chaptersFromStarts, validateChapterStarts, buildChapterDetectExcerpt, type Chapter, type ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import type { BookRef, ChapterResult } from "./chapter-run.ts";

export const MAX_PARALLEL_CHAPTERS = 3;

export interface BookRunDeps {
	readBookmarks(): Promise<{ pageCount: number; bookmarks: ChapterStart[] }>;
	readPageTexts(): Promise<string[]>;
	detectChaptersWithLlm(excerpt: string, pageCount: number): Promise<ChapterStart[]>;
	/** Registers the book as an active primary source (REQ-lec-02). Absent = the library is not installed. */
	registerSource?(): void;
	runChapter(chapter: Chapter): Promise<ChapterResult>;
	onChapters?(chapters: Chapter[]): void;
	concurrency?: number;
}

export interface BookResult {
	book: BookRef;
	chapters: Array<{ chapter: Chapter; result: ChapterResult }>;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}

export async function detectChapters(deps: Pick<BookRunDeps, "readBookmarks" | "readPageTexts" | "detectChaptersWithLlm">): Promise<Chapter[]> {
	const { pageCount, bookmarks } = await deps.readBookmarks();
	if (bookmarks.length > 0 && validateChapterStarts(bookmarks, pageCount).length === 0) return chaptersFromStarts(bookmarks, pageCount);
	const excerpt = buildChapterDetectExcerpt(await deps.readPageTexts());
	const proposed = await deps.detectChaptersWithLlm(excerpt, pageCount);
	const errors = validateChapterStarts(proposed, pageCount);
	if (errors.length > 0) throw new Error(`chapter detection failed: ${errors.join("; ")}`);
	return chaptersFromStarts(proposed, pageCount);
}

export async function runBook(book: BookRef, deps: BookRunDeps): Promise<BookResult> {
	const chapters = await detectChapters(deps);
	deps.registerSource?.();
	deps.onChapters?.(chapters);
	const results = await mapPool(chapters, deps.concurrency ?? MAX_PARALLEL_CHAPTERS, (c) => deps.runChapter(c));
	return { book, chapters: chapters.map((chapter, i) => ({ chapter, result: results[i]! })) };
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-book-run.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 8`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/lecture/book-run.ts tests/ext-book-run.test.ts
git commit -m "feat(ext): add the book run with parallel chapters" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 12: The lecture service (REQ-lec-01 to 08)

**Files:**
- Create: `src/server/ext/lecture-service.ts`
- Test: `tests/ext-lecture-service.test.ts`

**Contract:** `createLectureService(deps)` returns `startBookIngest({pdfPath, title?}) => {bookId, finished}` plus the read queries. It refuses (with a status) a relative path or a non-`.pdf` (400), a missing file (404) and a spent ceiling (429); it is single-flight per book id (the same PDF while a run is active returns the running one); the run is recorded in a shared registry the status route reads (`phase`: `detecting` | `running` | `done` | `failed`, plus per-chapter progress); it registers the book as a primary source; it ends `failed` when any chapter did not finish. Reads: `listLectures`, `getLecture`, `overlay`, `citing` (the node-panel back-links).

- [ ] **Step 1: Write the failing test**

`tests/ext-lecture-service.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSourceLibrary } from "../src/core/ext/sources.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { bookIdFor, createLectureService, LectureServiceError, type BookRunStatus, type LectureServiceDeps } from "../src/server/ext/lecture-service.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";
import { memSourcesStore } from "./helpers/ext-fakes.ts";

const PDF = "/books/prob.pdf";
const SRC = "src_0123456789ab";
const base = makeLecture();
const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };

function setup(over: Partial<LectureServiceDeps> = {}) {
	const store = new Map<string, Lecture>();
	const runs = new Map<string, BookRunStatus>();
	let imported = false;
	const deps: LectureServiceDeps = {
		lectures: { save: (l) => void store.set(l.id, l), get: (id) => store.get(id) ?? null, list: () => [...store.values()].sort((a, b) => a.id.localeCompare(b.id)), remove: (id) => void store.delete(id) },
		gate: { allowed: () => true, record: () => {} },
		graphNodes: () => (imported ? [NODE_A, NODE_B].map((id) => ({ id, name: id, statement: "s", provenance: [{ chatId: SRC, messageId: "" }] })) : []),
		importChapterGraph: async () => void (imported = true),
		findSourceId: () => (imported ? SRC : null),
		pdf: {
			exists: (p) => p === PDF,
			readBookmarks: async () => ({ pageCount: 20, bookmarks: [{ title: "Measurable spaces", page: 1 }] }),
			readPageTexts: async () => [],
			readChapterText: async () => "Unrelated source text for this chapter.",
		},
		writers: {
			detectChaptersWithLlm: async () => [],
			writeOutline: async () => [{ title: "t", kind: "definition", summary: "s" }],
			writeLecture: async () => draft,
		},
		runs,
		now: () => "2026-11-04T10:00:00.000Z",
		...over,
	};
	return { svc: createLectureService(deps), store, runs };
}

describe("startBookIngest", () => {
	it("runs the book in the background and ends with phase done and saved lectures", async () => {
		const { svc, store, runs } = setup();
		const { bookId, finished } = svc.startBookIngest({ pdfPath: PDF });
		assert.equal(bookId, bookIdFor(PDF));
		assert.equal(runs.get(bookId)!.phase, "detecting");
		await finished;
		const s = runs.get(bookId)!;
		assert.equal(s.phase, "done");
		assert.equal(s.title, "prob");
		assert.deepEqual(s.chapters.map((c) => c.state), ["done"]);
		assert.equal(store.size, 1);
	});
	it("registers the book as an active primary source when a library is present", async () => {
		const library = createSourceLibrary(memSourcesStore());
		const { svc } = setup({ library });
		await svc.startBookIngest({ pdfPath: PDF, title: "Probability 1" }).finished;
		assert.deepEqual(library.list().map((e) => [e.locator, e.tier, e.status]), [[PDF, "primary", "active"]]);
	});
	it("is single-flight per book", async () => {
		const { svc } = setup();
		const a = svc.startBookIngest({ pdfPath: PDF });
		const b = svc.startBookIngest({ pdfPath: PDF });
		await b.finished;
		await a.finished;
		assert.equal(svc.runStatuses().length, 1);
	});
	it("marks the run failed when some chapter fails", async () => {
		const { svc, runs } = setup({ writers: { detectChaptersWithLlm: async () => [], writeOutline: async () => { throw new Error("boom"); }, writeLecture: async () => draft } });
		const { bookId, finished } = svc.startBookIngest({ pdfPath: PDF });
		await finished;
		assert.equal(runs.get(bookId)!.phase, "failed");
		assert.match(runs.get(bookId)!.chapters[0]!.error!, /boom/);
	});
	it("refuses relative paths, non-pdf files, missing files and a spent ceiling", () => {
		const { svc } = setup({ gate: { allowed: () => false, record: () => {} } });
		const code = (f: () => unknown): number => { try { f(); } catch (e) { return (e as LectureServiceError).status; } return 0; };
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "rel/x.pdf" })), 400);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "/x/notes.txt" })), 400);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "/x/missing.pdf" })), 404);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: PDF })), 429);
	});
});

describe("read queries", () => {
	it("derives the overlay and the back-links from the stored lectures", async () => {
		const { svc } = setup();
		await svc.startBookIngest({ pdfPath: PDF }).finished;
		assert.equal(svc.overlay().nodes.length, 1);
		assert.deepEqual(svc.overlay().edges.map((e) => e.to), [NODE_A, NODE_B]);
		assert.equal(svc.citing(NODE_A).length, 1);
		assert.equal(svc.citing("n_nobody00").length, 0);
		assert.equal(svc.getLecture(svc.listLectures()[0]!.id)?.title, base.title);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-service.test.ts`
Expected: FAIL with `Cannot find module '../src/server/ext/lecture-service.ts'`.

- [ ] **Step 3: Write the implementation**

`src/server/ext/lecture-service.ts`

```typescript
// src/server/ext/lecture-service.ts
/**
 * The lecture stage's service (REQ-lec-01 to 08): starts a book ingest in the
 * background, tracks per-chapter status, and answers the read queries of the
 * pages and routes. Everything impure is injected; the live wiring is
 * lecture-live.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { runBook } from "../../agent/ext/lecture/book-run.ts";
import { runChapter, type ChapterProgress, type ChapterRunDeps } from "../../agent/ext/lecture/chapter-run.ts";
import type { LectureWriteInput } from "../../agent/ext/lecture/writers.ts";
import type { GraphNode } from "../../core/contracts.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import type { LectureDraft } from "../../core/ext/lecture/build.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { Chapter, ChapterStart } from "../../core/ext/lecture/chapters.ts";
import { citingLectures, lectureOverlay } from "../../core/ext/lecture/lecture-graph.ts";
import type { OutlineBlock } from "../../core/ext/lecture/split.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";

export interface BookRunStatus {
	bookId: string;
	title: string;
	pdfPath: string;
	phase: "detecting" | "running" | "done" | "failed";
	chapters: ChapterProgress[];
	error?: string;
	startedAt: string;
}

export class LectureServiceError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface LectureServiceDeps {
	lectures: LecturesStore;
	library?: SourceLibrary;
	gate: CostGate;
	graphNodes(): ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement" | "provenance">>;
	importChapterGraph: ChapterRunDeps["importChapterGraph"];
	findSourceId: ChapterRunDeps["findSourceId"];
	pdf: {
		exists(pdfPath: string): boolean;
		readBookmarks(pdfPath: string): Promise<{ pageCount: number; bookmarks: ChapterStart[] }>;
		readPageTexts(pdfPath: string): Promise<string[]>;
		readChapterText(pdfPath: string, chapter: Chapter): Promise<string>;
	};
	writers: {
		detectChaptersWithLlm(excerpt: string, pageCount: number): Promise<ChapterStart[]>;
		writeOutline(chapter: Chapter, chapterText: string): Promise<OutlineBlock[]>;
		writeLecture(input: LectureWriteInput): Promise<LectureDraft>;
	};
	/** Shared run registry (a globalThis map in the live wiring, so dev reloads do not lose it). */
	runs: Map<string, BookRunStatus>;
	now?: () => string;
}

/** "b" + 8 hex of the path hash: stable per PDF, filesystem-safe (lecture ids embed it). */
export function bookIdFor(pdfPath: string): string {
	return `b${createHash("sha256").update(pdfPath).digest("hex").slice(0, 8)}`;
}

export function createLectureService(deps: LectureServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());

	function startBookIngest(input: { pdfPath: string; title?: string }): { bookId: string; finished: Promise<void> } {
		const pdfPath = input.pdfPath;
		if (!path.isAbsolute(pdfPath) || !pdfPath.toLowerCase().endsWith(".pdf")) throw new LectureServiceError(400, "pdfPath must be an absolute path to a .pdf file");
		if (!deps.pdf.exists(pdfPath)) throw new LectureServiceError(404, "that PDF does not exist");
		const bookId = bookIdFor(pdfPath);
		const running = deps.runs.get(bookId);
		if (running !== undefined && (running.phase === "detecting" || running.phase === "running")) {
			return { bookId, finished: Promise.resolve() };
		}
		if (!deps.gate.allowed()) throw new LectureServiceError(429, "the daily ceiling for background model work is spent");
		const title = (input.title?.trim() || path.basename(pdfPath, path.extname(pdfPath))).trim();
		const status: BookRunStatus = { bookId, title, pdfPath, phase: "detecting", chapters: [], startedAt: now() };
		deps.runs.set(bookId, status);
		const book = { bookId, bookTitle: title };
		const finished = runBook(book, {
			readBookmarks: () => deps.pdf.readBookmarks(pdfPath),
			readPageTexts: () => deps.pdf.readPageTexts(pdfPath),
			detectChaptersWithLlm: deps.writers.detectChaptersWithLlm,
			...(deps.library ? { registerSource: () => registerBookAsPrimary(deps.library!, pdfPath, title) } : {}),
			onChapters: (chapters) => {
				status.phase = "running";
				status.chapters = chapters.map((chapter) => ({ chapter, state: "queued", lectures: 0, uncovered: 0 }));
			},
			runChapter: (chapter) =>
				runChapter(book, chapter, {
					gate: deps.gate,
					lectures: deps.lectures,
					importChapterGraph: deps.importChapterGraph,
					findSourceId: deps.findSourceId,
					readNodes: deps.graphNodes,
					readChapterText: (c) => deps.pdf.readChapterText(pdfPath, c),
					writeOutline: deps.writers.writeOutline,
					writeLecture: deps.writers.writeLecture,
					now,
					onProgress: (p) => {
						const i = status.chapters.findIndex((c) => c.chapter.index === p.chapter.index);
						if (i >= 0) status.chapters[i] = p;
					},
				}),
		}).then(
			() => {
				status.phase = status.chapters.every((c) => c.state === "done") ? "done" : "failed";
				if (status.phase === "failed") status.error = "some chapters did not finish; see the per-chapter errors";
			},
			(err: unknown) => {
				status.phase = "failed";
				status.error = err instanceof Error ? err.message : String(err);
			},
		);
		return { bookId, finished };
	}

	return {
		startBookIngest,
		runStatuses: (): BookRunStatus[] => [...deps.runs.values()],
		listLectures: () => deps.lectures.list(),
		getLecture: (id: string) => deps.lectures.get(id),
		overlay: () => lectureOverlay(deps.lectures.list(), new Set(deps.graphNodes().map((n) => n.id))),
		citing: (nodeId: string) => citingLectures(nodeId, deps.lectures.list()),
	};
}

export type LectureService = ReturnType<typeof createLectureService>;
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-service.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 6`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/server/ext/lecture-service.ts tests/ext-lecture-service.test.ts
git commit -m "feat(ext): add the lecture service" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Live wiring, routes and node-panel back-links (REQ-lec-01 to 06, REQ-lec-11, REQ-lec-12, REQ-lec-18)

**Files:**
- Create: `src/server/ext/cost-live.ts`, `src/server/ext/study-engine.ts`, `src/server/ext/lecture-live.ts`, `app/api/ext/lectures/route.ts`, `app/api/ext/lectures/[id]/route.ts`, `app/api/ext/lectures/overlay/route.ts`
- Modify: `src/server/ext/stores.ts`, `src/server/ext/index.ts`, `src/server/ext/panel-providers.ts`
- Test: `tests/ext-lecture-live.test.ts`, `tests/ext-lecture-panel.test.ts`

**Contract:**
- `stores.ts` (the extension's composition root) gains `lecturesStore` and `snapshotReader` (Task 21 adds the two practice ledgers).
- `cost-live.ts`: the same daily ceiling and `LH_EXT_DAILY_CEILING_USD` override as the verification stage (default 2 USD), built fresh per call; `livePriceStep` prices a billed step with upstream's `callCost` (an unpriced model counts as 0, the same rule as verification).
- `study-engine.ts`: the teacher-slot engine, resolved like the verification stage resolves the researcher slot (readable errors for a missing model or key). Kept apart from `lecture-live.ts` so the chat handler, which imports the practice wiring in Part B, never imports back into itself.
- `lecture-live.ts`: composes `createLectureService` with the real stores, `getGraph(stores.graphStore).nodes`, upstream's `extraction.importNotes` (registering the label in the source directory first, emitting `sources-changed` after, exactly as `app/api/graph/import/route.ts` does) and a run registry on `globalThis` that survives dev reloads. A notes source id is `src_` plus the first 12 hex of the SHA-256 of the file label (upstream's own rule, `extraction.ts`).
- `panel-providers.ts` (node knowledge, landed) gets one member, `lecturesCiting`, so a node's panel lists the lectures that cite it (back-links, REQ-lec-12): the lectures store's list run through the core `citingLectures`, mapped to the panel's `{lectureId, title}`. It reads the store directly and does not import `lecture-live.ts`: that module reaches the chat handler, which reaches `node-knowledge-live.ts`, which imports this file, so importing it here would be a cycle (observed as a `Cannot access 'panelSources' before initialization` crash).
- Routes are transport only: `GET /api/ext/lectures` returns `{runs, lectures}` (lectures without their bodies); `POST` `{pdfPath, title?}` answers 202 `{bookId}` and the run continues in the background; `GET /api/ext/lectures/:id`; `GET /api/ext/lectures/overlay`.

- [ ] **Step 1: Write the failing tests**

`tests/ext-lecture-live.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-live-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { lectureService } = await import("../src/server/ext/lecture-live.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("live composition of the lecture stage", () => {
	it("starts empty and reads nothing from outside the data folder", () => {
		assert.deepEqual(lectureService.listLectures(), []);
		assert.deepEqual(lectureService.runStatuses(), []);
		assert.deepEqual(lectureService.overlay(), { nodes: [], edges: [] });
	});
	it("refuses an ingest of a relative or missing PDF before any model call", () => {
		assert.throws(() => lectureService.startBookIngest({ pdfPath: "book.pdf" }), /absolute path/);
		assert.throws(() => lectureService.startBookIngest({ pdfPath: path.join(TMP_DATA, "none.pdf") }), /does not exist/);
	});
});
```

`tests/ext-lecture-panel.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { makeLecture, NODE_A } from "./helpers/lecture-fixture.ts";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-panel-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { extStores } = await import("../src/server/ext/stores.ts");
const { panelSources } = await import("../src/server/ext/panel-providers.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("lecture back-links in the node panel (REQ-lec-12)", () => {
	it("lists the lectures that cite a node, in the panel's shape", () => {
		extStores.lecturesStore.save(makeLecture());
		assert.deepEqual(panelSources.lecturesCiting?.(NODE_A), [{ lectureId: "lec_b0123abcd_c02_l01", title: "Sigma algebras" }]);
	});
	it("lists none for a node no lecture cites", () => {
		assert.deepEqual(panelSources.lecturesCiting?.("n_none0000"), []);
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-lecture-live.test.ts tests/ext-lecture-panel.test.ts`
Expected: FAIL with `Cannot find module '../src/server/ext/lecture-live.ts'` (the panel test fails on `lecturesCiting` being undefined once the wiring exists, which is the next failure to fix).

- [ ] **Step 3: Edit the extension's composition root**

In `src/server/ext/stores.ts`:

Replace
```typescript
import { createGoalsStore } from "../../store/ext/goals-store.ts";
```
with
```typescript
import { createGoalsStore } from "../../store/ext/goals-store.ts";
import { createLecturesStore } from "../../store/ext/lectures-store.ts";
```

Replace
```typescript
import { createSnapshotStore } from "../../store/ext/snapshot-store.ts";
```
with
```typescript
import { createSnapshotReader } from "../../store/ext/snapshot-reader.ts";
import { createSnapshotStore } from "../../store/ext/snapshot-store.ts";
```

Replace
```typescript
	costStore: createCostStore(EXT_PATHS.dir),
```
with
```typescript
	costStore: createCostStore(EXT_PATHS.dir),
	lecturesStore: createLecturesStore(EXT_PATHS.dir),
	snapshotReader: createSnapshotReader(EXT_PATHS.dir),
```

- [ ] **Step 4: Write the wiring**

`src/server/ext/cost-live.ts`

```typescript
// src/server/ext/cost-live.ts
/**
 * The shared daily ceiling (REQ-cost-01) and the step pricer for the study
 * stage's background model work. Same ceiling and env override as the
 * verification stage; the gate is built fresh per call so an environment
 * change lands without a restart.
 */

import type { StepPricer } from "../../agent/ext/lecture/structured.ts";
import { createCostGate, type CostGate } from "../../core/ext/cost-gate.ts";
import { callCost } from "../pricing.ts";
import { extStores } from "./stores.ts";

const DEFAULT_DAILY_CEILING_USD = 2;
function ceilingUsd(): number {
	const raw = Number(process.env.LH_EXT_DAILY_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING_USD;
}

export const liveCostGate: CostGate = {
	allowed: () => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).allowed(),
	record: (usd, source) => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).record(usd, source),
};

/** USD of one billed step; an unpriced model counts as 0 (the same rule as the verification stage). */
export const livePriceStep: StepPricer = (model, usage) =>
	callCost({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }, model) ?? 0;
```

`src/server/ext/study-engine.ts`

```typescript
// src/server/ext/study-engine.ts
/**
 * The teacher-slot engine and the writer dependencies of the study stage's
 * background model work. Kept apart from lecture-live.ts so that the chat
 * handler (which imports practice-live.ts) never imports back into itself.
 */

import type { WriterDeps } from "../../agent/ext/lecture/writers.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { ROLE_SLOT } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { stores } from "../stores.ts";
import { liveCostGate, livePriceStep } from "./cost-live.ts";

/** The teacher slot's engine, fresh per run (a settings change lands immediately). Throws with a readable reason. */
export function teacherEngine(): PiEngine {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new Error("lectures and exercises need a model for the teacher role: configure the models in settings");
	if (!providerKeyPresent(spec.provider)) throw new Error(`no API key for provider ${spec.provider}`);
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.teacher]?.cacheRetention);
}

export const writerDeps = (): WriterDeps => ({ engine: teacherEngine(), gate: liveCostGate, priceStep: livePriceStep });
```

`src/server/ext/lecture-live.ts`

```typescript
// src/server/ext/lecture-live.ts
/**
 * Composition of the lecture stage: the live stores, the teacher-slot engine,
 * upstream's notes import for the chapter graphs, and the shared cost gate.
 * Only wiring; everything testable is in lecture-service.ts and src/agent/ext.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { readBookmarks, readChapterText, readPageTexts } from "../../agent/ext/lecture/pdf-facts.ts";
import { detectChaptersWithLlm, writeLectureDraft, writeOutline } from "../../agent/ext/lecture/writers.ts";
import { emit } from "../../core/events.ts";
import { getGraph } from "../../core/graph.ts";
import { createSourceLibrary } from "../../core/ext/sources.ts";
import { extraction } from "../chat-handler.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createLectureService, type BookRunStatus } from "./lecture-service.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";

/** The run registry survives dev-server module reloads. */
const g = globalThis as { __lhExtLectureRuns?: Map<string, BookRunStatus> };
const runs = (g.__lhExtLectureRuns ??= new Map<string, BookRunStatus>());

const sourceIdOf = (filePath: string): string => `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

export const lectureService = createLectureService({
	lectures: extStores.lecturesStore,
	library: createSourceLibrary(extStores.sourcesStore),
	gate: liveCostGate,
	graphNodes: () => getGraph(stores.graphStore).nodes,
	importChapterGraph: async ({ filePath, text }) => {
		sourceDirectory.registerImport(filePath);
		try {
			await extraction.importNotes({ filePath, text });
		} finally {
			emit("sources-changed", {});
		}
	},
	findSourceId: (filePath) => {
		const id = sourceIdOf(filePath);
		return sourceDirectory.read().sources.some((s) => s.id === id) ? id : null;
	},
	pdf: { exists: (p) => fs.existsSync(p), readBookmarks, readPageTexts, readChapterText },
	writers: {
		detectChaptersWithLlm: (excerpt, pageCount) => detectChaptersWithLlm(writerDeps(), excerpt, pageCount),
		writeOutline: (chapter, text) => writeOutline(writerDeps(), chapter, text),
		writeLecture: (input) => writeLectureDraft(writerDeps(), input),
	},
	runs,
});
```

- [ ] **Step 5: Write the routes**

`app/api/ext/lectures/route.ts`

```typescript
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
	const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
	return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
}

/** GET → { runs, lectures }: the per-chapter run status and the saved lectures (without their blocks). */
export async function GET() {
	try {
		const lectures = lectureService.listLectures().map((l) => ({ id: l.id, title: l.title, bookTitle: l.bookTitle, chapter: l.chapter, order: l.order }));
		return Response.json({ runs: lectureService.runStatuses(), lectures });
	} catch (error) {
		return errorResponse(error);
	}
}

/** POST { pdfPath, title? } → 202 { bookId }; the run continues in the background. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const { bookId, finished } = lectureService.startBookIngest({
			pdfPath: String(body.pdfPath ?? ""),
			...(typeof body.title === "string" ? { title: body.title } : {}),
		});
		void finished.catch((err) => console.error("[ext] lecture ingest failed:", err));
		return Response.json({ bookId }, { status: 202 });
	} catch (error) {
		return errorResponse(error);
	}
}
```

`app/api/ext/lectures/[id]/route.ts`

```typescript
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const lecture = lectureService.getLecture(id);
	return lecture ? Response.json({ lecture }) : Response.json({ error: "unknown lecture" }, { status: 404 });
}
```

`app/api/ext/lectures/overlay/route.ts`

```typescript
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → { nodes, edges }: lectures as special graph nodes with `cites` edges, derived from lecture.json (REQ-lec-11). */
export async function GET() {
	return Response.json(lectureService.overlay());
}
```

- [ ] **Step 6: Add the barrel line (the ext server barrel is already exported by `src/server/index.ts`)**

Append to `src/server/ext/index.ts` this line (the practice line is appended in Task 21):

```ts
export * from "./lecture-live.ts";
```

- [ ] **Step 7: Fill the node panel's lecture back-links**

In `src/server/ext/panel-providers.ts`:

Replace
```typescript
 *   - lectures:       sources.lecturesCiting (not yet)
```
with
```typescript
 *   - lectures:       sources.lecturesCiting (read from the lectures store)
```

Replace
```typescript
import { panelTrustOf } from "../../core/ext/panel-trust.ts";
```
with
```typescript
import { citingLectures } from "../../core/ext/lecture/lecture-graph.ts";
import { panelTrustOf } from "../../core/ext/panel-trust.ts";
```

Replace
```typescript
import { personalPanel } from "./personal-panel.ts";
```
with
```typescript
import { personalPanel } from "./personal-panel.ts";
import { extStores } from "./stores.ts";
```

Replace
```typescript
	trust: (nodeId) => panelTrustOf(trustViews([nodeId])[0]),
};
```
with
```typescript
	trust: (nodeId) => panelTrustOf(trustViews([nodeId])[0]),
	lecturesCiting: (nodeId) => citingLectures(nodeId, extStores.lecturesStore.list()).map((l) => ({ lectureId: l.id, title: l.title })),
};
```

- [ ] **Step 8: Run the tests, the typecheck and the lint**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/ext-lecture-live.test.ts tests/ext-lecture-panel.test.ts
npx tsc --noEmit -p . | head
npx eslint src/server/ext app/api/ext 2>&1 | tail -5
```

Expected: `pass 4` (2 + 2), `fail 0`; no typecheck output; no lint output. (Lint proves the layer law: `app/api` imports only `@/src/server`.)

- [ ] **Step 9: Commit**

```bash
git add src/server/ext/cost-live.ts src/server/ext/study-engine.ts src/server/ext/lecture-live.ts src/server/ext/stores.ts src/server/ext/index.ts src/server/ext/panel-providers.ts app/api/ext/lectures tests/ext-lecture-live.test.ts tests/ext-lecture-panel.test.ts
git commit -m "feat(ext): wire the lecture stage, add its routes and the node-panel back-links" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Lecture pages and player (REQ-lec-09, REQ-lec-10; functional UI)

**Files:**
- Create: `components/ext/lecture-player.tsx`, `components/ext/lecture-view.tsx`, `components/ext/lectures-panel.tsx`, `app/lectures/page.tsx`, `app/lectures/[id]/page.tsx`
- Modify: `src/core/ext/index.ts` (append; the node-knowledge barrel)
- Test: `tests/ext-study-core-barrel.test.ts`

**Contract:**
- The browser-safe core barrel (`src/core/ext/index.ts`, already exported by `src/core/index.ts`) gains only what the player needs (`activeCue`, `parseNodeLinks`, `stripNodeLinks`, the `Lecture*` types); nothing behind it imports `node:`.
- `LecturePlayer({lecture, onNodeClick?})`: left, the current slide (heading and elements; node links are buttons calling `onNodeClick(nodeId)`; formulas as raw LaTeX in a `<pre>`; the element named by the active cue is boxed or underlined); right, the current block (role label, text), Previous / Play-Pause / Next. Playing speaks `block.text` with `speechSynthesis`, tracks `boundary` offsets for the cue, and moves to the next block on `end`. An `exercise` block, after it is spoken, runs a visible countdown of its `seconds` and then moves on to the `reveal` that follows (Next acts as "Done"). Without `speechSynthesis` the player runs in text mode: Play shows the block, Next moves on.
- `LectureView` (client) passes the node-knowledge plan's `openNodePanel` as `onNodeClick`: a click on a concept opens the node in the docked side panel that plan mounts in the app layout, and the lecture stays on screen beside it (REQ-lec-10); navigation then continues inside the panel.
- `app/lectures/[id]/page.tsx` is a server component (params are a Promise in this Next version, as in `app/chat/[id]/page.tsx`): it reads the lecture through the server barrel and passes plain JSON to `LectureView`.
- `LecturesPanel`: path input, "Make lectures", the per-chapter progress (polled every 3 s) and the lecture list.

- [ ] **Step 1: Write the failing test**

`tests/ext-study-core-barrel.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import * as core from "../src/core/index.ts";

describe("browser-safe core barrel for the lecture player", () => {
	it("exports what the player needs", () => {
		assert.equal(typeof core.activeCue, "function");
		assert.equal(typeof core.parseNodeLinks, "function");
		assert.equal(typeof core.stripNodeLinks, "function");
		assert.deepEqual(core.parseNodeLinks("a [[n_x|b]] c").map((p) => p.kind), ["text", "node", "text"]);
	});
	it("the modules behind it import nothing from node:", () => {
		for (const f of ["src/core/ext/lecture/lecture.ts", "src/core/ext/lecture/cues.ts", "src/core/ext/index.ts"]) {
			assert.equal(/from\s+"node:/.test(fs.readFileSync(f, "utf-8")), false, f);
		}
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-study-core-barrel.test.ts`
Expected: FAIL (`core.activeCue` is not a function).

- [ ] **Step 3: Extend the core barrel**

Append to `src/core/ext/index.ts` (after its existing `export * from ...` lines; skip any statement already present):

```typescript
export { activeCue } from "./lecture/cues.ts";
export { parseNodeLinks, stripNodeLinks, type TextPart } from "./lecture/lecture.ts";
export type {
	Block as LectureBlock,
	Cue as LectureCue,
	Lecture,
	Slide as LectureSlide,
	SlideElement as LectureSlideElement,
} from "./lecture/lecture.ts";
```

- [ ] **Step 4: Run the test and see it pass**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-study-core-barrel.test.ts`
Expected: `pass 2`, `fail 0`.

- [ ] **Step 5: Write the components**

`components/ext/lecture-player.tsx`

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activeCue, parseNodeLinks, type Lecture, type LectureBlock, type LectureSlideElement } from "@/src/core";

const ROLE_LABEL: Record<LectureBlock["role"], string> = { narrate: "", note: "Note", exercise: "Exercise", reveal: "Discussion" };

function Linked({ text, onNodeClick }: { text: string; onNodeClick?: (nodeId: string) => void }) {
	return (
		<>
			{parseNodeLinks(text).map((p, i) =>
				p.kind === "text" ? (
					<span key={i}>{p.text}</span>
				) : (
					<button key={i} type="button" className="underline decoration-dotted" onClick={() => onNodeClick?.(p.nodeId)}>
						{p.label ?? p.nodeId}
					</button>
				),
			)}
		</>
	);
}

function Element({ el, cue, onNodeClick }: { el: LectureSlideElement; cue: "box" | "underline" | null; onNodeClick?: (id: string) => void }) {
	const mark = cue === "box" ? "outline outline-2 outline-offset-2 outline-primary" : cue === "underline" ? "underline decoration-2" : "";
	if (el.type === "list") {
		return (
			<ul className={`list-disc pl-5 ${mark}`}>
				{(el.items ?? []).map((item, i) => (
					<li key={i}><Linked text={item} onNodeClick={onNodeClick} /></li>
				))}
			</ul>
		);
	}
	if (el.type === "formula") return <pre className={`overflow-x-auto font-mono text-sm ${mark}`}>{el.content}</pre>;
	return <p className={mark}><Linked text={el.content ?? ""} onNodeClick={onNodeClick} /></p>;
}

/** Narrated lecture player (REQ-lec-09, 10). Speech: the browser's speechSynthesis; without it the lecture runs in text mode with a manual Next. */
export function LecturePlayer({ lecture, onNodeClick }: { lecture: Lecture; onNodeClick?: (nodeId: string) => void }) {
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [charIndex, setCharIndex] = useState(0);
	const [remaining, setRemaining] = useState<number | null>(null);
	const [hasSpeech, setHasSpeech] = useState(false);
	useEffect(() => setHasSpeech(typeof window !== "undefined" && "speechSynthesis" in window), []);

	const block = lecture.blocks[index];
	const last = index >= lecture.blocks.length - 1;
	const slide = lecture.slides.find((s) => s.id === block?.slideId) ?? lecture.slides[0];
	const cue = block ? activeCue(block.cues, charIndex) : null;

	const goto = useCallback((i: number) => {
		window.speechSynthesis?.cancel();
		setCharIndex(0);
		setRemaining(null);
		setIndex(Math.max(0, Math.min(i, lecture.blocks.length - 1)));
	}, [lecture.blocks.length]);

	const advance = useCallback(() => {
		if (last) setPlaying(false);
		else goto(index + 1);
	}, [goto, index, last]);
	const advanceRef = useRef(advance);
	advanceRef.current = advance;

	// Speak the current block while playing; an exercise then runs its countdown.
	useEffect(() => {
		if (!playing || !block) return;
		const afterSpeech = () => {
			if (block.role === "exercise") setRemaining(block.seconds ?? 60);
			else if (hasSpeech) advanceRef.current();
		};
		if (!hasSpeech) {
			afterSpeech();
			return;
		}
		const u = new SpeechSynthesisUtterance(block.text);
		u.onboundary = (e) => setCharIndex(e.charIndex);
		u.onend = afterSpeech;
		window.speechSynthesis.cancel();
		window.speechSynthesis.speak(u);
		return () => {
			u.onend = null;
			window.speechSynthesis.cancel();
		};
	}, [playing, block, hasSpeech]);

	// The exercise countdown (REQ-lec-10): at zero the lecture moves on to the discussion.
	useEffect(() => {
		if (remaining === null || !playing) return;
		if (remaining <= 0) {
			advanceRef.current();
			return;
		}
		const t = setTimeout(() => setRemaining((r) => (r === null ? r : r - 1)), 1000);
		return () => clearTimeout(t);
	}, [remaining, playing]);

	if (!block || !slide) return <p>This lecture is empty.</p>;
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<section aria-label="Slide" className="flex flex-col gap-3 rounded border p-4">
				<h2 className="text-lg font-medium">{slide.heading}</h2>
				{slide.elements.map((el) => (
					<Element key={el.id} el={el} cue={cue && cue.target === el.id ? cue.style : null} onNodeClick={onNodeClick} />
				))}
			</section>
			<section aria-label="Narration" className="flex flex-col gap-3 rounded border p-4">
				<div className="text-xs text-muted-foreground">
					Block {index + 1} of {lecture.blocks.length}
					{ROLE_LABEL[block.role] ? ` · ${ROLE_LABEL[block.role]}` : ""}
					{!hasSpeech ? " · text mode (no speech engine)" : ""}
				</div>
				<p className={block.role === "note" ? "italic" : ""}>{block.text}</p>
				{remaining !== null ? (
					<div role="timer" className="font-mono text-2xl">{remaining}s</div>
				) : null}
				<div className="mt-auto flex gap-2">
					<button type="button" className="rounded border px-3 py-1" disabled={index === 0} onClick={() => goto(index - 1)}>Previous</button>
					<button type="button" className="rounded border px-3 py-1" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
					<button type="button" className="rounded border px-3 py-1" disabled={last} onClick={() => goto(index + 1)}>{remaining !== null ? "Done" : "Next"}</button>
				</div>
			</section>
		</div>
	);
}
```

`components/ext/lecture-view.tsx`

```tsx
"use client";

import type { Lecture } from "@/src/core";
import { LecturePlayer } from "./lecture-player";
import { openNodePanel } from "./open-node";

/** The lecture beside the node panel: a concept click opens the node in the panel without leaving the lecture (REQ-lec-10). */
export function LectureView({ lecture }: { lecture: Lecture }) {
	return <LecturePlayer lecture={lecture} onNodeClick={openNodePanel} />;
}
```

`components/ext/lectures-panel.tsx`

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

interface ChapterRow { chapter: { index: number; title: string }; state: string; lectures: number; uncovered: number; error?: string }
interface RunRow { bookId: string; title: string; phase: string; error?: string; chapters: ChapterRow[] }
interface LectureRow { id: string; title: string; bookTitle: string; chapter: { index: number; title: string }; order: number }

/** Lectures page: ingest a book PDF (absolute path), follow the per-chapter progress, open lectures (REQ-lec-01 to 08). */
export function LecturesPanel() {
	const [pdfPath, setPdfPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [runs, setRuns] = useState<RunRow[]>([]);
	const [lectures, setLectures] = useState<LectureRow[]>([]);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/ext/lectures");
		if (!res.ok) return;
		const body = (await res.json()) as { runs: RunRow[]; lectures: LectureRow[] };
		setRuns(body.runs);
		setLectures(body.lectures);
	}, []);
	useEffect(() => {
		void refresh();
		const t = setInterval(() => void refresh(), 3000);
		return () => clearInterval(t);
	}, [refresh]);

	async function ingest() {
		setError(null);
		const res = await fetch("/api/ext/lectures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdfPath }) });
		if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start the ingest.");
		else void refresh();
	}

	return (
		<div className="flex flex-col gap-6">
			<form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ingest(); }}>
				<input className="flex-1 rounded border px-2 py-1" placeholder="/absolute/path/to/book.pdf" value={pdfPath} onChange={(e) => setPdfPath(e.target.value)} />
				<button type="submit" className="rounded border px-3 py-1" disabled={pdfPath.trim() === ""}>Make lectures</button>
			</form>
			{error !== null ? <p className="text-destructive">{error}</p> : null}
			{runs.map((r) => (
				<section key={r.bookId} className="rounded border p-3">
					<h2 className="font-medium">{r.title} <span className="text-xs text-muted-foreground">{r.phase}</span></h2>
					{r.error ? <p className="text-destructive">{r.error}</p> : null}
					<ul className="text-sm">
						{r.chapters.map((c) => (
							<li key={c.chapter.index}>
								{c.chapter.index}. {c.chapter.title}: {c.state}, {c.lectures} lectures{c.uncovered > 0 ? `, ${c.uncovered} nodes not covered` : ""}{c.error ? ` (${c.error})` : ""}
							</li>
						))}
					</ul>
				</section>
			))}
			<section>
				<h2 className="mb-2 font-medium">Lectures</h2>
				{lectures.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
					<ul className="flex flex-col gap-1">
						{lectures.map((l) => (
							<li key={l.id}><a className="underline" href={`/lectures/${l.id}`}>{l.bookTitle} · ch. {l.chapter.index} · {l.order}. {l.title}</a></li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
```

- [ ] **Step 6: Write the pages**

`app/lectures/page.tsx`

```tsx
import { LecturesPanel } from "@/components/ext/lectures-panel";

export const dynamic = "force-dynamic";

export default function LecturesPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Lectures</h1>
			<LecturesPanel />
		</main>
	);
}
```

`app/lectures/[id]/page.tsx`

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { LectureView } from "@/components/ext/lecture-view";
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function LecturePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const lecture = lectureService.getLecture(id);
	if (!lecture) notFound();
	return (
		<main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
			<div>
				<Link className="text-sm underline" href="/lectures">All lectures</Link>
				<h1 className="text-xl font-medium">{lecture.bookTitle} · ch. {lecture.chapter.index}: {lecture.title}</h1>
			</div>
			<LectureView lecture={lecture} />
		</main>
	);
}
```

- [ ] **Step 7: Typecheck and lint**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
npx tsc --noEmit -p . | head
npx eslint src/core/ext components/ext app/lectures 2>&1 | tail -8
```

Expected: no output from either.

- [ ] **Step 8: Manual smoke of the player (needs a lecture on disk)**

Without a model key you can still see the player: write a fixture lecture and open it.

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
mkdir -p /tmp/lh-lecture-smoke && cat > /tmp/lh-lecture-smoke/seed.ts <<'SEED'
import { makeLecture } from "tests/helpers/lecture-fixture.ts";
import { createLecturesStore } from "src/store/ext/lectures-store.ts";
createLecturesStore(`${process.env.LH_DATA_DIR}/ext`).save(makeLecture());
console.log("seeded lec_b0123abcd_c02_l01");
SEED
export LH_DATA_DIR="$(pwd)/.fresh-data" && mkdir -p "$LH_DATA_DIR" && npx tsx /tmp/lh-lecture-smoke/seed.ts
bash scripts/dev-fresh.sh --keep
```

(`dev:fresh` wipes `.fresh-data` on every launch unless `--keep` is given, which is why the seed goes there and the server starts with `--keep`.) Open `http://localhost:3005/lectures` (the seeded lecture is listed), open it, press Play: the first block is spoken, the slide's first text element is boxed at the cue offset, the exercise block shows a 60 s countdown (press Next to skip it), the discussion follows, and a `Note` block is shown in italics. Click the underlined concept on the slide: the node panel opens beside the lecture (the seeded node id is not in an empty graph, so the panel reports an unknown node; with a real ingest it shows the node and, under it, this lecture as a back-link). Stop the server; the next plain `npm run dev:fresh` wipes the seeded data. If the speech fails in the Electron app but works in the browser, the Task 1 check was run on a different Electron than the app's; re-run it.

- [ ] **Step 9: Commit**

```bash
git add src/core/ext/index.ts components/ext/lecture-player.tsx components/ext/lecture-view.tsx components/ext/lectures-panel.tsx app/lectures tests/ext-study-core-barrel.test.ts
git commit -m "feat(ext): add the lecture pages and the narrated player" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

# Part B: Office hours and graded exercises

## Task 15: Verdict rules (REQ-lec-14)

**Files:**
- Create: `src/core/ext/practice/verdict.ts`
- Test: `tests/ext-verdict.test.ts`

**Contract:** the model only PROPOSES comparison items `{stepRef, sourceQuote, workQuote, stance}` (`stance`: `matches` | `differs` | `missing`). `checkVerdictItems(items, source, work)` keeps an item only when `sourceQuote` passes the verification stage's `checkQuote` against the source text (`quote_too_short` under 20 characters, `quote_not_found` when absent after normalization) and, unless `stance` is `missing`, `workQuote` occurs in the work after the same normalization (`work_quote_not_found`). `verdictOutcome(kept)` is `not_verifiable` with nothing kept, `consistent` when every kept item matches, `differs` otherwise (a `missing` counts as a difference). The wording never says "correct": `OUTCOME_TEXT.consistent` is "consistent with the designated source ... not a proof of correctness".

- [ ] **Step 1: Write the failing test**

`tests/ext-verdict.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkVerdictItems, parseVerdictItem, verdictOutcome, type VerdictItem } from "../src/core/ext/practice/verdict.ts";

const SOURCE = "The sum of two even numbers is even because each is twice an integer.\nHence the sum is twice an integer, so it is even.";
const WORK = "Let a=2k and b=2m. Then a+b = 2(k+m), which is twice an integer.";

const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m)",
	stance: "matches",
	...over,
});

describe("checkVerdictItems (REQ-lec-14)", () => {
	it("keeps an item whose quotes occur, normalized for case, spacing and hyphenation", () => {
		const r = checkVerdictItems([item({ sourceQuote: "EACH is   twice an integer" })], SOURCE, WORK);
		assert.equal(r.kept.length, 1);
		assert.deepEqual(r.discarded, []);
	});
	it("discards an invented source quotation", () => {
		const r = checkVerdictItems([item({ sourceQuote: "the proof is obviously correct as written" })], SOURCE, WORK);
		assert.deepEqual(r.discarded, [{ stepRef: "s1", reason: "quote_not_found" }]);
		assert.equal(r.kept.length, 0);
	});
	it("discards a too-short source quotation", () => {
		assert.equal(checkVerdictItems([item({ sourceQuote: "even" })], SOURCE, WORK).discarded[0]!.reason, "quote_too_short");
	});
	it("discards matches/differs whose work quotation is not in the work, but not `missing`", () => {
		assert.equal(checkVerdictItems([item({ workQuote: "never written" })], SOURCE, WORK).discarded[0]!.reason, "work_quote_not_found");
		assert.equal(checkVerdictItems([item({ workQuote: "", stance: "matches" })], SOURCE, WORK).discarded[0]!.reason, "work_quote_not_found");
		assert.equal(checkVerdictItems([item({ workQuote: "", stance: "missing" })], SOURCE, WORK).kept.length, 1);
	});
});

describe("verdictOutcome", () => {
	it("is not_verifiable with nothing kept, consistent when all match, differs otherwise", () => {
		assert.equal(verdictOutcome([]), "not_verifiable");
		assert.equal(verdictOutcome([item({})]), "consistent");
		assert.equal(verdictOutcome([item({}), item({ stance: "differs" })]), "differs");
		assert.equal(verdictOutcome([item({ stance: "missing", workQuote: "" })]), "differs");
	});
	it("parses items strictly", () => {
		assert.equal(parseVerdictItem({ ...item({}), stance: "correct" }), null);
		assert.equal(parseVerdictItem(null), null);
		assert.deepEqual(parseVerdictItem(item({})), item({}));
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-verdict.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/practice/verdict.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/practice/verdict.ts`

```typescript
// src/core/ext/practice/verdict.ts
/**
 * Source-anchored verdicts (REQ-lec-14, REQ-ver-04). The model only PROPOSES
 * comparison items; code decides what survives. An item survives when its
 * quotation from the designated source occurs in the source text (the
 * verification stage's checkQuote: normalization, minimum length) and, for
 * `matches` / `differs`, its quotation of the student's work occurs in the
 * work. With nothing surviving the answer is "not_verifiable": the model's own
 * judgment is never the verdict.
 */

import { checkQuote, normalizeForMatch } from "../quote.ts";

/** matches: the work says what the source step says. differs: the work states something else for that step. missing: the work has no counterpart. */
export type VerdictStance = "matches" | "differs" | "missing";

export interface VerdictItem {
	/** The reference step this item is about (a step id for exercises; any short label for a plain source). */
	stepRef: string;
	/** Verbatim from the designated source. */
	sourceQuote: string;
	/** Verbatim from the student's work; empty for `missing`. */
	workQuote: string;
	stance: VerdictStance;
}

export type VerdictDiscard = "quote_not_found" | "quote_too_short" | "work_quote_not_found";
export type VerdictOutcome = "consistent" | "differs" | "not_verifiable";

const STANCES = new Set<string>(["matches", "differs", "missing"]);

/** Structural parse of one model item; null when malformed. */
export function parseVerdictItem(raw: unknown): VerdictItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.stepRef !== "string" || r.stepRef === "" || typeof r.sourceQuote !== "string") return null;
	if (typeof r.workQuote !== "string" || typeof r.stance !== "string" || !STANCES.has(r.stance)) return null;
	return { stepRef: r.stepRef, sourceQuote: r.sourceQuote, workQuote: r.workQuote, stance: r.stance as VerdictStance };
}

const contains = (haystack: string, needle: string): boolean => {
	const n = normalizeForMatch(needle, "join");
	return n !== "" && normalizeForMatch(haystack, "join").includes(n);
};

export function checkVerdictItems(
	items: readonly VerdictItem[],
	source: string,
	work: string,
): { kept: VerdictItem[]; discarded: Array<{ stepRef: string; reason: VerdictDiscard }> } {
	const kept: VerdictItem[] = [];
	const discarded: Array<{ stepRef: string; reason: VerdictDiscard }> = [];
	for (const item of items) {
		const q = checkQuote(source, item.sourceQuote);
		if (q !== "ok") {
			discarded.push({ stepRef: item.stepRef, reason: q });
			continue;
		}
		if (item.stance !== "missing" && !contains(work, item.workQuote)) {
			discarded.push({ stepRef: item.stepRef, reason: "work_quote_not_found" });
			continue;
		}
		kept.push(item);
	}
	return { kept, discarded };
}

/** Nothing surviving: not_verifiable. Every survivor matches: consistent. Otherwise: differs. */
export function verdictOutcome(kept: readonly VerdictItem[]): VerdictOutcome {
	if (kept.length === 0) return "not_verifiable";
	return kept.every((i) => i.stance === "matches") ? "consistent" : "differs";
}

export const OUTCOME_TEXT: Record<VerdictOutcome, string> = {
	consistent: "On the steps checked, the work is consistent with the designated source. This is a comparison with that source, not a proof of correctness.",
	differs: "The work differs from the designated source at the steps listed below.",
	not_verifiable: "Not verifiable: nothing could be confirmed against a designated source.",
};
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-verdict.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 6`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/practice/verdict.ts tests/ext-verdict.test.ts
git commit -m "feat(ext): add the code-checked verdict rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Exercise rules, grading and events (REQ-lec-15, 16, 17)

**Files:**
- Create: `src/core/ext/practice/exercises.ts`
- Test: `tests/ext-exercises.test.ts`

**Contract:**
- An `Exercise` is `{id, prompt, nodeIds, steps: [{id, text, nodeIds}]}`; the steps ARE the reference solution. `validateExerciseSet(exercises, {scope, targetNodeIds, statements})` returns every violation: an empty set; duplicate exercise ids; an empty prompt; fewer than 2 distinct nodes (a single-fact recall is not an exercise); a node outside the goal's scope (exercise or step); a prompt that restates a node statement of 40 or more normalized characters; no steps, duplicate step ids, a step shorter than 20 characters (it must be quotable), a step citing no node; a goal target no exercise covers.
- `isLowConfidence(exercise, trust)`: true when any node the reference uses has a trust level other than `sourced` (missing counts as `unverified`).
- `nodeOutcomes(exercise, kept)`: a step is good when its surviving items all match, bad when any differs or is missing, unknown without items; a node's outcome is `passed` (all its known steps good), `failed` (none good), `weak` (mixed); a node with no known step is omitted.
- Ledger `exercises.jsonl`: events `set_created`, `graded`, `applied`. `deriveExerciseSets` replays them (the first `set_created` per id wins; the latest `graded` per exercise wins; gradings of unknown exercises and events of unknown sets are ignored; the first `applied` wins). `setComplete`: every exercise has a latest grading that is not `not_verifiable`. `setResults`: per node the worst outcome across gradings, EXCEPT that a `passed` outcome of a low-confidence grading is withheld.

- [ ] **Step 1: Write the failing test**

`tests/ext-exercises.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";
import {
	deriveExerciseSets,
	isLowConfidence,
	nodeOutcomes,
	parseExerciseEvent,
	referenceText,
	setComplete,
	setResults,
	validateExerciseSet,
	type Exercise,
	type ExerciseEvent,
} from "../src/core/ext/practice/exercises.ts";

const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m)",
	stance: "matches",
	...over,
});

const ex = (over: Partial<Exercise> = {}): Exercise => ({
	id: "ex1",
	prompt: "Show that the sum of two even numbers is even.",
	nodeIds: ["n_a", "n_b"],
	steps: [
		{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
		{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_a", "n_b"] },
	],
	...over,
});
const CTX = { scope: new Set(["n_a", "n_b", "n_c"]), targetNodeIds: ["n_c"], statements: new Map([["n_a", "Every even number is twice an integer, a fact used everywhere."]]) };

describe("validateExerciseSet (REQ-lec-15)", () => {
	const covering = ex({ nodeIds: ["n_a", "n_c"], steps: [{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a", "n_c"] }] });
	it("accepts a set over scope nodes that covers the targets", () => {
		assert.deepEqual(validateExerciseSet([covering], CTX), []);
	});
	it("rejects an exercise on a single node, outside the scope, or covering no target", () => {
		const text = validateExerciseSet([ex({ nodeIds: ["n_a"] }), ex({ id: "ex2", nodeIds: ["n_a", "n_zzz"] })], CTX).join("\n");
		assert.match(text, /at least 2 nodes/);
		assert.match(text, /n_zzz, which is outside the goal's scope/);
		assert.match(text, /no exercise covers the goal's target node n_c/);
	});
	it("rejects a recall question that restates a node statement, short steps, and uncited steps", () => {
		const bad = ex({
			nodeIds: ["n_a", "n_c"],
			prompt: "Every even number is twice an integer, a fact used everywhere. Prove it.",
			steps: [{ id: "s1", text: "too short", nodeIds: [] }],
		});
		const text = validateExerciseSet([bad], CTX).join("\n");
		assert.match(text, /full statement of n_a/);
		assert.match(text, /shorter than 20/);
		assert.match(text, /cites no node/);
	});
	it("rejects empty sets and duplicate ids", () => {
		assert.match(validateExerciseSet([], CTX).join(), /no exercises/);
		assert.match(validateExerciseSet([covering, covering], CTX).join(), /duplicate exercise id/);
	});
});

describe("grading (REQ-lec-16, 17)", () => {
	it("low confidence when the reference uses any node that is not sourced", () => {
		const e = ex();
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"], ["n_b", "sourced"]])), false);
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"]])), true);
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"], ["n_b", "contested"]])), true);
	});
	it("derives node outcomes from the steps that cite each node", () => {
		const kept: VerdictItem[] = [item({ stepRef: "s1" }), item({ stepRef: "s2", stance: "differs" })];
		assert.deepEqual(nodeOutcomes(ex(), kept), [
			{ nodeId: "n_a", outcome: "weak" }, // s1 good, s2 bad
			{ nodeId: "n_b", outcome: "failed" }, // only s2, bad
		]);
		assert.deepEqual(nodeOutcomes(ex(), [item({ stepRef: "s1" }), item({ stepRef: "s2" })]).map((o) => o.outcome), ["passed", "passed"]);
		assert.deepEqual(nodeOutcomes(ex(), []), []);
	});
	it("renders the reference with step ids", () => {
		assert.equal(referenceText(ex()), "[s1] Write each number as twice an integer.\n[s2] Add them and factor out the two.");
	});
});

const T = "2026-11-04T10:00:00.000Z";
describe("exercise sets", () => {
	const created: ExerciseEvent = { type: "set_created", setId: "set1", goalId: "goal_1", exercises: [ex(), ex({ id: "ex2" })], at: T };
	const graded = (exerciseId: string, over: Partial<Extract<ExerciseEvent, { type: "graded" }>> = {}): ExerciseEvent => ({
		type: "graded", setId: "set1", exerciseId, outcome: "consistent", nodeOutcomes: [{ nodeId: "n_a", outcome: "passed" }], lowConfidence: false, at: T, ...over,
	});
	it("round-trips events through the parser and rejects bad ones", () => {
		for (const e of [created, graded("ex1"), { type: "applied", setId: "set1", reached: true, at: T } as ExerciseEvent]) assert.deepEqual(parseExerciseEvent(JSON.parse(JSON.stringify(e))), e);
		assert.equal(parseExerciseEvent({ ...graded("ex1"), outcome: "correct" }), null);
		assert.equal(parseExerciseEvent({ type: "set_created", setId: "s", goalId: "g", exercises: [], at: T }), null);
	});
	it("is complete only when every exercise has a verifiable grading", () => {
		const open = deriveExerciseSets([created, graded("ex1")])[0]!;
		assert.equal(setComplete(open), false);
		const unverifiable = deriveExerciseSets([created, graded("ex1"), graded("ex2", { outcome: "not_verifiable", nodeOutcomes: [] })])[0]!;
		assert.equal(setComplete(unverifiable), false);
		assert.equal(setComplete(deriveExerciseSets([created, graded("ex1"), graded("ex2")])[0]!), true);
	});
	it("takes the latest grading per exercise and ignores gradings of unknown exercises", () => {
		const s = deriveExerciseSets([created, graded("ex1", { outcome: "differs" }), graded("ex1"), graded("zzz")])[0]!;
		assert.equal(s.graded.get("ex1")!.outcome, "consistent");
		assert.equal(s.graded.size, 1);
	});
	it("aggregates the worst outcome per node and withholds passes of low-confidence gradings", () => {
		const s = deriveExerciseSets([
			created,
			graded("ex1", { nodeOutcomes: [{ nodeId: "n_a", outcome: "passed" }, { nodeId: "n_b", outcome: "passed" }] }),
			graded("ex2", { lowConfidence: true, nodeOutcomes: [{ nodeId: "n_a", outcome: "weak" }, { nodeId: "n_c", outcome: "passed" }] }),
		])[0]!;
		assert.deepEqual(setResults(s).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
			{ nodeId: "n_a", outcome: "weak" },
			{ nodeId: "n_b", outcome: "passed" },
		]);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-exercises.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/practice/exercises.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/practice/exercises.ts`

```typescript
// src/core/ext/practice/exercises.ts
/**
 * Graded exercises (REQ-lec-15, 16, 17). An exercise set belongs to a goal and
 * is built over nodes of the goal's scope. Each exercise carries its reference
 * solution as steps, each step citing the nodes it uses. Grading compares the
 * student's work with that reference through verdict.ts; a node's outcome is
 * derived from the steps that cite it.
 */

import { normalizeForMatch, MIN_QUOTE_CHARS } from "../quote.ts";
import type { TrustLevel } from "../trust.ts";
import type { VerdictItem } from "./verdict.ts";

export interface ExerciseStep {
	id: string;
	text: string;
	nodeIds: string[];
}
export interface Exercise {
	id: string;
	prompt: string;
	/** The nodes the exercise combines. */
	nodeIds: string[];
	/** The reference solution. */
	steps: ExerciseStep[];
}
export type NodeOutcome = "passed" | "weak" | "failed";

export interface ExerciseSetContext {
	/** The goal's scope (targets plus premise closure). */
	scope: ReadonlySet<string>;
	targetNodeIds: readonly string[];
	statements: ReadonlyMap<string, string>;
}

/** Every rule violation of a generated set, empty = accepted. */
export function validateExerciseSet(exercises: readonly Exercise[], ctx: ExerciseSetContext): string[] {
	const errors: string[] = [];
	if (exercises.length === 0) errors.push("the set has no exercises");
	const ids = new Set<string>();
	const covered = new Set<string>();
	for (const ex of exercises) {
		if (ids.has(ex.id)) errors.push(`duplicate exercise id ${ex.id}`);
		ids.add(ex.id);
		if (ex.prompt.trim() === "") errors.push(`exercise ${ex.id} has an empty prompt`);
		const distinct = new Set(ex.nodeIds);
		if (distinct.size < 2) errors.push(`exercise ${ex.id} must combine at least 2 nodes (a single-fact recall question is not an exercise)`);
		for (const id of distinct) {
			covered.add(id);
			if (!ctx.scope.has(id)) errors.push(`exercise ${ex.id} uses node ${id}, which is outside the goal's scope`);
		}
		const prompt = normalizeForMatch(ex.prompt, "join");
		for (const id of distinct) {
			const statement = normalizeForMatch(ctx.statements.get(id) ?? "", "join");
			if (statement.length >= 40 && prompt.includes(statement)) errors.push(`exercise ${ex.id} states the full statement of ${id} in its prompt: ask for an application, not a recall`);
		}
		if (ex.steps.length === 0) errors.push(`exercise ${ex.id} has no reference solution steps`);
		const stepIds = new Set<string>();
		for (const s of ex.steps) {
			if (stepIds.has(s.id)) errors.push(`exercise ${ex.id} repeats step id ${s.id}`);
			stepIds.add(s.id);
			if (s.text.trim().length < MIN_QUOTE_CHARS) errors.push(`exercise ${ex.id} step ${s.id} is shorter than ${MIN_QUOTE_CHARS} characters (it must be quotable)`);
			if (s.nodeIds.length === 0) errors.push(`exercise ${ex.id} step ${s.id} cites no node`);
			for (const id of s.nodeIds) if (!ctx.scope.has(id)) errors.push(`exercise ${ex.id} step ${s.id} cites node ${id}, outside the goal's scope`);
		}
	}
	for (const t of ctx.targetNodeIds) if (!covered.has(t)) errors.push(`no exercise covers the goal's target node ${t}`);
	return [...new Set(errors)];
}

/** The text the student's work is compared with: one line per step, prefixed by its id. */
export function referenceText(ex: Exercise): string {
	return ex.steps.map((s) => `[${s.id}] ${s.text}`).join("\n");
}

/** Every node the reference solution relies on. */
export function nodesUsed(ex: Exercise): string[] {
	return [...new Set([...ex.nodeIds, ...ex.steps.flatMap((s) => s.nodeIds)])];
}

/** REQ-lec-16: the grading is low confidence when the reference uses any node whose trust is not `sourced`. */
export function isLowConfidence(ex: Exercise, trust: ReadonlyMap<string, TrustLevel>): boolean {
	return nodesUsed(ex).some((id) => (trust.get(id) ?? "unverified") !== "sourced");
}

/** Per-node outcomes of one graded exercise: a step is good when its surviving items all match, bad when any differs or is missing, unknown without items. */
export function nodeOutcomes(ex: Exercise, kept: readonly VerdictItem[]): Array<{ nodeId: string; outcome: NodeOutcome }> {
	const stepStatus = new Map<string, "good" | "bad">();
	for (const s of ex.steps) {
		const items = kept.filter((i) => i.stepRef === s.id);
		if (items.length === 0) continue;
		stepStatus.set(s.id, items.every((i) => i.stance === "matches") ? "good" : "bad");
	}
	const out: Array<{ nodeId: string; outcome: NodeOutcome }> = [];
	for (const nodeId of nodesUsed(ex)) {
		const known = ex.steps.filter((s) => s.nodeIds.includes(nodeId) && stepStatus.has(s.id)).map((s) => stepStatus.get(s.id)!);
		if (known.length === 0) continue;
		const good = known.filter((k) => k === "good").length;
		out.push({ nodeId, outcome: good === known.length ? "passed" : good === 0 ? "failed" : "weak" });
	}
	return out;
}

// ── ledger events ───────────────────────────────────────────────────────────

export type ExerciseEvent =
	| { type: "set_created"; setId: string; goalId: string; exercises: Exercise[]; at: string }
	| {
			type: "graded";
			setId: string;
			exerciseId: string;
			outcome: "consistent" | "differs" | "not_verifiable";
			nodeOutcomes: Array<{ nodeId: string; outcome: NodeOutcome }>;
			lowConfidence: boolean;
			at: string;
	  }
	| { type: "applied"; setId: string; reached: boolean; at: string };

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const OUTCOMES = new Set<string>(["passed", "weak", "failed"]);
const VERDICTS = new Set<string>(["consistent", "differs", "not_verifiable"]);

function parseExercise(raw: unknown): Exercise | null {
	if (!isObj(raw) || !isStr(raw.id) || typeof raw.prompt !== "string") return null;
	if (!Array.isArray(raw.nodeIds) || !raw.nodeIds.every(isStr) || !Array.isArray(raw.steps)) return null;
	const steps: ExerciseStep[] = [];
	for (const s of raw.steps) {
		if (!isObj(s) || !isStr(s.id) || typeof s.text !== "string" || !Array.isArray(s.nodeIds) || !s.nodeIds.every(isStr)) return null;
		steps.push({ id: s.id, text: s.text, nodeIds: [...s.nodeIds] });
	}
	return { id: raw.id, prompt: raw.prompt, nodeIds: [...raw.nodeIds], steps };
}

export function parseExerciseEvent(raw: unknown): ExerciseEvent | null {
	if (!isObj(raw) || !isStr(raw.setId) || !isStr(raw.at)) return null;
	if (raw.type === "applied") return typeof raw.reached === "boolean" ? { type: "applied", setId: raw.setId, reached: raw.reached, at: raw.at } : null;
	if (raw.type === "graded") {
		if (!isStr(raw.exerciseId) || !isStr(raw.outcome) || !VERDICTS.has(raw.outcome) || typeof raw.lowConfidence !== "boolean" || !Array.isArray(raw.nodeOutcomes)) return null;
		const outcomes: Array<{ nodeId: string; outcome: NodeOutcome }> = [];
		for (const o of raw.nodeOutcomes) {
			if (!isObj(o) || !isStr(o.nodeId) || !isStr(o.outcome) || !OUTCOMES.has(o.outcome)) return null;
			outcomes.push({ nodeId: o.nodeId, outcome: o.outcome as NodeOutcome });
		}
		return { type: "graded", setId: raw.setId, exerciseId: raw.exerciseId, outcome: raw.outcome as "consistent" | "differs" | "not_verifiable", nodeOutcomes: outcomes, lowConfidence: raw.lowConfidence, at: raw.at };
	}
	if (raw.type === "set_created") {
		if (!isStr(raw.goalId) || !Array.isArray(raw.exercises) || raw.exercises.length === 0) return null;
		const exercises: Exercise[] = [];
		for (const e of raw.exercises) {
			const parsed = parseExercise(e);
			if (parsed === null) return null;
			exercises.push(parsed);
		}
		return { type: "set_created", setId: raw.setId, goalId: raw.goalId, exercises, at: raw.at };
	}
	return null;
}

export interface ExerciseSetState {
	setId: string;
	goalId: string;
	exercises: Exercise[];
	createdAt: string;
	/** Latest grading per exercise id. */
	graded: Map<string, Extract<ExerciseEvent, { type: "graded" }>>;
	applied: { reached: boolean } | null;
}

export function deriveExerciseSets(events: readonly ExerciseEvent[]): ExerciseSetState[] {
	const sets = new Map<string, ExerciseSetState>();
	for (const e of events) {
		if (e.type === "set_created") {
			if (!sets.has(e.setId)) sets.set(e.setId, { setId: e.setId, goalId: e.goalId, exercises: e.exercises, createdAt: e.at, graded: new Map(), applied: null });
			continue;
		}
		const s = sets.get(e.setId);
		if (s === undefined) continue;
		if (e.type === "graded") {
			if (s.exercises.some((x) => x.id === e.exerciseId)) s.graded.set(e.exerciseId, e);
		} else if (s.applied === null) s.applied = { reached: e.reached };
	}
	return [...sets.values()];
}

/** Every exercise has a latest grading that could be verified. */
export function setComplete(set: ExerciseSetState): boolean {
	return set.exercises.every((x) => {
		const g = set.graded.get(x.id);
		return g !== undefined && g.outcome !== "not_verifiable";
	});
}

/**
 * The results handed to the personal layer when a set is complete. Per node the
 * worst outcome across exercises wins. Passed outcomes of LOW-CONFIDENCE
 * gradings are withheld (a pass resting on unverified nodes does not advance a
 * goal); their weak and failed outcomes still count, since they only reopen a node.
 */
export function setResults(set: ExerciseSetState): Array<{ nodeId: string; outcome: NodeOutcome }> {
	const rank: Record<NodeOutcome, number> = { passed: 0, weak: 1, failed: 2 };
	const worst = new Map<string, NodeOutcome>();
	for (const g of set.graded.values()) {
		for (const o of g.nodeOutcomes) {
			if (g.lowConfidence && o.outcome === "passed") continue;
			const prev = worst.get(o.nodeId);
			if (prev === undefined || rank[o.outcome] > rank[prev]) worst.set(o.nodeId, o.outcome);
		}
	}
	return [...worst.entries()].map(([nodeId, outcome]) => ({ nodeId, outcome }));
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-exercises.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 11`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/practice/exercises.ts tests/ext-exercises.test.ts
git commit -m "feat(ext): add exercise rules, grading derivation and events" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Office-hours session events (REQ-lec-12, REQ-lec-14)

**Files:**
- Create: `src/core/ext/practice/office-hours.ts`
- Test: `tests/ext-office-hours-events.test.ts`

**Contract:** ledger `office-hours.jsonl`, keyed by chat id. Event `designated` `{chatId, label, sha256, exercise?: {setId, exerciseId}, at}` pins the text a session's work is compared with (a snapshot hash, 64 hex); event `verdict` `{chatId, outcome, items, discarded, at}` records each verdict given. `designationOf(events, chatId)` is the latest designation of a chat or null. The parser rejects a malformed hash, an unknown outcome and malformed items, so a corrupt line is skipped by the ledger.

- [ ] **Step 1: Write the failing test**

`tests/ext-office-hours-events.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { designationOf, parseOfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";

const T = "2026-11-04T10:00:00.000Z";
const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m)",
	stance: "matches",
	...over,
});

describe("office-hours events", () => {
	const hash = "a".repeat(64);
	it("round-trips and resolves the latest designation of a chat", () => {
		const d1 = parseOfficeHoursEvent({ type: "designated", chatId: "c1", label: "L1", sha256: hash, at: T })!;
		const d2 = parseOfficeHoursEvent({ type: "designated", chatId: "c1", label: "L2", sha256: hash, exercise: { setId: "s", exerciseId: "e" }, at: T })!;
		const v = parseOfficeHoursEvent({ type: "verdict", chatId: "c1", outcome: "differs", items: [item({})], discarded: 1, at: T })!;
		assert.equal(designationOf([d1, v, d2], "c1")?.label, "L2");
		assert.equal(designationOf([d1], "other"), null);
	});
	it("rejects malformed events", () => {
		assert.equal(parseOfficeHoursEvent({ type: "designated", chatId: "c", label: "L", sha256: "xyz", at: T }), null);
		assert.equal(parseOfficeHoursEvent({ type: "verdict", chatId: "c", outcome: "correct", items: [], discarded: 0, at: T }), null);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-office-hours-events.test.ts`
Expected: FAIL with `Cannot find module '../src/core/ext/practice/office-hours.ts'`.

- [ ] **Step 3: Write the implementation**

`src/core/ext/practice/office-hours.ts`

```typescript
// src/core/ext/practice/office-hours.ts
/**
 * office-hours.jsonl: the designated source of an office-hours session and
 * every verdict given. Keyed by chat id (the session is a chat of kind
 * `office_hours`). The conversation itself lives in the chat record.
 */

import { parseVerdictItem, type VerdictItem, type VerdictOutcome } from "./verdict.ts";

export type OfficeHoursEvent =
	| {
			type: "designated";
			chatId: string;
			/** Human label of the source ("Solutions manual, ch. 3", "Exercise ex_1 reference"). */
			label: string;
			/** Snapshot of the source text (data/ext/snapshots/<sha256>.txt). */
			sha256: string;
			/** Set when the session grades an exercise. */
			exercise?: { setId: string; exerciseId: string };
			at: string;
	  }
	| { type: "verdict"; chatId: string; outcome: VerdictOutcome; items: VerdictItem[]; discarded: number; at: string };

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseOfficeHoursEvent(raw: unknown): OfficeHoursEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.chatId) || !isStr(r.at)) return null;
	if (r.type === "designated") {
		if (!isStr(r.label) || !/^[0-9a-f]{64}$/.test(String(r.sha256))) return null;
		const ex = r.exercise as { setId?: unknown; exerciseId?: unknown } | undefined;
		if (ex !== undefined && (!isStr(ex.setId) || !isStr(ex.exerciseId))) return null;
		return {
			type: "designated",
			chatId: r.chatId,
			label: r.label,
			sha256: r.sha256 as string,
			...(ex ? { exercise: { setId: ex.setId as string, exerciseId: ex.exerciseId as string } } : {}),
			at: r.at,
		};
	}
	if (r.type === "verdict") {
		if (r.outcome !== "consistent" && r.outcome !== "differs" && r.outcome !== "not_verifiable") return null;
		if (!Array.isArray(r.items) || typeof r.discarded !== "number") return null;
		const items: VerdictItem[] = [];
		for (const i of r.items) {
			const p = parseVerdictItem(i);
			if (p === null) return null;
			items.push(p);
		}
		return { type: "verdict", chatId: r.chatId, outcome: r.outcome, items, discarded: r.discarded, at: r.at };
	}
	return null;
}

export type Designation = Extract<OfficeHoursEvent, { type: "designated" }>;

/** The latest designation of a session, or null. */
export function designationOf(events: readonly OfficeHoursEvent[], chatId: string): Designation | null {
	let found: Designation | null = null;
	for (const e of events) if (e.type === "designated" && e.chatId === chatId) found = e;
	return found;
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-office-hours-events.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 2`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/ext/practice/office-hours.ts tests/ext-office-hours-events.test.ts
git commit -m "feat(ext): add office-hours designation and verdict events" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 18: The office-hours agent: tools, instructions, construction (REQ-lec-13, REQ-lec-14)

**Files:**
- Create: `src/agent/ext/practice/office-hours-instructions.ts`, `src/agent/ext/practice/office-hours-tools.ts`, `src/agent/ext/practice/office-hours-agent.ts`
- Test: `tests/ext-office-hours-tools.test.ts`

**Contract:**
- Tools: `read_source` (the designated source and its label, or "no source is designated"), upstream's `ask_user_question` (reused), and `verdict`. **`verdict` is registered only when the newest user message in the stored record begins with `/verdict`.** The chat handler persists the user message before it builds the agent (`saveMessages(chatId, merged)` precedes the turn in `src/server/chat-handler.ts`), so the record the tools read already holds the command; a follow-up message after the command removes the tool again. The tool passes the model's items and the learner's work (every user message except command messages, joined) to the service; a service error becomes a retryable error result.
- The instructions (an `AgentBuildOptions.instructions` string, the seam the personal layer added; no upstream prompt file changes) forbid stating correctness in the model's own voice, forbid revealing the source before the learner has worked, define the verdict items and their quotation rules, and tell the model to relay the tool's text as it is and then ask one pointing question per difference.
- `createOfficeHoursAgent` is `createPracticeAgent` with these tools and instructions, the same construction the review agent uses.

- [ ] **Step 1: Write the failing test**

`tests/ext-office-hours-tools.test.ts`

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOfficeHoursAgent } from "../src/agent/ext/practice/office-hours-agent.ts";
import { OFFICE_HOURS_INSTRUCTIONS } from "../src/agent/ext/practice/office-hours-instructions.ts";
import { learnerTexts, officeHoursTools, verdictRequested, type OfficeHoursToolContext } from "../src/agent/ext/practice/office-hours-tools.ts";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const msgs = (...texts: string[]): LhMessage[] => texts.map((t) => newUserMessage(t));

function ctxFor(messages: LhMessage[], source: { label: string; text: string } | null) {
	const submitted: Array<{ items: VerdictItem[]; work: string }> = [];
	const ctx: OfficeHoursToolContext = {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages }) },
		source: () => source,
		submitVerdict: (items, work) => {
			submitted.push({ items, work });
			return { text: `checked ${items.length}` };
		},
	};
	return { ctx, submitted };
}

describe("verdict gating (REQ-lec-14)", () => {
	it("detects the command only as the newest user message", () => {
		assert.equal(verdictRequested(msgs("hello", "/verdict")), true);
		assert.equal(verdictRequested(msgs("/verdict", "but wait, one more thing")), false);
		assert.equal(verdictRequested(msgs("  /verdict please")), true);
		assert.equal(verdictRequested([]), false);
	});
	it("registers the verdict tool only on the command", () => {
		const plain = officeHoursTools(ctxFor(msgs("here is my proof"), null).ctx);
		assert.deepEqual(Object.keys(plain).sort(), ["ask_user_question", "read_source"]);
		const asked = officeHoursTools(ctxFor(msgs("here is my proof", "/verdict"), null).ctx);
		assert.deepEqual(Object.keys(asked).sort(), ["ask_user_question", "read_source", "verdict"]);
	});
	it("excludes command messages from the work", () => {
		assert.deepEqual(learnerTexts(msgs("my proof", "/verdict", "more")), ["my proof", "more"]);
	});
});

describe("tools", () => {
	it("read_source returns the designated source or says there is none", async () => {
		const withSource = officeHoursTools(ctxFor(msgs("x"), { label: "Manual ch.3", text: "Step one is trivial." }).ctx);
		const r1 = await withSource.read_source!.execute("t", {} as never);
		assert.match(JSON.stringify(r1), /DESIGNATED SOURCE: Manual ch\.3[\s\S]*Step one is trivial\./);
		const none = officeHoursTools(ctxFor(msgs("x"), null).ctx);
		assert.match(JSON.stringify(await none.read_source!.execute("t", {} as never)), /No source is designated/);
	});
	it("verdict passes the items and the learner's work (never the command) to the service", async () => {
		const { ctx, submitted } = ctxFor(msgs("Let a=2k.", "Then a+b=2(k+m).", "/verdict"), { label: "S", text: "t" });
		const tools = officeHoursTools(ctx);
		const item = { stepRef: "s1", sourceQuote: "each is twice an integer", workQuote: "Let a=2k.", stance: "matches" as const };
		const res = await tools.verdict!.execute("t", { items: [item] } as never);
		assert.match(JSON.stringify(res), /checked 1/);
		assert.equal(submitted[0]!.work, "Let a=2k.\n\nThen a+b=2(k+m).");
		assert.deepEqual(submitted[0]!.items, [item]);
	});
	it("a service error becomes a retryable error result", async () => {
		const { ctx } = ctxFor(msgs("/verdict"), null);
		ctx.submitVerdict = () => {
			throw new Error("no source is designated");
		};
		const res = await officeHoursTools(ctx).verdict!.execute("t", { items: [] } as never);
		assert.equal((res as { isError?: boolean }).isError, true);
	});
});

describe("agent", () => {
	it("is built with its own tools and instructions naming them", () => {
		const agent = createOfficeHoursAgent(ctxFor(msgs("x"), null).ctx, {
			engine: { model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never, streamFn: (async () => { throw new Error("not streamed"); }) as never },
		});
		assert.equal(typeof agent.prompt, "function");
		for (const name of ["read_source", "verdict", "ask_user_question"]) assert.match(OFFICE_HOURS_INSTRUCTIONS, new RegExp(name));
		assert.match(OFFICE_HOURS_INSTRUCTIONS, /\/verdict/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-office-hours-tools.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/ext/practice/office-hours-agent.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/practice/office-hours-instructions.ts`

```typescript
// src/agent/ext/practice/office-hours-instructions.ts
/**
 * The office-hours agent's system prompt (REQ-lec-12, 13, 14). A TypeScript
 * constant on purpose: it rides AgentBuildOptions.instructions, so no
 * upstream prompt directory or override key changes (docs/ext/TOUCHPOINTS.md).
 */

export const OFFICE_HOURS_INSTRUCTIONS = `You hold office hours for a learner who has written their own work (a proof, a solution, an explanation) and wants it reviewed. You never write the solution for them.

## What you may and may not do

- Ask questions and point at places. Use ask_user_question for a question that needs an answer; ask ONE per turn and end your turn. Hints are short and aim at the learner's own reasoning ("which hypothesis lets you take this step?").
- NEVER say that the work, or any part of it, is correct or incorrect, complete or flawed, in your own voice. You have no authority to judge. The only judgment available is the VERDICT below, which is built from quotations that code checks.
- NEVER reveal a step of the designated source before the learner has worked on it, and never paste the source's solution. read_source is for you to read; quote from it only inside a verdict.

## The designated source

The session has one DESIGNATED SOURCE: the text the work is compared with (a solutions manual passage, a textbook proof, an exercise's reference solution). Call read_source to read it. If it reports that no source is designated, say that no verdict is possible and keep to questions; do not compare against your own knowledge.

## The verdict

A verdict happens ONLY when the learner types the command /verdict. Until then the verdict tool does not exist for you, and you must not announce results. When the learner sends /verdict, read the source with read_source if you have not, then call verdict ONCE with items. Each item compares ONE step of the source with the learner's work:
- stepRef: a short label for the step ("s2" for an exercise reference, otherwise your own label).
- sourceQuote: a quotation copied EXACTLY from the source, at least 20 characters. Never paraphrase and never invent.
- workQuote: a quotation copied EXACTLY from the learner's work that addresses that step; empty only when stance is missing.
- stance: matches when the work says what the source step says (same claim, same justification, notation aside), differs when the work states something else for that step, missing when the work has no counterpart.

Code checks every quotation against the texts. Items whose quotations are not found are dropped, and with nothing left the verdict is "not verifiable". Quote carefully: a short exact quote is better than a long inexact one. After the tool returns, relay its text to the learner as it is and, for each difference listed, ask one question that points at the place without giving the fix.

## Style

Brief and direct. Maths in LaTeX with $...$ and $$...$$. No praise by reflex, no lectures.`;
```

`src/agent/ext/practice/office-hours-tools.ts`

```typescript
// src/agent/ext/practice/office-hours-tools.ts
/**
 * THE OFFICE-HOURS AGENT'S TOOLS (REQ-lec-12 to 14).
 *
 * `verdict` is registered ONLY when the learner's latest message is the
 * command /verdict: the gate is structural (the model cannot call a tool it
 * does not have), not a prompt promise. The command message is already in the
 * stored record when the turn starts (the chat handler persists the user
 * message before building the agent), which is what this reads.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../../core/native-messages.ts";
import { parseVerdictItem, type VerdictItem } from "../../../core/ext/practice/verdict.ts";
import { askUserQuestionTool } from "../../tools.ts";
import { invalidInputResult, toToolResult } from "../../tool-execute.ts";
import { healToolRecord } from "../../tools/heal.ts";

export const VERDICT_COMMAND = "/verdict";
export const MAX_SOURCE_CHARS = 30_000;

export interface VerdictReport {
	/** Text relayed to the model (and so to the learner). */
	text: string;
}

export interface OfficeHoursToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
	/** The designated source, or null when the session has none. */
	source(): { label: string; text: string } | null;
	/** Checks the items against the source and the work, records the verdict (and the grading of an exercise). */
	submitVerdict(items: VerdictItem[], work: string): VerdictReport;
}

function textOf(m: LhMessage): string {
	if (m.role !== "user") return "";
	const c = m.content as unknown;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join("\n");
	return "";
}

/** The user's messages in order, command messages excluded. */
export function learnerTexts(messages: readonly LhMessage[]): string[] {
	return messages.map(textOf).filter((t) => t.trim() !== "" && !t.trim().startsWith(VERDICT_COMMAND));
}

/** True when the newest user message is the verdict command. */
export function verdictRequested(messages: readonly LhMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		return textOf(m).trim().startsWith(VERDICT_COMMAND);
	}
	return false;
}

const emptyInput = Type.Object({});
const verdictInput = Type.Object({
	items: Type.Array(
		Type.Object({
			stepRef: Type.String({ minLength: 1 }),
			sourceQuote: Type.String({ description: "Copied exactly from the designated source." }),
			workQuote: Type.String({ description: "Copied exactly from the learner's work; empty only for stance missing." }),
			stance: Type.Union([Type.Literal("matches"), Type.Literal("differs"), Type.Literal("missing")]),
		}),
		{ maxItems: 40 },
	),
});

export function officeHoursTools(ctx: OfficeHoursToolContext): Record<string, AgentTool<any>> {
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];

	const read_source: AgentTool<typeof emptyInput> = {
		name: "read_source",
		label: "read_source",
		description: "Read the session's designated source (the text the learner's work is compared with). Reports when none is designated.",
		parameters: emptyInput,
		executionMode: "sequential",
		execute: async () => {
			const s = ctx.source();
			if (s === null) return toToolResult("No source is designated for this session. No verdict is possible; keep to questions.");
			const clipped = s.text.length > MAX_SOURCE_CHARS ? `${s.text.slice(0, MAX_SOURCE_CHARS)}\n[truncated]` : s.text;
			return toToolResult(`DESIGNATED SOURCE: ${s.label}\n\n${clipped}`);
		},
	};

	const tools: Record<string, AgentTool<any>> = { read_source, ask_user_question: askUserQuestionTool };

	if (verdictRequested(messages)) {
		const verdict: AgentTool<typeof verdictInput> = {
			name: "verdict",
			label: "verdict",
			description:
				"Give the verdict on the learner's work against the designated source. Pass comparison items with EXACT quotations from the source and from the work; code checks them. Call once.",
			parameters: verdictInput,
			executionMode: "sequential",
			execute: async (_id, input) => {
				const items: VerdictItem[] = [];
				for (const raw of input.items) {
					const item = parseVerdictItem(raw);
					if (item === null) return invalidInputResult("verdict", ["malformed item"]);
					items.push(item);
				}
				try {
					const report = ctx.submitVerdict(items, learnerTexts(messages).join("\n\n"));
					return { ...toToolResult(report.text), details: { kind: "verdict" } };
				} catch (e) {
					return invalidInputResult("verdict", [e instanceof Error ? e.message : String(e)]);
				}
			},
		};
		tools.verdict = verdict;
	}
	return healToolRecord(tools);
}
```

`src/agent/ext/practice/office-hours-agent.ts`

```typescript
// src/agent/ext/practice/office-hours-agent.ts
/**
 * The office-hours session's agent: the practice agent's construction with its
 * own tools and instructions (the same seam the review agent uses).
 */

import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { OFFICE_HOURS_INSTRUCTIONS } from "./office-hours-instructions.ts";
import { officeHoursTools, type OfficeHoursToolContext } from "./office-hours-tools.ts";

export function createOfficeHoursAgent(ctx: OfficeHoursToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: officeHoursTools(ctx), instructions: OFFICE_HOURS_INSTRUCTIONS },
	);
}
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-office-hours-tools.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 7`, `fail 0`, no typecheck output. (If the typecheck says `instructions` does not exist on `AgentBuildOptions`, the personal-layer plan's Task 9 has not landed: Task 1 Step 1 would have caught it.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/practice/office-hours-instructions.ts src/agent/ext/practice/office-hours-tools.ts src/agent/ext/practice/office-hours-agent.ts tests/ext-office-hours-tools.test.ts
git commit -m "feat(ext): add the office-hours agent with a command-gated verdict tool" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 19: Exercise writer and the practice service (REQ-lec-12 to 18)

**Files:**
- Create: `src/agent/ext/practice/exercise-writer.ts`, `src/server/ext/practice-service.ts`
- Test: `tests/ext-practice-service.test.ts`

**Contract:** `createPracticeService(deps)`, every dependency injected:
- `startSession({label, sourceText?})`: creates an `office_hours` chat; with a text, snapshots it (`SnapshotStore.put`) and appends `designated`. `startExercise({setId, exerciseId})`: designates the exercise's reference solution (`[s1] ...` lines) with the exercise link.
- `sourceOf(chatId)`: the designated label and text from the snapshot, or null.
- `submitVerdict(chatId, items, work)`: refuses (409) without a designated source and without any work; otherwise `checkVerdictItems`, appends `verdict`, and returns the text the model relays (outcome sentence, one line per difference with both quotations, a count of dropped comparisons). For an exercise session it also appends `graded` (outcomes by node, `lowConfidence` from `trust(...)`), adds a low-confidence notice when it applies and, once `setComplete`, calls `applyExerciseResult({goalId, results: setResults(set)})` exactly once and appends `applied` (nothing is applied when every result is withheld).
- `createExerciseSet({goalId, count?})`: unknown or inactive goal (404), spent ceiling (429), before any model call; `generateWithFeedback` with the validator's violations as feedback and at most 2 retries; a set still invalid is refused (422) and nothing is stored.
- `toolContext(chatId, chatStore)` is the object the office-hours agent is built with.
- The exercise writer is one `runStructured` submission (role `teacher`, cost source `exercises`) whose prompt states the doctrine of decision 9 and the reference-solution format.

- [ ] **Step 1: Write the failing test**

`tests/ext-practice-service.test.ts`

```typescript
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Exercise, ExerciseEvent, NodeOutcome } from "../src/core/ext/practice/exercises.ts";
import { parseExerciseEvent } from "../src/core/ext/practice/exercises.ts";
import { parseOfficeHoursEvent, type OfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { TrustLevel } from "../src/core/ext/trust.ts";
import { createPracticeService, PracticeError, type PracticeServiceDeps } from "../src/server/ext/practice-service.ts";

const SRC = "Write each number as twice an integer.\nAdd them and factor out the two.";
const exercise = (over: Partial<Exercise> = {}): Exercise => ({
	id: "ex1",
	prompt: "Show that the sum of two even numbers is even.",
	nodeIds: ["n_a", "n_b"],
	steps: [
		{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
		{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_b"] },
	],
	...over,
});

function harness(opts: { trust?: Record<string, TrustLevel>; generated?: Exercise[][]; allowed?: boolean } = {}) {
	const oh: OfficeHoursEvent[] = [];
	const ex: ExerciseEvent[] = [];
	const snaps = new Map<string, string>();
	const applied: Array<{ goalId: string; results: Array<{ nodeId: string; outcome: NodeOutcome }> }> = [];
	const prompts: Array<string | null> = [];
	const queue = [...(opts.generated ?? [[exercise({ nodeIds: ["n_a", "n_c"], steps: [{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a", "n_c"] }] })]])];
	let chats = 0;
	const deps: PracticeServiceDeps = {
		officeHours: { append: (e) => void oh.push(parseOfficeHoursEvent(e)!), readAll: () => [...oh] },
		exercises: { append: (e) => void ex.push(parseExerciseEvent(e)!), readAll: () => [...ex] },
		snapshots: {
			put: (t) => {
				const h = createHash("sha256").update(t).digest("hex");
				snaps.set(h, t);
				return h;
			},
			get: (h) => snaps.get(h) ?? null,
		},
		gate: { allowed: () => opts.allowed ?? true, record: () => {} },
		createSession: () => ({ id: `chat_${++chats}` }),
		goalScope: (id) => (id === "goal_1" ? { title: "Even sums", targetNodeIds: ["n_c"], scope: ["n_a", "n_b", "n_c"], status: "active" } : null),
		nodes: (ids) => ids.map((id) => ({ id, name: id, statement: `statement of ${id}` })),
		trust: (ids) => new Map(ids.map((id) => [id, opts.trust?.[id] ?? "sourced"] as const)),
		writeExerciseSet: async (input) => {
			prompts.push(input.feedback);
			return queue.shift() ?? [];
		},
		applyExerciseResult: (input) => {
			applied.push(input);
			return { reached: input.results.every((r) => r.outcome === "passed") };
		},
		now: () => "2026-11-04T10:00:00.000Z",
		newId: () => "abc",
	};
	return { svc: createPracticeService(deps), oh, ex, applied, prompts };
}

const item = (stepRef: string, sourceQuote: string, workQuote: string, stance: "matches" | "differs" | "missing" = "matches") => ({ stepRef, sourceQuote, workQuote, stance });
const WORK = "Let a = 2k and b = 2m. Then a + b = 2(k + m).";

describe("free office-hours session (REQ-lec-12, 13, 14)", () => {
	it("designates a snapshot of the pasted source and answers read_source from it", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "Manual ch.3", sourceText: SRC });
		assert.equal(s.chatId, "chat_1");
		assert.equal(h.svc.sourceOf(s.chatId)?.text, SRC);
	});
	it("the tool context reads the designated source and routes the verdict to the session", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "Manual ch.3", sourceText: SRC });
		const tc = h.svc.toolContext(s.chatId, { getChat: () => null });
		assert.deepEqual(tc.source(), { label: "Manual ch.3", text: SRC });
		assert.match(tc.submitVerdict([item("s1", "Write each number as twice an integer", "Let a = 2k")], WORK).text, /consistent/);
	});
	it("a session without a source gives no verdict", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "No source" });
		assert.equal(h.svc.sourceOf(s.chatId), null);
		assert.throws(() => h.svc.submitVerdict(s.chatId, [], WORK), (e: unknown) => e instanceof PracticeError && e.status === 409);
	});
	it("keeps items whose quotes exist and reports differences; drops invented quotes", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		const r = h.svc.submitVerdict(s.chatId, [
			item("s1", "Write each number as twice an integer", "Let a = 2k and b = 2m"),
			item("s2", "Add them and factor out the two", "a + b = 2(k + m)", "differs"),
			item("s3", "this quotation was never in the source at all", "Then a + b"),
		], WORK);
		assert.match(r.text, /differs from the designated source/);
		assert.match(r.text, /s2: the source says/);
		assert.match(r.text, /1 comparison\(s\) were dropped/);
		const v = h.oh.filter((e) => e.type === "verdict");
		assert.equal(v.length, 1);
		assert.equal(v[0]!.type === "verdict" && v[0]!.outcome, "differs");
	});
	it("with every quotation invented the verdict is not verifiable, never a model judgment", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		const r = h.svc.submitVerdict(s.chatId, [item("s1", "an entirely invented passage of the source", "Let a = 2k")], WORK);
		assert.match(r.text, /Not verifiable/);
	});
	it("refuses a verdict before the learner has written anything", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		assert.throws(() => h.svc.submitVerdict(s.chatId, [], "  "), /not written any work/);
	});
});

describe("exercise sets (REQ-lec-15)", () => {
	it("generates, validates and stores a set", async () => {
		const h = harness();
		const { setId } = await h.svc.createExerciseSet({ goalId: "goal_1" });
		assert.equal(setId, "set_abc");
		assert.equal(h.svc.getSet(setId).exercises.length, 1);
	});
	it("retries with the violations as feedback, then rejects after the retries", async () => {
		const bad = [exercise({ nodeIds: ["n_a"] })];
		const h = harness({ generated: [bad, bad, bad] });
		await assert.rejects(h.svc.createExerciseSet({ goalId: "goal_1" }), /rejected/);
		assert.equal(h.prompts.length, 3);
		assert.equal(h.prompts[0], null);
		assert.match(h.prompts[1] ?? "", /at least 2 nodes/);
		assert.equal(h.ex.length, 0);
	});
	it("refuses an unknown goal and a spent ceiling, before any model call", async () => {
		const h = harness({ allowed: false });
		await assert.rejects(h.svc.createExerciseSet({ goalId: "nope" }), /unknown or inactive/);
		await assert.rejects(h.svc.createExerciseSet({ goalId: "goal_1" }), /ceiling/);
		assert.equal(h.prompts.length, 0);
	});
});

describe("graded exercises (REQ-lec-16, 17)", () => {
	async function setup(trust?: Record<string, TrustLevel>) {
		const h = harness({
			trust,
			generated: [[exercise({ nodeIds: ["n_a", "n_c"], steps: [
				{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
				{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_c"] },
			] })]],
		});
		const { setId } = await h.svc.createExerciseSet({ goalId: "goal_1" });
		const sess = h.svc.startExercise({ setId, exerciseId: "ex1" });
		return { h, setId, sess };
	}
	const both = [item("s1", "Write each number as twice an integer", "Let a = 2k and b = 2m"), item("s2", "Add them and factor out the two", "a + b = 2(k + m)")];

	it("designates the reference solution and grades by node", async () => {
		const { h, sess } = await setup();
		assert.match(h.svc.sourceOf(sess.chatId)!.text, /\[s1\] Write each number/);
		h.svc.submitVerdict(sess.chatId, both, WORK);
		const g = h.ex.find((e) => e.type === "graded");
		assert.equal(g?.type === "graded" && g.outcome, "consistent");
		assert.deepEqual(g?.type === "graded" && g.nodeOutcomes.map((o) => o.outcome), ["passed", "passed"]);
	});
	it("applies the results to the personal layer once, when the set is complete", async () => {
		const { h, sess } = await setup();
		const r = h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.equal(h.applied.length, 1);
		assert.match(r.text, /goal is reached/);
		h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.equal(h.applied.length, 1);
	});
	it("does not apply an unverifiable grading", async () => {
		const { h, sess } = await setup();
		h.svc.submitVerdict(sess.chatId, [item("s1", "an entirely invented passage of the source", "Let a")], WORK);
		assert.equal(h.applied.length, 0);
	});
	it("withholds passes resting on unverified nodes (low confidence) and says so", async () => {
		const { h, sess } = await setup({ n_c: "unverified" });
		const r = h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.match(r.text, /Low confidence/);
		assert.equal(h.applied.length, 0, "all passes withheld: nothing to apply");
	});
	it("a differing step reopens its nodes through the personal layer", async () => {
		const { h, sess } = await setup();
		h.svc.submitVerdict(sess.chatId, [both[0]!, item("s2", "Add them and factor out the two", "a + b = 2(k + m)", "differs")], WORK);
		const byNode = Object.fromEntries(h.applied[0]!.results.map((r) => [r.nodeId, r.outcome]));
		assert.deepEqual(byNode, { n_a: "passed", n_c: "failed" });
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-practice-service.test.ts`
Expected: FAIL with `Cannot find module '../src/server/ext/practice-service.ts'`.

- [ ] **Step 3: Write the implementation**

`src/agent/ext/practice/exercise-writer.ts`

```typescript
// src/agent/ext/practice/exercise-writer.ts
/**
 * Generates an exercise set for a goal (REQ-lec-15): one schema-validated
 * submission through the lecture stage's runStructured seam, so it is gated
 * by the shared daily cost ceiling. Semantic rules (validateExerciseSet) are
 * checked by the caller, which retries with the violations as feedback.
 */

import { Type } from "typebox";
import type { Exercise } from "../../../core/ext/practice/exercises.ts";
import type { WriterDeps } from "../lecture/writers.ts";
import { runStructured } from "../lecture/structured.ts";

export interface ExerciseNode {
	id: string;
	name: string;
	statement: string;
}

export interface ExerciseWriteInput {
	goalTitle: string;
	/** The goal's scope nodes. */
	nodes: readonly ExerciseNode[];
	targetNodeIds: readonly string[];
	count: number;
	feedback: string | null;
}

export const EXERCISE_SYSTEM = `You write graded exercises for a learner studying a knowledge graph toward a goal. Submit them with the submit_exercises tool.

An exercise makes the learner APPLY several nodes together to solve a small problem: a proof, a computation, a counterexample. It is never a recall question: do not copy a node statement into a prompt, and do not ask "state" or "define".

Each exercise carries its REFERENCE SOLUTION as steps. A step is one sentence or formula of the solution, at least 20 characters, written exactly as a solutions manual would write it, and it lists the node ids whose content the step uses. The reference solution is what the learner's work will be compared with, so it must be correct, complete and use only the given nodes' content.

Rules: use only node ids from the list; every exercise combines at least 2 distinct nodes; together the exercises cover every target node; exercise ids are ex1, ex2, ...; step ids are s1, s2, ... within an exercise.`;

export function exercisePrompt(input: ExerciseWriteInput): string {
	const nodes = input.nodes.map((n) => `- ${n.id} (${n.name}): ${n.statement}`).join("\n");
	return [
		`Goal: ${input.goalTitle}`,
		`Target nodes: ${input.targetNodeIds.join(", ")}`,
		`Write ${input.count} exercises over these nodes:`,
		nodes,
		...(input.feedback !== null ? ["", "Your previous attempt was rejected for these reasons; fix them:", input.feedback] : []),
	].join("\n");
}

const ExerciseSchema = Type.Object({
	exercises: Type.Array(
		Type.Object({
			id: Type.String(),
			prompt: Type.String(),
			nodeIds: Type.Array(Type.String(), { minItems: 2 }),
			steps: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), nodeIds: Type.Array(Type.String(), { minItems: 1 }) }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

export async function writeExerciseSet(deps: WriterDeps, input: ExerciseWriteInput): Promise<Exercise[]> {
	const out = await runStructured<{ exercises: Exercise[] }>({
		...deps,
		costSource: "exercises",
		role: "teacher",
		toolName: "submit_exercises",
		toolDescription: "Submit the exercise set with reference solutions.",
		parameters: ExerciseSchema,
		systemPrompt: EXERCISE_SYSTEM,
		prompt: exercisePrompt(input),
	});
	return out.exercises;
}
```

`src/server/ext/practice-service.ts`

```typescript
// src/server/ext/practice-service.ts
/**
 * Office hours and graded exercises (REQ-lec-12 to 17). Everything impure is
 * injected; the live wiring is practice-live.ts.
 *
 * A session is a chat of kind `office_hours` plus a "designated" event that
 * pins the text its work is compared with. A verdict is computed by code
 * (verdict.ts) from the items the model proposed; when the session grades an
 * exercise, the per-node outcomes are derived by code and, once every
 * exercise of the set has a verifiable grading, handed to the personal layer
 * through applyExerciseResult (the only writer of a goal's `reached`).
 */

import { randomBytes } from "node:crypto";
import type { OfficeHoursToolContext, VerdictReport } from "../../agent/ext/practice/office-hours-tools.ts";
import type { ExerciseNode, ExerciseWriteInput } from "../../agent/ext/practice/exercise-writer.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { generateWithFeedback } from "../../core/ext/lecture/retry.ts";
import {
	deriveExerciseSets,
	isLowConfidence,
	nodeOutcomes,
	referenceText,
	setComplete,
	setResults,
	validateExerciseSet,
	type Exercise,
	type ExerciseEvent,
	type ExerciseSetState,
	type NodeOutcome,
} from "../../core/ext/practice/exercises.ts";
import { designationOf, type OfficeHoursEvent } from "../../core/ext/practice/office-hours.ts";
import { checkVerdictItems, OUTCOME_TEXT, verdictOutcome, type VerdictItem } from "../../core/ext/practice/verdict.ts";
import type { SnapshotStore } from "../../core/ext/ports.ts";
import type { TrustLevel } from "../../core/ext/trust.ts";
import type { SnapshotReader } from "../../core/ext/study-ports.ts";

export const MAX_EXERCISE_RETRIES = 2;
export const DEFAULT_EXERCISE_COUNT = 3;
const MAX_SOURCE_TEXT_CHARS = 200_000;

export class PracticeError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

interface LedgerLike<T> {
	append(event: T): void;
	readAll(): T[];
}

export interface PracticeServiceDeps {
	officeHours: LedgerLike<OfficeHoursEvent>;
	exercises: LedgerLike<ExerciseEvent>;
	snapshots: SnapshotStore & SnapshotReader;
	gate: CostGate;
	/** Creates an `office_hours` chat. */
	createSession(title: string): { id: string };
	/** The goal's targets and scope, or null for an unknown or inactive goal. */
	goalScope(goalId: string): { title: string; targetNodeIds: string[]; scope: string[]; status: string } | null;
	nodes(ids: readonly string[]): ExerciseNode[];
	trust(nodeIds: readonly string[]): Map<string, TrustLevel>;
	writeExerciseSet(input: ExerciseWriteInput): Promise<Exercise[]>;
	/** The personal layer's applyExerciseResult. */
	applyExerciseResult(input: { goalId: string; results: Array<{ nodeId: string; outcome: NodeOutcome }> }): { reached: boolean };
	now?: () => string;
	newId?: () => string;
}

export interface SessionView {
	chatId: string;
	label: string;
	exercise?: { setId: string; exerciseId: string };
}

export function createPracticeService(deps: PracticeServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(5).toString("hex"));

	function sets(): ExerciseSetState[] {
		return deriveExerciseSets(deps.exercises.readAll());
	}
	function setById(setId: string): ExerciseSetState {
		const s = sets().find((x) => x.setId === setId);
		if (s === undefined) throw new PracticeError(404, "unknown exercise set");
		return s;
	}

	function designate(chatId: string, label: string, text: string, exercise?: { setId: string; exerciseId: string }): void {
		const sha256 = deps.snapshots.put(text);
		deps.officeHours.append({ type: "designated", chatId, label, sha256, ...(exercise ? { exercise } : {}), at: now() });
	}

	/** REQ-lec-12: a free office-hours session on a pasted source (solutions manual passage, textbook proof). */
	function startSession(input: { label: string; sourceText?: string }): SessionView {
		const label = input.label.trim();
		if (label === "") throw new PracticeError(400, "label is required");
		const text = input.sourceText?.trim() ?? "";
		if (text.length > MAX_SOURCE_TEXT_CHARS) throw new PracticeError(400, "the source text is too long");
		const chat = deps.createSession(`Office hours: ${label}`);
		if (text !== "") designate(chat.id, label, text);
		return { chatId: chat.id, label };
	}

	/** REQ-lec-16: a session that grades one exercise; its designated source is the exercise's reference solution. */
	function startExercise(input: { setId: string; exerciseId: string }): SessionView {
		const set = setById(input.setId);
		const ex = set.exercises.find((e) => e.id === input.exerciseId);
		if (ex === undefined) throw new PracticeError(404, "unknown exercise");
		const label = `Exercise ${ex.id}: reference solution`;
		const chat = deps.createSession(`Exercise: ${ex.prompt.slice(0, 60)}`);
		const link = { setId: set.setId, exerciseId: ex.id };
		designate(chat.id, label, referenceText(ex), link);
		return { chatId: chat.id, label, exercise: link };
	}

	function sourceOf(chatId: string): { label: string; text: string } | null {
		const d = designationOf(deps.officeHours.readAll(), chatId);
		if (d === null) return null;
		const text = deps.snapshots.get(d.sha256);
		return text === null ? null : { label: d.label, text };
	}

	/** REQ-lec-13 / 14 / 16: code decides the verdict; an exercise session also records the grading. */
	function submitVerdict(chatId: string, items: VerdictItem[], work: string): VerdictReport {
		const d = designationOf(deps.officeHours.readAll(), chatId);
		const source = d === null ? null : sourceOf(chatId);
		if (d === null || source === null) throw new PracticeError(409, "no source is designated for this session: no verdict is possible");
		if (work.trim() === "") throw new PracticeError(409, "the learner has not written any work yet");
		const { kept, discarded } = checkVerdictItems(items, source.text, work);
		const outcome = verdictOutcome(kept);
		const at = now();
		deps.officeHours.append({ type: "verdict", chatId, outcome, items: kept, discarded: discarded.length, at });

		const lines = [OUTCOME_TEXT[outcome]];
		for (const i of kept) {
			if (i.stance === "matches") continue;
			const where = i.stance === "differs" ? `the work says "${i.workQuote}"` : "the work has nothing for this step";
			lines.push(`- ${i.stepRef}: the source says "${i.sourceQuote}"; ${where}.`);
		}
		if (discarded.length > 0) lines.push(`${discarded.length} comparison(s) were dropped because their quotations were not found in the texts.`);

		if (d.exercise !== undefined) {
			const set = setById(d.exercise.setId);
			const ex = set.exercises.find((e) => e.id === d.exercise!.exerciseId);
			if (ex !== undefined) {
				const low = isLowConfidence(ex, deps.trust([...new Set([...ex.nodeIds, ...ex.steps.flatMap((s) => s.nodeIds)])]));
				deps.exercises.append({
					type: "graded",
					setId: set.setId,
					exerciseId: ex.id,
					outcome,
					nodeOutcomes: nodeOutcomes(ex, kept),
					lowConfidence: low,
					at,
				});
				if (low) lines.push("Low confidence: the reference solution relies on nodes that are not verified against a source.");
				const applied = applyIfComplete(set.setId);
				if (applied !== null) lines.push(applied.reached ? "Exercise set complete: the goal is reached." : "Exercise set complete: the review schedule was updated; the goal is not reached yet.");
			}
		}
		return { text: lines.join("\n") };
	}

	/** When every exercise has a verifiable grading, hands the results to the personal layer, once. */
	function applyIfComplete(setId: string): { reached: boolean } | null {
		const set = setById(setId);
		if (set.applied !== null || !setComplete(set)) return null;
		const results = setResults(set);
		if (results.length === 0) return null;
		const res = deps.applyExerciseResult({ goalId: set.goalId, results });
		deps.exercises.append({ type: "applied", setId, reached: res.reached, at: now() });
		return res;
	}

	/** REQ-lec-15: generate, validate in code, retry with the violations as feedback. */
	async function createExerciseSet(input: { goalId: string; count?: number }): Promise<{ setId: string }> {
		const goal = deps.goalScope(input.goalId);
		if (goal === null || goal.status !== "active") throw new PracticeError(404, "unknown or inactive goal");
		if (!deps.gate.allowed()) throw new PracticeError(429, "the daily ceiling for background model work is spent");
		const nodes = deps.nodes(goal.scope);
		const ctx = { scope: new Set(goal.scope), targetNodeIds: goal.targetNodeIds, statements: new Map(nodes.map((n) => [n.id, n.statement] as const)) };
		const count = Math.max(1, Math.min(input.count ?? DEFAULT_EXERCISE_COUNT, 8));
		const run = await generateWithFeedback({
			attempt: (feedback) => deps.writeExerciseSet({ goalTitle: goal.title, nodes, targetNodeIds: goal.targetNodeIds, count, feedback }),
			validate: (v) => validateExerciseSet(v, ctx),
			feedback: (errors) => errors.map((e) => `- ${e}`).join("\n"),
			maxRetries: MAX_EXERCISE_RETRIES,
		});
		if (!run.ok) throw new PracticeError(422, `the generated exercises were rejected: ${run.errors.join("; ")}`);
		const setId = `set_${newId()}`;
		deps.exercises.append({ type: "set_created", setId, goalId: input.goalId, exercises: run.value, at: now() });
		return { setId };
	}

	function toolContext(chatId: string, chatStore: OfficeHoursToolContext["chatStore"]): OfficeHoursToolContext {
		return { chatId, chatStore, source: () => sourceOf(chatId), submitVerdict: (items, work) => submitVerdict(chatId, items, work) };
	}

	return {
		startSession,
		startExercise,
		submitVerdict,
		createExerciseSet,
		sourceOf,
		toolContext,
		listSets: (goalId?: string): ExerciseSetState[] => sets().filter((s) => goalId === undefined || s.goalId === goalId),
		getSet: setById,
		/** Verdicts given in a session, newest last. */
		verdictsOf: (chatId: string) => deps.officeHours.readAll().filter((e) => e.type === "verdict" && e.chatId === chatId),
	};
}

export type PracticeService = ReturnType<typeof createPracticeService>;
```

- [ ] **Step 4: Run it and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-practice-service.test.ts && npx tsc --noEmit -p . | head
```

Expected: `pass 14`, `fail 0`, no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ext/practice/exercise-writer.ts src/server/ext/practice-service.ts tests/ext-practice-service.test.ts
git commit -m "feat(ext): add the exercise writer and the practice service" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 20: The `office_hours` session kind (store side)

**Files:**
- Modify: `src/core/contracts/chat.ts`, `src/core/ports.ts`, `src/store/chats.ts`, `app/chat/[id]/page.tsx` (upstream touchpoints)
- Test: `tests/ext-office-hours-kind.test.ts`

**Contract:** `createChat(title, "office_hours")` stamps `kind: "office_hours"` on the record and the list; `"review"`, `"practice"` and the default (no `kind` field, reads as teach) are unchanged. The personal layer already made the stamping line generic (`...(kind ? { kind } : {})`), so only the three type declarations widen.

- [ ] **Step 1: Write the failing test**

`tests/ext-office-hours-kind.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-oh-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("session kind office_hours", () => {
	it("createChat(kind: 'office_hours') stamps the marker on the record and the list", () => {
		const chat = chatStore.createChat("Office hours: proof", "office_hours");
		assert.equal(chat.kind, "office_hours");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.kind, "office_hours");
	});
	it("the other kinds are unchanged", () => {
		assert.equal(chatStore.createChat("r", "review").kind, "review");
		assert.equal(chatStore.createChat("p", "practice").kind, "practice");
		assert.equal("kind" in chatStore.createChat("plain"), false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsc --noEmit -p . | head -5`
Expected: type errors in `tests/ext-office-hours-kind.test.ts` (`"office_hours"` is not assignable to `"practice" | "review"`). (At runtime the test would already pass, because the stamp is generic; the failing check here is the typecheck.)

- [ ] **Step 3: Widen the three declarations and map the kind in the chat page**

In `src/core/contracts/chat.ts`:

Replace
```typescript
export type ChatKind = "teach" | "practice" | "review";
```
with
```typescript
export type ChatKind = "teach" | "practice" | "review" | "office_hours";
```

In `src/core/ports.ts`:

Replace
```typescript
createChat(title: string, kind?: "practice" | "review"): ChatRecord;
```
with
```typescript
createChat(title: string, kind?: "practice" | "review" | "office_hours"): ChatRecord;
```

In `src/store/chats.ts`:

Replace
```typescript
function createChat(title: string, kind?: "practice" | "review"): ChatRecord {
```
with
```typescript
function createChat(title: string, kind?: "practice" | "review" | "office_hours"): ChatRecord {
```

Widening `ChatKind` makes the chat page's `kind` prop (`"teach" | "practice"`) fail to typecheck, so the page maps `office_hours` to `"teach"` (the chat UI is the plain one, like `review`) in the same step:

In `app/chat/[id]/page.tsx`:

Replace
```tsx
kind={chat.kind === "review" ? "teach" : (chat.kind ?? "teach")}
```
with
```tsx
kind={chat.kind === "review" || chat.kind === "office_hours" ? "teach" : (chat.kind ?? "teach")}
```

- [ ] **Step 4: Run the test, the upstream kind tests and the typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/ext-office-hours-kind.test.ts tests/ext-review-kind.test.ts tests/chat-kind.test.ts
npx tsc --noEmit -p . | head
```

Expected: tests PASS (`pass 2` for the new file); no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/chat.ts src/core/ports.ts src/store/chats.ts "app/chat/[id]/page.tsx" tests/ext-office-hours-kind.test.ts
git commit -m "feat(ext): add the office_hours chat kind" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 21: Practice wiring, routes and page (REQ-lec-12, 15, 16, 17; functional UI)

**Files:**
- Create: `src/server/ext/practice-live.ts`, `app/api/ext/exercises/route.ts`, `app/api/ext/office-hours/route.ts`, `components/ext/practice-panel.tsx`, `app/practice/page.tsx`
- Modify: `src/server/ext/stores.ts`, `src/server/ext/index.ts`
- Test: `tests/ext-practice-live.test.ts`

**Contract:**
- `stores.ts` gains the two ledgers through `createLedger` (the Foundation's rule: new ledgers go through it).
- `practice-live.ts` composes `createPracticeService`: the two ledgers; the snapshot store/reader pair; the shared gate; `createChat(title, "office_hours")`; `goalScope` from the goals ledger and `goalScope(targets, chains)` over the current graph; node statements from `getGraph`; trust from `trustViews`; the exercise writer with the teacher engine; and `applyExerciseResult(input, {graphStore, goalsStore, reviewStore, cardsStore})` from the personal layer's core (it needs no more than those four stores). It also exports `listActiveGoals()` for the page.
- Routes are transport only: `GET /api/ext/exercises?goalId=` (sets with each exercise's latest grading; Maps flattened), `POST /api/ext/exercises {goalId, count?}` (201 `{setId}`; waits for the model), `POST /api/ext/office-hours` (either `{label, sourceText?}` or `{setId, exerciseId}`; 201 `{chatId, label}`).
- `PracticePanel`: a label and a paste box ("Start office hours"), a goal picker with "Generate a set", and each set's exercises with their outcome and "Work on it"; starting a session navigates to `/chat/<id>`.

- [ ] **Step 1: Write the failing test**

`tests/ext-practice-live.test.ts`

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-live-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { practiceService, listActiveGoals } = await import("../src/server/ext/practice-live.ts");
const { extStores } = await import("../src/server/ext/stores.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("live composition of the practice stage", () => {
	it("starts empty", () => {
		assert.deepEqual(practiceService.listSets(), []);
		assert.deepEqual(listActiveGoals(), []);
		assert.deepEqual(extStores.officeHoursLedger.readAll(), []);
	});
	it("starts a session whose designated source is a snapshot under data/ext", () => {
		const view = practiceService.startSession({ label: "Manual", sourceText: "A passage of the solutions manual." });
		assert.equal(practiceService.sourceOf(view.chatId)?.text, "A passage of the solutions manual.");
		assert.equal(fs.existsSync(path.join(TMP_DATA, "ext", "office-hours.jsonl")), true);
		assert.equal(fs.readdirSync(path.join(TMP_DATA, "ext", "snapshots")).length, 1);
	});
	it("refuses a verdict when the session has no source", () => {
		const view = practiceService.startSession({ label: "No source" });
		assert.throws(() => practiceService.submitVerdict(view.chatId, [], "my work"), /no source is designated/);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-practice-live.test.ts`
Expected: FAIL with `Cannot find module '../src/server/ext/practice-live.ts'`.

- [ ] **Step 3: Add the ledgers to the composition root**

In `src/server/ext/stores.ts`:

Replace
```typescript
import { createGoalsStore } from "../../store/ext/goals-store.ts";
```
with
```typescript
import { parseExerciseEvent } from "../../core/ext/practice/exercises.ts";
import { parseOfficeHoursEvent } from "../../core/ext/practice/office-hours.ts";
import { createGoalsStore } from "../../store/ext/goals-store.ts";
```

Replace
```typescript
import { createLecturesStore } from "../../store/ext/lectures-store.ts";
```
with
```typescript
import { createLecturesStore } from "../../store/ext/lectures-store.ts";
import { createLedger } from "../../store/ext/ledger.ts";
```

Replace
```typescript
	snapshotReader: createSnapshotReader(EXT_PATHS.dir),
```
with
```typescript
	snapshotReader: createSnapshotReader(EXT_PATHS.dir),
	officeHoursLedger: createLedger(EXT_PATHS.dir, "office-hours.jsonl", parseOfficeHoursEvent),
	exercisesLedger: createLedger(EXT_PATHS.dir, "exercises.jsonl", parseExerciseEvent),
```

- [ ] **Step 4: Write the wiring**

`src/server/ext/practice-live.ts`

```typescript
// src/server/ext/practice-live.ts
/**
 * Composition of the office-hours / exercises stage. Only wiring; the logic is
 * in practice-service.ts. Exercise results reach the personal layer through
 * its core applyExerciseResult (the only writer of a goal's `reached`).
 */

import { writeExerciseSet } from "../../agent/ext/practice/exercise-writer.ts";
import { getGraph } from "../../core/graph.ts";
import { goalScope, deriveGoals } from "../../core/ext/goals.ts";
import { applyExerciseResult } from "../../core/ext/review-service.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createPracticeService } from "./practice-service.ts";
import { extStores } from "./stores.ts";
import { writerDeps } from "./study-engine.ts";
import { trustViews } from "./verification.ts";

export const practiceService = createPracticeService({
	officeHours: extStores.officeHoursLedger,
	exercises: extStores.exercisesLedger,
	snapshots: { put: (t) => extStores.snapshotStore.put(t), get: (h) => extStores.snapshotReader.get(h) },
	gate: liveCostGate,
	createSession: (title) => stores.chatStore.createChat(title, "office_hours"),
	goalScope: (goalId) => {
		const goal = deriveGoals(extStores.goalsStore.readEvents()).find((x) => x.id === goalId);
		if (goal === undefined) return null;
		const chains = getGraph(stores.graphStore).chains;
		return { title: goal.title, targetNodeIds: goal.targetNodeIds, scope: goalScope(goal.targetNodeIds, chains), status: goal.status };
	},
	nodes: (ids) => {
		const want = new Set(ids);
		return getGraph(stores.graphStore).nodes.filter((n) => want.has(n.id)).map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
	},
	trust: (ids) => new Map(trustViews([...ids]).map((v) => [v.nodeId, v.level] as const)),
	writeExerciseSet: (input) => writeExerciseSet(writerDeps(), input),
	applyExerciseResult: (input) =>
		applyExerciseResult(input, {
			graphStore: stores.graphStore,
			goalsStore: extStores.goalsStore,
			reviewStore: extStores.reviewStore,
			cardsStore: extStores.cardsStore,
		}),
});


/** Active goals for the practice page. */
export function listActiveGoals(): Array<{ id: string; title: string }> {
	return deriveGoals(extStores.goalsStore.readEvents()).filter((g) => g.status === "active").map((g) => ({ id: g.id, title: g.title }));
}
```

Append to `src/server/ext/index.ts`:

```ts
export * from "./practice-live.ts";
```

- [ ] **Step 5: Write the routes, the component and the page**

`app/api/ext/exercises/route.ts`

```typescript
import { practiceService } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
	const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
	return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
}

/** GET ?goalId= → { sets }: exercise sets with their latest gradings (Maps flattened for JSON). */
export async function GET(req: Request) {
	const goalId = new URL(req.url).searchParams.get("goalId") ?? undefined;
	const sets = practiceService.listSets(goalId).map((s) => ({
		setId: s.setId,
		goalId: s.goalId,
		createdAt: s.createdAt,
		applied: s.applied,
		exercises: s.exercises.map((e) => {
			const g = s.graded.get(e.id);
			return { id: e.id, prompt: e.prompt, graded: g ? { outcome: g.outcome, lowConfidence: g.lowConfidence } : null };
		}),
	}));
	return Response.json({ sets });
}

/** POST { goalId, count? } → 201 { setId }. Calls the model; the reply waits for it. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const res = await practiceService.createExerciseSet({
			goalId: String(body.goalId ?? ""),
			...(typeof body.count === "number" ? { count: body.count } : {}),
		});
		return Response.json(res, { status: 201 });
	} catch (error) {
		return errorResponse(error);
	}
}
```

`app/api/ext/office-hours/route.ts`

```typescript
import { practiceService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { label, sourceText? } starts a free session; POST { setId, exerciseId } starts a session that grades that exercise. → 201 { chatId, label }. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const view =
			typeof body.setId === "string" && typeof body.exerciseId === "string"
				? practiceService.startExercise({ setId: body.setId, exerciseId: body.exerciseId })
				: practiceService.startSession({ label: String(body.label ?? ""), ...(typeof body.sourceText === "string" ? { sourceText: body.sourceText } : {}) });
		return Response.json(view, { status: 201 });
	} catch (error) {
		const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
		return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
	}
}
```

`components/ext/practice-panel.tsx`

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ExerciseRow { id: string; prompt: string; graded: { outcome: string; lowConfidence: boolean } | null }
interface SetRow { setId: string; goalId: string; exercises: ExerciseRow[]; applied: { reached: boolean } | null }

/** Practice page: office hours on a pasted source (REQ-lec-12) and graded exercise sets (REQ-lec-15 to 17). */
export function PracticePanel({ goals }: { goals: Array<{ id: string; title: string }> }) {
	const router = useRouter();
	const [label, setLabel] = useState("");
	const [sourceText, setSourceText] = useState("");
	const [goalId, setGoalId] = useState(goals[0]?.id ?? "");
	const [sets, setSets] = useState<SetRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/ext/exercises");
		if (res.ok) setSets(((await res.json()) as { sets: SetRow[] }).sets);
	}, []);
	useEffect(() => void refresh(), [refresh]);

	async function post(url: string, body: unknown): Promise<Record<string, unknown> | null> {
		setError(null);
		const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			setError(typeof json.error === "string" ? json.error : "Request failed.");
			return null;
		}
		return json;
	}
	async function open(body: unknown) {
		const json = await post("/api/ext/office-hours", body);
		if (json && typeof json.chatId === "string") router.push(`/chat/${json.chatId}`);
	}
	async function generate() {
		setBusy(true);
		await post("/api/ext/exercises", { goalId });
		setBusy(false);
		void refresh();
	}

	return (
		<div className="flex flex-col gap-8">
			{error !== null ? <p className="text-destructive">{error}</p> : null}
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Office hours</h2>
				<p className="text-sm text-muted-foreground">Paste the text your work will be compared with (a solutions manual passage, a textbook proof). Without it you get questions but no verdict.</p>
				<input className="rounded border px-2 py-1" placeholder="Label, e.g. Solutions manual ch. 3" value={label} onChange={(e) => setLabel(e.target.value)} />
				<textarea className="min-h-32 rounded border px-2 py-1" placeholder="Designated source (optional)" value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
				<button type="button" className="self-start rounded border px-3 py-1" disabled={label.trim() === ""} onClick={() => void open({ label, ...(sourceText.trim() ? { sourceText } : {}) })}>Start office hours</button>
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Exercises</h2>
				{goals.length === 0 ? <p className="text-sm text-muted-foreground">Create a goal first.</p> : (
					<div className="flex gap-2">
						<select className="rounded border px-2 py-1" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
							{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
						</select>
						<button type="button" className="rounded border px-3 py-1" disabled={busy || goalId === ""} onClick={() => void generate()}>{busy ? "Generating…" : "Generate a set"}</button>
					</div>
				)}
				{sets.map((s) => (
					<div key={s.setId} className="rounded border p-3">
						<div className="text-xs text-muted-foreground">{goals.find((g) => g.id === s.goalId)?.title ?? s.goalId}{s.applied ? (s.applied.reached ? " · goal reached" : " · results applied") : ""}</div>
						<ul className="flex flex-col gap-2">
							{s.exercises.map((ex) => (
								<li key={ex.id} className="flex items-start gap-2">
									<span className="flex-1">{ex.prompt}{ex.graded ? <em className="ml-2 text-xs">{ex.graded.outcome}{ex.graded.lowConfidence ? " (low confidence)" : ""}</em> : null}</span>
									<button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => void open({ setId: s.setId, exerciseId: ex.id })}>Work on it</button>
								</li>
							))}
						</ul>
					</div>
				))}
			</section>
		</div>
	);
}
```

`app/practice/page.tsx`

```tsx
import { PracticePanel } from "@/components/ext/practice-panel";
import { listActiveGoals } from "@/src/server";

export const dynamic = "force-dynamic";

export default function PracticePage() {
	const goals = listActiveGoals();
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Practice</h1>
			<PracticePanel goals={goals} />
		</main>
	);
}
```

- [ ] **Step 6: Run the test, the typecheck and the lint**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/ext-practice-live.test.ts
npx tsc --noEmit -p . | head
npx eslint src/server/ext src/agent/ext app/api/ext app/practice components/ext 2>&1 | tail -5
```

Expected: `pass 3`, `fail 0`; no typecheck output; no lint output.

- [ ] **Step 7: Commit**

```bash
git add src/server/ext/practice-live.ts src/server/ext/stores.ts src/server/ext/index.ts app/api/ext/exercises app/api/ext/office-hours components/ext/practice-panel.tsx app/practice tests/ext-practice-live.test.ts
git commit -m "feat(ext): wire the practice stage and add its routes and page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 22: Chat handler wiring (REQ-lec-13, REQ-lec-14)

**Files:**
- Modify: `src/server/chat-handler.ts` (upstream touchpoint)

**Contract:** an `office_hours` session builds the office-hours agent from turn one (the `buildAgent` test seam still wins), writes nothing to the graph (no extraction) and compacts like practice, exactly as the personal layer's `review` kind does; practice, review and teaching behaviour is unchanged. Apply each replacement exactly once.

- [ ] **Step 1: Apply the handler edits**

In `src/server/chat-handler.ts`:

Replace
```typescript
import { createReviewAgent } from "../agent/ext/review-agent.ts";
```
with
```typescript
import { createOfficeHoursAgent } from "../agent/ext/practice/office-hours-agent.ts";
import { createReviewAgent } from "../agent/ext/review-agent.ts";
```

Replace
```typescript
import { personalLayer } from "./ext/personal-layer.ts";
```
with
```typescript
import { personalLayer } from "./ext/personal-layer.ts";
import { practiceService } from "./ext/practice-live.ts";
```

Replace
```typescript
/** Sessions that write nothing to the graph and compact like practice (practice, and the extension's review kind). */
const isPracticeLike = (kind: string | undefined): boolean => kind === "practice" || kind === "review";
```
with
```typescript
/** Sessions that write nothing to the graph and compact like practice (practice, and the extension's review and office_hours kinds). */
const isPracticeLike = (kind: string | undefined): boolean => kind === "practice" || kind === "review" || kind === "office_hours";
```

Replace
```typescript
		: record.kind === "review"
			? createReviewAgent(
```
with
```typescript
		: record.kind === "office_hours"
			? createOfficeHoursAgent(practiceService.toolContext(chatId, stores.chatStore), agentOpts)
		: record.kind === "review"
			? createReviewAgent(
```

- [ ] **Step 2: Verify nothing else moved**

```bash
git diff --stat src/server/chat-handler.ts
grep -n 'kind === "practice"\|kind !== "practice"' src/server/chat-handler.ts
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsc --noEmit -p . | head
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/chat-flow.test.ts tests/practice-flow.test.ts tests/chat-kind.test.ts tests/chat-birth-stamp.test.ts tests/ext-review-kind.test.ts tests/ext-office-hours-kind.test.ts
```

Expected: a handful of changed lines in each file; the grep prints exactly two lines (the `isPracticeLike` definition and the `record.kind === "practice"` branch of the agent construction, now with the `office_hours` and `review` branches before it); no typecheck output; tests PASS.

- [ ] **Step 3: Confirm the write-ahead assumption the verdict gate relies on**

```bash
grep -n "saveMessages" src/server/chat-handler.ts | head -5
```

Expected: a `saveMessages(chatId, merged)` call that precedes the agent construction in the turn (so the learner's `/verdict` message is in the stored record when `officeHoursTools` reads it). If the order ever changes upstream, `tests/ext-office-hours-tools.test.ts` still passes (it injects the record) but the live gate would not: this grep is the guard.

- [ ] **Step 4: Manual smoke of an office-hours session (needs a configured model key)**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run dev
```

Open `http://localhost:3000/practice`. Type a label, paste a two-line source ("Write each number as twice an integer. Add them and factor out the two."), press "Start office hours": the chat opens. Send your own short proof; the agent asks a question and never says correct or incorrect. Send `/verdict`: the agent calls `read_source` then `verdict`, and relays text starting "On the steps checked, the work is consistent with the designated source" or "The work differs ..." or "Not verifiable". Check `data/ext/office-hours.jsonl`: one `designated` line and one `verdict` line whose `items` quote the pasted source. Start another session WITHOUT a source and send `/verdict`: the answer is "no verdict is possible" and no `verdict` line is written. If the chat layout misbehaves for an `office_hours` session (a visual problem), note it for the UI redesign session; do not fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/server/chat-handler.ts
git commit -m "feat(ext): run office_hours sessions with the office-hours agent" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 23: Contracts and touchpoints docs (REQ-lec-19, REQ-port-01, REQ-int-04)

**Files:**
- Modify: `docs/ext/CONTRACTS.md`, `docs/ext/TOUCHPOINTS.md`

- [ ] **Step 1: Append the language-neutral contracts**

Append to the end of `docs/ext/CONTRACTS.md`:

````markdown

## `lectures/<id>/lecture.json` (lecture document, one file per lecture)

A JSON object written atomically (temp file and rename), not a ledger. Readers skip a file that is not valid JSON or whose shape this schema rejects; a reader that finds `format.json` newer than it understands must refuse.

- `version`: `1`. `id`: `lec_b<8 hex>_c<NN>_l<NN>` (`NN` at least 2 digits, zero padded). The id is the directory name; no other string is a valid id.
- `bookId`: `b` plus the first 8 hex of the SHA-256 of the absolute PDF path. `bookTitle`: string. `title`: non-empty. `summary`: string (3 to 4 sentences handed to the next lecture of the chapter).
- `chapter`: `{index (1-based int), title, pageStart, pageEnd}` (pages 1-based, inclusive). `order`: int at least 1, the position inside the chapter.
- `chapterSourceId`: the notes-source id (`src_` plus the first 12 hex of the SHA-256 of the chapter label `"<bookTitle>/<NN> <chapter title>"`, `NN` the chapter index padded to 2) under which the chapter graph was extracted. `createdAt`: ISO-8601.
- `slides`: array of `{id, heading, elements}`; `elements`: array of `{id, type, content?, items?}` with `type` in `text` | `formula` | `list`. `text` and `formula` carry `content` (string); `list` carries `items` (strings). `text` and list items may contain node links `[[n_<id>]]` or `[[n_<id>|label]]` (`n_` followed by letters, digits, `_` or `-`; the label may be empty). A `formula` is LaTeX without delimiters.
- `blocks`: ordered array of `{id, role, slideId, text, nodeIds, cues, seconds?}`. `role` in `narrate` (spoken discourse), `note` (editorial addition not in the source), `exercise` (timed prompt; `seconds` is required and a positive int), `reveal` (discussion following an exercise). `seconds` appears on `exercise` blocks only. `nodeIds`: graph node ids the block covers. `cues`: array of `{atChar (int >= 0), target (element id), style}` with `style` in `box` | `underline`.

### Lecture validator rules (semantic; the lecture is rejected when any applies)

1. No slides, or no blocks. 2. Duplicate slide ids or duplicate block ids. 3. A block whose `slideId` is not a slide. 4. A `narrate` block with empty `nodeIds` (a `note` may have none). 5. A block `nodeId`, or a node link on any slide, that is not a node of the graph. 6. A cue with `atChar` greater than the block text length, or whose `target` is not an element of the block's slide. 7. An `exercise` block not immediately followed by a `reveal`; a `reveal` block not immediately preceded by an `exercise`. 8. **Verbatim:** after lower-casing and splitting into maximal runs of letters and digits (Unicode), a block text (node-link markup replaced by its label or id) shares any run of 12 consecutive words with the plain text of the chapter it was written from.

A rejected lecture is regenerated with the list of violations as feedback, at most 2 times after the first attempt (3 attempts in all); a lecture still invalid is not stored and its chapter run is failed. **Coverage report:** the chapter's nodes (graph nodes whose provenance `chatId` is the chapter's source id) that no stored lecture of the book cites in a block `nodeIds` or a slide link.

### Chapter rules and the outline split

- A proposed chapter list is valid when it is non-empty, every title is non-blank, every start page is an integer within 1 to the page count, and pages strictly increase. A chapter runs to the page before the next one; the last to the end of the book. PDF bookmarks (outline top level, or the level below when the top has fewer than 3 entries and the next level has at least 3), normalized by dropping blank titles and any entry whose page does not exceed the previous kept page, are used when valid; otherwise a model proposes the list from an excerpt, validated by the same rules.
- Lectures are split from the chapter outline, never from page count: each outline block has an estimated spoken length by kind (`definition` 150, `theorem` 375, `example` 100, `motivation` 120, `remark` 80 words); blocks are packed in order into a lecture until adding one would exceed 2000 words; a block alone above the target forms its own lecture. Lectures of a chapter are produced in order, each receiving the previous lecture's `summary`.

### Lecture overlay and back-links (derived, nothing stored)

For every lecture: one special node `{id: lectureId, title, kind: "lecture"}`; for every node id the lecture cites (block `nodeIds` and slide links) that exists in the graph, one edge `{from: lectureId, to: nodeId, type: "cites"}`. Back-links of a node: the lectures whose citations include it, ordered by lecture id. No lecture is written to `nodes.jsonl` or `chains.jsonl`.

## `office-hours.jsonl` (ledger, keyed by chat id)

Event `designated`: `{type:"designated", chatId, label, sha256, exercise?, at}`. `sha256` is 64 lowercase hex, the name of a file `snapshots/<sha256>.txt`; `exercise`, when present, is `{setId, exerciseId}`. The latest `designated` event of a chat is its designated source.

Event `verdict`: `{type:"verdict", chatId, outcome, items, discarded, at}`; `outcome` in `consistent` | `differs` | `not_verifiable`; `items`: the kept items `{stepRef, sourceQuote, workQuote, stance}` with `stance` in `matches` | `differs` | `missing`; `discarded`: count of dropped items.

### Verdict rules

The model proposes items; the following decide. For each item, `checkQuote(source, sourceQuote)` of the "Quote check" section above must return `ok`, otherwise the item is dropped (`quote_too_short` or `quote_not_found`). Unless `stance` is `missing`, the item is also dropped when `normalize(workQuote, join)` is empty or does not occur in `normalize(work, join)` (`work_quote_not_found`). The work is every message of the learner in the session except messages beginning with `/verdict`. Outcome: no item kept gives `not_verifiable`; all kept items `matches` gives `consistent`; otherwise `differs`. A verdict exists only when the learner's newest message begins with `/verdict` and the session has a designated source; the text of a verdict never states correctness, only consistency with the designated source.

## `exercises.jsonl` (ledger)

Event `set_created`: `{type:"set_created", setId, goalId, exercises, at}`; `exercises` non-empty array of `{id, prompt, nodeIds, steps}` with `steps` an array of `{id, text, nodeIds}` (the reference solution).
Event `graded`: `{type:"graded", setId, exerciseId, outcome, nodeOutcomes, lowConfidence, at}`; `outcome` as in a verdict; `nodeOutcomes`: array of `{nodeId, outcome}` with `outcome` in `passed` | `weak` | `failed`; `lowConfidence`: boolean.
Event `applied`: `{type:"applied", setId, reached, at}`.

Derivation (`deriveExerciseSets`): replay in file order; the first `set_created` per `setId` defines the set; `graded` and `applied` for an unknown set are ignored; a `graded` for an exercise id not in the set is ignored; the latest `graded` per exercise wins; the first `applied` wins.

### Exercise set validation (rejected when any applies)

An empty set; a duplicate exercise id; an empty prompt; fewer than 2 distinct `nodeIds`; any node (exercise or step) outside the goal's scope (`goalScope` of the contract above); a prompt whose normalized text contains the normalized statement of one of its nodes when that statement has at least 40 normalized characters; an exercise without steps; a duplicate step id within an exercise; a step text under 20 characters; a step citing no node; a goal target node covered by no exercise. A rejected set is regenerated with the violations as feedback, at most 2 times after the first attempt.

### Grading and results

Per exercise, a step is good when its surviving verdict items all have `stance` `matches`, bad when any is `differs` or `missing`, unknown when it has no surviving item. A node used by the exercise (its `nodeIds` or any step's) has outcome `passed` when all its known steps are good, `failed` when none is good, `weak` otherwise, and has no outcome when none of its steps is known. A grading is `lowConfidence` when any node the reference uses has a trust level other than `sourced` (no verification state counts as `unverified`). A set is complete when every exercise has a latest grading whose `outcome` is not `not_verifiable`. The results handed to the personal layer's exercise interface are, per node, the worst outcome (`failed` over `weak` over `passed`) across the latest gradings, **omitting any `passed` outcome that comes from a `lowConfidence` grading**; when the results are empty nothing is applied. They are applied once per set (`applied` event), as `exercise` review events by the personal layer.
````

- [ ] **Step 2: Append the touchpoints**

In `docs/ext/TOUCHPOINTS.md`, add these rows to the table (if a row for the same file already exists, extend its "Why" with this plan's text and its "Added in" with `, Lectures and office hours`):

```markdown
| `src/core/contracts/chat.ts` | `ChatKind` gains `"office_hours"` (office-hours sessions) | Lectures and office hours |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"office_hours"` | Lectures and office hours |
| `src/store/chats.ts` | `createChat` type widened to the same kinds | Lectures and office hours |
| `src/server/chat-handler.ts` | `isPracticeLike` also accepts `office_hours`; the office-hours agent branch; two imports | Lectures and office hours |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for an `office_hours` session | Lectures and office hours |
| `src/core/ext/index.ts` | appended exports for the lecture player | Lectures |
| `src/server/ext/panel-providers.ts` | `lecturesCiting` member (lecture back-links in a node's panel) | Lectures |
```

In the "Planned (not yet touched)" paragraph, delete the mention of the `kind` union if they are still listed (they are touched now).

- [ ] **Step 3: Verify the touchpoint list is closed**

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*' ':!docs/superpowers/**'
```

Expected: only files that appear in the touchpoints table (the Foundation, verification, personal-layer and this plan's rows, plus `package.json` entries). Any other file is an unlisted upstream edit: revert it.

- [ ] **Step 4: Commit**

```bash
git add docs/ext/CONTRACTS.md docs/ext/TOUCHPOINTS.md
git commit -m "docs(ext): add lecture, office-hours and exercise contracts and touchpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Task 24: Full verification, mutation spot-check, manual smoke

**Files:** none changed (revert every mutation).

- [ ] **Step 1: Full suite, typecheck, lint against the Task 1 baseline**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
NODE_ENV=test npx tsx --test tests/*.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖" | head -12
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -5
```

Expected: the same failures as the Task 1 Step 2 baseline and no more (observed with this plan applied: 4 failures, all environment ones: the `claude-code` provider tests, the Next compression drain test, the Google SDK offline test); typecheck and lint print nothing new.

- [ ] **Step 2: Mutation spot-check (security profile: mutation testing)**

For each row: apply the change, run the test file, expect it to FAIL, then `git checkout -- <file>` to revert. Each row was run against this plan's code and failed as stated.

| File | Mutation | Test file that must fail |
|---|---|---|
| `src/core/ext/lecture/validate.ts` | `VERBATIM_RUN_WORDS = 12` to `14` (or `11`) | `tests/ext-lecture-validate.test.ts` |
| `src/core/ext/lecture/split.ts` | `words + w > target` to `words + w > target * 2` | `tests/ext-lecture-split.test.ts` |
| `src/core/ext/lecture/cues.ts` | `c.atChar <= charIndex` to `c.atChar < charIndex` | `tests/ext-lecture-graph.test.ts` |
| `src/agent/ext/lecture/chapter-run.ts` | `MAX_LECTURE_RETRIES = 2` to `3` | `tests/ext-chapter-run.test.ts` |
| `src/core/ext/practice/verdict.ts` | `kept.every(` to `kept.some(` in `verdictOutcome` | `tests/ext-verdict.test.ts` |
| `src/core/ext/practice/verdict.ts` | `if (item.stance !== "missing" && !contains(work, item.workQuote)) {` to `if (false) {` | `tests/ext-verdict.test.ts` |
| `src/core/ext/practice/exercises.ts` | delete the line `if (g.lowConfidence && o.outcome === "passed") continue;` | `tests/ext-exercises.test.ts` |
| `src/core/ext/practice/exercises.ts` | `if (distinct.size < 2)` to `if (distinct.size < 1)` | `tests/ext-exercises.test.ts` |
| `src/agent/ext/practice/office-hours-tools.ts` | `if (verdictRequested(messages)) {` to `if (true) {` | `tests/ext-office-hours-tools.test.ts` |
| `src/server/ext/practice-service.ts` | `if (set.applied !== null \|\| !setComplete(set)) return null;` to `if (!setComplete(set)) return null;` | `tests/ext-practice-service.test.ts` |

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && NODE_ENV=test npx tsx --test tests/ext-verdict.test.ts
git checkout -- src/core/ext/practice/verdict.ts
```

Expected for each: FAIL while mutated, PASS after the revert. A mutation that does not fail means a missing test: add one before finishing.

- [ ] **Step 3: Manual smoke of a real book (needs a configured model key; spends a little money)**

```bash
source ~/.nvm/nvm.sh && nvm use 26 >/dev/null
export LH_EXT_DAILY_CEILING_USD=1
npm run dev
```

Use a SHORT book or a PDF of a few chapters (a full book at the default ceiling of 2 USD will stop partway, which is also worth seeing). Open `http://localhost:3000/lectures`, enter the absolute path (for example `<local>/dispense_Prob_1.pdf`) and press "Make lectures". Expected:
1. Within seconds the run appears with the detected chapters (`queued`), then up to 3 chapters at a time move through `graph`, `outline`, `writing`, `done`.
2. `data/ext/sources.json` gains the book as `primary`, `active`; the graph (home page) gains the chapter nodes (a new source named `<book>/<NN> <chapter>`); `data/ext/lectures/` gains `lec_b…_cNN_lNN/lecture.json` files; `data/ext/cost.jsonl` gains `lecture` spend lines.
3. A lecture opens at `/lectures/<id>`; Play speaks it, the slide highlights follow the narration, an exercise shows its countdown, and a `Note` is italic. Spot-check two things by reading: the discourse rephrases the book (no copied paragraph) and the formulas on the slides are the book's.
4. With `LH_EXT_DAILY_CEILING_USD=0.05` a second ingest stops with chapters `stopped_cost` and the already saved lectures intact.
5. `curl -s localhost:3000/api/ext/lectures/overlay` lists one `kind: "lecture"` node per lecture and `cites` edges to chapter nodes.

Then create a goal whose target is one of the chapter nodes, open `/practice`, choose the goal and press "Generate a set": a set of 3 exercises appears (wait for the model). Press "Work on it" on one: a chat opens whose designated source is the reference solution (`data/ext/office-hours.jsonl` has a `designated` line with an `exercise`). Write a solution, send `/verdict`: the answer lists steps and quotations, `data/ext/exercises.jsonl` gains a `graded` line, and after all three exercises are graded an `applied` line appears and the goal is `reached` only if every target node passed.

- [ ] **Step 4: Layer and touchpoint check**

```bash
git status --short
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*' ':!docs/superpowers/**'
```

Expected: a clean tree after the commits, and the second command lists only files that are in `docs/ext/TOUCHPOINTS.md`.

---

## Self-review

**1. Spec coverage (REQ id to task):**

| REQ | Where |
|---|---|
| REQ-lec-01 chapters from bookmarks (LLM fallback), split from the outline at about 2000 words | Task 4 (`splitOutline`, chapter rules), Task 8 (`readBookmarks`), Task 11 (`detectChapters`), Task 12 (`startBookIngest`) |
| REQ-lec-02 the book becomes an active primary source | Task 7 (`registerBookAsPrimary`), Task 11 (`runBook` registers once), Task 12 (test) |
| REQ-lec-03 graph first, lectures after, with the chapter's nodes as input | Task 10 (`runChapter` order; nodes passed to the writer), Task 9 (prompt carries the node list) |
| REQ-lec-04 graph extracted from the chapter text, never from discourse | Task 8 (`readChapterText` via `pdfExtract`), Task 10 (`importChapterGraph` on `chapterText`), Task 13 (`extraction.importNotes`) |
| REQ-lec-05 sequence with a rolling summary inside a chapter, chapters in parallel | Task 10 (`previousSummary`), Task 11 (`mapPool`, 3 in flight) |
| REQ-lec-06 `lecture.json` with slides, role-typed blocks, cues, node references, timed exercises | Task 2 (schema, parser), Task 4 (`buildLecture`), Task 6 (store) |
| REQ-lec-07 validator: unknown node ids, coverage report, at most two retries with feedback | Task 3 (`validateLecture`, `uncoveredChapterNodes`, `generateWithFeedback`), Task 10 (3 attempts, report) |
| REQ-lec-08 rephrase never verbatim, editorial additions tagged | Task 3 (12-word rule), Task 9 (prompt; `note` role), Task 14 (italic `Note`) |
| REQ-lec-09 native lecture view with slides and a speech player with cue highlighting | Task 1 (speech check), Task 5 (`activeCue`), Task 14 (`LecturePlayer`) |
| REQ-lec-10 click a concept, node opens in a side panel beside the slides | Task 14 (`onNodeClick` wired to `openNodePanel` in `LectureView`) |
| REQ-lec-11 lectures as special graph nodes with `cites` edges, nothing in the content ledgers | Task 5 (`lectureOverlay`), Task 13 (`/api/ext/lectures/overlay`). **Partial:** the derived data and API are done; drawing the overlay inside upstream's graph canvas is not (decision 12). |
| REQ-lec-12 a node's panel lists the lectures that cite it | Task 5 (`citingLectures`), Task 12 (`citing`), Task 13 Step 7 (panel provider `lecturesCiting`) |
| REQ-lec-13 Socratic questions per step, never states correctness | Task 18 (instructions; no verdict tool without the command). Prompt-enforced only (decision 6). |
| REQ-lec-14 verdict only on request, only by comparison with a designated source with code-verified quotation, else "not verifiable" | Task 15 (rules), Task 18 (`/verdict` gating), Task 19 (`submitVerdict`, designation required), Task 22 (write-ahead guard) |
| REQ-lec-15 non-immediate exercise set over nodes in the goal's scope | Task 16 (`validateExerciseSet`), Task 19 (`createExerciseSet`), Task 21 (routes, page). "Non-immediate" read as decision 9. |
| REQ-lec-16 reference solution from `sourced` nodes, otherwise low confidence | Task 16 (`isLowConfidence`), Task 19 (grading) |
| REQ-lec-17 grading follows REQ-lec-13/14 and emits per-node outcomes as `exercise` review events (REQ-pl-14) | Task 16 (`nodeOutcomes`, `setResults`), Task 19 (`applyIfComplete` to `applyExerciseResult`), Task 21 (live deps) |
| REQ-lec-18 chapter runs and exercise generation under the daily cost ceiling | Task 9 (`assertWithinCeiling`, per-step `record`), Task 10 (`stopped_cost`), Task 12 (429), Task 19 (429), Task 13 (`cost-live`). Gap: `importNotes` is not metered (decision 5). |
| REQ-lec-19 schema and validator documented as language-neutral contracts | Task 23 |
| Umbrella REQ-int-01 to 04, REQ-port-01 | extension files only under `src/**/ext/`, `app/api/ext/`, `components/ext/` (Tasks 2 to 21); ledgers through `createLedger` (Task 21); the closed touchpoint list (Tasks 14, 20, 22, 24, 25) |

**Gaps stated:** REQ-lec-11 canvas rendering (partial), REQ-lec-13 enforced by instructions only, the `importNotes` cost not metered, "non-immediate" interpreted. Designating a library PDF page range as an office-hours source is not planned (decision 8).

**2. Placeholder scan:** no `TODO`, `TBD`, "similar to", "add appropriate" or elided code in this plan; every code step shows complete file content, and every shared-file edit gives the exact old and new text.

**3. Type consistency (names used across tasks):** `Lecture`, `Block`, `Slide`, `Cue` (Task 2) are the types of `validateLecture` (3), `buildLecture` (4), `lectureOverlay` (5), `LecturesStore` (6), the writers (9), `runChapter` (10), the service (12) and the player (14, through the `LectureBlock` / `LectureSlide` aliases of the core barrel). `CostGate` (`allowed()`, `record(usd, source)`) is the verification stage's and is used unchanged in Tasks 9, 10, 12, 19. `StepPricer` (9) is what `livePriceStep` (13) implements. `VerdictItem` (15) is the type of `ExerciseEvent` gradings' inputs (16), `OfficeHoursEvent.verdict.items` (17), `OfficeHoursToolContext.submitVerdict` (18) and `PracticeService.submitVerdict` (19). `NodeOutcome` (16) is `applyExerciseResult`'s `outcome` (personal layer). `ExerciseWriteInput` / `ExerciseNode` (19) are what `PracticeServiceDeps.writeExerciseSet` / `nodes` use and what `practice-live.ts` (21) supplies. `OfficeHoursToolContext` (18) is what `practiceService.toolContext` returns (19) and the chat handler passes (22). The ledgers `officeHoursLedger` / `exercisesLedger` (21) satisfy the structural `LedgerLike` of the practice service (19). The `office_hours` kind literal is the same in Tasks 20, 21 and 22.

**Task count:** 24 (Part A: Tasks 1 to 14; Part B: Tasks 15 to 24).
