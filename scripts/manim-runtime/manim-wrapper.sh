#!/bin/sh
# <root>/bin/manim, written by scripts/manim-runtime/build.sh.
# Relocatable: the root is derived from this file's own location, and nothing
# outside the runtime is used except the system libraries.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/.." && pwd -P)

PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

# TeX: bundled tree, bundled texmf.cnf, nothing from the user's home or a TeX install.
TEXMFROOT="$ROOT/texlive"
TEXMFCNF="$ROOT/texlive/texmf-config"
TEXMFVAR="$ROOT/texlive/texmf-var"
TEXMFSYSVAR="$TEXMFVAR"
TEXMFSYSCONFIG="$ROOT/texlive/texmf-config"
TEXMFCONFIG="$TEXMFSYSCONFIG"
TEXMFHOME="$ROOT/texlive/texmf-home"
TEXMFLOCAL="$ROOT/texlive/texmf-local"
export TEXMFROOT TEXMFCNF TEXMFVAR TEXMFSYSVAR TEXMFSYSCONFIG TEXMFCONFIG TEXMFHOME TEXMFLOCAL

# Python: the standalone interpreter, no user site, no bytecode writes.
PYTHONHOME="$ROOT/python"
PYTHONPATH="$ROOT/python/lib/python3.12/site-packages"
PYTHONNOUSERSITE=1
PYTHONDONTWRITEBYTECODE=1
PYTHONUTF8=1
export PYTHONHOME PYTHONPATH PYTHONNOUSERSITE PYTHONDONTWRITEBYTECODE PYTHONUTF8

exec "$ROOT/python/bin/python3.12" -m manim "$@"
