/*
 * binjson.c — implementation of the binjson C codec. See binjson.h and
 * FORMAT.md. Kept free of any host/Emscripten dependency so it builds and
 * unit-tests with a plain C compiler; only the standard library is used.
 */
#include "binjson.h"

#include <stdlib.h>
#include <string.h>

/* ---- Little-endian scalar helpers (endian-independent) --------------- */

static void wr_u32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void wr_u64le(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) {
        p[i] = (uint8_t)(v & 0xFF);
        v >>= 8;
    }
}

static uint32_t rd_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t rd_u64le(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 7; i >= 0; i--) {
        v = (v << 8) | p[i];
    }
    return v;
}

/* ---- Builder --------------------------------------------------------- */

typedef struct {
    size_t   size_pos;    /* offset of the 4-byte contentSize field       */
    uint32_t count;       /* direct child values so far                   */
    int      is_object;   /* container kind                               */
    int      pending_key; /* object only: a key awaits its value          */
} bj_frame;

struct bj_builder {
    uint8_t  *buf;
    size_t    len;
    size_t    cap;
    bj_frame *frames;
    int       depth;
    int       frame_cap;
    int       error;      /* sticky */
};

static int bld_ensure(bj_builder *b, size_t extra) {
    if (b->len + extra <= b->cap) return BJ_OK;
    size_t ncap = b->cap ? b->cap : 64;
    while (ncap < b->len + extra) ncap *= 2;
    uint8_t *nb = (uint8_t *)realloc(b->buf, ncap);
    if (!nb) return BJ_ERR_OOM;
    b->buf = nb;
    b->cap = ncap;
    return BJ_OK;
}

static int bld_append(bj_builder *b, const uint8_t *p, size_t n) {
    int e = bld_ensure(b, n);
    if (e) return e;
    memcpy(b->buf + b->len, p, n);
    b->len += n;
    return BJ_OK;
}

/*
 * Called at the start of every value. Counts the value against its enclosing
 * container and enforces object key/value alternation.
 */
static int bld_note_value(bj_builder *b) {
    if (b->depth > 0) {
        bj_frame *f = &b->frames[b->depth - 1];
        if (f->is_object) {
            if (!f->pending_key) return BJ_ERR_STATE; /* value without key */
            f->pending_key = 0;
        }
        f->count++;
    }
    return BJ_OK;
}

static int bld_push_frame(bj_builder *b, size_t size_pos, int is_object) {
    if (b->depth >= BJ_MAX_DEPTH) return BJ_ERR_DEPTH;
    if (b->depth == b->frame_cap) {
        int nc = b->frame_cap ? b->frame_cap * 2 : 16;
        bj_frame *nf = (bj_frame *)realloc(b->frames, (size_t)nc * sizeof(bj_frame));
        if (!nf) return BJ_ERR_OOM;
        b->frames = nf;
        b->frame_cap = nc;
    }
    bj_frame *f = &b->frames[b->depth++];
    f->size_pos = size_pos;
    f->count = 0;
    f->is_object = is_object;
    f->pending_key = 0;
    return BJ_OK;
}

bj_builder *bj_builder_new(void) {
    bj_builder *b = (bj_builder *)calloc(1, sizeof(bj_builder));
    return b;
}

void bj_builder_free(bj_builder *b) {
    if (!b) return;
    free(b->buf);
    free(b->frames);
    free(b);
}

void bj_builder_reset(bj_builder *b) {
    if (!b) return;
    b->len = 0;
    b->depth = 0;
    b->error = BJ_OK;
}

int bj_builder_error(const bj_builder *b) {
    return b ? b->error : BJ_ERR_STATE;
}

const uint8_t *bj_builder_data(const bj_builder *b, size_t *len) {
    if (!b || b->error || b->depth != 0) return NULL;
    if (len) *len = b->len;
    return b->buf;
}

/* Set and return the sticky error in one step. */
static int bld_fail(bj_builder *b, int e) {
    if (e && !b->error) b->error = e;
    return b->error;
}

/* Emit a value that is a single type byte plus `n` payload bytes. */
static int bld_put_scalar(bj_builder *b, const uint8_t *bytes, size_t n) {
    if (b->error) return b->error;
    int e = bld_note_value(b);
    if (e) return bld_fail(b, e);
    return bld_fail(b, bld_append(b, bytes, n));
}

int bj_put_null(bj_builder *b) {
    uint8_t t = BJ_TYPE_NULL;
    return bld_put_scalar(b, &t, 1);
}

int bj_put_bool(bj_builder *b, int truthy) {
    uint8_t t = truthy ? BJ_TYPE_TRUE : BJ_TYPE_FALSE;
    return bld_put_scalar(b, &t, 1);
}

int bj_put_int(bj_builder *b, int64_t v) {
    uint8_t tmp[9];
    tmp[0] = BJ_TYPE_INT;
    wr_u64le(tmp + 1, (uint64_t)v);
    return bld_put_scalar(b, tmp, sizeof(tmp));
}

int bj_put_float(bj_builder *b, double v) {
    uint8_t tmp[9];
    uint64_t bits;
    memcpy(&bits, &v, 8);
    tmp[0] = BJ_TYPE_FLOAT;
    wr_u64le(tmp + 1, bits);
    return bld_put_scalar(b, tmp, sizeof(tmp));
}

int bj_put_date(bj_builder *b, int64_t millis) {
    uint8_t tmp[9];
    tmp[0] = BJ_TYPE_DATE;
    wr_u64le(tmp + 1, (uint64_t)millis);
    return bld_put_scalar(b, tmp, sizeof(tmp));
}

int bj_put_pointer(bj_builder *b, uint64_t off) {
    uint8_t tmp[9];
    tmp[0] = BJ_TYPE_POINTER;
    wr_u64le(tmp + 1, off);
    return bld_put_scalar(b, tmp, sizeof(tmp));
}

int bj_put_oid(bj_builder *b, const uint8_t *bytes12) {
    if (b->error) return b->error;
    int e = bld_note_value(b);
    if (e) return bld_fail(b, e);
    uint8_t t = BJ_TYPE_OID;
    if ((e = bld_append(b, &t, 1))) return bld_fail(b, e);
    return bld_fail(b, bld_append(b, bytes12, 12));
}

/* Emit a length-prefixed byte run for STRING / BINARY. */
static int bld_put_lenpref(bj_builder *b, uint8_t type,
                           const uint8_t *bytes, uint32_t len) {
    if (b->error) return b->error;
    int e = bld_note_value(b);
    if (e) return bld_fail(b, e);
    uint8_t hdr[5];
    hdr[0] = type;
    wr_u32le(hdr + 1, len);
    if ((e = bld_append(b, hdr, sizeof(hdr)))) return bld_fail(b, e);
    if (len && (e = bld_append(b, bytes, len))) return bld_fail(b, e);
    return BJ_OK;
}

int bj_put_raw(bj_builder *b, const uint8_t *bytes, uint32_t len) {
    if (b->error) return b->error;
    int e = bld_note_value(b);
    if (e) return bld_fail(b, e);
    return bld_fail(b, bld_append(b, bytes, len));
}

int bj_put_string(bj_builder *b, const uint8_t *utf8, uint32_t len) {
    return bld_put_lenpref(b, BJ_TYPE_STRING, utf8, len);
}

int bj_put_binary(bj_builder *b, const uint8_t *bytes, uint32_t len) {
    return bld_put_lenpref(b, BJ_TYPE_BINARY, bytes, len);
}

/* Open a container: type byte + reserved contentSize(4) + count(4). */
static int bld_begin_container(bj_builder *b, uint8_t type, int is_object) {
    if (b->error) return b->error;
    int e = bld_note_value(b);
    if (e) return bld_fail(b, e);
    uint8_t hdr[9] = { type, 0, 0, 0, 0, 0, 0, 0, 0 };
    size_t size_pos = b->len + 1; /* contentSize field follows the type byte */
    if ((e = bld_append(b, hdr, sizeof(hdr)))) return bld_fail(b, e);
    return bld_fail(b, bld_push_frame(b, size_pos, is_object));
}

/* Close a container: back-patch contentSize and count. */
static int bld_end_container(bj_builder *b, int is_object) {
    if (b->error) return b->error;
    if (b->depth == 0 || b->frames[b->depth - 1].is_object != is_object)
        return bld_fail(b, BJ_ERR_STATE);
    bj_frame f = b->frames[b->depth - 1];
    if (f.is_object && f.pending_key) /* dangling key with no value */
        return bld_fail(b, BJ_ERR_STATE);
    b->depth--;
    /* contentSize = bytes after the size field = count field (4) + children. */
    size_t content = b->len - (f.size_pos + 4);
    if (content > 0xFFFFFFFFu) return bld_fail(b, BJ_ERR_STATE);
    wr_u32le(b->buf + f.size_pos, (uint32_t)content);
    wr_u32le(b->buf + f.size_pos + 4, f.count);
    return BJ_OK;
}

int bj_begin_array(bj_builder *b)  { return bld_begin_container(b, BJ_TYPE_ARRAY, 0); }
int bj_end_array(bj_builder *b)    { return bld_end_container(b, 0); }
int bj_begin_object(bj_builder *b) { return bld_begin_container(b, BJ_TYPE_OBJECT, 1); }
int bj_end_object(bj_builder *b)   { return bld_end_container(b, 1); }

int bj_put_key(bj_builder *b, const uint8_t *utf8, uint32_t len) {
    if (b->error) return b->error;
    if (b->depth == 0) return bld_fail(b, BJ_ERR_STATE);
    bj_frame *f = &b->frames[b->depth - 1];
    if (!f->is_object || f->pending_key) return bld_fail(b, BJ_ERR_STATE);
    uint8_t lb[4];
    wr_u32le(lb, len);
    int e;
    if ((e = bld_append(b, lb, 4))) return bld_fail(b, e);
    if (len && (e = bld_append(b, utf8, len))) return bld_fail(b, e);
    f->pending_key = 1;
    return BJ_OK;
}

/* ---- Decoder --------------------------------------------------------- */

typedef struct {
    const uint8_t *d;
    size_t         len;
    size_t         pos;
    int            depth;
} bj_reader;

static int rd_need(const bj_reader *r, size_t n) {
    return (n <= r->len - r->pos) ? BJ_OK : BJ_ERR_EOF;
}

static int bj_decode_value(bj_reader *r, const bj_visitor *v) {
    if (r->depth > BJ_MAX_DEPTH) return BJ_ERR_DEPTH;

    int e;
    if ((e = rd_need(r, 1))) return e;
    uint8_t type = r->d[r->pos++];

    switch (type) {
    case BJ_TYPE_NULL:
        v->on_null(v->ctx);
        return BJ_OK;
    case BJ_TYPE_FALSE:
        v->on_bool(v->ctx, 0);
        return BJ_OK;
    case BJ_TYPE_TRUE:
        v->on_bool(v->ctx, 1);
        return BJ_OK;

    case BJ_TYPE_INT: {
        if ((e = rd_need(r, 8))) return e;
        int64_t val = (int64_t)rd_u64le(r->d + r->pos);
        r->pos += 8;
        if (val < BJ_MIN_SAFE_INT || val > BJ_MAX_SAFE_INT) return BJ_ERR_INT_RANGE;
        v->on_int(v->ctx, (double)val);
        return BJ_OK;
    }
    case BJ_TYPE_FLOAT: {
        if ((e = rd_need(r, 8))) return e;
        uint64_t bits = rd_u64le(r->d + r->pos);
        r->pos += 8;
        double d;
        memcpy(&d, &bits, 8);
        v->on_float(v->ctx, d);
        return BJ_OK;
    }
    case BJ_TYPE_STRING: {
        if ((e = rd_need(r, 4))) return e;
        uint32_t n = rd_u32le(r->d + r->pos);
        r->pos += 4;
        if ((e = rd_need(r, n))) return e;
        v->on_string(v->ctx, r->d + r->pos, n);
        r->pos += n;
        return BJ_OK;
    }
    case BJ_TYPE_OID: {
        if ((e = rd_need(r, 12))) return e;
        v->on_oid(v->ctx, r->d + r->pos);
        r->pos += 12;
        return BJ_OK;
    }
    case BJ_TYPE_DATE: {
        if ((e = rd_need(r, 8))) return e;
        int64_t val = (int64_t)rd_u64le(r->d + r->pos);
        r->pos += 8;
        v->on_date(v->ctx, (double)val);
        return BJ_OK;
    }
    case BJ_TYPE_POINTER: {
        if ((e = rd_need(r, 8))) return e;
        uint64_t val = rd_u64le(r->d + r->pos);
        r->pos += 8;
        if (val > (uint64_t)BJ_MAX_SAFE_INT) return BJ_ERR_POINTER_RANGE;
        v->on_pointer(v->ctx, (double)val);
        return BJ_OK;
    }
    case BJ_TYPE_BINARY: {
        if ((e = rd_need(r, 4))) return e;
        uint32_t n = rd_u32le(r->d + r->pos);
        r->pos += 4;
        if ((e = rd_need(r, n))) return e;
        v->on_binary(v->ctx, r->d + r->pos, n);
        r->pos += n;
        return BJ_OK;
    }
    case BJ_TYPE_ARRAY: {
        if ((e = rd_need(r, 4))) return e;
        uint32_t size = rd_u32le(r->d + r->pos);
        r->pos += 4;
        if ((e = rd_need(r, size))) return e;   /* content within buffer     */
        if ((e = rd_need(r, 4))) return e;       /* count field               */
        uint32_t count = rd_u32le(r->d + r->pos);
        r->pos += 4;
        v->on_array_begin(v->ctx, count);
        for (uint32_t i = 0; i < count; i++) {
            r->depth++;
            e = bj_decode_value(r, v);
            r->depth--;
            if (e) return e;
        }
        v->on_array_end(v->ctx);
        return BJ_OK;
    }
    case BJ_TYPE_OBJECT: {
        if ((e = rd_need(r, 4))) return e;
        uint32_t size = rd_u32le(r->d + r->pos);
        r->pos += 4;
        if ((e = rd_need(r, size))) return e;
        if ((e = rd_need(r, 4))) return e;
        uint32_t count = rd_u32le(r->d + r->pos);
        r->pos += 4;
        v->on_object_begin(v->ctx, count);
        for (uint32_t i = 0; i < count; i++) {
            if ((e = rd_need(r, 4))) return e;
            uint32_t klen = rd_u32le(r->d + r->pos);
            r->pos += 4;
            if ((e = rd_need(r, klen))) return e;
            v->on_key(v->ctx, r->d + r->pos, klen);
            r->pos += klen;
            r->depth++;
            e = bj_decode_value(r, v);
            r->depth--;
            if (e) return e;
        }
        v->on_object_end(v->ctx);
        return BJ_OK;
    }

    default:
        return BJ_ERR_UNKNOWN_TYPE;
    }
}

int bj_decode(const uint8_t *data, size_t len, const bj_visitor *v, size_t *consumed) {
    bj_reader r = { data, len, 0, 0 };
    int e = bj_decode_value(&r, v);
    if (e) return e;
    if (consumed) *consumed = r.pos;
    return BJ_OK;
}

int bj_value_size(const uint8_t *data, size_t len, size_t pos, size_t *out_size) {
    if (pos >= len) return BJ_ERR_EOF;
    uint8_t type = data[pos];
    switch (type) {
    case BJ_TYPE_NULL:
    case BJ_TYPE_FALSE:
    case BJ_TYPE_TRUE:
        *out_size = 1;
        return BJ_OK;
    case BJ_TYPE_INT:
    case BJ_TYPE_FLOAT:
    case BJ_TYPE_DATE:
    case BJ_TYPE_POINTER:
        *out_size = 1 + 8;
        return BJ_OK;
    case BJ_TYPE_OID:
        *out_size = 1 + 12;
        return BJ_OK;
    case BJ_TYPE_STRING:
    case BJ_TYPE_BINARY: {
        if (pos + 1 + 4 > len) return BJ_ERR_EOF;
        uint32_t n = rd_u32le(data + pos + 1);
        *out_size = (size_t)1 + 4 + n;
        return BJ_OK;
    }
    case BJ_TYPE_ARRAY:
    case BJ_TYPE_OBJECT: {
        if (pos + 1 + 4 > len) return BJ_ERR_EOF;
        uint32_t sz = rd_u32le(data + pos + 1);
        *out_size = (size_t)1 + 4 + sz;
        return BJ_OK;
    }
    default:
        return BJ_ERR_UNKNOWN_TYPE;
    }
}
