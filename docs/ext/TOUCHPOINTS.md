# Upstream touchpoints

The closed list of files of the LearnHarness fork that this extension edits. Any other
upstream file must stay byte-identical to `upstream/main` (REQ-int-04). Check with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!components/ext/**' ':!scripts/ext-*'
```

| File | Why | Added in |
|---|---|---|
| `package.json` | `allowScripts` entries for `fsevents`, `protobufjs`, `unrs-resolver` | Foundation |
| `src/server/chat-handler.ts` | wrap the exported `extraction` pipeline with `withPostMerge(…, verifyAfterMerge)` (post-merge verification, REQ-src-13) | Source verification |
| `src/server/index.ts` | barrel line `export * from "./ext/index.ts";` so `app/` routes can reach ext server functions | Source verification |
| `app/api/chats/route.ts` | tag picked propositions with their trust level in the graph-context message (REQ-src-15) | Source verification |
| `components/graph-view.tsx` | mount `<TrustBadge />` under the node statement in the detail card (REQ-src-15) | Source verification |
| `package.json`, `package-lock.json` | `ts-fsrs` 5.4.2 | Personal layer |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"review"` | Personal layer |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"review"` | Personal layer |
| `src/store/chats.ts` | `createChat` stamps kind `"review"` | Personal layer |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.instructions?` replaces the composed prompt | Personal layer |
| `src/server/chat-handler.ts` | imports `isPracticeLike` (defined in core), the review agent branch, two imports | Personal layer |
| `app/chat/[id]/page.tsx` | passes `"teach"` to `Chat` for a `review` session | Personal layer |
| `src/server/index.ts` | barrel line `export * from "./ext/index.ts";` (shared with other plans) | Personal layer |
| `src/core/index.ts` | one line: `export * from "./ext/index.ts"` (browser-safe ext barrel) | Node knowledge |
| `app/layout.tsx` | mounts `<NodePanelHost />` | Node knowledge |
| `components/graph-view.tsx` | "Open node panel" button in the node detail card | Node knowledge |
| `components/graph-context-card.tsx` | proposition name opens the node panel | Node knowledge |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"office_hours"` (office-hours sessions) | Lectures and office hours |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"office_hours"` | Lectures and office hours |
| `src/store/chats.ts` | `createChat` type widened to the same kinds | Lectures and office hours |
| `src/server/chat-handler.ts` | imports `isPracticeLike` (defined in core, also accepts `office_hours`); the office-hours agent branch; two imports | Lectures and office hours |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for an `office_hours` session | Lectures and office hours |
| `src/core/ext/index.ts` | appended exports for the lecture player | Lectures |
| `src/server/ext/panel-providers.ts` | `lecturesCiting` member (lecture back-links in a node's panel) | Lectures |
| `src/core/source-organization.ts` | `chainSourceDirectory` hides every practice-like session (office hours, review) via `isPracticeLike` | Practice-like sessions |
| `components/minimal-home.tsx` | home counts practice-like sessions as practice | Practice-like sessions |
| `components/chain-table.tsx` | chain filter hides sources of practice-like sessions | Practice-like sessions |
| `src/agent/subagents/pi-run.ts` | `SubagentRunOptions.onAgent?`, one call after the `Agent` is built, so a running research cycle can be steered (REQ-rs-16) | Research loop |

Planned (not yet touched): the PDF viewer
and MCP dependencies in `package.json`.

Not touched on purpose: `config.ts` (paths are derived in `src/store/ext/paths.ts`) and
`src/server/stores.ts` (the extension has its own root, `src/server/ext/stores.ts`).
