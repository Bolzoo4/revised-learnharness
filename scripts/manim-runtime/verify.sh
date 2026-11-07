#!/usr/bin/env bash
# Verifies a built Manim runtime. Exits non-zero at the first failing step.
#
#   1. Mach-O references: otool -L over every Mach-O; nothing outside the runtime
#      except /usr/lib and /System; every @loader_path/@rpath resolves; every
#      file passes codesign --verify --strict (REQ-vid-01).
#   2. Relocation: copy the runtime to another directory (the path contains a
#      space), check it again, and render the probe scene there with a clean PATH
#      (REQ-vid-03).
#   3. Formulas: render every line of formulas.txt with MathTex from the copy
#      (REQ-vid-02).
#   4. Sizes: uncompressed (apparent bytes) and zip.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
OUT=${LH_MANIM_RUNTIME_OUT:-$REPO/build/manim-runtime}
WORK=${LH_MANIM_BUILD_WORK:-$REPO/build/manim-runtime-work}
VERIFY=$WORK/verify
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ -x "$OUT/bin/manim" ] || fail "no runtime at $OUT (run scripts/manim-runtime/build.sh)"
rm -rf "$VERIFY" && mkdir -p "$VERIFY"

# clean_run CMD...: run with an empty environment apart from the clean PATH and fresh HOME/TMPDIR.
clean_run() {
  local home=$VERIFY/home tmp=$VERIFY/tmp
  mkdir -p "$home" "$tmp"
  env -i PATH="$CLEAN_PATH" HOME="$home" TMPDIR="$tmp" LANG=en_US.UTF-8 "$@"
}

step "1. Mach-O references and signatures in $OUT"
if ! /usr/bin/python3 "$HERE/macho.py" check "$OUT" > "$VERIFY/check.log" 2>&1; then
  cat "$VERIFY/check.log"; fail "Mach-O check"
fi
cat "$VERIFY/check.log"
/usr/bin/python3 "$HERE/macho.py" dump "$OUT" > "$VERIFY/otool.txt"
if grep -E '^\s(/opt/homebrew|/usr/local|/Library/|/Users/|/private/|/Applications/|/tmp/|/var/)' "$VERIFY/otool.txt" > "$VERIFY/forbidden.txt"; then
  cat "$VERIFY/forbidden.txt"; fail "otool -L shows a path outside the runtime"
fi
MACHO_COUNT=$(grep -c '^== ' "$VERIFY/otool.txt" || true)
pass "otool -L over $MACHO_COUNT Mach-O files: no /opt/homebrew, /usr/local, /Library, /Users reference"

step "2. Relocation: copy to a new directory and render the probe there"
RELOC="$VERIFY/moved copy"
mkdir -p "$RELOC"
cp -Rp "$OUT" "$RELOC/manim-runtime"
COPY=$RELOC/manim-runtime
[ "$COPY" != "$OUT" ] || fail "copy landed on the original path"
if ! /usr/bin/python3 "$HERE/macho.py" check "$COPY" > "$VERIFY/check-copy.log" 2>&1; then
  cat "$VERIFY/check-copy.log"; fail "Mach-O check on the moved copy"
fi
pass "Mach-O check on the moved copy ($COPY)"

PROBE=$VERIFY/probe
mkdir -p "$PROBE/media"
cp "$HERE/probe_scene.py" "$PROBE/scene.py"
clean_run "$COPY/bin/manim" -ql --disable_caching --media_dir "$PROBE/media" -o scene "$PROBE/scene.py" Scene \
  > "$PROBE/render.log" 2>&1 || { tail -40 "$PROBE/render.log"; fail "probe render"; }
MP4=$PROBE/media/videos/scene/480p15/scene.mp4
[ -s "$MP4" ] || { tail -40 "$PROBE/render.log"; fail "probe render produced no mp4 at $MP4"; }
DUR=$(clean_run "$COPY/bin/ffprobe" -v error -show_entries format=duration -of csv=p=0 "$MP4" || true)
case "$DUR" in
  ''|N/A) fail "ffprobe could not read the probe mp4 (duration='$DUR')" ;;
esac
awk -v d="$DUR" 'BEGIN { exit !(d + 0 > 0) }' || fail "probe mp4 has zero duration"
pass "probe scene rendered from the moved copy with PATH=$CLEAN_PATH: $MP4 (${DUR}s)"

step "3. Every formula in formulas.txt with MathTex"
FDIR=$VERIFY/formulas
mkdir -p "$FDIR/media"
cp "$HERE/formulas_scene.py" "$FDIR/formulas_scene.py"
cp "$HERE/formulas.txt" "$FDIR/formulas.txt"
clean_run LH_FORMULAS_FILE="$FDIR/formulas.txt" LH_FORMULA_REPORT="$FDIR/report.tsv" \
  "$COPY/bin/manim" -ql --disable_caching --media_dir "$FDIR/media" -o formulas "$FDIR/formulas_scene.py" Formulas \
  > "$FDIR/render.log" 2>&1 || { tail -40 "$FDIR/render.log"; fail "formula scene did not render"; }
[ -s "$FDIR/report.tsv" ] || fail "formula scene wrote no report"
EXPECTED=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/formulas.txt" || true)
GOT=$(wc -l < "$FDIR/report.tsv" | tr -d ' ')
OK=$(grep -c '^OK' "$FDIR/report.tsv" || true)
cat "$FDIR/report.tsv"
[ "$GOT" = "$EXPECTED" ] || fail "report has $GOT lines for $EXPECTED formulas"
if [ "$OK" != "$EXPECTED" ]; then
  fail "$((EXPECTED - OK)) of $EXPECTED formulas failed (see above)"
fi
pass "all $EXPECTED formulas compiled and rendered with MathTex"

step "4. Sizes"
read -r UNCOMPRESSED_BYTES < <(/usr/bin/python3 -c '
import os, sys
total = 0
for d, _, files in os.walk(sys.argv[1]):
    for f in files:
        p = os.path.join(d, f)
        if not os.path.islink(p):
            total += os.path.getsize(p)
print(total)' "$OUT")
ZIP=$VERIFY/manim-runtime.zip
(cd "$(dirname "$OUT")" && zip -qr -9 "$ZIP" "$(basename "$OUT")")
ZIP_BYTES=$(stat -f %z "$ZIP")
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }
echo "uncompressed (apparent bytes): $(mb "$UNCOMPRESSED_BYTES") ($UNCOMPRESSED_BYTES bytes)"
echo "zip -9:                        $(mb "$ZIP_BYTES") ($ZIP_BYTES bytes)"
for part in python texlive bin lib; do
  [ -e "$OUT/$part" ] && echo "  $part: $(du -sh "$OUT/$part" | cut -f1)"
done
echo "  python/lib/python3.12/site-packages: $(du -sh "$OUT/python/lib/python3.12/site-packages" | cut -f1)"
# The relocated copy and the zip are large scratch; the sizes above are already measured.
rm -rf "$RELOC" "$ZIP"
pass "verify complete for $OUT"
