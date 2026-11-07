# Revised LearnHarness

**An unofficial extension fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist, maintained by Riccardo Bolzonello.** It is not endorsed by or affiliated with the original project. "Revised" only says that this fork builds on top of it; everything below the line is the original README. Licence: AGPL-3.0, the original copyright notices are kept.

LearnHarness teaches with an agent and a knowledge graph. This fork turns it into a longer-running study system: spaced repetition, checked sources, narrated lectures, exam training and a background research loop. Its three starting points were personal tools (a flashcard app with FSRS, a PDF lecture pipeline, a knowledge-graph research prototype) that were merged here instead of growing apart.

## What is added

Everything below is new; the original agents, graph and extraction pipeline are unchanged apart from the listed touchpoints. "Tested" means automated tests with fake models; "tried" means used by hand in the installed macOS app; nothing has had an end-to-end run with real models yet unless it says so.

| Addition | Where in the app | Design | Status |
|---|---|---|---|
| Spaced repetition (FSRS per node), daily plan, flashcards, tutor from a card or node | Review | [personal layer](docs/ext/design/specs/2026-11-04-personal-layer-spaced-repetition-design.md) | tested, tried |
| Trust levels for propositions (`unverified`, `sourced`, `contested`, `refuted`), quotations confirmed by code | node card, node panel | [source verification](docs/ext/design/specs/2026-11-04-source-verification-design.md) | tested, tried |
| Node panel: explanation, trust, neighbours, citing lectures, cards, review state | any view | [node knowledge](docs/ext/design/specs/2026-11-04-node-knowledge-design.md) | tested, tried |
| Narrated lectures, office hours, graded exercises; a chapter's nodes join the graph only after its lectures are written | Lectures | [lectures](docs/ext/design/specs/2026-11-04-lecture-office-hours-exercises-design.md) | tested, tried |
| PDF reading next to a chat that knows the page; cards from questions, selections and answers | Study | [assisted study](docs/ext/design/specs/2026-11-04-assisted-study-design.md) | tested, tried |
| Exam collections, splitting exams into exercises, guided solving with material first and web second, solution status | Exams | [exam training](docs/ext/design/specs/2026-11-07-exam-training-design.md) | tested; splitter not run with a real model |
| Background research loop: marks from the graph, research goal, progress reports, notes | Research | [research loop](docs/ext/design/specs/2026-11-04-research-loop-design.md) | tested |
| Interactive demos, drawings and Manim videos in teaching, review, study, office hours, lectures | in chat | [video](docs/ext/design/specs/2026-11-07-manim-video-design.md) | tested; render tried on one Mac |
| Study notes per session, passed to the sessions that work on its nodes | node panel | [session notes](docs/ext/design/specs/2026-11-07-session-notes-design.md) | tested, tried |
| Debriefs and journal | Journal | [debriefs](docs/ext/design/specs/2026-11-04-session-debriefs-design.md) | tested, tried |
| Read-only MCP server for other local agents | `scripts/ext-mcp.ts` | [MCP](docs/ext/design/specs/2026-11-04-external-access-mcp-design.md) | tested |
| Daily cost gate and provider usage-limit pauses | all background work | [umbrella spec](docs/ext/design/specs/2026-11-04-learning-platform-integration-design.md) | tested |
| Light theme | Settings, Appearance | commit message `feat(ext): light theme` | tested, tried |

To see exactly which original files were touched and why, read [`docs/ext/TOUCHPOINTS.md`](docs/ext/TOUCHPOINTS.md); the file formats are in [`docs/ext/CONTRACTS.md`](docs/ext/CONTRACTS.md); the overview written for the original author is [`docs/ext/OVERVIEW.md`](docs/ext/OVERVIEW.md).

## How it is built

- All extension code lives under `src/*/ext/`, `components/ext/`, `app/api/ext/` and the new pages (`app/review`, `app/lectures`, `app/study`, `app/exams`, `app/research`, `app/journal`).
- Upstream files are edited only at a closed list of touchpoints, one row each with the reason, in [`docs/ext/TOUCHPOINTS.md`](docs/ext/TOUCHPOINTS.md). File formats and invariants are in [`docs/ext/CONTRACTS.md`](docs/ext/CONTRACTS.md).
- The layering follows upstream: pure code in `core`, store adapters, agents that do not import stores, composition roots in `server`.
- Every feature has a written design with numbered requirements (`REQ-<topic>-NN`) in [`docs/ext/design/specs/`](docs/ext/design/specs/) and an implementation plan in [`docs/ext/design/plans/`](docs/ext/design/plans/); the file formats are the contracts in `docs/ext/CONTRACTS.md`.

## Run it

Same as upstream: see [`docs/getting-started.md`](docs/getting-started.md). Extension tests: `NODE_ENV=test npx tsx --test tests/ext-*.test.ts tests/ext-*.test.tsx`. To ship video in a packaged macOS app, run `scripts/manim-runtime/build.sh` first ([`docs/ext/MANIM-RUNTIME.md`](docs/ext/MANIM-RUNTIME.md)); without the runtime the video tool is simply not offered.

## Status, honestly

The extension is tested with fakes (more than 3,000 extension tests, typecheck and lint clean), a local unsigned macOS build was installed and used for first manual tries. **Not yet verified:** end-to-end runs of most features with real models, the exam splitter on real exams with a model, Manim on a second Mac, and a signed or notarized build. Three upstream tests fail on a machine that has the `claude` CLI installed or for an unexamined loader reason. The Manim runtime includes an ffmpeg build that is GPL-licensed.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download (original)</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

**Bring your files.** In the desktop app, attach PDFs, photos, or any other file with the paperclip, or drag them in. The file stays where it is: the message carries its path, and the agent reads it from there.

The agent can also research questions in the background, create visual explanations, show your own images in the lesson and mark them up with arrows and labels, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Install

**This fork has no prebuilt downloads yet.** Run it from source, or build the macOS app yourself.

- **From source (any OS):** `npm ci`, then `npm run dev` and open http://localhost:3000. All extension pages are included.
- **macOS app (Apple Silicon), unsigned local build:** install Node 26 and Xcode, run `npm ci`, then `scripts/ext-build-mac-local.sh --install`. It builds, ad-hoc signs and copies the app to `/Applications`; macOS may ask you to allow it. Without `--install` it only builds `dist/mac-arm64/LearnHarness.app`. `npm run desktop:dist` is the original maintainer's signed and notarized path and does not work without their Apple team and keychain profile.
- **Video explanations (optional):** before the macOS build run `scripts/manim-runtime/build.sh` (needs `uv`, Homebrew `cairo`, `pango` and `ffmpeg`, a TeX installation and network on the build machine; see [`docs/ext/MANIM-RUNTIME.md`](docs/ext/MANIM-RUNTIME.md)). It adds about 340 MB to the app. Without it the video tool is not offered and everything else works.
- **Updates:** this fork's builds look for updates in this repository's releases, which do not exist yet, so there are no automatic updates. The feed was changed on purpose: the original feed would replace this app with the original LearnHarness.

The prebuilt downloads of the **original** app (without any of the additions above) are at [learnharness.ai](https://learnharness.ai) and its [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases).

Choose your models, then start a session with what you want to understand. You can use provider API keys, supported subscription connections in the desktop app, an installed [Claude Code CLI](docs/claude-code.md), or a [custom OpenAI-compatible endpoint](docs/custom-providers.md), including a local model server. Optional dictation and web search use separate service keys. Web research can use a Tavily, Brave, Exa, Firecrawl, or Ollama key in Settings → Providers → Search. Ollama search uses its hosted service, not a local model server.

See [Getting started](docs/getting-started.md) for model setup, dictation, files, and notes imports, and [context, caching, and costs](docs/compaction-accounting.md) for advanced cache preferences.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. Billing depends on your provider, CLI configuration, subscription, or local setup. The live cost meter estimates known API costs, not subscription, CLI, or custom-endpoint charges.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

See the [documentation index](docs/README.md) for all guides, [development](docs/development.md) for setup and checks, [architecture](docs/architecture.md) for the runtime, [keyboard shortcuts](docs/keyboard.md), and [desktop builds and releases](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
