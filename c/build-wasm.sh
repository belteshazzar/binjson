#!/usr/bin/env bash
# Build the binjson WASM codec with Emscripten.
# Produces dist/wasm/binjson-core.mjs + binjson-core.wasm (loaded by
# src/binjson-wasm.js). Requires `emcc` on PATH (emsdk).
set -euo pipefail

# Output into src/ so the artifacts ship with the package (dist/ is gitignored
# and npmignored).
cd "$(dirname "$0")/.."
mkdir -p src/wasm

EXPORTS='_malloc,_free,'\
'_bjw_enc_reset,_bjw_put_null,_bjw_put_bool,_bjw_put_int,_bjw_put_float,'\
'_bjw_put_date,_bjw_put_pointer,_bjw_put_string,_bjw_put_binary,_bjw_put_oid,'\
'_bjw_put_key,_bjw_begin_array,_bjw_end_array,_bjw_begin_object,_bjw_end_object,'\
'_bjw_enc_finish,_bjw_enc_ptr,_bjw_enc_size,'\
'_bjw_decode,_bjw_events_ptr,_bjw_events_len,_bjw_consumed,_bjw_value_size'

emcc c/binjson.c c/binjson_wasm.c \
  -O3 \
  -flto \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createBinjsonModule \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sALLOW_TABLE_GROWTH=0 \
  -sFILESYSTEM=0 \
  --no-entry \
  -o src/wasm/binjson-core.mjs

echo "built src/wasm/binjson-core.mjs ($(wc -c < src/wasm/binjson-core.wasm) bytes wasm)"
