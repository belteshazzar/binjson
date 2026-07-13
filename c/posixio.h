/*
 * posixio.h — bj_io (bjio.h) backed by real POSIX file descriptors.
 *
 * The native counterpart to hostio.h's WASM-side implementation (which
 * bridges to a JS FileSystemSyncAccessHandle via EM_JS): every read/write
 * goes through a plain positioned pread(2)/pwrite(2) on an already-open fd,
 * so a native host (a macOS/iOS app via Swift, a native CLI, a server
 * process, ...) can use exactly the same bpt_create/bpt_open/textlog_open/
 * db.h entry points the WASM build uses, just constructing the bj_io
 * differently -- see docs/platform-strategy.md's macOS/iOS section.
 */
#ifndef POSIXIO_H
#define POSIXIO_H

#include "bjio.h"

#ifdef __cplusplus
extern "C" {
#endif

/* A bj_io whose callbacks operate on an already-open POSIX file descriptor
 * `fd`. Does not take ownership of `fd` -- posixio_open/posixio_close below
 * are a convenience for the common case, not a requirement; a caller that
 * already has a fd open some other way can pass it straight to bjio_posix. */
bj_io bjio_posix(int fd);

/* Open (or create) `path` for synchronous positioned reads and writes,
 * returning the new fd via *out_fd. Returns BJ_OK or a negative BJ_ERR_*
 * code (errno is left set on failure for the caller to inspect if useful). */
int posixio_open(const char *path, int create, int *out_fd);

/* Close a fd opened by posixio_open (or any fd bjio_posix was pointed at). */
void posixio_close(int fd);

#ifdef __cplusplus
}
#endif

#endif /* POSIXIO_H */
