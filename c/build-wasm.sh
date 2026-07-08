#!/usr/bin/env bash
# Build the binjson + bplustree WASM modules with Emscripten.
# Produces lib/binjson-core.mjs and lib/bplustree-core.mjs (+ .wasm), loaded by
# src/binjson-wasm.js and src/bplustree-wasm.js via ../lib. Requires `emcc` on
# PATH (emsdk).
set -euo pipefail

# Output into lib/ (gitignored). These generated artifacts are shipped with the
# package via the "files" allowlist in package.json and rebuilt on prepack.
cd "$(dirname "$0")/.."
mkdir -p lib

# Flags shared by both modules.
COMMON_FLAGS=(
  -O3
  -flto
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_RUNTIME_METHODS=HEAPU8
  -sALLOW_TABLE_GROWTH=0
  -sFILESYSTEM=0
  --no-entry
)

EXPORTS='_malloc,_free,'\
'_bjw_enc_reset,_bjw_put_null,_bjw_put_bool,_bjw_put_int,_bjw_put_float,'\
'_bjw_put_date,_bjw_put_pointer,_bjw_put_string,_bjw_put_binary,_bjw_put_oid,'\
'_bjw_put_key,_bjw_begin_array,_bjw_end_array,_bjw_begin_object,_bjw_end_object,'\
'_bjw_enc_finish,_bjw_enc_ptr,_bjw_enc_size,'\
'_bjw_decode,_bjw_events_ptr,_bjw_events_len,_bjw_consumed,_bjw_value_size'

emcc c/binjson.c c/binjson_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createBinjsonModule \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -o lib/binjson-core.mjs

echo "built lib/binjson-core.mjs ($(wc -c < lib/binjson-core.wasm) bytes wasm)"

BPT_EXPORTS='_malloc,_free,'\
'_bptw_create,_bptw_load,_bptw_free,'\
'_bptw_add,_bptw_delete,_bptw_search,_bptw_entries,_bptw_range,_bptw_height,'\
'_bptw_size,_bptw_root,_bptw_next_id,_bptw_order,'\
'_bptw_out_ptr,_bptw_out_len,_bptw_image_ptr,_bptw_image_len'

emcc c/binjson.c c/bplustree.c c/bplustree_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createBplustreeModule \
  -sEXPORTED_FUNCTIONS="$BPT_EXPORTS" \
  -o lib/bplustree-core.mjs

echo "built lib/bplustree-core.mjs ($(wc -c < lib/bplustree-core.wasm) bytes wasm)"

RT_EXPORTS='_malloc,_free,'\
'_rtw_create,_rtw_load,_rtw_free,'\
'_rtw_insert,_rtw_remove,_rtw_clear,_rtw_search,_rtw_compact,'\
'_rtw_size,_rtw_max_entries,'\
'_rtw_out_ptr,_rtw_out_len,_rtw_image_ptr,_rtw_image_len'

emcc c/binjson.c c/rtree.c c/rtree_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createRtreeModule \
  -sEXPORTED_FUNCTIONS="$RT_EXPORTS" \
  -o lib/rtree-core.mjs

echo "built lib/rtree-core.mjs ($(wc -c < lib/rtree-core.wasm) bytes wasm)"
