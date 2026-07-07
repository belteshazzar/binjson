/*
 * test_binjson.c — native conformance test for the binjson C codec.
 *
 * For each case it (1) builds the value with the builder API and asserts the
 * bytes are identical to the reference encoder's output (captured from
 * src/binjson.js), then (2) decodes those bytes through a re-encoding visitor
 * and asserts encode(decode(x)) == x, proving the reader/writer round-trip.
 *
 * Build & run:  cc -std=c11 -Wall -Wextra c/binjson.c c/test_binjson.c -o /tmp/bjtest && /tmp/bjtest
 */
#include "binjson.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void dump(const char *label, const uint8_t *p, size_t n) {
    fprintf(stderr, "  %s [%zu]:", label, n);
    for (size_t i = 0; i < n; i++) fprintf(stderr, " %u", p[i]);
    fprintf(stderr, "\n");
}

static int expect_bytes(const char *name, bj_builder *b,
                        const uint8_t *want, size_t want_len) {
    size_t got_len = 0;
    const uint8_t *got = bj_builder_data(b, &got_len);
    if (!got) {
        fprintf(stderr, "FAIL %s: builder error %d\n", name, bj_builder_error(b));
        failures++;
        return 0;
    }
    if (got_len != want_len || memcmp(got, want, want_len) != 0) {
        fprintf(stderr, "FAIL %s: byte mismatch\n", name);
        dump("want", want, want_len);
        dump("got ", got, got_len);
        failures++;
        return 0;
    }
    return 1;
}

/* ---- Re-encoding visitor: decode straight back into a builder --------- */

static void re_null(void *c)   { bj_put_null((bj_builder *)c); }
static void re_bool(void *c, int t) { bj_put_bool((bj_builder *)c, t); }
static void re_int(void *c, double v)   { bj_put_int((bj_builder *)c, (int64_t)v); }
static void re_float(void *c, double v) { bj_put_float((bj_builder *)c, v); }
static void re_str(void *c, const uint8_t *p, uint32_t n) { bj_put_string((bj_builder *)c, p, n); }
static void re_bin(void *c, const uint8_t *p, uint32_t n) { bj_put_binary((bj_builder *)c, p, n); }
static void re_oid(void *c, const uint8_t *p) { bj_put_oid((bj_builder *)c, p); }
static void re_date(void *c, double v)  { bj_put_date((bj_builder *)c, (int64_t)v); }
static void re_ptr(void *c, double v)   { bj_put_pointer((bj_builder *)c, (uint64_t)v); }
static void re_arr_begin(void *c, uint32_t n) { (void)n; bj_begin_array((bj_builder *)c); }
static void re_arr_end(void *c) { bj_end_array((bj_builder *)c); }
static void re_obj_begin(void *c, uint32_t n) { (void)n; bj_begin_object((bj_builder *)c); }
static void re_key(void *c, const uint8_t *p, uint32_t n) { bj_put_key((bj_builder *)c, p, n); }
static void re_obj_end(void *c) { bj_end_object((bj_builder *)c); }

static int roundtrip(const char *name, const uint8_t *bytes, size_t len) {
    bj_builder *out = bj_builder_new();
    bj_visitor v = {
        re_null, re_bool, re_int, re_float, re_str, re_bin, re_oid,
        re_date, re_ptr, re_arr_begin, re_arr_end, re_obj_begin,
        re_key, re_obj_end, out
    };
    size_t consumed = 0;
    int e = bj_decode(bytes, len, &v, &consumed);
    int ok = 1;
    if (e) {
        fprintf(stderr, "FAIL %s: decode error %d\n", name, e);
        ok = 0;
    } else if (consumed != len) {
        fprintf(stderr, "FAIL %s: consumed %zu of %zu bytes\n", name, consumed, len);
        ok = 0;
    } else {
        size_t rlen = 0;
        const uint8_t *r = bj_builder_data(out, &rlen);
        if (!r || rlen != len || memcmp(r, bytes, len) != 0) {
            fprintf(stderr, "FAIL %s: round-trip mismatch\n", name);
            dump("orig ", bytes, len);
            if (r) dump("recod", r, rlen);
            ok = 0;
        }
    }
    if (!ok) failures++;
    bj_builder_free(out);
    return ok;
}

/* Expected reference bytes (from src/binjson.js). */
struct ref_case { const char *name; uint8_t bytes[80]; size_t len; };
static const struct ref_case REF[] = {
    {"null", {0}, 1},
    {"false", {1}, 1},
    {"true", {2}, 1},
    {"int42", {3,42,0,0,0,0,0,0,0}, 9},
    {"intNeg", {3,0,240,90,43,23,255,255,255}, 9},
    {"float", {4,0,0,0,0,0,0,12,64}, 9},
    {"str", {5,5,0,0,0,104,101,108,108,111}, 10},
    {"strUtf8", {5,10,0,0,0,104,195,169,108,108,111,240,159,152,128}, 15},
    {"date", {7,0,104,229,207,139,1,0,0}, 9},
    {"ptr", {8,255,255,0,0,0,0,0,0}, 9},
    {"oid", {6,80,127,31,119,188,248,108,215,153,67,144,17}, 13},
    {"bin", {9,4,0,0,0,1,2,3,255}, 9},
    {"arr", {16,20,0,0,0,3,0,0,0,3,1,0,0,0,0,0,0,0,2,5,1,0,0,0,120}, 25},
    {"obj", {17,31,0,0,0,2,0,0,0,1,0,0,0,97,3,1,0,0,0,0,0,0,0,3,0,0,0,98,101,101,5,1,0,0,0,122}, 36},
    {"nested", {17,54,0,0,0,2,0,0,0,4,0,0,0,108,105,115,116,16,28,0,0,0,2,0,0,0,17,10,0,0,0,1,0,0,0,1,0,0,0,110,0,16,4,0,0,0,0,0,0,0,4,0,0,0,102,108,97,103,1}, 59},
};

/* Rebuild each case with the builder API so we can assert byte-parity. */
static void build_case(const char *name, bj_builder *b) {
    if (!strcmp(name, "null")) bj_put_null(b);
    else if (!strcmp(name, "false")) bj_put_bool(b, 0);
    else if (!strcmp(name, "true")) bj_put_bool(b, 1);
    else if (!strcmp(name, "int42")) bj_put_int(b, 42);
    else if (!strcmp(name, "intNeg")) bj_put_int(b, -1000000000000LL);
    else if (!strcmp(name, "float")) bj_put_float(b, 3.5);
    else if (!strcmp(name, "str")) bj_put_string(b, (const uint8_t *)"hello", 5);
    else if (!strcmp(name, "strUtf8")) {
        const uint8_t s[] = {104,195,169,108,108,111,240,159,152,128};
        bj_put_string(b, s, sizeof(s));
    }
    else if (!strcmp(name, "date")) bj_put_date(b, 1700000000000LL);
    else if (!strcmp(name, "ptr")) bj_put_pointer(b, 65535);
    else if (!strcmp(name, "oid")) {
        const uint8_t o[12] = {80,127,31,119,188,248,108,215,153,67,144,17};
        bj_put_oid(b, o);
    }
    else if (!strcmp(name, "bin")) {
        const uint8_t d[] = {1,2,3,255};
        bj_put_binary(b, d, sizeof(d));
    }
    else if (!strcmp(name, "arr")) {
        bj_begin_array(b);
        bj_put_int(b, 1);
        bj_put_bool(b, 1);
        bj_put_string(b, (const uint8_t *)"x", 1);
        bj_end_array(b);
    }
    else if (!strcmp(name, "obj")) {
        bj_begin_object(b);
        bj_put_key(b, (const uint8_t *)"a", 1);   bj_put_int(b, 1);
        bj_put_key(b, (const uint8_t *)"bee", 3); bj_put_string(b, (const uint8_t *)"z", 1);
        bj_end_object(b);
    }
    else if (!strcmp(name, "nested")) {
        bj_begin_object(b);
        bj_put_key(b, (const uint8_t *)"list", 4);
        bj_begin_array(b);
        bj_begin_object(b);
        bj_put_key(b, (const uint8_t *)"n", 1); bj_put_null(b);
        bj_end_object(b);
        bj_begin_array(b); bj_end_array(b);
        bj_end_array(b);
        bj_put_key(b, (const uint8_t *)"flag", 4); bj_put_bool(b, 0);
        bj_end_object(b);
    }
    else fprintf(stderr, "no builder for case %s\n", name);
}

/* ---- Extra targeted checks ------------------------------------------- */

static void re_null_noop(void *c) { (void)c; }
static void re_bool_noop(void *c, int t) { (void)c; (void)t; }
static void re_i_noop(void *c, double v) { (void)c; (void)v; }
static void re_s_noop(void *c, const uint8_t *p, uint32_t n) { (void)c; (void)p; (void)n; }
static void re_oid_noop(void *c, const uint8_t *p) { (void)c; (void)p; }
static void re_c_noop(void *c, uint32_t n) { (void)c; (void)n; }
static void re_e_noop(void *c) { (void)c; }

static bj_visitor noop_visitor(void) {
    bj_visitor v = {
        re_null_noop, re_bool_noop, re_i_noop, re_i_noop, re_s_noop, re_s_noop,
        re_oid_noop, re_i_noop, re_i_noop, re_c_noop, re_e_noop, re_c_noop,
        re_s_noop, re_e_noop, NULL
    };
    return v;
}

static void expect_err(const char *name, const uint8_t *b, size_t n, int want) {
    bj_visitor v = noop_visitor();
    int e = bj_decode(b, n, &v, NULL);
    if (e != want) {
        fprintf(stderr, "FAIL %s: expected err %d, got %d\n", name, want, e);
        failures++;
    }
}

static void test_errors(void) {
    expect_err("empty", (const uint8_t *)"", 0, BJ_ERR_EOF);
    { const uint8_t b[] = {0x0A}; expect_err("badtype", b, 1, BJ_ERR_UNKNOWN_TYPE); }
    { const uint8_t b[] = {BJ_TYPE_INT, 1, 2, 3}; expect_err("trunc_int", b, 4, BJ_ERR_EOF); }
    { const uint8_t b[] = {BJ_TYPE_STRING, 10, 0, 0, 0, 'a'}; expect_err("trunc_str", b, 6, BJ_ERR_EOF); }
    /* INT one past MAX_SAFE_INTEGER = 9007199254740992 = 0x0020000000000000 */
    { const uint8_t b[] = {BJ_TYPE_INT, 0,0,0,0,0,0,0x20,0}; expect_err("int_range", b, 9, BJ_ERR_INT_RANGE); }
    /* POINTER one past MAX_SAFE_INTEGER */
    { const uint8_t b[] = {BJ_TYPE_POINTER, 0,0,0,0,0,0,0x20,0}; expect_err("ptr_range", b, 9, BJ_ERR_POINTER_RANGE); }
}

static void test_value_size(void) {
    for (size_t i = 0; i < sizeof(REF) / sizeof(REF[0]); i++) {
        size_t sz = 0;
        int e = bj_value_size(REF[i].bytes, REF[i].len, 0, &sz);
        if (e || sz != REF[i].len) {
            fprintf(stderr, "FAIL value_size %s: err %d, got %zu want %zu\n",
                    REF[i].name, e, sz, REF[i].len);
            failures++;
        }
    }
}

int main(void) {
    size_t n = sizeof(REF) / sizeof(REF[0]);
    for (size_t i = 0; i < n; i++) {
        bj_builder *b = bj_builder_new();
        build_case(REF[i].name, b);
        if (expect_bytes(REF[i].name, b, REF[i].bytes, REF[i].len))
            roundtrip(REF[i].name, REF[i].bytes, REF[i].len);
        bj_builder_free(b);
    }
    test_value_size();
    test_errors();

    if (failures) {
        fprintf(stderr, "\n%d check(s) FAILED\n", failures);
        return 1;
    }
    printf("all %zu cases: byte-parity + round-trip OK; value_size + error checks OK\n", n);
    return 0;
}
