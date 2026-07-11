#!/bin/bash
# Build and run the hostile-file fuzz harness (c/fuzz.c) with ASan + UBSan.
#
#   c/fuzz.sh [iterations] [seed]     (defaults: 20000, 1)
#
# Exits non-zero on any crash, hang (20s watchdog), or sanitizer report.
# To reproduce a failure: c/fuzz.sh 1 <seed printed by the failing run>.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/bjfuzz"
cc -std=c11 -g -O1 -Wall -Wextra -Werror \
   -fsanitize=address,undefined -fno-sanitize-recover=all \
   -o "$OUT" \
   c/fuzz.c c/binjson.c c/bjfile.c c/bplustree.c c/rtree.c c/textlog.c \
   c/textindex.c c/stemmer.c c/diff.c c/geo.c

"$OUT" "${1:-20000}" "${2:-1}"
