# Sourced by build.sh. Builds the pruned TeX tree for the Manim runtime (REQ-vid-02).
#
# The file list is not guessed: each formula in formulas.txt is compiled with the
# system TeX under `latex -recorder`, and every file it reads from the system TeX
# tree is copied. Only the arm64 slice of the TeX binaries is shipped.

# tex_closure SYSROOT FORMULAS PROBEDIR LISTFILE
#   Compiles each formula with the system latex (one file each, same preamble as
#   Manim's default template plus mathtools and bm) and writes the sorted list of
#   files under SYSROOT that latex read to LISTFILE.
tex_closure() {
  local sysroot=$1 formulas=$2 probe=$3 list=$4
  local preamble
  rm -rf "$probe" && mkdir -p "$probe"
  preamble='\documentclass[preview]{standalone}
\usepackage[english]{babel}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{mathtools}
\usepackage{bm}
\begin{document}'
  local n=0 line tex
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    n=$((n + 1))
    {
      printf '%s\n' "$preamble"
      printf '\\begin{align*}\n%s\n\\end{align*}\n' "$line"
      printf '\\end{document}\n'
    } > "$probe/f$n.tex"
  done < "$formulas"
  [ "$n" -gt 0 ] || { echo "no formulas in $formulas" >&2; return 1; }

  local raw="$probe/inputs.raw"
  : > "$raw"
  for tex in "$probe"/f*.tex; do
    if ! "$SYS_LATEX" -recorder -interaction=batchmode -halt-on-error \
          -output-directory="$probe" "$tex" > "$tex.log" 2>&1; then
      echo "system latex failed on $(basename "$tex"); see $tex.log" >&2
      return 1
    fi
    grep '^INPUT ' "${tex%.tex}.fls" >> "$raw"
  done
  sed 's/^INPUT //' "$raw" | sort -u | while IFS= read -r p; do
    case "$p" in
      "$sysroot"/*) case "$p" in */texmf.cnf) ;; *) printf '%s\n' "$p" ;; esac ;;
    esac
  done > "$list"
  echo "tex closure: $(wc -l < "$list" | tr -d ' ') files from $n formulas"
}

# tex_assemble SYSROOT LISTFILE TEXDIR
#   Copies the listed files into TEXDIR keeping their path below SYSROOT, plus a
#   texmf.cnf (the stock web2c one, read only through TEXMFCNF).
tex_assemble() {
  local sysroot=$1 list=$2 texdir=$3 p rel
  while IFS= read -r p; do
    rel=${p#"$sysroot"/}
    mkdir -p "$texdir/$(dirname "$rel")"
    cp -L "$p" "$texdir/$rel"
  done < "$list"
  mkdir -p "$texdir/texmf-config" "$texdir/texmf-var" "$texdir/texmf-local" "$texdir/texmf-home"
  cp -L "$sysroot/texmf-dist/web2c/texmf.cnf" "$texdir/texmf-config/texmf.cnf"
  # The stock texmf.cnf reaches these trees with "!!", which means "only through the
  # ls-R database", so each tree needs its own ls-R (what mktexlsr writes).
  for tree in texmf-dist texmf-var; do
    tex_lsr "$texdir/$tree"
  done
}

# tex_lsr DIR: writes DIR/ls-R, a sorted file database in the format kpathsea reads.
tex_lsr() {
  local dir=$1
  (
    cd "$dir" || exit 1
    echo "% ls-R -- filename database for kpathsea; do not change this line."
    find . -type d | LC_ALL=C sort | while IFS= read -r sub; do
      printf '%s:\n' "$sub"
      find "$sub" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort
      printf '\n'
    done
  ) > "$dir/ls-R"
}

# copy_arm64 SRC DEST: copies SRC, thinning a universal binary to arm64.
copy_arm64() {
  local src=$1 dest=$2
  if [ "$(lipo -archs "$src")" = "arm64" ]; then
    cp -L "$src" "$dest"
  else
    lipo -thin arm64 "$src" -output "$dest"
  fi
  chmod u+w "$dest"
}
