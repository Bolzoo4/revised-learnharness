#!/usr/bin/env bash
# Builds the relocatable Manim runtime (REQ-vid-01..03) and verifies it.
#
#   scripts/manim-runtime/build.sh            build into build/manim-runtime, then verify.sh
#   scripts/manim-runtime/build.sh --no-verify
#
# Inputs: uv (Python), the Xcode SDK (pycairo build), Homebrew cairo and ffmpeg
# (read only), and the system TeX Live at /usr/local/texlive (read only).
# Nothing under $HOME, Homebrew or TeX is written. See docs/ext/MANIM-RUNTIME.md.
set -euo pipefail

MANIM_VERSION=0.22.1
PY_VERSION=3.12.13
PKGCONF_VERSION=3.0.7.post0
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
OUT=${LH_MANIM_RUNTIME_OUT:-$REPO/build/manim-runtime}
WORK=${LH_MANIM_BUILD_WORK:-$REPO/build/manim-runtime-work}
CAIRO_PREFIX=/opt/homebrew/opt/cairo
FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
FFPROBE_BIN=/opt/homebrew/bin/ffprobe
TEXBIN=/usr/local/texlive/2025/bin/universal-darwin
SYS_TEX=/usr/local/texlive/2025
SYS_LATEX=$SYS_TEX/bin/universal-darwin/latex

RUN_VERIFY=1
[ "${1:-}" = "--no-verify" ] && RUN_VERIFY=0

log() { printf '[manim-runtime] %s\n' "$*"; }
die() { printf '[manim-runtime] FAILED: %s\n' "$*" >&2; exit 1; }

# shellcheck source=texlive.sh
. "$HERE/texlive.sh"

# --- preflight -------------------------------------------------------------
UV=$(command -v uv || true)
[ -n "$UV" ] || die "uv not found on PATH"
for t in otool install_name_tool codesign lipo xcrun zip; do
  command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
done
for f in "$FFMPEG_BIN" "$FFPROBE_BIN" "$TEXBIN/pdftex" "$TEXBIN/dvisvgm" "$SYS_LATEX" \
         "$SYS_TEX/texmf-dist/web2c/texmf.cnf" "$SYS_TEX/texmf-var/web2c/pdftex/latex.fmt" \
         "$CAIRO_PREFIX/lib/pkgconfig/cairo.pc"; do
  [ -e "$f" ] || die "missing input: $f"
done
rm -rf "$WORK/stage"
mkdir -p "$WORK/logs" "$WORK/stage"
export UV_CACHE_DIR="$WORK/uv-cache"
export UV_LINK_MODE=copy          # never hard-link into the uv cache: install_name_tool must not touch it
export UV_PYTHON_INSTALL_DIR="$WORK/python-install"
STAGE="$WORK/stage/manim-runtime"
mkdir -p "$STAGE"

# --- 1. standalone Python ---------------------------------------------------
if [ -n "${LH_MANIM_PYTHON_HOME:-}" ]; then
  PY_HOME=$LH_MANIM_PYTHON_HOME
  log "python: using $PY_HOME (LH_MANIM_PYTHON_HOME)"
else
  log "python: installing $PY_VERSION with uv"
  "$UV" python install "$PY_VERSION" > "$WORK/logs/python.log" 2>&1 || die "uv python install failed (see $WORK/logs/python.log)"
  PY_HOME=$(dirname "$(dirname "$("$UV" python find --managed-python "$PY_VERSION")")")
fi
[ -x "$PY_HOME/bin/python3.12" ] || die "no python3.12 under $PY_HOME"
cp -Rp "$PY_HOME" "$STAGE/python"
chmod -R u+w "$STAGE/python"
# uv marks its interpreters externally managed; this copy is ours to fill, so drop the marker.
rm -f "$STAGE/python/lib/python3.12/EXTERNALLY-MANAGED"
PY="$STAGE/python/bin/python3.12"
log "python: $("$PY" -c 'import sys;print(sys.version.split()[0])') in $STAGE/python"

# --- 2. build tools: pkgconf from PyPI, shims for the Homebrew pkg-config gaps ---
TOOLS=$WORK/build-tools
rm -rf "$TOOLS"
"$UV" venv --quiet --python "$PY" "$TOOLS" > "$WORK/logs/tools.log" 2>&1
"$UV" pip install --quiet --python "$TOOLS/bin/python" "pkgconf==$PKGCONF_VERSION" >> "$WORK/logs/tools.log" 2>&1 \
  || die "pkgconf install failed (see $WORK/logs/tools.log)"
SHIM=$WORK/pkgshim
rm -rf "$SHIM" && mkdir -p "$SHIM"
SDK_USR=$(xcrun --sdk macosx --show-sdk-path)/usr
printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\n\nName: zlib\nDescription: zlib shim (SDK)\nVersion: 1.2.12\nLibs: -L${libdir} -lz\nCflags: -I${includedir}\n' "$SDK_USR" > "$SHIM/zlib.pc"
for name in bzip2 expat kbproto renderproto xextproto xproto; do
  printf 'Name: %s\nDescription: shim for build\nVersion: 9.9.9\nLibs:\nCflags:\n' "$name" > "$SHIM/$name.pc"
done
XORG_INC=$(ls -d /opt/homebrew/Cellar/xorgproto/*/include 2>/dev/null | tail -1 || true)
PKG_PATHS="$SHIM"
for lib in cairo pango libpng fontconfig freetype pixman libxcb libxrender libxext libx11 libxau libxdmcp glib pcre2 harfbuzz fribidi libffi; do
  [ -d "/opt/homebrew/opt/$lib/lib/pkgconfig" ] && PKG_PATHS="$PKG_PATHS:/opt/homebrew/opt/$lib/lib/pkgconfig"
done

# --- 3. Manim and pycairo into the standalone site-packages (no venv) -------
log "manim: installing manim==$MANIM_VERSION (pycairo is compiled against $CAIRO_PREFIX)"
(
  export PATH="$TOOLS/bin:$PATH"
  export PKG_CONFIG_PATH="$PKG_PATHS"
  [ -n "$XORG_INC" ] && export CFLAGS="-I$XORG_INC"
  "$UV" pip install --python "$PY" "manim==$MANIM_VERSION"
) > "$WORK/logs/manim.log" 2>&1 || die "manim install failed (see $WORK/logs/manim.log)"
"$PY" -c 'import manim, cairo; print("import ok", manim.__version__)' > "$WORK/logs/import.log" 2>&1 \
  || die "import check failed (see $WORK/logs/import.log)"
log "manim: $(tail -1 "$WORK/logs/import.log")"

# --- 4. prune the Python tree ----------------------------------------------
log "prune: python tree"
PYLIB="$STAGE/python/lib/python3.12"
rm -rf "$PYLIB/test" "$PYLIB/idlelib" "$PYLIB/tkinter" "$PYLIB/turtledemo" "$PYLIB/ensurepip" \
       "$PYLIB/lib2to3" "$PYLIB/pydoc_data" "$PYLIB"/config-3.12-darwin \
       "$PYLIB/site-packages/pip" "$PYLIB/site-packages/pip-"*.dist-info \
       "$STAGE/python/lib/pkgconfig" "$STAGE/python/include" "$STAGE/python/share" \
       "$STAGE/python/lib"/tcl* "$STAGE/python/lib"/tk* "$STAGE/python/lib"/libtcl* "$STAGE/python/lib"/libtk* \
       "$STAGE/python/lib"/*.a "$STAGE/python/lib"/thread* "$STAGE/python/lib/python3.12/lib-dynload"/_tkinter*.so
# Packages the cairo renderer never imports (checked by a probe render after each prune):
# pyobjc and screeninfo (macOS window code), the pyglet / moderngl-window stack (the OpenGL
# window), Cython and pyglm (build-time only). moderngl and glcontext stay: manim imports them.
PYSP="$PYLIB/site-packages"
rm -rf "$PYSP"/objc "$PYSP"/AppKit "$PYSP"/Foundation "$PYSP"/CoreFoundation "$PYSP"/pyobjc* \
       "$PYSP"/screeninfo* "$PYSP"/moderngl_window* "$PYSP"/pyglet* \
       "$PYSP"/Cython* "$PYSP"/cython* "$PYSP"/pyglm*
# Console scripts of the pruned packages and of pip: only the interpreter stays in python/bin.
find "$STAGE/python/bin" -mindepth 1 -maxdepth 1 ! -name 'python3*' -exec rm -f {} +
find "$STAGE/python" \( -name '__pycache__' -o -name '*.dSYM' \) -prune -exec rm -rf {} +
find "$STAGE/python/lib/python3.12/site-packages" -type d \( -name tests -o -name test \) -prune -exec rm -rf {} +
find "$STAGE/python/lib/python3.12/site-packages" -name '*.pyi' -delete
"$PY" -m compileall -q -j 0 "$PYLIB" > "$WORK/logs/compileall.log" 2>&1 || true
log "prune: python tree is $(du -sk "$STAGE/python" | cut -f1) KB"

# --- 5. TeX: formula closure from the system TeX, then arm64 binaries --------
log "tex: computing the file closure for formulas.txt"
tex_closure "$SYS_TEX" "$HERE/formulas.txt" "$WORK/tex-probe" "$WORK/tex-closure.txt" \
  || die "tex closure failed"
log "tex: copying into the bundle"
tex_assemble "$SYS_TEX" "$WORK/tex-closure.txt" "$STAGE/texlive"
mkdir -p "$STAGE/bin"
copy_arm64 "$TEXBIN/pdftex" "$STAGE/bin/latex"       # argv[0] "latex" selects latex.fmt
copy_arm64 "$TEXBIN/dvisvgm" "$STAGE/bin/dvisvgm"
codesign --force --sign - --timestamp=none "$STAGE/bin/latex" "$STAGE/bin/dvisvgm"

# --- 6. ffmpeg and ffprobe (Homebrew, copied; dylibs follow in step 7) ------
cp -L "$FFMPEG_BIN" "$STAGE/bin/ffmpeg"
cp -L "$FFPROBE_BIN" "$STAGE/bin/ffprobe"
chmod u+w "$STAGE/bin/ffmpeg" "$STAGE/bin/ffprobe"

# --- 7. Mach-O closure: rewrite to @loader_path, re-sign inside-out ----------
log "macho: bundling dependencies and re-signing changed files"
"$TOOLS/bin/python" "$HERE/macho.py" bundle "$STAGE" | tee "$WORK/logs/bundle.log" | grep -v '^RESIGNED' || true
grep -q 'bundle:' "$WORK/logs/bundle.log" || die "bundle step did not finish (see $WORK/logs/bundle.log)"
codesign --force --sign - --timestamp=none "$STAGE/bin/ffmpeg" "$STAGE/bin/ffprobe"

# --- 8. the bin/manim wrapper (the runtime contract) -------------------------
cp "$HERE/manim-wrapper.sh" "$STAGE/bin/manim"
chmod 755 "$STAGE/bin/manim"

# --- 9. move into place, then verify -----------------------------------------
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$STAGE" "$OUT"
rm -rf "$WORK/stage"
log "built: $OUT ($(du -sk "$OUT" | cut -f1) KB uncompressed)"

if [ "$RUN_VERIFY" = 1 ]; then
  LH_MANIM_RUNTIME_OUT=$OUT LH_MANIM_BUILD_WORK=$WORK "$HERE/verify.sh"
fi
