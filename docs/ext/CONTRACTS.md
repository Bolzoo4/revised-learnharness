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
