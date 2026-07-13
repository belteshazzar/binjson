/* _POSIX_C_SOURCE must be defined before any system header is pulled in
 * (even transitively) for pread(2)/pwrite(2) to be visible under -std=c11
 * on glibc; Darwin's libc doesn't gate on it but defining it is harmless
 * there. */
#define _POSIX_C_SOURCE 200809L
/*
 * posixio.c — see posixio.h.
 */
#include "posixio.h"
#include "binjson.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static uint64_t pio_size(void *ctx) {
    int fd = (int)(intptr_t)ctx;
    struct stat st;
    if (fstat(fd, &st) != 0) return 0;
    return (uint64_t)st.st_size;
}

/* A short read (including 0 at EOF) is not an error -- bjfile.c's own
 * callers already re-request the remainder themselves (see bjfile.c's
 * read_at), matching hostio.c's WASM-side contract exactly. Only a real
 * pread(2) failure (after retrying an EINTR) is reported as an error. */
static int64_t pio_read(void *ctx, uint64_t off, uint8_t *buf, uint32_t len) {
    int fd = (int)(intptr_t)ctx;
    for (;;) {
        ssize_t n = pread(fd, buf, len, (off_t)off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return BJ_ERR_STATE;
        }
        return (int64_t)n;
    }
}

/* Unlike read, callers here call write() once and expect it to either fully
 * land `len` bytes or report an error -- loop over pwrite(2) ourselves
 * (a partial pwrite is legal POSIX behavior, e.g. across a signal) rather
 * than pushing that back onto every caller. */
static int32_t pio_write(void *ctx, uint64_t off, const uint8_t *buf, uint32_t len) {
    int fd = (int)(intptr_t)ctx;
    uint32_t written = 0;
    while (written < len) {
        ssize_t n = pwrite(fd, buf + written, len - written, (off_t)(off + written));
        if (n < 0) {
            if (errno == EINTR) continue;
            return BJ_ERR_STATE;
        }
        if (n == 0) return BJ_ERR_EOF; /* shouldn't happen for a regular file; avoid spinning */
        written += (uint32_t)n;
    }
    return BJ_OK;
}

static int32_t pio_truncate(void *ctx, uint64_t len) {
    int fd = (int)(intptr_t)ctx;
    if (ftruncate(fd, (off_t)len) != 0) return BJ_ERR_STATE;
    return BJ_OK;
}

bj_io bjio_posix(int fd) {
    bj_io io;
    io.ctx = (void *)(intptr_t)fd;
    io.size = pio_size;
    io.read = pio_read;
    io.write = pio_write;
    io.truncate = pio_truncate;
    return io;
}

int posixio_open(const char *path, int create, int *out_fd) {
    int flags = O_RDWR | (create ? O_CREAT : 0);
    int fd = open(path, flags, 0644);
    if (fd < 0) return BJ_ERR_STATE;
    *out_fd = fd;
    return BJ_OK;
}

void posixio_close(int fd) {
    close(fd);
}
