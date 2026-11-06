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

## `frontier.jsonl` (frontier marks ledger)

Events steer the research loop across regions of the knowledge graph (REQ-res-01, REQ-res-02, REQ-rs-03, REQ-rs-06).

Event `set`: `{type:"set", markId, scope, mark, maxDepth?, budgetUsd?, note, author, at}`
- `markId`: non-empty string.
- `scope`: `{kind, id}` where `kind` is `node` | `subtree` | `goal`, and `id` is a non-empty string (node id or goal id).
- `mark`: `expand` (raise priority, research premises/sources) | `hold` (no expansion; verification still allowed) | `stop` (excluded from expansion and verification).
- `maxDepth`: optional integer >= 0 (tools bound this to 10; default depth is 2).
- `budgetUsd`: optional finite number > 0 (spending limit for this mark's region).
- `note`: string (context or reason for the mark).
- `author`: `user` | `agent`.
- `at`: ISO-8601 timestamp.

Event `clear`: `{type:"clear", markId, author, at}`
- `markId`: non-empty string.
- `author`: `user` | `agent`.
- `at`: ISO-8601 timestamp.

Derivation (`deriveMarks`):
Replay events in file order into a map keyed by `markId`.
- **Author validation rule:** an `agent` event (`set` or `clear`) NEVER overwrites or clears an existing mark whose `author` is `user`. Such agent events are silently ignored.
- A `set` event with a known id updates the mark (subject to the author rule).
- A `clear` event removes the mark from the map (subject to the author rule).
- Returns the surviving marks in order.

Region of a mark's scope (`regionOf(scope, goals, chains)`):
- `node`: `{id}` (the single node).
- `subtree`: `{id}` plus the transitive closure of its premises (`goalScope([id], chains)`).
- `goal`: the goal's target nodes plus their premise closure (`goalScope(goal.targetNodeIds, chains)`).

Overlap resolution (`createMarkResolver(marks, goals, chains).effective(nodeId)`):
When multiple marks cover a node, the effective mark is chosen by sorting candidates in order:
1. `user` author wins over `agent` author (`author !== "user"` comparison);
2. Specificity of scope kind (`node` < `subtree` < `goal`);
3. Smaller region size (fewest nodes);
4. Newer timestamp (`at` descending);
5. Smaller `markId` (lexicographical tie-break).

Frontier mode and enforcement:
- `frontierMode(mark, spentUsd)`: `none` when no mark covers the node; `stop` when mark is `stop`; `hold` when mark's `budgetUsd` is exhausted (`!(spentUsd < budgetUsd)`); otherwise the mark's kind (`expand` or `hold`). An exhausted budget degrades `expand` to `hold` but never lifts a `stop`.
- `modeAllows(mode, gapClass)`: `stop` excludes all work; `hold` excludes `expansion` but allows `verification`; `expand` and `none` allow both.

## `watchlist.json` (watchlist configuration file)

`{"entries": [WatchEntry, ...]}`, rewritten atomically on changes (read-modify-write configuration file, not a ledger).
Invalid entries and duplicate ids are dropped on parse (first entry of a repeated id wins).

`WatchEntry`: `{id, kind, query, cadenceHours, goalId?}`
- `id`: non-empty string.
- `kind`: `arxiv-query` | `feed` | `repo`.
- `query`: non-empty string:
  - `arxiv-query`: an arXiv search expression (e.g. `cat:cs.AI`);
  - `feed`: an HTTP or HTTPS feed URL;
  - `repo`: GitHub repository in `owner/name` format (alphanumerics, `.`, `_`, `-`; names consisting entirely of dots are rejected).
- `cadenceHours`: finite positive number (default 24, bounds 1 to 8760 hours).
- `goalId`: optional non-empty string; scopes similarity ranking to that goal's graph nodes instead of all active scopes.

SSRF and egress validation (`validateWatchTarget`, `isPublicHttpUrl`):
All external fetch targets and URLs cited by models must pass strict public-address validation:
- Scheme must be `http:` or `https:`.
- Credentials (`username` or `password`) are forbidden.
- Internal/local hostnames rejected: `localhost`, `*.localhost`, `*.local`, `*.internal`.
- Non-public IPv4 ranges rejected: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (Carrier-Grade NAT / shared), `127.0.0.0/8` (loopback), `169.254.0.0/16` (link-local), `172.16.0.0/12` (private), `192.0.0.0/24`, `192.168.0.0/16` (private), `198.18.0.0/15` (benchmarking), and `224.0.0.0/3` (multicast and reserved up to `255.255.255.255`).
- Non-public IPv6 ranges rejected: loopback (`::1`), link-local (`fe80::/10`), unique-local (`fc00::/7`), site-local (`fec0::/10`), multicast (`ff00::/8`), IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16` embedding private IPv4).
- Redirects: followed manually (max 3 hops); every hop must pass the public address rules; https-to-http downgrade is rejected. Response bodies are streamed and aborted if exceeding `MAX_FEED_BYTES` (1 MB) or `MAX_FEED_CHARS` (512 KB decoded).

## `inbox.jsonl` (source inbox ledger)

Ledger tracking candidate sources discovered by the research cycle or watch feed (REQ-rs-07, REQ-rs-08, REQ-rs-09).

Event `proposed`: `{type:"proposed", locator, title, gapId, foundBy, cycleId, snapshot, at}`
- `locator`: canonical locator string (normalized via `normalizeLocator`: lower-case scheme and host, no fragment, path trailing slashes removed, query preserved).
- `title`: string.
- `gapId`: string (identifying the gap or `watch:<entryId>`).
- `foundBy`: `cycle` | `watch`.
- `cycleId`: string.
- `snapshot`: sha256 hash of the stored text in `snapshots/<sha256>.txt`.
- `at`: ISO-8601 timestamp.

Event `decided`: `{type:"decided", locator, decision, at}`
- `locator`: canonical locator string.
- `decision`: `approved` | `rejected` | `activated`.
- `at`: ISO-8601 timestamp.

Event `ingested`: `{type:"ingested", locator, nodesAdded, at}`
- `locator`: canonical locator string.
- `nodesAdded`: integer >= 0.
- `at`: ISO-8601 timestamp.

Derivation (`deriveInbox`):
- Replay in file order. The first `proposed` for a canonical locator defines the item (`status = "pending"`, `proposedAt = at`). Later `proposed` events for that locator are ignored.
- A `decided` event sets `status` to `approved` | `rejected` | `activated` and sets `decidedAt`.
- `ingestedLocators(events)`: set of locators with an `ingested` event.

Triage rules (`triage(locator, isActive, inbox)`):
- If the item was previously `rejected`: returns `skip-rejected` (never proposed again).
- If the item already exists in the inbox (`pending`, `approved`, or `activated`) or has an `ingested` event: returns `skip-seen`.
- If the source is an active library entry: returns `ingest`.
- Otherwise: returns `inbox` (proposes to inbox ledger).

Authority constraints:
- **Agent constraint:** the agent's `decide_inbox` tool may only submit `approved` (ingest once) or `rejected` (never propose again) for a source explicitly named by the learner.
- **Activation constraint:** `activated` (which adds the URL prefix to `sources.json` as an active source and ingests it) is strictly user-only from the UI and is never permitted to automated agents.

## `research-log.jsonl` (cycle ledger)

Records every completed or terminated research cycle (REQ-rs-10).

Event `cycle`: `{type:"cycle", cycleId, trigger, startedAt, endedAt, stoppedBy, gaps, watch, nodesAdded, costUsd, steers}`
- `cycleId`: non-empty string.
- `trigger`: `schedule` | `manual`.
- `startedAt`, `endedAt`: ISO-8601 timestamps.
- `stoppedBy`: `completed` | `no-gaps` | `ceiling` | `aborted` | `error`.
- `gaps`: array of `GapLog` entries:
  - `gapId`: string.
  - `type`: `uncovered` | `no-premises` | `weak-premise` | `unverified` | `contested-no-primary`.
  - `nodeId?`, `chatId?`, `markId?`: optional strings.
  - `questions`: array of question strings.
  - `confidence?`: optional number in [0, 1].
  - `rationale?`: optional string.
  - `stoppedBy?`: `confidence` | `no-more-sources` | `turn-limit`.
  - `sources`: array of `{locator, outcome, nodesAdded}` where outcome is `ingested` | `inbox` | `skipped-rejected` | `skipped-seen` | `skipped-active` | `not-fetched` | `not-capturable` | `over-cap` | `failed`.
  - `nodesAdded`: integer >= 0.
  - `costUsd`: finite number >= 0.
  - `saturated`: boolean (true when an expansion gap added < 2 nodes, causing the agent to set a `hold` mark).
  - `error?`: optional error label string.
- `watch`: `{entries, items, ingested, inbox}` summary counts.
- `nodesAdded`: total nodes added across all gaps in the cycle.
- `costUsd`: total USD cost incurred by the cycle.
- `steers`: array of user steering messages accepted during the cycle.

Error label invariants:
To prevent leakage of internal system details, network errors, or stack traces, `research-log.jsonl` only stores fixed error labels:
- `"the gap failed"` (`GAP_FAILED`)
- `"the watch failed"` (`WATCH_FAILED`)
- `"the cycle failed"` (`CYCLE_FAILED`)
Raw errors are passed to the in-process `onError` callback and are never written to the ledger.

Derivations:
- `markSpendUsd(log)`: sums the `costUsd` of every gap recorded under each `markId`.
- `cycleDue(log, nowIso, cycleHours)`: true if the log has no cycle or if elapsed time since the newest cycle's `startedAt` is >= `cycleHours * 3,600,000` ms.

## `radar.jsonl` (radar ledger)

Tracks watch item checks and classifications (REQ-rs-11, REQ-rs-12).

Event `checked`: `{type:"checked", entryId, ok, items, at}`
- `entryId`: watch entry id.
- `ok`: boolean (false if fetch or parse failed).
- `items`: count of feed items discovered.
- `at`: ISO-8601 timestamp.

Event `classified`: `{type:"classified", entryId, itemId, title, link, nearestNodeIds, relation, action, rationale, at}`
- `entryId`: watch entry id.
- `itemId`: unique feed item identifier or link.
- `title`, `link`: string metadata.
- `nearestNodeIds`: array of candidate node ids selected by distinct word overlap (4+ letter words).
- `relation`: proposed relation: `extends` | `contradicts` | `applies` | `unrelated`.
- `action`: `ingest` (if approved active source) | `ignore`.
- `rationale`: string explanation from classifier.
- `at`: ISO-8601 timestamp.

Derivations:
- `seenItemIds(radar, entryId?)`: set of `itemId`s already classified (optionally scoped to a specific watch entry).
- `dueEntries(entries, radar, nowIso)`: returns watchlist entries that have never been checked or whose latest `checked` event is older than `cadenceHours`.

## Cycle orchestration and live steering

- **Mutual exclusion:** `runCycle` acquires an in-process lock (`running` Set and `lockKey`). If a cycle is in-flight, any concurrent start throws `CycleBusyError`.
- **Scheduler cadence:** `createResearchService` exposes `tick()`, invoked periodically. If `canRun()` is true and `cycleDue(...)` is satisfied, starts a cycle with trigger `schedule`.
- **`CycleControl` and live steering:**
  - `CycleControl` manages `AbortController` and steering queues.
  - While a gap's research agent runs, it is attached via `control.attach(agent)`. A steer message sent via `control.steer(message)` is delivered immediately to the live agent (`agent.steer(...)`, returning `"delivered"`).
  - Between gaps, no agent is attached: steer messages are queued in `takeSteers()` and delivered at the start of the next gap prompt (returning `"queued"`).
  - When all research gaps complete (`onGapsDone()`), steering is closed (`closeSteering()`). Any subsequent steer attempt returns `"closed"` and is rejected with `ResearchInputError("the cycle has no gap left to steer")`.
  - Max 50 steering messages per cycle; max 2000 characters per message.
- **Runner seam (`onAgent`):**
  - Upstream `runSubagent` accepts `opts.onAgent?: (agent: Agent) => void` and calls it immediately after agent instantiation.
  - The gap researcher wires `onAgent` to attach the agent to `CycleControl`. On settlement of the gap, the agent is detached (`attach(null)`).

## Research console chat

- **Session kind:** `ChatKind` `"research"`. It is categorized as practice-like (`isPracticeLike`), ensuring it never triggers extraction pipelines and uses practice-style compaction.
- **Agent:** Built via `createResearchAgent` with `RESEARCH_INSTRUCTIONS`.
- **Dedicated tools:** The agent is given 9 tools:
  1. `read_log`: inspect recent cycle log entries and cycle status.
  2. `list_marks`: list active frontier marks and effective regions.
  3. `edit_mark`: create (`action: "set"`) or remove (`action: "clear"`) frontier marks.
  4. `run_cycle`: trigger a manual cycle run.
  5. `control_cycle`: send a steer message or abort a running cycle.
  6. `list_inbox`: list pending or decided inbox sources.
  7. `decide_inbox`: approve or reject a source locator named by the learner.
  8. `list_watchlist`: inspect configured watch targets.
  9. `edit_watchlist`: add or remove arXiv query, RSS/Atom feed, or repo targets.
- **Cost gating:**
  - Wraps the engine via `gateResearchEngine` against `cost.jsonl`.
  - Checks if daily spend is below ceiling (default 2 USD; env `LH_EXT_DAILY_CEILING_USD`). If exceeded, throws `"the daily research ceiling is reached"`.
  - Usage collector records model spend to `cost.jsonl` with `source: "research"`. If recording fails, a latch refuses subsequent model calls.

## `documents.jsonl` (ledger)

Event `registered`: `{type:"registered", documentId, title, pageCount, at}`. `documentId` is the lowercase-hex sha256 (64 chars) of the PDF file's bytes; `title` non-empty; `pageCount` a positive integer.
Event `chat`: `{type:"chat", documentId, chatId, at}`; binds the document's one study conversation.

Derivation (`deriveDocuments`, `documentOfChat`): replay in file order; the first `registered` per `documentId` defines the document (the same file registered twice is one document); the first `chat` per document wins, so there is exactly one conversation per document; a `chat` for an unregistered document is ignored. `documentOfChat(chatId)` is the inverse lookup.

Stored files, content-addressed under `documents/`: `<documentId>.pdf` (a byte copy, written through a temp file and renamed) and `<documentId>.pages.json` (a JSON array of strings, one per page, page 1 first; a cache of the extracted text, rebuilt when absent).

## `reading.jsonl` (ledger)

Event `visit`: `{type:"visit", documentId, page, at}` (page a positive integer). Event `close`: `{type:"close", documentId, at}`.

Derivation (`deriveReading(events, documentId, {dwellSeconds = 5, pageCount})`): replay the document's events in file order. A visit lasts until the next event of the same document (a visit or a close). A page is READ when some visit to it lasted at least `dwellSeconds`. The newest visit has no end and counts only once a later event follows. `lastPage` is the page of the newest visit. Pages greater than `pageCount` (when given) are ignored. `readPages` is ascending and distinct.

## `study-links.jsonl` (ledger)

Event `link`: `{type:"link", nodeId, documentId, page, at}`. Append-only. `sourcesOfNode` returns the distinct `(documentId, page)` pairs of a node in order of first appearance; `linkedPages(documentId)` the ascending distinct pages that have at least one node; `nodeIdsOnPages(documentId, pages)` the distinct node ids on those pages. Nothing here is derived from the content ledgers: a link to a node that no longer exists is filtered by the reader.

## `study-drafts.jsonl` (ledger)

Event `proposed`: `{type:"proposed", draftId, documentId, page, proposition, question, answer, at}` (all strings non-blank, page a positive integer). Event `decided`: `{type:"decided", draftId, decision, at}` with `decision` in `approved` | `rejected`. Event `pages_processed`: `{type:"pages_processed", documentId, pages, at}` (non-empty array of positive integers): the pages a "complete" run has handled.

Derivation (`deriveDrafts`): replay in file order; the first `proposed` per `draftId` defines the draft with status `pending`; the first `decided` per draft wins; a `decided` for an unknown draft is ignored. `processedPages(documentId)` is the ascending distinct union of `pages_processed`. Drafts are never graph content: only approval sends the proposition to the extraction pipeline.

### Complete (the run that writes `proposed` events)

Pages offered: read (`deriveReading`) and not in `processedPages`, ascending. Each batch of 4 pages is checked against the daily cost ceiling before the call; when it is reached the run stops with `ceilingReached` and the pages not yet handled stay unprocessed. The model proposes candidates; `dropRepeats` removes any whose proposition equals (`sameProposition`: `normalizeForMatch(…, "join")` equal after stripping trailing full stops and whitespace) the statement of a node linked to a page of the batch, the proposition of any draft (pending, approved or rejected) on those pages, or an earlier candidate, then keeps at most 5 per page. Propositions are at most 400 characters. Every handled page is recorded in a `pages_processed` event, including pages that produced nothing.

### Confirming a card (the only road into the graph)

The proposition text alone is imported as a notes source with the pseudo-path `study/<slug>/p<page, 4 digits>-<sha256(proposition.trim())[0..8]>.md` (`<slug>` is the title NFKD-normalised, diacritics removed, lowercased, non-alphanumerics collapsed to `-`, at most 40 characters, `document` when empty); the source text is the trimmed proposition plus a newline. The pipeline may create or link nodes. The card attaches to the node returned by `pickCardNode`: the candidate maximising the Jaccard overlap of word sets (`normalizeForMatch(·, "join")` split on non-letter-or-digit, words of at least 2 characters) between the proposition and the node's statement, any alias, or its name; a tie goes to the first candidate; with no candidate the confirmation fails and nothing is linked. A `link` event is appended for the node and page. A user-confirmed card is `active`; an unedited approved draft is an agent card approved by the learner. The node is pinned unless the learner opted out.

## The study message context line

A user message in a `study` session is `[study-context] <JSON>` + `\n` + the learner's text. `<JSON>` is `{"documentId": string, "page": positive integer, "selection": string}`; the selection is cut to 2000 characters; `JSON.stringify` escapes newlines so the first line ends at the first `\n`. A message without a valid first line has no context. The agent's prompt for a turn is composed from the NEWEST user message's context (and no earlier one) plus the text of that page.

`pageCitations(text)` finds every `(p. N)` (regex `\(p\.\s*(\d{1,5})\)`, N at least 1) with its start and end offsets; `citationAt(text, offset)` returns the page of the citation covering `offset`, if any.
