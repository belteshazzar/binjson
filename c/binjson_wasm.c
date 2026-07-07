/*
 * binjson_wasm.c — Emscripten glue over the host-agnostic codec in binjson.c.
 *
 * Bridge design (see FORMAT.md and binjson.h):
 *   Encode: the JS host walks its value graph and calls the bjw_put_* / bjw_*
 *           builder functions on a singleton bj_builder. bjw_enc_finish then
 *           exposes the finished bytes via bjw_enc_ptr / bjw_enc_size.
 *   Decode: bjw_decode parses the input with the Phase 2 reader and re-emits a
 *           flat "event stream" into a buffer that JS replays. This keeps all
 *           parsing/bounds-checking/range-guards in C while avoiding JS<->WASM
 *           function-pointer imports. Event tags are the BJW_EV_* values below;
 *           the JS side mirrors them.
 *
 * Memory notes for the JS caller:
 *   - Heap growth may swap the backing ArrayBuffer, so always re-read HEAPU8
 *     after any call before touching a returned pointer.
 *   - The encode and event buffers are owned by C and reused on the next call;
 *     copy the bytes out before calling again.
 */
#include "binjson.h"

#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/* Event tags for the decode stream. Mirrored in src/binjson-wasm.js. */
#define BJW_EV_NULL      0
#define BJW_EV_FALSE     1
#define BJW_EV_TRUE      2
#define BJW_EV_INT       3  /* + f64 (8 bytes, native/LE)          */
#define BJW_EV_FLOAT     4  /* + f64                                */
#define BJW_EV_STRING    5  /* + u32 len (LE) + bytes               */
#define BJW_EV_OID       6  /* + 12 bytes                           */
#define BJW_EV_DATE      7  /* + f64                                */
#define BJW_EV_POINTER   8  /* + f64                                */
#define BJW_EV_BINARY    9  /* + u32 len (LE) + bytes               */
#define BJW_EV_ARR_BEGIN 10 /* + u32 count (LE)                     */
#define BJW_EV_ARR_END   11
#define BJW_EV_OBJ_BEGIN 12 /* + u32 count (LE)                     */
#define BJW_EV_KEY       13 /* + u32 len (LE) + bytes               */
#define BJW_EV_OBJ_END   14

/* ---- Encode: singleton builder -------------------------------------- */

static bj_builder *g_enc = NULL;
static const uint8_t *g_enc_ptr = NULL;
static size_t g_enc_len = 0;

static bj_builder *enc(void) {
    if (!g_enc) g_enc = bj_builder_new();
    return g_enc;
}

EMSCRIPTEN_KEEPALIVE int bjw_enc_reset(void) {
    bj_builder *b = enc();
    if (!b) return BJ_ERR_OOM;
    bj_builder_reset(b);
    g_enc_ptr = NULL;
    g_enc_len = 0;
    return BJ_OK;
}

EMSCRIPTEN_KEEPALIVE int bjw_put_null(void)          { return bj_put_null(enc()); }
EMSCRIPTEN_KEEPALIVE int bjw_put_bool(int t)         { return bj_put_bool(enc(), t); }
EMSCRIPTEN_KEEPALIVE int bjw_put_int(double v)       { return bj_put_int(enc(), (int64_t)v); }
EMSCRIPTEN_KEEPALIVE int bjw_put_float(double v)     { return bj_put_float(enc(), v); }
EMSCRIPTEN_KEEPALIVE int bjw_put_date(double ms)     { return bj_put_date(enc(), (int64_t)ms); }
EMSCRIPTEN_KEEPALIVE int bjw_put_pointer(double off) { return bj_put_pointer(enc(), (uint64_t)off); }

EMSCRIPTEN_KEEPALIVE int bjw_put_string(const uint8_t *p, int n) {
    return bj_put_string(enc(), p, (uint32_t)n);
}
EMSCRIPTEN_KEEPALIVE int bjw_put_binary(const uint8_t *p, int n) {
    return bj_put_binary(enc(), p, (uint32_t)n);
}
EMSCRIPTEN_KEEPALIVE int bjw_put_oid(const uint8_t *p12) {
    return bj_put_oid(enc(), p12);
}
EMSCRIPTEN_KEEPALIVE int bjw_put_key(const uint8_t *p, int n) {
    return bj_put_key(enc(), p, (uint32_t)n);
}

EMSCRIPTEN_KEEPALIVE int bjw_begin_array(void)  { return bj_begin_array(enc()); }
EMSCRIPTEN_KEEPALIVE int bjw_end_array(void)    { return bj_end_array(enc()); }
EMSCRIPTEN_KEEPALIVE int bjw_begin_object(void) { return bj_begin_object(enc()); }
EMSCRIPTEN_KEEPALIVE int bjw_end_object(void)   { return bj_end_object(enc()); }

/* Finalize: capture the finished bytes. Returns length, or negative error. */
EMSCRIPTEN_KEEPALIVE int bjw_enc_finish(void) {
    size_t len = 0;
    const uint8_t *d = bj_builder_data(enc(), &len);
    if (!d) {
        int e = bj_builder_error(enc());
        return e ? e : BJ_ERR_STATE;
    }
    g_enc_ptr = d;
    g_enc_len = len;
    return (int)len;
}
EMSCRIPTEN_KEEPALIVE const uint8_t *bjw_enc_ptr(void) { return g_enc_ptr; }
EMSCRIPTEN_KEEPALIVE int bjw_enc_size(void)           { return (int)g_enc_len; }

/* ---- Decode: reader -> event buffer --------------------------------- */

typedef struct {
    uint8_t *buf;
    size_t   len;
    size_t   cap;
    int      error;
} ev_writer;

static void ev_ensure(ev_writer *w, size_t extra) {
    if (w->error) return;
    if (w->len + extra <= w->cap) return;
    size_t nc = w->cap ? w->cap : 128;
    while (nc < w->len + extra) nc *= 2;
    uint8_t *nb = (uint8_t *)realloc(w->buf, nc);
    if (!nb) { w->error = BJ_ERR_OOM; return; }
    w->buf = nb;
    w->cap = nc;
}
static void ev_u8(ev_writer *w, uint8_t b) {
    ev_ensure(w, 1);
    if (w->error) return;
    w->buf[w->len++] = b;
}
static void ev_u32(ev_writer *w, uint32_t v) {
    ev_ensure(w, 4);
    if (w->error) return;
    w->buf[w->len++] = (uint8_t)(v);
    w->buf[w->len++] = (uint8_t)(v >> 8);
    w->buf[w->len++] = (uint8_t)(v >> 16);
    w->buf[w->len++] = (uint8_t)(v >> 24);
}
static void ev_f64(ev_writer *w, double d) {
    ev_ensure(w, 8);
    if (w->error) return;
    memcpy(w->buf + w->len, &d, 8); /* consumed via DataView(..., true) on LE wasm */
    w->len += 8;
}
static void ev_bytes(ev_writer *w, const uint8_t *p, uint32_t n) {
    ev_ensure(w, n);
    if (w->error) return;
    if (n) memcpy(w->buf + w->len, p, n);
    w->len += n;
}

static void ev_on_null(void *c)                { ev_u8(c, BJW_EV_NULL); }
static void ev_on_bool(void *c, int t)         { ev_u8(c, t ? BJW_EV_TRUE : BJW_EV_FALSE); }
static void ev_on_int(void *c, double v)       { ev_u8(c, BJW_EV_INT); ev_f64(c, v); }
static void ev_on_float(void *c, double v)     { ev_u8(c, BJW_EV_FLOAT); ev_f64(c, v); }
static void ev_on_string(void *c, const uint8_t *p, uint32_t n) { ev_u8(c, BJW_EV_STRING); ev_u32(c, n); ev_bytes(c, p, n); }
static void ev_on_binary(void *c, const uint8_t *p, uint32_t n) { ev_u8(c, BJW_EV_BINARY); ev_u32(c, n); ev_bytes(c, p, n); }
static void ev_on_oid(void *c, const uint8_t *p12) { ev_u8(c, BJW_EV_OID); ev_bytes(c, p12, 12); }
static void ev_on_date(void *c, double v)      { ev_u8(c, BJW_EV_DATE); ev_f64(c, v); }
static void ev_on_pointer(void *c, double v)   { ev_u8(c, BJW_EV_POINTER); ev_f64(c, v); }
static void ev_on_arr_begin(void *c, uint32_t n) { ev_u8(c, BJW_EV_ARR_BEGIN); ev_u32(c, n); }
static void ev_on_arr_end(void *c)             { ev_u8(c, BJW_EV_ARR_END); }
static void ev_on_obj_begin(void *c, uint32_t n) { ev_u8(c, BJW_EV_OBJ_BEGIN); ev_u32(c, n); }
static void ev_on_key(void *c, const uint8_t *p, uint32_t n) { ev_u8(c, BJW_EV_KEY); ev_u32(c, n); ev_bytes(c, p, n); }
static void ev_on_obj_end(void *c)             { ev_u8(c, BJW_EV_OBJ_END); }

static uint8_t *g_events = NULL;
static size_t   g_events_len = 0;
static size_t   g_consumed = 0;

/*
 * Decode `len` bytes at `data`. On success returns 0 and exposes the event
 * stream via bjw_events_ptr/bjw_events_len (and bytes consumed via
 * bjw_consumed). On failure returns a negative BJ_ERR_* code.
 */
EMSCRIPTEN_KEEPALIVE int bjw_decode(const uint8_t *data, int len) {
    ev_writer w = { NULL, 0, 0, BJ_OK };
    bj_visitor v = {
        ev_on_null, ev_on_bool, ev_on_int, ev_on_float, ev_on_string,
        ev_on_binary, ev_on_oid, ev_on_date, ev_on_pointer,
        ev_on_arr_begin, ev_on_arr_end, ev_on_obj_begin, ev_on_key,
        ev_on_obj_end, &w
    };
    size_t consumed = 0;
    int e = bj_decode(data, (size_t)len, &v, &consumed);
    if (e) { free(w.buf); return e; }
    if (w.error) { free(w.buf); return w.error; }

    free(g_events);
    g_events = w.buf;
    g_events_len = w.len;
    g_consumed = consumed;
    return 0;
}
EMSCRIPTEN_KEEPALIVE const uint8_t *bjw_events_ptr(void) { return g_events; }
EMSCRIPTEN_KEEPALIVE int bjw_events_len(void)            { return (int)g_events_len; }
EMSCRIPTEN_KEEPALIVE int bjw_consumed(void)             { return (int)g_consumed; }

/* Total on-wire size of the value at data[pos]; writes size via out param
 * pointer (4 bytes, LE). Returns 0 on success or a negative BJ_ERR_* code. */
EMSCRIPTEN_KEEPALIVE int bjw_value_size(const uint8_t *data, int len, int pos, uint8_t *out4) {
    size_t sz = 0;
    int e = bj_value_size(data, (size_t)len, (size_t)pos, &sz);
    if (e) return e;
    out4[0] = (uint8_t)(sz);
    out4[1] = (uint8_t)(sz >> 8);
    out4[2] = (uint8_t)(sz >> 16);
    out4[3] = (uint8_t)(sz >> 24);
    return 0;
}
