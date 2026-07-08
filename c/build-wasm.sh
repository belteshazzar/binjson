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
'_rtw_insert,_rtw_remove,_rtw_clear,_rtw_search,_rtw_search_radius,_rtw_haversine,_rtw_compact,'\
'_rtw_size,_rtw_max_entries,'\
'_rtw_out_ptr,_rtw_out_len,_rtw_image_ptr,_rtw_image_len'

emcc c/binjson.c c/geo.c c/rtree.c c/rtree_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createRtreeModule \
  -sEXPORTED_FUNCTIONS="$RT_EXPORTS" \
  -o lib/rtree-core.mjs

echo "built lib/rtree-core.mjs ($(wc -c < lib/rtree-core.wasm) bytes wasm)"

TL_EXPORTS='_malloc,_free,'\
'_tlw_create,_tlw_load,_tlw_free,'\
'_tlw_add_version,_tlw_get_version,_tlw_get_version_hash,_tlw_get_diff,'\
'_tlw_version,_tlw_diffs_per_snapshot,'\
'_tlw_out_ptr,_tlw_out_len,_tlw_image_ptr,_tlw_image_len'

emcc c/binjson.c c/diff.c c/textlog.c c/textlog_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createTextlogModule \
  -sEXPORTED_FUNCTIONS="$TL_EXPORTS" \
  -o lib/textlog-core.mjs

echo "built lib/textlog-core.mjs ($(wc -c < lib/textlog-core.wasm) bytes wasm)"

# Standalone diff engine (jsdiff port) for the browser demo (public/diff.html)
# and src/diff-wasm.js. diff.c has no other dependencies.
DF_EXPORTS='_malloc,_free,_diff_create_patch,_diff_get_diff,_diff_apply_patch'

emcc c/diff.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createDiffModule \
  -sEXPORTED_FUNCTIONS="$DF_EXPORTS" \
  -o lib/diff-core.mjs

echo "built lib/diff-core.mjs ($(wc -c < lib/diff-core.wasm) bytes wasm)"

# Standalone Porter stemmer (stemmer@2.0.1 port) for src/stemmer-wasm.js and the
# eventual textindex WASM port. stemmer.c has no other dependencies.
ST_EXPORTS='_malloc,_free,_stemmer_stem'

emcc c/stemmer.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createStemmerModule \
  -sEXPORTED_FUNCTIONS="$ST_EXPORTS" \
  -o lib/stemmer-core.mjs

echo "built lib/stemmer-core.mjs ($(wc -c < lib/stemmer-core.wasm) bytes wasm)"

# Full-text index: textindex.c on top of the B+ tree, binjson and stemmer ports.
# Exports the bplustree glue too, so the JS shim can manage the three tree files.
TI_EXPORTS='_malloc,_free,'\
'_bptw_create,_bptw_load,_bptw_free,'\
'_bptw_add,_bptw_delete,_bptw_search,_bptw_entries,_bptw_range,_bptw_height,'\
'_bptw_size,_bptw_root,_bptw_next_id,_bptw_order,'\
'_bptw_out_ptr,_bptw_out_len,_bptw_image_ptr,_bptw_image_len,'\
'_tixw_add,_tixw_remove,_tixw_clear,_tixw_query,_tixw_query_all,'\
'_tixw_out_ptr,_tixw_out_len'

emcc c/binjson.c c/bplustree.c c/bplustree_wasm.c c/stemmer.c c/textindex.c c/textindex_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createTextindexModule \
  -sEXPORTED_FUNCTIONS="$TI_EXPORTS" \
  -o lib/textindex-core.mjs

echo "built lib/textindex-core.mjs ($(wc -c < lib/textindex-core.wasm) bytes wasm)"
