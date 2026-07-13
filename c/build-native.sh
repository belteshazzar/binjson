#!/usr/bin/env bash
# Build a native (non-WASM) static library from the same C sources
# build-wasm.sh combines into the WASM module -- for embedding directly in
# a native host (a macOS/iOS app via Swift, a native CLI, a server process,
# ...) instead of through a WASM+JS bridge. Requires a C11 compiler
# (cc/clang/gcc) and `ar` on PATH -- no Emscripten involved. See
# docs/platform-strategy.md's macOS/iOS section for the surrounding plan.
#
# Unlike the WASM build, the *_wasm.c glue files are excluded: they only
# exist to satisfy Emscripten's WASM-export ABI (malloc'd heap buffers,
# int32 pointer/length pairs crossing a JS boundary). A native host calls
# the underlying dc_*/bj_* functions directly with native pointers, and
# constructs its own bj_io via bjio_posix() (posixio.c) instead of the WASM
# build's bjio_host() (hostio.c -- EM_JS-based, so excluded here too; its
# own non-Emscripten fallback is a non-functional stub, by design).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p lib-native

CC="${CC:-cc}"
AR="${AR:-ar}"
CFLAGS=(-std=c11 -O2 -Wall -Wextra -Ic)

# Every C source the native build needs: build-wasm.sh's ALL_SOURCES minus
# the *_wasm.c glue files, with posixio.c standing in for hostio.c.
ALL_SOURCES=(
  c/binjson.c
  c/bjfile.c c/posixio.c
  c/bplustree.c
  c/geo.c c/rtree.c
  c/diff.c c/textlog.c
  c/stemmer.c c/textindex.c
  c/db_keyenc.c c/regex.c c/db_query.c c/db_update.c c/db.c
)

echo "Compiling native object files..."
OBJS=()
for src in "${ALL_SOURCES[@]}"; do
  obj="lib-native/$(basename "${src%.c}").o"
  "$CC" "${CFLAGS[@]}" -c "$src" -o "$obj"
  OBJS+=("$obj")
done

echo "Archiving lib-native/libbinjson.a..."
rm -f lib-native/libbinjson.a
"$AR" rcs lib-native/libbinjson.a "${OBJS[@]}"

echo "built lib-native/libbinjson.a ($(wc -c < lib-native/libbinjson.a) bytes, ${#ALL_SOURCES[@]} object files)"
