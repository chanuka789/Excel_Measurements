#!/bin/sh
# Pyodide (Python in the browser) for processing models on the user's computer: only the files the add-in needs
# (core, standard library, numpy, shapely, libgeos), served by this server at /vendor/pyodide (~16 MB).
# 0.29 or newer is needed: older builds stop for good on a GEOS error.
set -e
VER=${PYODIDE_VERSION:-0.29.5}
DEST=${1:-vendor/pyodide}
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/p.tar.bz2" "https://github.com/pyodide/pyodide/releases/download/$VER/pyodide-$VER.tar.bz2"
tar -xjf "$TMP/p.tar.bz2" -C "$TMP" pyodide/pyodide.mjs pyodide/pyodide.js pyodide/pyodide.asm.js pyodide/pyodide.asm.wasm \
  pyodide/python_stdlib.zip pyodide/pyodide-lock.json pyodide/package.json \
  pyodide/numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl pyodide/shapely-2.0.7-cp313-cp313-pyemscripten_2025_0_wasm32.whl pyodide/libgeos-3.12.1.zip
mkdir -p "$DEST" && cp "$TMP"/pyodide/* "$DEST"/ && rm -rf "$TMP"
echo "pyodide $VER in $DEST: $(du -sh "$DEST" | cut -f1)"
