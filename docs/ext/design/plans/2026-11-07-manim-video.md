# Manim video implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Ship Manim inside the LearnHarness app and add a `video` job tool (spec: `docs/superpowers/specs/2026-11-07-manim-video-design.md`, REQ-vid-01..13).

**Architecture:** Two independent workstreams meeting at one contract, the runtime directory. Workstream A builds and verifies the relocatable runtime. Workstream B adds the sandboxed render service, the sub-agent tool, the card and the wiring, tested against a fake runtime.

**Tech Stack:** Python 3.12 (uv standalone), Manim 0.22.1, pycairo built against bundled cairo, ffmpeg, pruned TeX, electron-builder extraResources, macOS `sandbox-exec`, TypeScript in `src/*/ext/`.

## The contract between A and B

- Runtime root: `process.resourcesPath + "/manim-runtime"` in the packaged app; the env var `LH_MANIM_RUNTIME` overrides it (development, tests). Absent directory = runtime absent (REQ-vid-12).
- `<root>/bin/manim`: an executable wrapper (sh) that sets PATH to `<root>/bin`, TEXMFCNF/TEXMFROOT/TEXMFVAR to the bundled TeX, PYTHONHOME/PYTHONPATH to the bundled Python, then `exec`s `python3 -m manim "$@"`. It uses nothing outside `<root>` and the system.
- `<root>/bin/ffprobe` is present (used by B to check duration).
- Render command B runs: `<root>/bin/manim -ql --disable_caching --media_dir <work>/media -o scene <work>/scene.py Scene`, with `<work>` a fresh temp directory; the result is `<work>/media/videos/scene/480p15/scene.mp4`.

## Workstream A — runtime bundle (REQ-vid-01, 02, 03, 11 build part)

Files: `scripts/manim-runtime/build.sh` (+ helpers), `scripts/manim-runtime/verify.sh`, `scripts/manim-runtime/formulas.txt`, `electron-builder` config (extraResources), `docs/ext/MANIM-RUNTIME.md`, `scripts/build-mac*` hook if the build entry exists.

- [ ] Build: uv standalone Python 3.12, Manim 0.22.1 installed into plain site-packages (no venv), pycairo compiled from source against cairo (PyPI `pkgconf` wheel and the workaround shims found in the spike: scratchpad `manim-probe2/env.sh`), cairo and ffmpeg closures copied next to the runtime, prune (tests, tkinter, idlelib, PyObjCTest, dSYM).
- [ ] Rewrite every dylib reference to `@loader_path`/`@rpath` relative paths (`install_name_tool` or `delocate`/`dylibbundler`), ad-hoc re-sign each changed Mach-O inside-out.
- [ ] TeX: pruned tree with a shipped `texmf.cnf`; the package set = Manim's default template packages plus amsmath, amssymb, mathtools, bm; `latex.fmt` shipped; `dvisvgm` included.
- [ ] `verify.sh`: (1) `otool -L` over every Mach-O, fail on any `/opt/homebrew` or absolute path outside the runtime; (2) copy the runtime to a new temp directory and render the probe scene there with an empty PATH apart from system dirs; (3) render every formula in `formulas.txt` (fractions, integrals, sums, matrices, Greek letters, cases) with MathTex; report sizes (uncompressed and zip).
- [ ] electron-builder extraResources copies the runtime to `manim-runtime`; the reinstall script's signing step covers it; document it.
- [ ] Output: a measured size report and the exact list of remaining problems.

## Workstream B — render service, tool, card (REQ-vid-04..13)

Files (new): `src/core/ext/video/*` (pure: request validation, limits, sandbox profile text, result checks), `src/server/ext/video-render.ts` (runs sandbox-exec, time limit, process-tree kill), `src/agent/ext/video-builder.ts` (sub-agent), `components/artifacts` card via an ext component under `components/ext/`, wiring where `demo` is wired, tests `tests/ext-video-*.test.ts`, CONTRACTS.md section.

- [ ] Pure core: validate `title`/`brief` (non-empty, bounded), limits (time 120 s default, max fixes 4, max file size), `sandboxProfile(workDir, runtimeRoot)` producing a `sandbox-exec` profile that denies network and allows writes only under `workDir` and reads only under the runtime, the work dir and system libraries; `checkOutput(ffprobe json, size)`.
- [ ] Render service: create work dir, run `sandbox-exec -p <profile> <root>/bin/manim ...`, time limit, kill the process group on timeout and abort, delete the work dir on abort, return stdout/stderr tail for the fix loop (never to the learner).
- [ ] Sub-agent: follows `demo-builder.ts` (write_scene, render tools, bounded fix loop, usage reporting through the shared cost gate, editable prompt in `prompt-catalog.ts`). A failure result carries the fixed note; the dispatch instructions tell the agent to fall back to `demo`.
- [ ] Wiring: the tool is registered next to `demo` and `visual` (teacher, plus the practice-based sessions where the owner gives those tools), switchable in settings, offered only when the runtime directory exists. Any upstream edit is minimal and listed in TOUCHPOINTS.md.
- [ ] Card: video player with title, "Show scene" toggle, light and dark theme legible; job record keeps the mp4 and removes it with the job.
- [ ] Tests use a fake runtime (a sh `manim` that copies a fixture mp4, plus real `sandbox-exec` tests for the deny-network and deny-write profile on this Mac, skipped where `sandbox-exec` is missing).

## Order

A and B run in parallel (disjoint files). When both finish: integration check by the owner of the session (this one): full ext suite, typecheck, eslint, a real render through the real runtime and the real sandbox on this Mac, rebuild and reinstall.
