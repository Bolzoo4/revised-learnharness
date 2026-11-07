# Manim runtime

The relocatable Manim runtime that the `video` job tool renders with (spec
`docs/superpowers/specs/2026-11-07-manim-video-design.md`, REQ-vid-01..03). It is built by
`scripts/manim-runtime/build.sh` into `build/manim-runtime` (git-ignored) and checked by
`scripts/manim-runtime/verify.sh`. The build and the checks are the only evidence that the runtime
works: a build that has not passed verify is not a runtime.

## What is inside

Manim 0.22.1 on a standalone CPython 3.12.13 (uv's python-build-standalone), with pycairo built
against Homebrew cairo, plus ffmpeg, ffprobe, dvisvgm and a pdfTeX that loads a pruned TeX tree.

```
manim-runtime/
  bin/manim        sh wrapper: sets PATH, TEXMF* and PYTHON* from its own location, then
                   exec python3.12 -m manim "$@"
  bin/ffmpeg, bin/ffprobe
  bin/latex        pdfTeX (arm64 slice), selects latex.fmt by its argv[0]
  bin/dvisvgm      arm64 slice
  python/          standalone interpreter, lib/python3.12/site-packages (manim, deps, pycairo)
  lib/             non-system dylibs copied in (cairo and ffmpeg closures), @loader_path references
  texlive/         texmf-dist (pruned), texmf-var (latex.fmt), texmf-config (texmf.cnf), ls-R
```

This is the contract with the render service (B): the render command is
`<root>/bin/manim -ql --disable_caching --media_dir <work>/media -o scene <work>/scene.py Scene`, and
the output is `<work>/media/videos/scene/480p15/scene.mp4`. The runtime uses nothing outside its own
directory except the system libraries (`/usr/lib`, `/System`).

## Build

Needs, on the build Mac: `uv`, the Xcode SDK (`xcrun`), Homebrew `cairo` and `ffmpeg` (read only),
and the system TeX Live 2025 at `/usr/local/texlive/2025` (read only). Nothing is installed with
Homebrew, nothing under `$HOME` or the system is written, and no `sudo` is used.

```
scripts/manim-runtime/build.sh              # build, then verify.sh
scripts/manim-runtime/build.sh --no-verify
scripts/manim-runtime/verify.sh             # verify an existing build
```

Environment overrides: `LH_MANIM_RUNTIME_OUT` (default `build/manim-runtime`),
`LH_MANIM_BUILD_WORK` (default `build/manim-runtime-work`, scratch and logs),
`LH_MANIM_PYTHON_HOME` (reuse an existing standalone CPython instead of downloading one).

The steps, in order:

1. Standalone CPython 3.12.13 from uv, copied into the staging tree.
2. pycairo compiled against Homebrew cairo, with a PyPI `pkgconf` and build-only `.pc` shims (zlib
   from the SDK, empty xorg protocol files). Build-time only; nothing from the shims ships.
3. Manim 0.22.1 installed into the standalone's site-packages (no venv). `UV_LINK_MODE=copy`, so no
   file is hard-linked into the uv cache.
4. Python pruned: stdlib test suite, ensurepip, tkinter and Tcl/Tk, idlelib, pip, Cython, pyglm,
   pyobjc, screeninfo, the pyglet and moderngl-window stack (the OpenGL window: manim imports moderngl
   and glcontext, but not the windowing packages), console scripts other than the interpreter, test
   directories, `.pyi`. Each removal was checked by a probe render. Bytecode is compiled and kept:
   without it, a probe render took 8 s (32 s on the first run) instead of about 3 s.
5. TeX: each formula in `formulas.txt`, with the Manim default preamble plus `mathtools` and `bm`, is
   compiled with the system `latex -recorder`. Every file it reads from the system tree is copied,
   so the TeX tree is exactly what the formulas need, with no guesswork. `ls-R` is written for the two
   trees the stock `texmf.cnf` reaches through `!!`, which means "database only". Without it kpathsea
   finds nothing (this was the first thing the probe caught). The stock `texmf.cnf` is copied and
   the wrapper overrides the tree variables.
6. `pdftex` and `dvisvgm` are copied as arm64 slices (`lipo -thin`); the copied `pdftex` is named
   `latex`.
7. ffmpeg and ffprobe are copied from Homebrew.
8. `macho.py bundle`: every non-system dependency is copied into `lib/`, every reference is rewritten
   to `@loader_path`, absolute `LC_RPATH` entries are removed, and each changed file is ad-hoc
   re-signed. Dylibs are handled first. Unsigned extensions from wheels are ad-hoc signed too.
   `@rpath` is resolved through the rpaths of the original Homebrew file, because a copied library's
   own rpaths point into Homebrew.
9. `bin/manim` is written from `manim-wrapper.sh`; the staging tree is moved to `build/manim-runtime`.

## Verify

`verify.sh` runs four steps and stops at the first failure:

1. **References and signatures.** `macho.py check` plus `otool -L` over every Mach-O. Fails on any
   reference outside the runtime except `/usr/lib` and `/System`, on any unresolved `@loader_path` or
   `@rpath`, on an absolute install name or rpath, and on any file that fails
   `codesign --verify --strict`. A grep of the `otool -L` output also fails on `/opt/homebrew`,
   `/usr/local`, `/Library`, `/Users`, `/private`, `/Applications`, `/tmp`, `/var`.
2. **Relocation.** The runtime is copied to a new directory whose path contains a space, checked
   again, and the probe scene is rendered from there with `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`
   and a fresh `HOME`/`TMPDIR`. The output must be a non-empty mp4 that ffprobe reads with a positive
   duration. The copy's file list is compared with the original's to show that rendering writes
   nothing into the bundle.
3. **Formulas.** `formulas_scene.py` renders every line of `formulas.txt` with `MathTex` (through a
   template that adds `mathtools` and `bm`), and writes one OK or FAIL line per formula. The check
   fails unless every formula is OK.
4. **Sizes.** Uncompressed (apparent bytes), `zip -9`, and per component.

Passing verify does not prove the sandbox works: the sandbox profile is workstream B's, and verify
renders without `sandbox-exec`.

## Signing

Every rewritten file is ad-hoc signed by `macho.py bundle`, inside-out (dylibs in `lib/` before
everything else). The reinstall script's `codesign --force --deep --sign -` on the app also covers
the bundled runtime. A Developer ID release is a different matter; see open items.

## Electron

`electron-builder.yml` has one `extraResources` entry: `build/manim-runtime` goes to
`manim-runtime` inside the app's Resources. electron-builder skips a missing source silently, so a
build without the runtime still succeeds and the video tool is off (REQ-vid-12). `desktop:dist` does
not run `build.sh`, so a release that should include the video tool needs
`scripts/manim-runtime/build.sh` run first.

## Sizes (measured on this Mac, final build)

| Component | Size |
|---|---|
| Total, uncompressed (apparent bytes) | 342.1 MB (358,755,274 bytes) |
| Total, `zip -9` | 136.6 MB (143,216,885 bytes) |
| `python/` (interpreter, stdlib, site-packages) | 263 MB |
| of which `site-packages` | 208 MB (scipy 68, av 46, manimpango 22, numpy 17, PIL 13, the rest) |
| `lib/` (cairo and ffmpeg closures) | 77 MB |
| `bin/` (ffmpeg, ffprobe, latex, dvisvgm, manim) | 11 MB |
| `texlive/` (texmf-dist, texmf-var, cnf, ls-R) | 4 MB |

The spike measured 66 MB for the interpreter and 256 MB for the Python packages (no pruning), so the
prune removes about 30 MB of Python packages and the rest is the dependency set manim needs. The
bytecode cache (about 51 MB) is inside `python/`.

## Not in the runtime, on purpose

- The Homebrew ffmpeg is a full build, so its closure (about 70 MB: codecs, tesseract, gnutls) comes
  with it. A lean ffmpeg would be smaller, but building one needs tooling that was not installed.
- PyAV (`av`, about 46 MB with its own bundled ffmpeg) stays: manim 0.22 encodes through it in
  `scene_file_writer.py` and `video_segment_encoder.py`.
- scipy (about 68 MB) stays: manim imports `scipy.spatial.transform` in `utils/space_ops.py` at import.

## Open items

- **Licensing.** The Homebrew ffmpeg is built with GPL codecs (x264 and x265 are in the closure), so
  distributing the app means GPL obligations for that part. PyAV's wheel also bundles its own ffmpeg,
  whose license flags were not checked. Needs a decision before a release.
- **Hardened runtime and notarization.** `build/entitlements.mac.plist` and the release signing were
  not tested with this runtime. Bundled libraries signed by different identities may need
  `com.apple.security.cs.disable-library-validation`.
- **Sandbox.** The TeX tree and the bundle must stay readable inside `sandbox-exec` (workstream B's
  profile). Renders here write nothing into the bundle; `TEXMFVAR` points inside it, read only.
- **Build-machine paths.** `python/lib/python3.12/_sysconfigdata__darwin_darwin.py` holds the build
  paths (standalone CPython metadata, used only when compiling C extensions). `texmf.cnf` has
  comments with TeX Live paths. Neither is executed.
- **Not tested here:** a Mac without TeX or Homebrew (the verify step uses a clean PATH, not a clean
  machine), a second Mac, and `desktop:dist` with the runtime included.
