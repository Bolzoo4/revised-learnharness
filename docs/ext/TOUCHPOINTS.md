# Upstream touchpoints

The closed list of files of the LearnHarness fork that this extension edits. Any other
upstream file must stay byte-identical to `upstream/main` (REQ-int-04). Check with:

```bash
git diff --stat upstream/main -- . ':!src/**/ext/**' ':!tests/ext-*' ':!tests/helpers/**' ':!docs/ext/**' ':!docs/superpowers/**' ':!app/api/ext/**' ':!app/lectures/**' ':!app/practice/**' ':!app/journal/**' ':!app/study/**' ':!app/research/**' ':!components/ext/**' ':!scripts/ext-*'
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
| `components/minimal-home.tsx` | home counts sessions with `sessionMatchesFilter`, as the sidebar lists them: study and research sessions are not counted, review and office hours count as practice (the earlier row counted all practice-like kinds as practice) | Practice-like sessions |
| `components/chain-table.tsx` | chain filter hides sources of practice-like sessions | Practice-like sessions |
| `src/agent/subagents/pi-run.ts` | `SubagentRunOptions.onAgent?`, one call after the `Agent` is built, so a running research cycle can be steered (REQ-rs-16) | Research loop |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"research"` (research sessions) | Research loop |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"research"` | Research loop |
| `src/store/chats.ts` | `createChat` type widened to the same kinds | Research loop |
| `src/server/chat-handler.ts` | the research agent branch (after review) and its `researchToolContext` / `createResearchAgent` imports; the research turn is kept out of compaction (its summary spend is not on the daily gate, REQ-cost-01: two guards, the call and the kick factory) | Research loop |
| `app/chat/[id]/page.tsx` | passes `"research"` to `Chat` for a `research` session (the coverage ring hides for it) | Research loop |
| `src/core/ext/practice/session-kind.ts` | `isPracticeLike` also covers `research`: the research session is never extracted into the graph (REQ-res-03), shared with the home counts and chain filters (side effect: research sessions count as practice there, see the report) | Research loop |
| `src/core/contracts/chat.ts` | `ChatKind` gains `"study"` | Assisted study |
| `src/core/ports.ts` | `ChatStore.createChat` accepts kind `"study"` | Assisted study |
| `src/store/chats.ts` | `createChat` type widened to the same kinds | Assisted study |
| `src/server/chat-handler.ts` | imports `createStudyAgent` and `studyService`; the study agent branch | Assisted study |
| `app/chat/[id]/page.tsx` | pass `"teach"` to `Chat` for a `study` session | Assisted study |
| `components/chat.tsx` | optional `transformOutgoing` prop, applied on send and on steer (the study view prepends the page and selection) | Assisted study |
| `components/ext/node-panel-view.tsx` | "Source in your documents" section | Assisted study |
| `src/agent/subagents/extraction.ts` | `runExtraction` returns an empty run for a practice-like chat (research is never extracted, REQ-res-03) | Research review fixes |
| `app/api/graph/coverage/extract/route.ts` | answers 400 (`HttpError`, fixed message) for a practice-like session | Research review fixes |
| `components/chat.tsx` | `kind` prop gains `"research"`; the coverage ring hides for a research session, as for practice | Research review fixes |
| `src/server/chat-handler.ts` | research turn refused with a fixed 409 when the session is over the compaction threshold (research is never compacted, REQ-cost-01) | Research review fixes |
| `instrumentation.ts` (new root file) | `register()` starts the debrief scheduler (REQ-deb-01, REQ-deb-02) and the research loop's scheduler (REQ-rs-01), each guarded so a failure cannot crash the server; inert under `NODE_ENV=test` | Session debriefs, Research loop |
| `components/sidebar.tsx` | one import of `ExtNav` and one `<ExtNav />` line under the Teaching/Practice create buttons: the sidebar entries Review, Lectures, Study, Research, Journal (REQ-mode-01 navigation) | Navigation |
| `components/sidebar.tsx` | the session filter uses `sessionMatchesFilter` (core barrel): review and office-hours sessions list under "Practice", study sessions only under "All", research sessions nowhere (not even "All") | Navigation fixes |
| `components/settings/agent-section.tsx` | one import of `ExtPromptsSection` and one `<ExtPromptsSection />` line after the System prompts group: the "Extension agents" settings (editable extension prompts, docs/ext/CONTRACTS.md) | Editable extension prompts |
| `components/activity-dock.tsx` | the "Open session" link renders only when the id is a chat id (`chat_…`): an extraction of an imported source carries the source id, which has no session and led to a 404 | Navigation fixes |
| `app/not-found.tsx` (new root file) | a 404 page with a link home (the default one has no way back inside the desktop app) | Navigation fixes |
| `components/graph-view.tsx` | one import of `NodeMarkControl` and one `<NodeMarkControl />` line under `<TrustBadge />` in the node detail card: the node's research mark (expand / hold / stop / clear) (REQ-rs-18) | Research page rework |
| `src/agent/subagents/extraction.ts` | `ExtractionPipelineDeps.onBatchMerged?`, one call after a chat batch merges, with that batch's messages (session notes read the learner's words, REQ-sn-02) | Session study notes |
| `src/server/chat-handler.ts` | imports `sessionNotesAfterBatch` from the ext barrel and one `onBatchMerged` line in the extraction pipeline deps | Session study notes |
| `app/api/chats/route.ts` | the Practice session's graph-context message goes through `withStudyNotes` (the picked nodes' study preferences ahead of the context, REQ-sn-05) | Session study notes |
| `app/layout.tsx` | the theme bootstrap `<script>` in `<head>` (a cached light mode drops the `dark` class before paint) and `suppressHydrationWarning` on `<html>` | Light theme |
| `app/globals.css` | the light palette (`:root:not(.dark)`), the `--lh-hard-ink` token, light overrides of the white strokes and borders and of the status text colours | Light theme |
| `components/settings/appearance.tsx` | the provider sets the `dark` class on `<html>` (layout effect, once the saved record has loaded) and caches the mode; a stored background applies in dark only | Light theme |
| `components/settings/appearance-section.tsx` | Mode is a live Dark / Light select (was disabled); the background row dims in light | Light theme |
| `components/graph-canvas.ts` | `CanvasColors.regionLightness`: the cluster label lightness per mode | Light theme |
| `components/graph-view.tsx` | resolves `regionLightness` per mode and re-feeds the canvas when the mode changes | Light theme |
| `components/mermaid-render.ts` | `mermaidThemeFor(light)`: diagrams render in mermaid's default theme on the light page | Light theme |
| `components/confidence-rail.tsx` | the track and the ticks use the page tokens instead of `#141414` and `rgba(230,…)` | Light theme |
| `components/lh-mark.tsx` | the logo's white fills use `--lh-hard-ink` | Light theme |
| `tests/render-settings.test.tsx` | the Mode assertion pins the live select (it pinned the disabled "Coming soon" control) | Light theme |
| `src/core/contracts/jobs.ts` | `JobKind` gains `"video"`; `VideoToolInput` and `VideoResult`; the result unions, the failure shape, and the steer and abort texts gain video | Video (Manim) |
| `src/core/pending.ts` | `TOGGLEABLE_TOOLS` gains `"video"` (the settings switch) | Video (Manim) |
| `src/agent/subagents/runner.ts` | the video runner `runVideoJob` (kind→role `video` = `demoBuilder`, the kind table, the refusal shape), `JobRunnerDeps.videoRender?`, the widened input union | Video (Manim) |
| `src/agent/tools.ts` | `createTeacherTools` spreads `videoJobTools(...)`, the one registration point (teach phase only); the spawn types accept `VideoInput`; one import | Video (Manim) |
| `src/server/chat-handler.ts` | one import of `renderJobVideo` and the job runner's `videoRender` dependency | Video (Manim) |
| `src/store/jobs.ts` | `deleteJobsForChat` also removes the job's `.mp4` (`removeJobVideo`, store/ext/job-video.ts); one import | Video (Manim) |
| `components/artifacts/index.ts` | the `video` renderer (`VideoCard`) in the artifact registry; one import | Video (Manim) |
| `components/artifacts/steer-card.tsx` | the `video` case renders `VideoOutputCard`; one import | Video (Manim) |
| `components/artifacts/dispatch-card.tsx` | `KIND_LABEL` gains `video` ("Video builder") | Video (Manim) |
| `components/activity-dock.tsx` | `KIND_ICON` gains `video`; the dock label "Video builder"; one import (`FilmIcon`) | Video (Manim) |
| `components/settings/agent-section.tsx` | `TOGGLE_TOOLS` gains `"video"` (the Tool · video switch) | Video (Manim) |
| `tests/question-tools.test.ts` | the pinned `TOGGLEABLE_TOOLS` list includes `video` | Video (Manim) |
| `tests/tool-toggles-bridge.test.ts` | the pinned supported-tools message includes `video` | Video (Manim) |

Session debriefs add one upstream file to the closed list: `instrumentation.ts` (the row above, shared with the Research loop). Everything else they touch, including `src/server/ext/stores.ts` and `src/server/ext/index.ts`, is an extension file.

The study pages (`app/study/**`) and the research page (`app/research/**`) are extension pages: they sit under the exclusions in the check command above, as `app/journal/**` does.

Completed: All five child specs (Source Verification, Personal Layer, Node Knowledge, Lectures & Office Hours, and Autonomous Research Loop) are implemented.

Planned (not yet touched): the PDF viewer.

MCP server: no touchpoint. The entry is `scripts/ext-mcp.ts` (inside the `scripts/ext-*`
exclusion above) and its code lives under `src/**/ext/**`. `@modelcontextprotocol/sdk` 1.32.1 is
already an upstream dependency, so `package.json` is unchanged; there is deliberately no `npm run`
script for the server (it would edit `package.json`): launch it with
`LH_DATA_DIR=<data directory> npx tsx scripts/ext-mcp.ts [--knowledge-only]`.
`src/server/ext/personal-layer.ts` re-exports `startOfLocalDay` from `src/core/ext/local-day.ts`
(both under the exclusion).

Not touched on purpose: `config.ts` (paths are derived in `src/store/ext/paths.ts`) and
`src/server/stores.ts` (the extension has its own root, `src/server/ext/stores.ts`).
