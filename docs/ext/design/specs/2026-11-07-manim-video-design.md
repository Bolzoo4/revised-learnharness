# Manim videos in the teaching sessions — design

Date: 2026-11-07. Origin: the learner asked for 3Blue1Brown-style videos next to the interactive demos, and decided that the app ships with Manim.

## Context

LearnHarness already has the `demo` and `visual` job tools: a sub-agent writes a single-file HTML demo, tests it headlessly and shows it in a sandboxed iframe (`src/agent/subagents/demo-builder.ts`, `components/artifacts/demo-card.tsx`). Videos do not exist. A spike (2026-11-07) showed that Manim 0.22.1 runs in a standalone Python 3.12 on this Mac and renders a test scene with a formula in about 2 seconds. Measured with one formula: Python 66 MB, Python packages 256 MB (about 25-30 MB prunable), native libraries and ffmpeg about 83 MB, LaTeX about 26 MB. Unmeasured: compressed size, LaTeX for ordinary formulas, relocation of the bundle.

## Design

Two phases. Phase 1 packages a relocatable runtime and proves it on a second location. Phase 2 adds the tool and the card.

- **Runtime bundle** in the app resources: standalone Python 3.12 with Manim installed (no venv), pycairo built against a bundled cairo, ffmpeg with its libraries, a pruned TeX tree with a shipped `texmf.cnf`. Built by one script; every Mach-O is rewritten to relative paths and ad-hoc re-signed. The Electron main process starts renders with the bundle's directories first on PATH.
- **`video` job tool**, like `demo`: input `title` and `brief`; a sub-agent writes a Manim scene, renders it at low quality inside a sandbox with a time limit, checks the file and fixes errors in a bounded loop.
- **Sandbox**: the scene is Python written by a model. It runs under the macOS sandbox (`sandbox-exec`): no network, writes only inside a per-job work directory, reads only the runtime and that directory, a hard time limit, the process tree killed on timeout or abort.
- **Fallback**: a failed or timed-out video returns a failure note and the agent falls back to a `demo`.
- **Card**: the finished mp4 plays in the chat with a native video player.

## Requirements

- **REQ-vid-01**: The built app contains the Manim runtime; no file in it links to `/opt/homebrew` or to any path outside the bundle (checked with `otool -L` over every Mach-O).
- **REQ-vid-02**: The bundled TeX renders `MathTex` for a fixed list of test formulas (fractions, integrals, sums, matrices, Greek letters, cases) with no TeX installed on the machine.
- **REQ-vid-03**: A copy of the runtime moved to a different directory renders the probe scene; the build script's checks run this move.
- **REQ-vid-04**: The `video` tool takes `title` (non-empty, bounded) and `brief` (non-empty, bounded) and dispatches a sub-agent job through the existing jobs feed.
- **REQ-vid-05**: A render uses the low-quality preset and a time limit (default 120 s, a setting); exceeding it kills the process tree and fails the job.
- **REQ-vid-06**: A render has no network access and can write only inside its work directory; a scene that tries either fails the job and the attempt is recorded in the job notes.
- **REQ-vid-07**: A job succeeds only when the output file exists, is a readable mp4 of non-zero duration, and is under a size limit; otherwise the sub-agent may fix the scene up to N times (default 4, bounded).
- **REQ-vid-08**: On failure the tool result carries a fixed failure note and the instructions tell the agent to fall back to a `demo`; no exception text reaches the learner.
- **REQ-vid-09**: Aborting a job kills the render process tree and deletes its work directory.
- **REQ-vid-10**: The card plays the video, shows the title and the scene source on request, and is legible in the light and dark themes.
- **REQ-vid-11**: The tool is offered in the same sessions as `demo` and `visual`, can be switched off in settings like them, and its model spend is counted on the shared daily cost gate.
- **REQ-vid-12**: When the runtime is absent (development run) the tool is not offered; it is never offered and then fails.
- **REQ-vid-13**: Videos are stored with the job record and removed with it; the store layout is documented in CONTRACTS.md.

## Open items

- Compressed size of the app and the final pruned TeX package list.
- Whether the app later needs hardened runtime or notarization (then `disable-library-validation` is needed for the bundled libraries).
- Whether a second Mac check is possible before release.

## Security Profile

**Level:** baseline

**Active practices:**
- architectural-mapping (always on)
- design-by-contract (sandbox profile, time limits, output checks)
- adversarial-test-writing
- static-analysis-hardening

**Explicitly excluded:**
- mutation-testing — user decision 2026-11-05: behaviour tests and static analysis are enough for this project
- requirements-traceability-matrix — baseline chosen; REQ IDs are still assigned
- mcdc-coverage — baseline chosen
- system-safety-analysis — baseline chosen (I proposed it limited to the sandbox; the learner chose plain baseline)
- watchdog-safe-state — baseline chosen; the time limit and the process-tree kill are the safeguards
- lightweight-wcet — not applicable

**Set:** 2026-11-07, during brainstorming
