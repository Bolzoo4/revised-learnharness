# Upstream touchpoints

The closed list of files of the LearnHarness fork that this extension edits. Any other
upstream file must stay byte-identical to `upstream/main` (REQ-int-04). Check with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**'
```

| File | Why | Added in |
|---|---|---|
| `package.json` | `allowScripts` entries for `fsevents`, `protobufjs`, `unrs-resolver` | Foundation |

Planned (not yet touched): `src/server/chat-handler.ts` (post-extraction verification hook),
the `kind` union of `ChatRecord` (`src/core/contracts/chat.ts`), `src/server/index.ts` and
`src/core/index.ts` (barrel exports when routes and UI arrive), `package.json` (FSRS, PDF viewer
and MCP dependencies).

Not touched on purpose: `config.ts` (paths are derived in `src/store/ext/paths.ts`) and
`src/server/stores.ts` (the extension has its own root, `src/server/ext/stores.ts`).
