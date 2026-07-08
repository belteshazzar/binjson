#!/usr/bin/env bash
# Build the WASM modules with Emscripten. Each component <name> produces
# lib/<name>.wasm.mjs (the ES module loader) + lib/<name>.wasm (the binary),
# loaded by src/<name>-wasm.js via ../lib. Requires `emcc` on PATH (emsdk).
set -euo pipefail

# Output into lib/ (gitignored). These generated artifacts are shipped with the
# package via the "files" allowlist in package.json and rebuilt on prepack.
cd "$(dirname "$0")/.."
mkdir -p lib

# Flags shared by every module.
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

BJ_EXPORTS='_malloc,_free,'\
'_bjw_enc_reset,_bjw_put_null,_bjw_put_bool,_bjw_put_int,_bjw_put_float,'\
'_bjw_put_date,_bjw_put_pointer,_bjw_put_string,_bjw_put_binary,_bjw_put_oid,'\
'_bjw_put_key,_bjw_begin_array,_bjw_end_array,_bjw_begin_object,_bjw_end_object,'\
'_bjw_enc_finish,_bjw_enc_ptr,_bjw_enc_size,'\
'_bjw_decode,_bjw_events_ptr,_bjw_events_len,_bjw_consumed,_bjw_value_size'

build_module binjson createBinjsonModule "$BJ_EXPORTS" \
  c/binjson.c c/binjson_wasm.c

BPT_EXPORTS='_malloc,_free,'\
'_bptw_create,_bptw_load,_bptw_free,'\
'_bptw_add,_bptw_delete,_bptw_search,_bptw_entries,_bptw_range,_bptw_height,'\
'_bptw_size,_bptw_root,_bptw_next_id,_bptw_order,'\
'_bptw_out_ptr,_bptw_out_len,_bptw_image_ptr,_bptw_image_len'

build_module bplustree createBplustreeModule "$BPT_EXPORTS" \
  c/binjson.c c/bplustree.c c/bplustree_wasm.c

RT_EXPORTS='_malloc,_free,'\
'_rtw_create,_rtw_load,_rtw_free,'\
'_rtw_insert,_rtw_remove,_rtw_clear,_rtw_search,_rtw_search_radius,_rtw_haversine,_rtw_compact,'\
'_rtw_size,_rtw_max_entries,'\
'_rtw_out_ptr,_rtw_out_len,_rtw_image_ptr,_rtw_image_len'

build_module rtree createRtreeModule "$RT_EXPORTS" \
  c/binjson.c c/geo.c c/rtree.c c/rtree_wasm.c

TL_EXPORTS='_malloc,_free,'\
'_tlw_create,_tlw_load,_tlw_free,'\
'_tlw_add_version,_tlw_get_version,_tlw_get_version_hash,_tlw_get_diff,'\
'_tlw_version,_tlw_diffs_per_snapshot,'\
'_tlw_out_ptr,_tlw_out_len,_tlw_image_ptr,_tlw_image_len'

build_module textlog createTextlogModule "$TL_EXPORTS" \
  c/binjson.c c/diff.c c/textlog.c c/textlog_wasm.c

# Standalone diff engine (jsdiff port) for the browser demo (public/diff.html)
# and src/diff-wasm.js. diff.c has no other dependencies.
DF_EXPORTS='_malloc,_free,_diff_create_patch,_diff_get_diff,_diff_apply_patch'

build_module diff createDiffModule "$DF_EXPORTS" \
  c/diff.c

# Standalone Porter stemmer (stemmer@2.0.1 port) for src/stemmer-wasm.js and the
# textindex WASM port. stemmer.c has no other dependencies.
ST_EXPORTS='_malloc,_free,_stemmer_stem'

build_module stemmer createStemmerModule "$ST_EXPORTS" \
  c/stemmer.c

# Full-text index: textindex.c on top of the B+ tree, binjson and stemmer ports.
# Exports the bplustree glue too, so the JS shim can manage the three tree files.
TI_EXPORTS='_malloc,_free,'\
'_bptw_create,_bptw_load,_bptw_free,'\
'_bptw_add,_bptw_delete,_bptw_search,_bptw_entries,_bptw_range,_bptw_height,'\
'_bptw_size,_bptw_root,_bptw_next_id,_bptw_order,'\
'_bptw_out_ptr,_bptw_out_len,_bptw_image_ptr,_bptw_image_len,'\
'_tixw_add,_tixw_remove,_tixw_clear,_tixw_query,_tixw_query_all,'\
'_tixw_out_ptr,_tixw_out_len'

build_module textindex createTextindexModule "$TI_EXPORTS" \
  c/binjson.c c/bplustree.c c/bplustree_wasm.c c/stemmer.c c/textindex.c c/textindex_wasm.c
