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

Event `spend`: `{type:"spend", usd, source, at}`; `usd` finite and ≥ 0; `source` `verification` | `research` | `node-knowledge` | `debrief`. Spend for a day = sum of `usd` of events whose
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

## `review-focus.jsonl`

Event `focus`: `{type:"focus", chatId, cardId, at}` (a card) or `{type:"focus", chatId, nodeId, at}` (a node with no card yet). Exactly one of `cardId` and `nodeId` is present, each a non-empty string; any other shape is invalid and skipped by readers. Written once per tutor session (a `kind: "review"` chat): "Ask the tutor" on a card writes the card form, "With the tutor" on a node without a card writes the node form. Never written by the daily review. Derivation (`focusTargetOf`): the last `focus` event for a chat names what the tutor is focused on; a chat with no event is an ordinary session. `focusCardOf` returns the card of a card event and null otherwise. Events written before the node form stay valid (they are card events).

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
- `bookId`: `b` plus the first 8 hex of the SHA-256 of the absolute PDF path. An uploaded PDF's path is its content-addressed copy `<data>/ext/documents/<sha256>.pdf` (the study store), so the same bytes always give the same bookId. `bookTitle`: string. `title`: non-empty. `summary`: string (3 to 4 sentences handed to the next lecture of the chapter).
- `chapter`: `{index (1-based int), title, pageStart, pageEnd}` (pages 1-based, inclusive). `order`: int at least 1, the position inside the chapter.
- `chapterSourceId`: the notes-source id (`src_` plus the first 12 hex of the SHA-256 of the chapter label `"<bookTitle>/<NN> <chapter title>"`, `NN` the chapter index padded to 2) under which the chapter graph was extracted. `createdAt`: ISO-8601.
- `slides`: array of `{id, heading, elements}`; `elements`: array of `{id, type, content?, items?}` with `type` in `text` | `formula` | `list`. `text` and `formula` carry `content` (string); `list` carries `items` (strings). `text` and list items may contain node links `[[n_<id>]]` or `[[n_<id>|label]]` (`n_` followed by letters, digits, `_` or `-`; the label may be empty). A `formula` is LaTeX without delimiters.
- `blocks`: ordered array of `{id, role, slideId, text, nodeIds, cues, seconds?}`. `role` in `narrate` (spoken discourse), `note` (editorial addition not in the source), `exercise` (timed prompt; `seconds` is required and a positive int), `reveal` (discussion following an exercise). `seconds` appears on `exercise` blocks only. `nodeIds`: graph node ids the block covers. `cues`: array of `{atChar (int >= 0), target (element id), style}` with `style` in `box` | `underline`.

`GET /api/ext/lectures` lists each lecture with its `bookId` and `exercises`: `[{blockId, prompt}]`, the lecture's `exercise` blocks in order, `prompt` the block text clamped to 1000 characters (with an ellipsis when cut; the full text stays in the lecture).

### Lecture validator rules (semantic; the lecture is rejected when any applies)

1. No slides, or no blocks. 2. Duplicate slide ids or duplicate block ids. 3. A block whose `slideId` is not a slide. 4. A `narrate` block with empty `nodeIds` (a `note` may have none). 5. A block `nodeId`, or a node link on any slide, that is not a node of the graph. 6. A cue with `atChar` greater than the block text length, or whose `target` is not an element of the block's slide. 7. An `exercise` block not immediately followed by a `reveal`; a `reveal` block not immediately preceded by an `exercise`. 8. **Verbatim:** after lower-casing and splitting into maximal runs of letters and digits (Unicode), a block text (node-link markup replaced by its label or id) shares any run of 12 consecutive words with the plain text of the chapter it was written from.

A rejected lecture is regenerated with the list of violations as feedback, at most 2 times after the first attempt (3 attempts in all); a lecture still invalid is not stored and its chapter run is failed. **Coverage report:** the chapter's nodes (graph nodes whose provenance `chatId` is the chapter's source id) that no stored lecture of the book cites in a block `nodeIds` or a slide link.

### Chapter rules and the outline split

- A proposed chapter list is valid when it is non-empty, every title is non-blank, every start page is an integer within 1 to the page count, and pages strictly increase. A chapter runs to the page before the next one; the last to the end of the book. PDF bookmarks (outline top level, or the level below when the top has fewer than 3 entries and the next level has at least 3), normalized by dropping blank titles and any entry whose page does not exceed the previous kept page, are used when valid; otherwise a model proposes the list from an excerpt, validated by the same rules.
- Lectures are split from the chapter outline, never from page count: each outline block has an estimated spoken length by kind (`definition` 150, `theorem` 375, `example` 100, `motivation` 120, `remark` 80 words); blocks are packed in order into a lecture until adding one would exceed 2000 words; a block alone above the target forms its own lecture. Lectures of a chapter are produced in order, each receiving the previous lecture's `summary`.

### Lecture overlay and back-links (derived, nothing stored)

For every lecture: one special node `{id: lectureId, title, kind: "lecture"}`; for every node id the lecture cites (block `nodeIds` and slide links) that exists in the graph, one edge `{from: lectureId, to: nodeId, type: "cites"}`. Back-links of a node: the lectures whose citations include it, ordered by lecture id. No lecture is written to `nodes.jsonl` or `chains.jsonl`.

## Lecture ingest run state (`lecture-runs.json`)

One JSON document, `<data>/ext/lecture-runs.json`, rewritten atomically on every change of a book or chapter. `{"version": 1, "books": [...]}`, newest book first. Pure rules: `src/core/ext/lecture/run-record.ts`; the file: `src/store/ext/lecture-runs-store.ts`. A missing, unreadable or corrupt file reads as empty (never a crash); a record that does not validate is dropped, the rest is kept. A file stamped by a newer build is refused on save.

- Book: `bookId` (`b` + 8 hex, as in `lecture.json`), `title` (at most 300 characters), `pdfPath` (the stable locator the run reads: the content-addressed copy of an upload, never a temp path; absolute, `.pdf`), `phase` (`detecting` | `running` | `done` | `failed` | `interrupted`), `chapters`, `error` (optional, at most 2000 characters), `startedAt`, `updatedAt` (optional).
- Chapter: `chapter` (`{index, title, pageStart, pageEnd}`), `state`, `stage` (optional: the last working stage, `graph` | `outline` | `writing`), `lectures`, `uncovered`, `error` (optional, the explained text), `startedAt`, `updatedAt` (optional).
- Bounds: at most 50 books (every running book is kept; the newest of the others fill up) and 500 chapters per book.

### Chapter states

`queued` | `graph` | `outline` | `writing` (working) and `done` | `failed` | `stopped_cost` | `stopped_provider` | `interrupted` (final). `interrupted` is set on start for every chapter, and every book, that was in a working state when the app closed; its `error` is the fixed text `interrupted when the app was closed`. The conversion is saved, so it happens (and is logged) once per run. A record written before staging may carry an `importedParts` field: it is ignored.

### Staged chapter graph

A chapter's graph is extracted from the chapter text, in one import, into a staging overlay of the real graph (`src/server/ext/staged-graph-store.ts`). Upstream's notes pipeline runs unchanged over the overlay, which reads the real graph plus the chapter's own writes, so the import dedupes and links against existing nodes. Writes go to memory only:

- **Invisible until commit.** Nothing the chapter adds is shown in the graph, read by the teacher context, the MCP server, research, verification, the personal layer, or another extraction run, until the chapter commits.
- **Writing and validating the lectures.** The outline and the lecture writers read the real nodes plus the chapter's staged nodes (the same view the validator uses). The drafts are held in memory.
- **Commit, then save.** When every lecture of the chapter is valid, the staged writes are replayed into the real store once, in the order sources, usage, nodes, chains, coverage, checkpoints. Then the lectures are saved. After the commit the layout is settled, the source is listed in the library, `sources-changed` is emitted, and the post-merge verification runs (the live pipeline does these after a merge; a staging run does them after the commit).
- **Discard.** A chapter that fails, is stopped by the cost or provider limit, is aborted, or whose app closes before the commit discards its staging. Nothing reached the real store, so the real graph is unchanged. A Retry (or a book run) starts the chapter from scratch: no duplicates. Discarded, never written: the staged nodes, links, coverage, source record and its usage log, and the staged layout.
- **Links to existing nodes.** A link line to a node already in the real graph stays staged until the commit. The real node line is never changed, and the merged view adds its phrasings as it does for any two lines of one id.
- **Not staged.** `deleteSources` throws (a chapter never removes a source). A rewrite other than the chains throws. A chain rewrite (the simplification pass) may drop staged chain lines, never a real one, so a chapter cannot hide what already exists.
- **A chapter whose graph is active.** A chapter whose source record is in the real store and whose lectures are stored is done and is skipped (no import). Any other chapter is rebuilt from scratch.
- **Known windows.** A commit that fails part-way leaves the replayed part in the real store; the chapter fails with the explained error, and the next run finds no lectures and rebuilds (the auditor links the nodes already there). A crash between the commit and the last lecture save leaves active nodes without their lectures: the next run rebuilds the chapter the same way, and the cleanup below lists it until then. Another extraction run may add a node that duplicates a staged one, because the audit does not wait for the staging.

### Explained errors

A chapter's `error` is passed through `explainChapterError` (`src/core/ext/lecture/explain-error.ts`) before it is stored or logged: `;`-separated parts are shown once, with a count (`the extractor never submitted findings (x6)`), and a text matching `never submitted` or `ended without calling` gets the plain hint once: `The model stopped before calling the tool. This usually means it ran out of output space: lower the thinking level or choose a model with a larger output limit in Settings.` The states are not changed by this.

### Chapter log line

Written to stdout (`console.log`, which the desktop app captures into its `main.log`) once per chapter that reaches a final state, and once per chapter converted to `interrupted` on start:

`[lectures] book <bookId> chapter <index> "<title>" <state>[: <explained error>] (stage <stage|queued>[, <seconds>s])`

Only ids, the chapter index and title, the state, the explained error, the stage and the duration. Never the PDF path or any text of the book. The line is one line: whitespace in the error is collapsed.

## Stale chapter leftovers

Before staging, a chapter that failed, was stopped or was interrupted could leave its nodes and links in the real graph. Their leftovers are found by provenance and removed through upstream's own removal seam (`deleteSourcesTraces` in `src/core/graph-deletion.ts`, the one a source deletion uses). Code: `src/server/ext/lecture-cleanup.ts`.

- **A leftover chapter**: a chapter of a book that is not running, in state `failed`, `interrupted`, `stopped_cost` or `stopped_provider`, with no stored lecture, whose chapter source id (`src_` + the first 12 hex of the SHA-256 of the chapter label, as in a lecture's `chapterSourceId`) has a source record, a node or a link in the real graph.
- **Counts**: `nodes` (the nodes removal would delete: every point of theirs is this chapter's), `chains` (the links it would delete), `kept` (the nodes that stay because another source, chapter, lecture or chat also refers to them; this chapter's points on them go).
- **Removal**: `deleteSourcesTraces` with `delete-nodes`, then the source record is deleted, then the source's place in the library is dropped.

### `GET /api/ext/lectures/stale`

Read only. `200` `{chapters: [{bookId, bookTitle, chapterIndex, chapterTitle, state, nodes, chains, kept}]}`.

### `POST /api/ext/lectures/[id]/purge`

The path segment is the book id. Body `{chapterIndex}`. `200` `{nodesRemoved, chainsRemoved, nodesKept}`. Refusals, each a fixed `error` text:

- `400`: `chapterIndex must be a whole number, 1 or more`, or `unknown chapter`.
- `404`: `unknown book`.
- `409`: `the book is still being made; retry when it finishes`, `that chapter is still running`, `that chapter has no leftovers to remove`, `that chapter has lectures, so its leftovers are kept`, `an extraction is running; try again when it finishes`.

### `POST /api/ext/lectures/[id]/retry`

The path segment is the book id. Body: `{chapterIndex?: number}`, a JSON object. Absent `chapterIndex` = every chapter in `failed`, `interrupted`, `stopped_cost` or `stopped_provider`; a number = that chapter. The chapters re-run through the same pipeline and limits as the first run (`MAX_PARALLEL_CHAPTERS`, the cost gate, the provider pause), in the background. Answers:

- `202` `{bookId, chapters: [index, ...]}`: started.
- `400` a `chapterIndex` that is not a whole number of 1 or more, or not a chapter of the book (`unknown chapter`).
- `404` `unknown book`.
- `409` with a fixed text: `the book is still being made; retry when it finishes`, `that chapter is already running`, `that chapter does not need a retry`, `no chapter needs a retry`, `the book PDF is no longer stored`.
- `429` the daily ceiling is spent (the provider-limit text when the provider paused the work).

The book's phase is `running` while a retry runs, and `done` or `failed` again when every chapter has a final state. The retried chapters are queued at once, so a second retry meanwhile is refused.

## `office-hours.jsonl` (ledger, keyed by chat id)

Event `designated`: `{type:"designated", chatId, label, sha256, exercise?, focus?, at}`. `sha256` is 64 lowercase hex, the name of a file `snapshots/<sha256>.txt`; `exercise`, when present, is `{setId, exerciseId}`. The latest `designated` event of a chat is its designated source.

`focus` (optional; absent on older events, which stay valid): the exercise a session works on when it was opened from a lecture (the text of the lecture's exercise block). A string that is not blank and has at most 4000 characters (`MAX_FOCUS_CHARS`); any other `focus` makes the event invalid and it is skipped by readers. The latest `designated` event's `focus` is the session's focus. The agent's instructions carry it: the standing instructions, then the focus fenced in an `<exercise>` tag (a `</exercise` inside the focus is escaped). A focused session's record opens with an assistant message showing the label and the exercise; it is not learner work and never counts toward a verdict.

`POST /api/ext/lectures/[id]/office-hours` with `{blockId}` opens a session for an exercise of a lecture (201 `{chatId}`): the designated source is the text of the lecture's chapter, label `"<bookTitle> ch. <n>: <lecture title> · exercise <k>"` (`k` the exercise's position among the lecture's exercise blocks, from 1), focus the exercise block's text. The chapter text is re-read from the stored book PDF (pages `chapter.pageStart`..`pageEnd`, the same reader as the chapter run); when no stored PDF exists for the book, or it cannot be read, or reads empty, the answer is 409 with the fixed text "the chapter text is not available: its book PDF is no longer stored" and no session is created. A `blockId` that is not an exercise block of this lecture (or is unknown) is 404 "unknown exercise"; a block of this lecture that is not an exercise is 400.

Event `verdict`: `{type:"verdict", chatId, outcome, items, discarded, at}`; `outcome` in `consistent` | `differs` | `not_verifiable`; `items`: the kept items `{stepRef, sourceQuote, workQuote, stance}` with `stance` in `matches` | `differs` | `missing`; `discarded`: count of dropped items.

### Verdict rules

The model proposes items; the following decide. For each item, `checkQuote(source, sourceQuote)` of the "Quote check" section above must return `ok`, otherwise the item is dropped (`quote_too_short` or `quote_not_found`). Unless `stance` is `missing`, the item is also dropped when `normalize(workQuote, join)` is empty or does not occur in `normalize(work, join)` (`work_quote_not_found`). The work is every message of the learner in the session except messages beginning with `/verdict`. Outcome: no item kept gives `not_verifiable`; all kept items `matches` gives `consistent`; otherwise `differs`. A verdict exists only when the learner's newest message begins with `/verdict` and the session has a designated source; the text of a verdict never states correctness, only consistency with the designated source.

## Narration audio (`lecture-audio/`)

Each block of a lecture can be spoken by Deepgram text-to-speech (Aura-2). The pure rules are in `src/core/ext/lecture/audio.ts`; the synthesis, the files and the spend are in `src/server/ext/lecture-audio.ts`. Failure is soft: a failed block never changes its lecture.

Files, under `<data>/ext/lecture-audio/`:
- `cache/<sha256(voice + "\n" + text)>.mp3`: the audio of one request. The text is a chunk of the block with node-link markup removed. Identical text and voice are never paid twice.
- `<lectureId>/<blockId>.mp3`: a ready block's audio, its chunks concatenated in order.
- `<lectureId>/audio.json`: the manifest, written atomically.

Manifest: `{version: 1, lectureId, language: "it" | "en" | "unknown", voice: string | null, blocks: [{blockId, status: "ready" | "failed", chars, durationSec, chunks: [{startChar, endChar, startSec, durationSec, bytes}], error?}]}`. The chunks of a ready block tile `[0, chars)` in order and their `startSec` chain; a failed block has no chunks; `error` is a fixed text. A manifest whose voice or language is not the current one counts as no audio: its blocks are generated again.

Language: `guessLanguage` on the stripped text of all blocks, by stopwords. `it` or `en` when one side has at least 5 hits and at least 70% of them; otherwise `unknown`, and an unknown lecture gets no Deepgram audio (the browser voice speaks it).

Voices: `aura-2-livia-it` and `aura-2-thalia-en` by default; `LH_EXT_AUDIO_VOICE_IT` and `LH_EXT_AUDIO_VOICE_EN` override them, and only an Aura-2 voice of the same language is taken.

Chunking: at sentence ends where possible, else after the last whitespace of the window, else at any code point, never inside a node link. A chunk is at most 800 UTF-16 units (Deepgram refuses 2000 characters). A whitespace-only chunk is never sent and has zero duration.

Requests: `POST https://api.deepgram.com/v1/speak?model=<voice>&encoding=mp3&bit_rate=48000`, header `Authorization: Token <key>`, body `{"text": "..."}`. The key is `DEEPGRAM_API_KEY`, read on the server. At most 4 requests in flight per block; a 30 s timeout per request; up to 3 attempts for 429, 5xx and network errors, backing off 1 s then 2 s (a numeric `Retry-After` is honoured, up to 30 s). A 401 or 403 is not retried.

Timing approximation: Deepgram returns audio bytes only, with no timing. At the constant 48000 bit/s a chunk lasts `bytes * 8 / 48000` seconds. The container overhead is ignored, so chunk boundaries inside a block are approximate; the order is exact.

Clock to text (`charIndexAtTime`): the offset of the chunk that contains the time, linear inside it; past a chunk, its end; before the start, the first offset. It is monotonic in time, and the player feeds it to `activeCue`.

Cost: `chars * 0.03 / 1000` USD per request, `chars` the UTF-16 length of the request text. It is recorded in `audio-cost.jsonl` (source `audio`) BEFORE each attempt is sent. The audio gate is separate from the model gate: its own ledger, its own ceiling (`LH_EXT_AUDIO_CEILING_USD`, default 3 USD per UTC day), and a model provider's usage pause does not close it. When the gate is closed nothing is sent: an on-demand request answers 429, a batch stops, and no failed entry is written. `cost.jsonl` is not touched.

Pre-generation: every stored lecture starts its missing blocks in the background (`lectureAudio.prefetch`, called from the lecture store's `save` in `src/server/ext/lecture-live.ts`); the chapter run neither waits for it nor fails on it. With no key, or a language with no voice, nothing is generated. Removing a lecture removes its audio directory.

Every block of a lecture is spoken and so gets audio, including `note` blocks: the player speaks each block, and a note read by the browser voice next to Deepgram narration would sound inconsistent.

Routes (`app/api/ext/lectures/[id]/audio/`):
- `GET .../audio` answers `{keyConfigured, language, voice, ready, total, statuses: [{blockId, status: "ready" | "failed" | "missing"}], manifest}`; `manifest` holds the entries of the current voice. 404 `unknown lecture`.
- `POST .../audio` with `{}` answers 202 `{started: true}` and generates every missing block in the background (503 without a key, 422 for a language with no voice). With `{blockId}` it waits and answers 200 `{block}` once the block is ready; a ready block costs nothing. A block that is not in the lecture is 404 `unknown block`; a failed synthesis is 502 with the block's fixed text; a spent budget is 429.
- `GET .../audio/[blockId]` answers the block's `audio/mpeg` with `Accept-Ranges: bytes` and `Cache-Control: private, max-age=3600`. One `Range` is honoured (206; 416 when unsatisfiable). 404 for a block not of this lecture, or one not ready.
- `GET /api/ext/lectures` entries carry `audio: {ready, total, keyConfigured}`.

Player: a block with ready audio is played by an `<audio>` element and highlighted through the audio clock. A block without it is generated on demand when a key exists (the player shows "Preparing audio"), and the next block is requested while the current one plays. Any failure, or no audio at all, falls back to `speechSynthesis` as before. Pausing or leaving a block stops the element.

Privacy: the text of the lecture is sent to Deepgram, in chunks, once per distinct chunk (the cache keeps the result). The key is never sent to the browser, never logged, and never appears in an answer; failures are fixed texts.

Not verified here: a real Deepgram call (every test uses a fake fetch), the browser playback, and the real length of the audio against the byte-based timing approximation.

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
- **Ingest ceiling (review item 2):** every ingest is refused while the daily gate is closed (`makeIngest` in `src/server/ext/research-live.ts`, fixed refusal `the daily spending ceiling is reached`), and the cycle checks the gate before each ingest, so a gap that closes it mid-run ingests nothing more.
- **Ingest spend is NOT recorded on the gate (known gap):** the notes pipeline (`extraction.importNotes`) returns only node and chain counts (`EmissionStats`), not the billed total. Its usage is kept per source (`appendSourceUsage`, tokens only, no USD), so the gate sees the ingest as free. Closing this needs the pipeline to return a priced total; until then the ceiling bounds the gap research and the watch classification, not the ingest pipeline.

## `research-log.jsonl` (cycle ledger)

Records every completed or terminated research cycle (REQ-rs-10).

Event `cycle`: `{type:"cycle", cycleId, trigger, startedAt, endedAt, stoppedBy, gaps, watch, nodesAdded, costUsd, steers, goal?, reports?}`
- `cycleId`: non-empty string.
- `trigger`: `schedule` | `manual`.
- `startedAt`, `endedAt`: ISO-8601 timestamps.
- `stoppedBy`: `completed` | `no-gaps` | `ceiling` | `provider-limit` | `aborted` | `error` (`provider-limit`: a provider usage limit paused the cycle, see "Provider limits").
- `gaps`: array of `GapLog` entries:
  - `gapId`: string.
  - `type`: `uncovered` | `no-premises` | `weak-premise` | `unverified` | `contested-no-primary` | `goal` (the one gap of a goal cycle, see below).
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
- `goal?`: the research goal of a goal cycle (REQ-rs-19), a trimmed string of at most 500 characters. Absent on a graph cycle and on every entry written before goals existed.
- `reports?`: progress reports the research agent wrote while the cycle ran (REQ-rs-20), oldest first, at most 50 of at most 400 characters. Absent when there were none.

Entries written before `goal` and `reports` existed stay valid: the parser drops an invalid optional field and keeps the entry and its cost.

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
- `nearestNodeIds`: array of candidate node ids selected by distinct word overlap (a word is a run of 4+ Unicode letters, no digits, compared case-insensitively).
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
- **Goal cycles (REQ-rs-19):** `runCycle(deps, trigger, { goal })` researches the goal as its one gap (`goalGap`, type `goal`, label = the goal) instead of the graph's gaps, and runs no watch. Without a goal the cycle is unchanged. A goal is trimmed; blank is no goal; a non-string or one over 500 characters is refused with a 400 (`POST /api/ext/research/cycle` with `action: "start"`, field `goal`), and nothing starts. The daily cost gate applies as before.
- **Progress reports (REQ-rs-20):** the gap researcher's `report_progress({text})` tool (text trimmed, 1 to 400 characters, refused otherwise) hands each report to the cycle through `CycleControl.progress(text)`. The handle keeps the newest 50 (`reports()`). A report makes no model call and does not end the research. The reports are written to the cycle's log entry (`reports`).
- **Notes (REQ-rs-21):** a steer that arrives during a gap is delivered as a user message starting "Steering from the learner:". The agent reads it before its next `report_progress` call and changes direction after that report. Steering is not rewritten by this addendum; the UI presents it as a note.
- **Status (`GET /api/ext/research/cycle`):** `goal?` (the running cycle's goal, when it has one) and `reports` (the running cycle's reports, oldest first; `[]` when idle), in addition to the fields above.

- **Runner seam (`onAgent`):**
  - Upstream `runSubagent` accepts `opts.onAgent?: (agent: Agent) => void` and calls it immediately after agent instantiation.
  - The gap researcher wires `onAgent` to attach the agent to `CycleControl`. On settlement of the gap, the agent is detached (`attach(null)`).

## Research console chat

- **Session kind:** `ChatKind` `"research"`. It is categorized as practice-like (`isPracticeLike`, defined in `src/core/ext/practice/session-kind.ts`), so it never triggers extraction. It is never compacted: a turn over the compaction threshold is refused with the fixed 409 message "this research session is full, start a new one".
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

Event `visit`: `{type:"visit", documentId, page, at}` (page a positive integer). Event `close`: `{type:"close", documentId, at}`. The viewer saves the PRIMARY page only (the page with the largest visible share), after the learner has stayed on it for a moment; the other pages on screen are not recorded as visits.

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

A user message in a `study` session is `[study-context] <JSON>` + `\n` + the learner's text. `<JSON>` is `{"documentId": string, "page": positive integer, "selection": string, "pages"?: integer[]}`; the selection is cut to 2000 characters; `JSON.stringify` escapes newlines so the first line ends at the first `\n`. A message without a valid first line has no context. A message without `pages` (every message written before it existed) has no other pages.

`page` is the primary page (the page with the largest visible share of the viewer). `pages` lists the other pages partly on screen, ascending, at most 2, never the primary page: `extraPages` drops anything else (non-integers, out of range, duplicates, the primary) and keeps the lowest two. `visiblePages(rects, viewport)` (`components/ext/study-logic.ts`) decides them: the primary is the page with the most visible pixels (a tie goes to the lower page); another page counts when at least 20% of its height or of the viewport is visible; at most three pages in all. A card made from the page uses the primary page, and a card made from a selection uses the page the selection is on.

The agent's prompt for a turn is composed from the NEWEST user message's context (and no earlier one) plus the text of the primary page. The other pages are named in the prompt without their text (`The learner also sees part of pages 3, 5.`): the tutor reads them with `read_page`, and only pages within the document's page count are named.

`pageCitations(text)` finds every `(p. N)` (regex `\(p\.\s*(\d{1,5})\)`, N at least 1) with its start and end offsets; `citationAt(text, offset)` returns the page of the citation covering `offset`, if any.

A study conversation is compacted by upstream's context compaction like a teach chat: over the threshold it is compacted, never refused (only research is kept out of compaction, with a fixed 409). Accepted limit: like every upstream kind's, a study conversation's compaction summary spend is not on the daily cost gate.

## `journal.jsonl` (ledger)

Event (one per debrief): `{id, kind, sessionId, sessionKind, weekOf, at, facts, commentary, nullReason, styleVersion?, author}`
- `kind`: `session` | `weekly`. `author`: `agent`. `at`: ISO-8601, when the entry was written.
- Key of an entry: `sessionId` for `session` (namespaced as `session:<id>` only when the id contains a colon), `weekly:<weekOf>` for `weekly`. `id` = `deb_` plus the first 12 hex digits of the SHA-256 of the key, and a parsed event must carry exactly that id.
- `sessionId` matches `^[A-Za-z0-9_-]{1,100}$`. `weekOf` is a real calendar date. `at` is an ISO-8601 date-time. `styleVersion`, when present, is `^[A-Za-z0-9._-]{1,32}$`. A commentary is at most 4 x 2500 characters plus headings; the facts JSON is at most 16 KiB. Lines over these bounds are skipped by readers.
- `session`: `sessionId` non-empty, `sessionKind` in `review` | `lecture` | `office_hours` | `study` | `exercises`, `weekOf` null, `facts.kind` equal to `sessionKind`.
- `weekly`: `weekOf` = local date `YYYY-MM-DD` of the window start, `sessionId` and `sessionKind` null, `facts.kind` = `weekly`.
- `commentary`: non-empty Markdown, or null. `nullReason`: `ceiling` (the daily cost ceiling was reached) or `error` (three commentary attempts failed), non-null exactly when `commentary` is null.
- `facts`: an object; a reader checks only that it is an object with a string `kind`. Its fields are the "Debrief facts" below.
- Derivation (`deriveJournal`): replay in file order; the FIRST event per key wins, later ones are ignored (a session has at most one debrief). `recentDebriefs`: newest `at` first (ties: smaller `id`), optional filter by `kind` (`weekly` or a session kind) and by `since`; the limit defaults to 50, a non-positive, fractional or NaN limit means the default, the maximum is 200; the result carries `count` and `truncated`.
- Writers never write a null commentary without a reason; readers skip lines their parser rejects.

## `activity.jsonl` (ledger)

Every event has `sessionId` (`[A-Za-z0-9_-]{1,100}`) and `at` (ISO-8601).
- `end`: `{type:"end", sessionId, at}`: the user ended the session. The EARLIEST `end` of a session wins (`explicitEnds`).
- `lecture_view`: `{type, sessionId, lectureId, slideId, at}`; `concept_open`: `{..., nodeId}`; `exercise_done`: `{..., blockId}`. For these the session id matches `lecs_[A-Za-z0-9]{8,32}`, ids are non-empty strings of at most 200 characters.
- Lecture sessions (`deriveLectureSessions`): the first event of a session fixes its lecture; later events naming another lecture are ignored; `startedAt`/`lastActivityAt` are the earliest/latest event; slides, concepts and exercises are distinct sets. The writer refuses an event whose slide, exercise block (role `exercise`) or concept is not in the lecture, a session that belongs to another lecture, or a session that has an `end` or a debrief; it does not append an event already recorded for that session.

## Session end and which sessions are debriefed

Sessions (`SessionRef {sessionId, kind, title, startedAt, lastActivityAt}`):
- chats of kind `review`, `office_hours`, `study`: id = chat id, start = `createdAt`, last activity = `updatedAt` (for `study` also the newest reading or link event of the chat's document);
- exercise sets: id = `setId`, start = `set_created.at`, last activity = the newest `graded.at` (or the start);
- lectures: id = the lecture session id, start/last activity from `activity.jsonl`.

`endedAtOf(ref, now, idleMs, explicitEnd)`: unparseable `startedAt`/`lastActivityAt` → still open. An `explicitEnd` that parses → `max(explicitEnd, startedAt)`. Otherwise, if `idleMs` is a finite positive number and `now - lastActivityAt >= idleMs` → `lastActivityAt` (clamped to the start); else open. Defaults: `idleMs` = 30 minutes. `pendingSessions`: refs without a journal entry, ended, deduplicated by id (first listing wins), with `now - lastActivityAt <= lookback` (default 3 days) unless an explicit `end` exists; ordered by end time then id. A sweep takes at most 5 per run.

Review events carry no session id: `ownerOfEvent(at, windows)` = the window with `start <= at <= end` that started last (ties: smaller session id); a review session's window is `[createdAt, end]` where `end` is its end (or its last activity while it is still open).

## Debrief facts (computed by code, no model, no clock)

`spanSec(a, b)` = whole seconds from `a` to `b`, 0 if reversed or unparseable. All facts carry `kind`, `startedAt`, `endedAt` (except `weekly`), `durationSec`.
- `review`: `reviews`, `perChannel{fixed,dialogic}`, `ratings{"1".."4"}`, `lapses` (= rating 1), `reviewSec`, `budgetSec`, `budgetRatio` (`reviewSec/budgetSec`, 3 decimals, null if no budget), `weakPremises[{nodeId,name,count}]` (at most 10, count desc then id asc, one count per review event, premises counted from dialogic reviews). Counted: `review` events on existing nodes with channel `fixed`/`dialogic`, `at` inside the window and owned by the session.
- `lecture`: `lectureId`, `title`, `slidesViewed` (distinct, only slides of the lecture if it still exists), `slidesTotal`, `conceptsOpened`, `exercisesDone`, `exercisesTotal` (blocks with role `exercise`); totals null when the lecture is gone.
- `office_hours`: `designatedSource` (label of the latest designation), `verdicts{consistent,differs,not_verifiable}`, `latestItems{matches,differs,missing}` (items of the latest verdict), `stepsQuestioned` (distinct `stepRef` of items with stance `differs`/`missing` over all verdicts), `learnerMessages` (non-blank user messages in the window), `unansweredQuestions` (assistant messages ending in `?` with no non-blank user message before the next assistant message or the end).
- `exercises`: `setId`, `goalId`, `exercisesTotal`, `exercisesGraded`, `nodes[{nodeId,name,outcome}]` (worst outcome per node over the latest gradings, existing nodes, by id), `lowConfidenceGradings`, `applied`, `goalReached`.
- `study`: `documentId`/`title` (null when no document is bound), `pagesRead` (distinct positive integers, by the assisted-study reading rule over the window's visits), `learnerMessages`, `nodesLinked` (distinct nodes linked to the document in the window), `cardsCreated` (cards created in the window on those nodes).
- A session whose facts show nothing (no review, slide, concept, exercise, message, verdict, grading, page or link) gets no entry.

## Weekly window and weekly facts

`weeklyWindow(now, weekday, hour)` (LOCAL time; `weekday` 0 = Sunday .. 6; invalid values fall back to Sunday 18): `end` = the latest instant at or before `now` that is that weekday at that hour; `start` = `end` minus 7 calendar days; `weekOf` = local date of `start`; `days` = the local calendar days touched by `[start, end)`, clipped to it (7 or 8). Only the latest window is ever produced.

`weekly` facts: `weekOf`, `windowStart`, `windowEnd`, `budgetSec`; `days[{date,reviews,reviewSec}]` (fixed/dialogic reviews of existing nodes, half-open window); `backlog{dueAtStart,dueAtEnd,trend}` (active-scope nodes with a review state whose `due` is at or before each end; `trend` `up`/`down`/`flat`); `retention{reviews,recalled,rate}` (fixed/dialogic reviews in the window of nodes already reviewed before, rating >= 2 recalled; `rate` null if none, 3 decimals); `goals[{goalId,title,status,total,solidAtStart,solidAtEnd,delta}]` (goals not paused; scope nodes that exist; solid = recall >= 0.85 at each end); `trust{total,sourced,contested,refuted,unverified}` (active scope); `sessions` (count of session debriefs per kind written in the window, each session once). The review events are replayed in TIME order (stable), so a ledger whose file order is not chronological does not break the replay. A week with no reviews, no debriefed session and no active goal gets no entry.

## Commentary and cost

The agent submits `observations`, `stateOfLearning`, `critique`, `suggestion` (each non-blank, at most 2500 characters); the stored Markdown is `## Observations`, `## State of learning`, `## Critique`, `## Suggestion for the next session`, in that order, each followed by its text. A part that opens a heading, repeats a section header, or leaves a code fence unclosed is refused and never stored (the writer retries it as a failure). The model has no tool but the submission. Spend is recorded in `cost.jsonl` with `source` `debrief`; the commentary is attempted only while the shared daily ceiling allows (the `source` list of the `cost.jsonl` section also includes `node-knowledge` and `debrief`).

## Provider limits

A subscription plan, a rate limit or an overloaded provider refuses a call without spending USD, so the daily ceiling never trips. Background work therefore also pauses on the provider's own limit (process memory only; a restart retries once).

- **Detection (one place per engine):** every background engine is built by `observedEngine` (`src/server/ext/provider-pause.ts`), which wraps the engine's stream function with `withProviderLimitObserver` (`src/agent/ext/limit-aware-engine.ts`). Wrapped roots: the researcher engine (research cycle and watch classifier, `research-live.ts`), the verification engine (`verification.ts`), the debrief writer (`debrief-live.ts`), the teacher engine (study, lectures and practice, `study-engine.ts`) and the explanation writer (`node-knowledge-live.ts`). Interactive chat engines are not wrapped. A call that ends in an error whose text is a limit is observed once; a completed call is a success.
- **Classification (`isProviderLimitMessage`, `src/core/ext/provider-limit.ts`):** case-insensitive. True for usage limit reached or exceeded, rate limit (any of `rate limit`, `rate_limit`, `rate-limit`), `subscription_sharing_usage_limit_exceeded`, `429`, `quota`, `too many requests`, `overloaded`, `over capacity` / `at capacity` / `capacity exceeded`, and `limit reached` or `limit exceeded` when the text names no token, context, prompt, output, length, window or input. False for context-length, invalid-key, model-not-found and aborted texts.
- **Pause:** the first hit pauses for 30 minutes; each consecutive hit doubles it, capped at 6 hours. A reset hint in the provider's text replaces the backoff: `retry-after: N` (seconds), `try again in N minutes|hours|seconds`, or `resets H:MM am|pm` (the next such local time); the hint is clamped to [1 minute, 24 hours]. A limit seen while a pause holds is not a new hit. A completed call resets the hit count; the pause in force is kept. The gate reopens at exactly the pause end instant.
- **Gate:** `CostGate.allowed()` is false while the pause holds or the ceiling is spent. `CostGate.reason()` returns `provider-limit` (checked first, because it is transient) or `ceiling` or null. Every gated caller inherits the pause through `liveCostGate` and the verification gate, which are the same object.
- **Per path:**
  - Research cycle: the gap or classification that hit the limit is not logged as failed (its spend is kept if above zero); the cycle stops with `stoppedBy: "provider-limit"`; `tick()` starts nothing and `start()` answers `provider-limit` while paused.
  - Verification batch: nodes of the batch and the rest stay unverified (`VerifyReport.providerLimited`); no `check_failed` event is written.
  - Debrief: `finish` returns `deferred` with reason `provider-limit`; no attempt is counted, nothing is stored (no `nullReason`), the session stays pending. A sweep stops at the first such outcome and reports `providerLimited: true`; the weekly synthesis waits too.
  - Study complete: the run stops before the batch; no `pages_processed` event; the result carries `providerLimited: true`. Draft approval fails with the fixed text and imports nothing.
  - Lectures: a chapter ends `stopped_provider`; a book run whose chapters stopped that way carries the fixed text as its error.
  - Practice exercises: refused with HTTP 429 and the fixed text.
  - Explanations: the gate is closed, so the run reports `ceilingReached` (not distinguished in its result).
  - Research console chat: the refusal text is the fixed provider text instead of the ceiling text.
- **Visibility:** `GET /api/ext/research/cycle` (the research status) always carries `providerPausedUntil` (ISO or null). `GET /api/ext/debriefs` carries `providerPausedUntil` only while paused. The research page, the journal page, the study page and the trust badge show a fixed sentence. Nothing else exposes the pause.
- **Never stored or returned:** the raw provider text. Ledgers, cycle logs, status and HTTP responses carry only the fixed texts above and the pause end time.

## MCP server (read-only, stdio)

Process: `LH_DATA_DIR=<data directory> npx tsx scripts/ext-mcp.ts [--knowledge-only]`, started by the client, speaking MCP (JSON-RPC 2.0, newline-delimited) over stdin/stdout. Stdout carries only protocol; diagnostics go to stderr. The server reads `ext/*.jsonl`, `ext/lectures/*/lecture.json` and `graph/*.jsonl`; it never writes, creates, locks or stamps anything; it opens no socket and calls no model. Corrupt or torn ledger lines are skipped. A `format.json` stamp newer than the build makes every tool fail with `data_newer_than_build`. A request line above 256 KiB ends the session: the process exits with code 0 and the client restarts it. A closed stdout (the client went away) also ends the process quietly, with nothing on stderr.

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
| `data_too_large` | a ledger file exceeds the 128 MiB read ceiling, or `list_lectures` finds the lecture files together above 32 MiB (`get_node` never returns this: see below) |
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
| lecture files read by one `list_lectures` | 32 MiB together |
| lecture files parsed by one `get_node` (index build) | 32 MiB together; when reached, `citingLectures` is null and `citingLecturesOmitted` is true; the next call resumes |
| each array of a lecture outline (slides, exercises, cited nodes) | 24 KiB, then truncated |
| response | 128 KiB |
| future day for `get_daily_plan` | 30 days |

### Knowledge group

`search_nodes` input: `query` (string, required; NFC-normalised before the length limit and the match, and the stored name, statement and aliases are compared in NFC too, so composed and decomposed accents give the same result), `limit` (integer 1..50), `trust` (`unverified|sourced|contested|refuted`), `goalId` (string; needs study state). Output: `{query, items[{id, name, statement, trust}], count, truncated}`.

`get_node` input: `id`. Output: `{id, name, statement, aliases(page), trust{level, checkedAt, evidence(page)}, explanation{state, noSourceContext, form, version, author, body, pendingProposal}, arguments(page of {premises(page)}), conclusions(page), citingLectures(page or null), citingLecturesOmitted(boolean), citingLecturesOmittedReason(fixed text or null), studyState, cardCount, review{dueAt, recallProbability, reps, pinned, retired}|null, reviewUnavailable, goals(page)}`. Under `--knowledge-only` the last five fields are absent and `studyState` is `"disabled"`. `explanation.state` says when the text is stale; `noSourceContext` is true when it was written without source context. Evidence carries a source label, never a local path, query string or credential. `citingLectures` comes from an in-memory index of the lecture files, built on first use and kept for the life of the process: each call re-stats the lecture files, parses only new or changed ones (a file is identified by mtime, size and inode) and forgets deleted ones. It never writes to disk. When one call would parse more than the 32 MiB bound, `citingLectures` is null, `citingLecturesOmitted` is true and the reason is the fixed sentence in the server, with no error; repeated calls parse further until the index is complete, so the answer is complete again after a few calls. A lecture that is invalid, over 4 MiB, a non-file (FIFO, device, symlink to one) or stored under another id is never cited, and never fails the call.

`get_neighbors` input: `id`, `depth` (1 or 2). Output: `{center, depth, nodes(page of {id, name, depth, trust}), edges(page of {from, to})}`.

`list_lectures` input: `chapter` (integer chapter number). Output: page of `{id, title, bookTitle, chapter, order, createdAt, slideCount, exerciseCount, citedNodeCount}`.

`get_lecture` input: `id`. Output: outline `{id, title, bookTitle, chapter, order, summary, createdAt, slides(page of {id, heading, blockCount, nodeIds(page)}), exercises(page of {blockId, slideId, seconds, prompt, nodeIds}), citedNodes(page)}`. A slide's `nodeIds` are the nodes cited by its blocks followed by the node links written in its own text, deduplicated and capped at 20 (`citedNodes` is the lecture-wide set of both kinds). Narration text is never returned. Each outline array (slides, exercises, citedNodes) is fitted to 24 KiB; a page whose items were dropped says `truncated: true`, so a maximum-size lecture is answered, never refused.

### Study-state group (disabled by `--knowledge-only`)

`list_goals` input: `status` (`active|paused|reached`). No limit argument: the list is at most 50 goals and fitted to the 96 KiB list budget, with `truncated` set when it cuts. Output: page of `{id, title, status, priority, origin, createdAt, targetCount, scopeSize, solidNodes, solidShare, ready}`.

`get_goal` input: `id`. Output: `{id, title, status, priority, origin, createdAt, updatedAt, desiredRetention, targets(page), scope{size, solid, solidShare, ready, byTrust}, due{dueNow, unseen, scheduled}, exerciseSet{state: none|in_progress|complete|applied, exercises, graded}}`. Exercise prompts and reference solutions are never returned.

`get_daily_plan` input: `date` (`YYYY-MM-DD`, server local zone; today or up to 30 days ahead). Output: `{date, asOf, timezone, budgetMinutes, spentMinutes, remainingMinutes, due{fixed, dialogic, total}, newItems{fixed, dialogic, total}, planned{total, estimatedMinutes}, newCardQuota, capacity, deferred, needsCard, exerciseSetPending, pendingGoals(page)}`. The numbers come from the app's own plan function over the same data, time and default parameters. A future date is planned as of its last millisecond with nothing spent.

`research_status` input: none. Output: `{frontier(page of {id, scope, mark, maxDepth, note, author, at}), inbox{pending, approved, rejected, activated, total}, lastCycle{cycleId, trigger, startedAt, endedAt, stoppedBy, gaps, nodesAdded, watch}|null}`. Source locators, rationales, error texts, steering messages and cost figures are never returned.

`get_recent_debriefs` input: `limit`, `since` (ISO-8601 instant with a time zone), `kind` (`review|lecture|office_hours|study|exercises|weekly`). Output: `{debriefs(page of {id, kind, sessionKind, weekOf, at, facts, commentary, nullReason}), latestWeekly}`. Facts are returned when small; facts above 4 KiB are replaced by `{kind, omitted}`.

`list_documents` input: none. Output: page of `{id, title, pageCount, registeredAt, lastPage, readPages, readShare}`. No file path and no chat id.

## `session-notes.json` (configuration map, session study notes)

One JSON object, rewritten atomically on every change: `{ "<chatId>": { "text", "updatedAt", "edited" } }`.

- At most one note per chat (REQ-sn-01). `text` is 1 to 1000 characters (code points), trimmed, with `\n` line endings. `updatedAt` is ISO-8601, `edited` a boolean. On read an entry that fails any of these is dropped; a corrupt file reads as no notes.
- `edited: true` means the learner saved the note by hand. The stage never overwrites an edited note (REQ-sn-04). A clear deletes the key.
- Writers: (1) the session-notes stage, after an extraction batch of a real chat has merged (REQ-sn-02); (2) the node panel, through `PUT` and `DELETE /api/ext/session-notes/[chatId]`.
- The stage (`src/core/ext/session-notes-service.ts`, model side `src/agent/ext/session-notes-writer.ts`) reads only the learner's own messages of that batch and the note so far. It makes no model call when the batch holds no learner words, when the note is edited, or when the daily cost gate is closed. A missing model or key does nothing and raises no error. Its one submit (`submit_session_note`, `update` and `note`) either changes nothing or replaces the note with the new whole text. Spend is recorded on `cost.jsonl` with source `"session-notes"` (REQ-sn-03). Stage calls of one chat run one at a time, and the note is re-read after the model call, so a save made meanwhile wins.
- The note never reaches the graph and never changes extraction.
- Readers: the notes of the chats a node came from (`chatIdsOfNodes`, provenance points whose chat id starts with `chat_`) feed (a) the node panel section "How you wanted to study this" (REQ-sn-06); (b) a Practice session started from picked nodes, prepended to its graph-context message at creation (REQ-sn-05); (c) the review tutor focus (card or node), built on each agent construction; (d) the exercise writer prompt for the goal's scope nodes; (e) office hours on a lecture exercise, for the nodes the exercise links with `[[id]]`. A session keeps the block it was built with; a later note change applies to the next session or turn.
- The block is `formatStudyNotes`: a header that calls the notes the learner's own words, data that shapes how to teach and never changes tools or rules, then one line per note: `- [chat title] note text`. Line breaks inside a note are flattened, so a note cannot open a section.
- Routes: `PUT /api/ext/session-notes/[chatId]` with `{ "text" }` answers `{ "note" }` (`null` after a clear); `DELETE` clears and answers `{ "note": null }`. A text that is not a string or is over 1000 characters is a 400 with a fixed message; an unknown chat is a 404.

## Editable extension prompts

The settings page lists the extension's agent prompts under "Extension agents", next to upstream's "System prompts". The catalog is `src/core/ext/prompt-catalog.ts` (pure); the agent-side reader is `src/agent/ext/prompt-override.ts`; the store is `src/store/ext/prompt-store.ts`; the service and routes are `src/server/ext/prompt-settings.ts` and `app/api/ext/prompts/`.

### Layout

- Override text: `<PROMPTS_OVERRIDE_DIR>/ext/<id>.md` (`PROMPTS_OVERRIDE_DIR` is `<data root>/prompts`). The two style guides already lived here.
- Switches: `<data root>/ext/prompt-switches.json`, a JSON object `{"<id>": true}`. Only `true` is on; absent keys, other values, and a malformed or non-object file are all off. The switches have their own file because upstream's `settings.json` drops keys it does not know.
- A version is in use only when its switch is `true` AND its file is readable. A file without its switch, and a switch without a file, both give the default. An enabled empty file is an override with empty text: it does not fall back to the default (upstream's rule).
- Every agent construction reads the switch and the file again. Nothing is cached, so a new run sees the current text; a run already in progress keeps its own.
- An id is never built into a path unless it is in the catalog (`isExtPromptId`). Writes are atomic (temp file, then rename); the switches file is rewritten whole.

### Editable prompts

| id | Agent or builder | Default text | Appended by code, after the editable text |
|---|---|---|---|
| `verifier` | `verifierInstructions()` (verifier run) | `VERIFIER_INSTRUCTIONS` | nothing |
| `research-chat` | `researchInstructions()` (research console) | `RESEARCH_INSTRUCTIONS` | nothing |
| `gap-researcher` | `gapResearchInstructions()` (gap research run) | `GAP_RESEARCH_INSTRUCTIONS` | nothing |
| `watch-classifier` | `watchClassifyInstructions()` (classify call) | `WATCH_CLASSIFY_INSTRUCTIONS` | nothing |
| `review-daily` | `reviewDailyInstructions()` (daily review) | `REVIEW_INSTRUCTIONS` | nothing |
| `review-card` | `focusedReviewInstructions(focus)` (card tutor) | `REVIEW_CARD_BODY` | the card block: node id, name, statement, question, answer |
| `review-node` | `focusedNodeReviewInstructions(focus)` (node tutor) | `REVIEW_NODE_BODY` | the node block: node id, name, statement, explanation |
| `study-assistant` | `studyPrompt(ctx)` (study session, per turn) | `STUDY_INSTRUCTIONS` | the document title and page count, the current page, the other pages in view, the selection |
| `office-hours` | `officeHoursInstructions(focus)` (office hours; one id for the base and the exercise focus) | `OFFICE_HOURS_INSTRUCTIONS` | the exercise in focus, inside `<exercise>` tags |
| `debrief-style` | `debriefStyle()` (debrief writer) | `src/agent/ext/prompts/debrief-style.md` | the four-part rules and the submit tool (`DEBRIEF_RULES`) |
| `explanation-style` | `explanationStyle()` (explanation writer) | `src/agent/ext/prompts/explanation-style.md` | the structure and `[[id]]` link rules (`STRUCTURE_RULES`) |
| `session-notes` | `sessionNoteInstructions()` (session note proposal, after an extraction batch) | `SESSION_NOTE_INSTRUCTIONS` | the note so far and the learner's messages of the batch, one line each |

The focus variants keep their per-run data out of the editable text: the body is resolved first and the data block is appended after it, so an edit cannot drop the card, the node, the document or the exercise. The data block sits after the body in the default too, so the default text of `review-card` and `review-node` is the body alone (the card or node block follows it).

### Not editable, on purpose

These prompts interleave their per-run data with their output schema, or their output contract is checked in code. A text edit could drop the data or break the contract, so they stay in code: the lecture outline, lecture and chapter-detection prompts (`src/agent/ext/lecture/`), the study card and page drafts (`src/agent/ext/study/draft-writer.ts`), the exercise writer (`src/agent/ext/practice/exercise-writer.ts`), and the debrief and explanation prompt builders.

### Routes

- `GET /api/ext/prompts` returns an array, in catalog order, of `{id, label, description, warning, defaultText, overrideText, enabled}`. `overrideText` is the saved file's text or `null`; `enabled` is true only when the switch is on and the file exists.
- `PUT /api/ext/prompts/[id]`, body `{text?: string, enabled?: boolean}` with at least one key and no other keys. Writes the text first, then the switch. Returns the view. 400 for a body of the wrong shape, a text longer than 20000 characters, or turning a switch on with no version to use. 404 for an id outside the catalog. 413 for a body over 256 KiB. An empty text is allowed.
- `DELETE /api/ext/prompts/[id]` removes the file and clears the switch (the switch goes first, so a crash leaves "off + file"). Idempotent. Returns `{id, deleted: true, switchCleared}`. 404 for an unknown id.
- Errors are fixed messages; no input is echoed.

### Migration note

Before this section, a file in `ext/debrief-style.md` or `ext/explanation-style.md` took effect by its presence alone. Those two files now need their switch on, like every other editable prompt.
