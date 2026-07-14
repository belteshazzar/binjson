#!/usr/bin/env bash
# Build a single combined WASM module with Emscripten. All C sources
# (binjson, bplustree, diff, rtree, stemmer, textindex, textlog) are linked into
# one binary, lib/binjson.wasm + lib/binjson.wasm.mjs (the ES module loader),
# which every src/*-wasm.js wrapper loads via ../lib. Requires `emcc` on PATH
# (emsdk).
set -euo pipefail

# Output into lib/ (gitignored). These generated artifacts are shipped with the
# package via the "files" allowlist in package.json and rebuilt on prepack.
cd "$(dirname "$0")/.."
mkdir -p lib

# Flags shared by every module. The tree traversals recurse up to their
# depth caps (BPT_MAX_DEPTH / RT_MAX_DEPTH = 128) on corrupt files before
# erroring out; the default 64 KB stack silently overflows into the heap at
# that depth, so give the stack real headroom and make any future overflow
# trap loudly instead of corrupting memory.
COMMON_FLAGS=(
  -O3
  -flto
  -Ithird_party/regex-engine/include
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=1048576
  -sSTACK_OVERFLOW_CHECK=1
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_RUNTIME_METHODS=HEAPU8
  -sALLOW_TABLE_GROWTH=0
  -sFILESYSTEM=0
  --no-entry
)

# build_module <name> <EXPORT_NAME> <exported_functions> <source.c...>
#
# emcc names the wasm binary after the -o target's base, so we emit lib/<name>.mjs
# (binary -> lib/<name>.wasm) and then rename the loader to lib/<name>.wasm.mjs.
# The loader references the binary by a relative URL, so the rename is safe.
build_module() {
  local name=$1 export_name=$2 exports=$3
  shift 3
  emcc "$@" \
    "${COMMON_FLAGS[@]}" \
    -sEXPORT_NAME="$export_name" \
    -sEXPORTED_FUNCTIONS="$exports" \
    -o "lib/$name.mjs"
  mv "lib/$name.mjs" "lib/$name.wasm.mjs"
  echo "built lib/$name.wasm.mjs ($(wc -c < "lib/$name.wasm") bytes wasm)"
}

# Union of every component's exported functions. _malloc/_free and the bptw_*
# glue (shared by bplustree and textindex) appear once.
ALL_EXPORTS='_malloc,_free,'\
`# binjson`\
'_bjw_enc_reset,_bjw_put_null,_bjw_put_bool,_bjw_put_int,_bjw_put_float,'\
'_bjw_put_date,_bjw_put_pointer,_bjw_put_string,_bjw_put_binary,_bjw_put_oid,'\
'_bjw_put_key,_bjw_begin_array,_bjw_end_array,_bjw_begin_object,_bjw_end_object,'\
'_bjw_enc_finish,_bjw_enc_ptr,_bjw_enc_size,'\
'_bjw_decode,_bjw_events_ptr,_bjw_events_len,_bjw_consumed,_bjw_value_size,'\
`# bplustree (also used by textindex)`\
'_bptw_create,_bptw_open,_bptw_free,'\
'_bptw_snapshot,_bptw_open_at,_bptw_boundaries,_bptw_is_snapshot,'\
'_bptw_add,_bptw_delete,_bptw_search,_bptw_entries,_bptw_range,_bptw_height,_bptw_verify,_bptw_compact,'\
'_bptw_cursor_open,_bptw_cursor_next,_bptw_cursor_free,'\
'_bptw_size,_bptw_root,_bptw_next_id,_bptw_order,'\
'_bptw_out_ptr,_bptw_out_len,'\
`# rtree`\
'_rtw_create,_rtw_open,_rtw_free,'\
'_rtw_insert,_rtw_remove,_rtw_remove_at,_rtw_clear,_rtw_search,_rtw_search_radius,_rtw_haversine,_rtw_compact,'\
'_rtw_cursor_open,_rtw_cursor_next,_rtw_cursor_free,_rtw_nearest,'\
'_rtw_size,_rtw_max_entries,'\
'_rtw_out_ptr,_rtw_out_len,'\
`# textlog`\
'_tlw_create,_tlw_create_at,_tlw_open,_tlw_free,'\
'_tlw_add_version,_tlw_get_version,_tlw_get_version_hash,_tlw_get_diff,'\
'_tlw_version,_tlw_base_version,_tlw_diffs_per_snapshot,'\
'_tlw_out_ptr,_tlw_out_len,'\
`# diff`\
'_diff_create_patch,_diff_get_diff,_diff_apply_patch,'\
'_diff_create_delta,_diff_apply_delta,'\
`# stemmer`\
'_stemmer_stem,'\
`# textindex`\
'_tixw_recover,_tixw_add,_tixw_remove,_tixw_clear,_tixw_query,_tixw_query_all,_tixw_term_count,'\
'_tixw_out_new,_tixw_out_free,_tixw_out_ptr,_tixw_out_len,'\
`# db (document collections, on top of bplustree)`\
'_dcw_collection_open,_dcw_collection_free,_dcw_collection_recover,'\
'_dcw_collection_attach_index,_dcw_collection_add_index,_dcw_collection_remove_index,'\
'_dcw_collection_attach_text_index,_dcw_collection_add_text_index,'\
'_dcw_collection_attach_geo_index,_dcw_collection_add_geo_index,'\
'_dcw_find_by_index,'\
'_dcw_insert_one,_dcw_insert_many,_dcw_find_one,_dcw_find,_dcw_delete_one,_dcw_delete_many,'\
'_dcw_cursor_open,_dcw_cursor_next_batch,_dcw_cursor_close,'\
'_dcw_replace_one,_dcw_count,_dcw_distinct,'\
'_dcw_update_one,_dcw_update_many,'\
'_dcw_find_one_and_update,_dcw_find_one_and_replace,_dcw_find_one_and_delete,'\
'_dcw_out_new,_dcw_out_free,_dcw_out_ptr,_dcw_out_len'

# Every C source, each listed once. c/test_binjson.c is a native test harness
# with its own main() and is deliberately excluded.
#
# third_party/regex-engine's two sources are regex.c's actual engine (see
# regex.c's own top comment for why it's a thin adapter over them, not a
# replacement written from scratch) -- not exported to JS themselves
# (EXPORTED_FUNCTIONS below has no _regex_* entries), reachable only via
# regex.c's rx_match, which is reachable via db_query.c from the exported
# _dcw_* entry points, so normal reachability-based dead-code elimination
# keeps them without needing to be listed as roots.
ALL_SOURCES=(
  c/binjson.c c/binjson_wasm.c
  c/bjfile.c c/hostio.c
  c/bplustree.c c/bplustree_wasm.c
  c/geo.c c/rtree.c c/rtree_wasm.c
  c/diff.c c/textlog.c c/textlog_wasm.c
  c/stemmer.c c/textindex.c c/textindex_wasm.c
  c/db_keyenc.c c/regex.c c/db_query.c c/db_update.c c/db.c c/db_wasm.c
  third_party/regex-engine/src/regexp.c third_party/regex-engine/src/regex_wasm.c
)

build_module binjson createBinjsonModule "$ALL_EXPORTS" "${ALL_SOURCES[@]}"
