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
