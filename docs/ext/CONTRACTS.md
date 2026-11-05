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
