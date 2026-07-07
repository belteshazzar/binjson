/*
 * binjson.h — C codec for the binjson binary format.
 *
 * This is a host-agnostic port of the reference codec in src/binjson.js.
 * The wire format is specified in FORMAT.md and this code must stay
 * byte-for-byte compatible with it.
 *
 * Two halves:
 *   - Builder (encode): a streaming builder. The host walks its value graph
 *     and calls bj_put_* / bj_begin_* / bj_end_* in document order. The
 *     builder owns a growable output buffer and back-patches container sizes.
 *   - Decoder (decode): a bounds-checked reader that walks an encoded buffer
 *     and drives a bj_visitor callback struct. The host turns the callback
 *     stream back into its own value types.
 *
 * The JS <-> WASM glue (Phase 3) is a thin adapter on top of this API.
 */
#ifndef BINJSON_H
#define BINJSON_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Type bytes (see FORMAT.md) ------------------------------------- */
#define BJ_TYPE_NULL    0x00
#define BJ_TYPE_FALSE   0x01
#define BJ_TYPE_TRUE    0x02
#define BJ_TYPE_INT     0x03
#define BJ_TYPE_FLOAT   0x04
#define BJ_TYPE_STRING  0x05
#define BJ_TYPE_OID     0x06
#define BJ_TYPE_DATE    0x07
#define BJ_TYPE_POINTER 0x08
#define BJ_TYPE_BINARY  0x09
#define BJ_TYPE_ARRAY   0x10
#define BJ_TYPE_OBJECT  0x11

/* JS Number.MAX_SAFE_INTEGER / MIN_SAFE_INTEGER == +/- (2^53 - 1). */
#define BJ_MAX_SAFE_INT   9007199254740991LL
#define BJ_MIN_SAFE_INT  (-9007199254740991LL)

/* Guard against unbounded recursion on hostile nested input. */
#ifndef BJ_MAX_DEPTH
#define BJ_MAX_DEPTH 1000
#endif

/* ---- Error codes ---------------------------------------------------- */
#define BJ_OK                 0
#define BJ_ERR_OOM           (-1)  /* allocation failed                   */
#define BJ_ERR_STATE         (-2)  /* builder misuse (bad begin/end/key)  */
#define BJ_ERR_EOF           (-3)  /* unexpected end of input on decode   */
#define BJ_ERR_UNKNOWN_TYPE  (-4)  /* unknown type byte on decode         */
#define BJ_ERR_INT_RANGE     (-5)  /* INT outside JS safe-integer range   */
#define BJ_ERR_POINTER_RANGE (-6)  /* POINTER outside JS safe-int range   */
#define BJ_ERR_DEPTH         (-7)  /* nesting exceeded BJ_MAX_DEPTH        */

/* ---- Builder (encode) ----------------------------------------------- */
typedef struct bj_builder bj_builder;

/* Allocate a new builder, or NULL on OOM. */
bj_builder *bj_builder_new(void);
/* Free a builder and its buffer. Safe to pass NULL. */
void        bj_builder_free(bj_builder *b);
/* Reset a builder to empty so it can be reused for another value. */
void        bj_builder_reset(bj_builder *b);
/* Sticky error code: nonzero once any call has failed. */
int         bj_builder_error(const bj_builder *b);

/*
 * Access the finished bytes. Returns a pointer to the buffer and writes its
 * length through *len. Returns NULL if the builder is in an error state or a
 * container is still open (unbalanced begin/end). The pointer is owned by the
 * builder and invalidated by any further mutation or by bj_builder_free.
 */
const uint8_t *bj_builder_data(const bj_builder *b, size_t *len);

/* Primitive values. All return an error code (BJ_OK on success). */
int bj_put_null(bj_builder *b);
int bj_put_bool(bj_builder *b, int truthy);
int bj_put_int(bj_builder *b, int64_t v);        /* -> INT  (i64)          */
int bj_put_float(bj_builder *b, double v);       /* -> FLOAT (f64)         */
int bj_put_string(bj_builder *b, const uint8_t *utf8, uint32_t len);
int bj_put_binary(bj_builder *b, const uint8_t *bytes, uint32_t len);
int bj_put_oid(bj_builder *b, const uint8_t *bytes12);  /* exactly 12 bytes */
int bj_put_date(bj_builder *b, int64_t millis);  /* -> DATE (i64 ms)       */
int bj_put_pointer(bj_builder *b, uint64_t off); /* -> POINTER (u64)       */

/* Containers. Elements/entries emitted between begin and end. */
int bj_begin_array(bj_builder *b);
int bj_end_array(bj_builder *b);
int bj_begin_object(bj_builder *b);
/* Emit an object key (no type byte). Must be followed by exactly one value. */
int bj_put_key(bj_builder *b, const uint8_t *utf8, uint32_t len);
int bj_end_object(bj_builder *b);

/* ---- Decoder (decode) ----------------------------------------------- */

/*
 * Visitor callbacks invoked while decoding. `ctx` is passed through opaquely.
 * on_int / on_pointer / on_date receive doubles: INT and POINTER are range-
 * checked before the callback (values outside JS safe-integer range abort the
 * decode with BJ_ERR_INT_RANGE / BJ_ERR_POINTER_RANGE, matching the reference),
 * so the double is lossless. DATE mirrors the reference's Number(ms) narrowing
 * and is not range-checked. String/binary/key pointers point into the input
 * buffer and are only valid for the duration of the callback.
 */
typedef struct bj_visitor {
    void (*on_null)(void *ctx);
    void (*on_bool)(void *ctx, int truthy);
    void (*on_int)(void *ctx, double v);
    void (*on_float)(void *ctx, double v);
    void (*on_string)(void *ctx, const uint8_t *utf8, uint32_t len);
    void (*on_binary)(void *ctx, const uint8_t *bytes, uint32_t len);
    void (*on_oid)(void *ctx, const uint8_t *bytes12);
    void (*on_date)(void *ctx, double millis);
    void (*on_pointer)(void *ctx, double off);
    void (*on_array_begin)(void *ctx, uint32_t count);
    void (*on_array_end)(void *ctx);
    void (*on_object_begin)(void *ctx, uint32_t count);
    void (*on_key)(void *ctx, const uint8_t *utf8, uint32_t len);
    void (*on_object_end)(void *ctx);
    void *ctx;
} bj_visitor;

/*
 * Decode a single value starting at data[0]. Drives v's callbacks. On success
 * returns BJ_OK and, if `consumed` is non-NULL, writes the number of bytes the
 * value occupied (letting callers walk concatenated top-level values). On
 * failure returns a BJ_ERR_* code; callbacks may have already fired.
 */
int bj_decode(const uint8_t *data, size_t len, const bj_visitor *v, size_t *consumed);

/*
 * Compute the total on-wire size of the value at data[pos] without decoding it,
 * using the value-size rules in FORMAT.md. Writes the size through *out_size.
 * Returns BJ_OK, or BJ_ERR_EOF / BJ_ERR_UNKNOWN_TYPE.
 */
int bj_value_size(const uint8_t *data, size_t len, size_t pos, size_t *out_size);

#ifdef __cplusplus
}
#endif

#endif /* BINJSON_H */
