/*
 * test_posixio.c — native test harness for posixio.c (c/posixio.h).
 *
 * Exercises bjio_posix() two ways: directly (raw size/read/write/truncate
 * against a real temp file) and through a real bj_io consumer (bplustree),
 * closing and reopening the file to prove data actually persists on disk
 * through this bj_io the same way it does through hostio.c's WASM one.
 *
 * Build/run: see c/build-native.sh's sibling invocation in package.json's
 * "test:native" script, or directly:
 *   cc -std=c11 -Wall -Wextra -Werror -Ic \
 *     c/test_posixio.c c/posixio.c c/binjson.c c/bplustree.c \
 *     -o /tmp/test_posixio && /tmp/test_posixio
 */
#include "posixio.h"
#include "binjson.h"
#include "bplustree.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failures = 0;

#define CHECK(cond, msg) do { \
    if (!(cond)) { \
        fprintf(stderr, "FAIL: %s (%s:%d)\n", (msg), __FILE__, __LINE__); \
        failures++; \
    } \
} while (0)

static void test_raw_io(const char *path) {
    int fd;
    CHECK(posixio_open(path, 1, &fd) == BJ_OK, "posixio_open (create)");
    bj_io io = bjio_posix(fd);

    CHECK(io.size(io.ctx) == 0, "fresh file is empty");

    const uint8_t hello[] = "hello, posixio";
    CHECK(io.write(io.ctx, 0, hello, (uint32_t)sizeof(hello)) == BJ_OK, "write at offset 0");
    CHECK(io.size(io.ctx) == sizeof(hello), "size reflects the write");

    uint8_t buf[sizeof(hello)];
    int64_t got = io.read(io.ctx, 0, buf, (uint32_t)sizeof(buf));
    CHECK(got == (int64_t)sizeof(hello), "read back the full write");
    CHECK(memcmp(buf, hello, sizeof(hello)) == 0, "read bytes match what was written");

    /* Write past current EOF: the file must extend, not error. */
    const uint8_t tail[] = "tail";
    uint64_t tail_off = 1000;
    CHECK(io.write(io.ctx, tail_off, tail, (uint32_t)sizeof(tail)) == BJ_OK, "write past EOF extends the file");
    CHECK(io.size(io.ctx) == tail_off + sizeof(tail), "size reflects the extended write");

    uint8_t tail_buf[sizeof(tail)];
    got = io.read(io.ctx, tail_off, tail_buf, (uint32_t)sizeof(tail_buf));
    CHECK(got == (int64_t)sizeof(tail), "read back the tail write");
    CHECK(memcmp(tail_buf, tail, sizeof(tail)) == 0, "tail bytes match");

    /* Reading past EOF is a short (zero) read, not an error. */
    got = io.read(io.ctx, io.size(io.ctx) + 100, buf, 1);
    CHECK(got == 0, "read past EOF returns 0, not an error");

    CHECK(io.truncate(io.ctx, 5) == BJ_OK, "truncate");
    CHECK(io.size(io.ctx) == 5, "size reflects the truncation");

    posixio_close(fd);
}

static bpt_key num_key(double v) {
    bpt_key k;
    k.is_string = 0;
    k.num = v;
    k.str = NULL;
    k.str_len = 0;
    return k;
}

/* bpt_add's `val` must be one pre-encoded binjson value (bplustree.h's own
 * doc comment says so) -- a node packs multiple values together and relies
 * on each one being self-describing (type tag + implicit/explicit length)
 * to know where it ends, unlike bpt_add's `val_len` parameter which is just
 * for this call. A raw C string is not a valid binjson value on its own. */
static size_t encode_string_value(const char *s, uint8_t *out, size_t out_cap) {
    bj_builder *b = bj_builder_new();
    if (!b) return 0;
    bj_put_string(b, (const uint8_t *)s, (uint32_t)strlen(s));
    size_t n = 0;
    const uint8_t *d = bj_builder_data(b, &n);
    size_t copied = 0;
    if (d && n <= out_cap) {
        memcpy(out, d, n);
        copied = n;
    }
    bj_builder_free(b);
    return copied;
}

static void test_bplustree_roundtrip(const char *path) {
    int fd;
    CHECK(posixio_open(path, 1, &fd) == BJ_OK, "posixio_open for bplustree (create)");
    bj_io io = bjio_posix(fd);

    bpt *t = bpt_create(&io, 4);
    CHECK(t != NULL, "bpt_create over a native bj_io");
    if (!t) { posixio_close(fd); return; }

    for (int i = 0; i < 50; i++) {
        char val[32];
        snprintf(val, sizeof(val), "value-%d", i);
        uint8_t enc[64];
        size_t enc_len = encode_string_value(val, enc, sizeof(enc));
        CHECK(enc_len > 0, "encode_string_value");
        bpt_key k = num_key(i);
        int e = bpt_add(t, &k, enc, (uint32_t)enc_len);
        CHECK(e == BJ_OK, "bpt_add");
    }
    bpt_free(t);
    posixio_close(fd);

    /* Reopen a fresh fd + bj_io over the same file -- this is the part that
     * actually proves persistence, not just in-process correctness. */
    CHECK(posixio_open(path, 0, &fd) == BJ_OK, "posixio_open for bplustree (reopen, no create)");
    bj_io io2 = bjio_posix(fd);
    bpt *t2 = bpt_open(&io2);
    CHECK(t2 != NULL, "bpt_open over a reopened native bj_io");
    if (t2) {
        for (int i = 0; i < 50; i++) {
            bpt_key k = num_key(i);
            int found = 0;
            const uint8_t *vp = NULL;
            size_t vlen = 0;
            int e = bpt_search(t2, &k, &found, &vp, &vlen);
            CHECK(e == BJ_OK, "bpt_search");
            CHECK(found, "key found after reopen");
            char expected[32];
            snprintf(expected, sizeof(expected), "value-%d", i);
            uint8_t enc[64];
            size_t enc_len = encode_string_value(expected, enc, sizeof(enc));
            CHECK(found && vlen == enc_len && memcmp(vp, enc, enc_len) == 0, "value matches after reopen");
        }
        bpt_free(t2);
    }
    posixio_close(fd);
}

int main(void) {
    char raw_path[] = "/tmp/test_posixio_raw.XXXXXX";
    char bpt_path[] = "/tmp/test_posixio_bpt.XXXXXX";
    int raw_fd = mkstemp(raw_path);
    int bpt_fd = mkstemp(bpt_path);
    CHECK(raw_fd >= 0 && bpt_fd >= 0, "mkstemp");
    if (raw_fd >= 0) close(raw_fd);
    if (bpt_fd >= 0) close(bpt_fd);

    test_raw_io(raw_path);
    test_bplustree_roundtrip(bpt_path);

    unlink(raw_path);
    unlink(bpt_path);

    if (failures == 0) {
        printf("ALL PASSED\n");
        return 0;
    }
    fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
}
