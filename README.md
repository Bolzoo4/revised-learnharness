# LearnHarness v2

**An unofficial extension fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist, maintained by Riccardo Bolzonello.** It is not endorsed by or affiliated with the original project. The name only says that this fork builds on top of it; everything below the line is the original README. Licence: AGPL-3.0, the original copyright notices are kept.

LearnHarness teaches with an agent and a knowledge graph. This fork turns it into a longer-running study system: spaced repetition, checked sources, narrated lectures, exam training and a background research loop. Its three starting points were personal tools (a flashcard app with FSRS, a PDF lecture pipeline, a knowledge-graph research prototype) that were merged here instead of growing apart.

## What changes

Each item is a page or a session kind in the app. Details and the open questions are in [`docs/ext/OVERVIEW.md`](docs/ext/OVERVIEW.md).

- **Review**: spaced repetition (FSRS) per graph node, a daily plan bounded by time, flashcards, and a tutor you can open from a card or a node.
- **Source checking**: every proposition gets a trust level (`unverified`, `sourced`, `contested`, `refuted`); "sourced" needs a quotation that code confirms in a stored copy of the source.
- **Lectures**: chapters of a PDF become narrated lectures with slides, exercises and office hours; a chapter's nodes join the graph only after all its lectures are written.
- **Study**: read a PDF next to a chat that knows the page and the selection; make cards from questions, selections and answers.
- **Exams**: a space where you load old exams and course material; the agent splits exams into exercises, searches your material first and the web second, and guides you without giving the solution. Phase 2 (recurring exercise types, study plan) is designed, not built.
- **Research**: a periodic loop that fills gaps in the graph, with marks set from the graph (expand, hold, stop), a research goal you write, progress reports while it runs, and notes you can leave it.
- **Visual explanations**: interactive demos, drawings and Manim videos in the teaching, review, study, office-hours and lecture sessions. The macOS app ships its own Manim runtime.
- **Session study notes**: a short note on how you want to study something, kept per session and passed to the sessions that work on its nodes.
- **Debriefs and journal**, a read-only **MCP server** for other local agents, a shared daily **cost gate** and **provider usage-limit** pauses.
- **Light theme** (Settings, Appearance, Mode).

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
  <a href="https://learnharness.ai">Download</a> ·
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

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Choose your models, then start a session with what you want to understand. You can use provider API keys, supported subscription connections in the desktop app, an installed [Claude Code CLI](docs/claude-code.md), or a [custom OpenAI-compatible endpoint](docs/custom-providers.md), including a local model server. Optional dictation and web search use separate service keys. Web research can use a Tavily, Brave, Exa, Firecrawl, or Ollama key in Settings → Providers → Search. Ollama search uses its hosted service, not a local model server.

See [Getting started](docs/getting-started.md) for model setup, dictation, files, and notes imports, and [context, caching, and costs](docs/compaction-accounting.md) for advanced cache preferences.

All three platforms support in-app updates.

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
