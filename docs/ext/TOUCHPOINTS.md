# Upstream touchpoints

The closed list of files of the LearnHarness fork that this extension edits. Any other
upstream file must stay byte-identical to `upstream/main` (REQ-int-04). Check with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**'
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
| `src/server/chat-handler.ts` | `isPracticeLike` helper, the review agent branch, two imports | Personal layer |
| `app/chat/[id]/page.tsx` | passes `"teach"` to `Chat` for a `review` session | Personal layer |
| `src/server/index.ts` | barrel line `export * from "./ext/index.ts";` (shared with other plans) | Personal layer |

Planned (not yet touched): `src/core/index.ts` (barrel exports when routes and UI arrive), and the PDF viewer
and MCP dependencies in `package.json`.

Not touched on purpose: `config.ts` (paths are derived in `src/store/ext/paths.ts`) and
`src/server/stores.ts` (the extension has its own root, `src/server/ext/stores.ts`).
