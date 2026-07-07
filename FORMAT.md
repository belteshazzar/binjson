# binjson wire format

This document is the canonical byte-level specification of the binjson binary
encoding. It is derived from the reference implementation in
[`src/binjson.js`](src/binjson.js) and is intended to be a *contract*: any port
(e.g. the C/WASM codec) must produce and consume byte-for-byte identical output.

If the reference implementation and this document ever disagree, that is a bug in
one of them — treat the round-trip test suite in
[`test/binjson.test.js`](test/binjson.test.js) as the tie-breaker and fix
whichever is wrong.

## Conventions

- **Byte order:** every multi-byte scalar (lengths, integers, floats) is
  **little-endian**. There are no exceptions.
- **Lengths / sizes:** every length or size field is an **unsigned 32-bit**
  integer (`uint32`, 4 bytes, LE). The maximum encodable string, binary blob, or
  container content size is therefore `0xFFFFFFFF` (~4 GiB).
- **Strings:** all text (string values *and* object keys) is **UTF-8**. Length
  fields count **UTF-8 bytes**, not code points or UTF-16 units.
- **Values:** the format encodes a single value. A value is either a primitive
  or a container (`ARRAY` / `OBJECT`) that recursively contains values. Files may
  hold several top-level values concatenated back-to-back (see
  [Streams & files](#streams--files)).

## Type bytes

Every value begins with a single **type byte**. Object *keys* are the only
exception — they are written as bare length-prefixed UTF-8 with no type byte.

| Type      | Byte   | Payload                                            |
|-----------|--------|----------------------------------------------------|
| `NULL`    | `0x00` | none                                               |
| `FALSE`   | `0x01` | none                                               |
| `TRUE`    | `0x02` | none                                               |
| `INT`     | `0x03` | `int64` LE (8 bytes)                               |
| `FLOAT`   | `0x04` | `float64` LE (8 bytes, IEEE-754)                   |
| `STRING`  | `0x05` | `uint32` byte-length + UTF-8 bytes                 |
| `OID`     | `0x06` | 12 raw bytes                                        |
| `DATE`    | `0x07` | `int64` LE milliseconds since Unix epoch (8 bytes) |
| `POINTER` | `0x08` | `uint64` LE file offset (8 bytes)                  |
| `BINARY`  | `0x09` | `uint32` byte-length + raw bytes                   |
| `ARRAY`   | `0x10` | `uint32` content-size + content (see below)        |
| `OBJECT`  | `0x11` | `uint32` content-size + content (see below)        |

> Note the gap between `0x09` and `0x10`: container types intentionally start at
> `0x10`. Bytes `0x0A`–`0x0F` and anything `> 0x11` are **invalid** and must be
> rejected as an "unknown type byte".

## Per-type encoding

Notation: `[ ... ]` groups bytes; `u32(n)` = 4-byte LE unsigned; `i64(n)` =
8-byte LE signed; `u64(n)` = 8-byte LE unsigned; `f64(n)` = 8-byte LE IEEE-754.

### Primitives with no payload

```
NULL   -> [ 0x00 ]
FALSE  -> [ 0x01 ]
TRUE   -> [ 0x02 ]
```

### `INT` (0x03)

```
[ 0x03 ][ i64(value) ]
```

- Emitted for JS numbers that are integers **and** within the safe-integer range
  (`Number.isInteger(v) && Number.isSafeInteger(v)`). Numbers outside that range,
  or non-integers, are emitted as `FLOAT` instead.
- Stored as a full signed 64-bit integer.
- **On decode**, if the decoded `int64` falls outside
  `[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`
  (i.e. `±(2^53 − 1)`), the reference implementation throws
  *"Decoded integer exceeds safe range"*. A port that decodes into native
  64-bit integers must reproduce this guard when narrowing to a JS `number`.

### `FLOAT` (0x04)

```
[ 0x04 ][ f64(value) ]
```

Standard IEEE-754 double, little-endian.

### `STRING` (0x05)

```
[ 0x05 ][ u32(byteLength) ][ UTF-8 bytes ]
```

`byteLength` is the length of the UTF-8 encoding, not the JS string length.

### `OID` (0x06) — ObjectId

```
[ 0x06 ][ 12 raw bytes ]
```

- The 12 bytes are the raw ObjectId (MongoDB-compatible): a 24-char hex string
  decoded two hex chars per byte, big-endian order (byte 0 = first hex pair).
- No length prefix — the width is always exactly 12.
- Generation (timestamp + random tail) is a *producer* concern and is not part of
  the wire format; only the 12 bytes are.

### `DATE` (0x07)

```
[ 0x07 ][ i64(millisecondsSinceEpoch) ]
```

Signed 64-bit millisecond timestamp (`Date.prototype.getTime()`), so dates before
1970 (negative) are representable.

### `POINTER` (0x08)

```
[ 0x08 ][ u64(offset) ]
```

- Unsigned 64-bit file offset.
- **On decode**, if the offset exceeds `Number.MAX_SAFE_INTEGER` the reference
  implementation throws *"Pointer offset out of valid range"*. Reproduce this
  guard when narrowing to a JS `number`.

### `BINARY` (0x09)

```
[ 0x09 ][ u32(byteLength) ][ raw bytes ]
```

Opaque byte blob (JS `Uint8Array`). Decodes back to a `Uint8Array`.

### `ARRAY` (0x10)

```
[ 0x10 ][ u32(contentSize) ][ u32(count) ][ element_0 ][ element_1 ] ... [ element_{count-1} ]
```

- `contentSize` = number of bytes that follow the size field itself, i.e.
  `4 (the count field) + sum(sizeof(element_i))`.
- `count` = number of elements.
- Each `element_i` is a fully-encoded value (type byte + payload), recursively.
- Total bytes on the wire for an array = `1 + 4 + contentSize`.
- `contentSize` is redundant with `count`-driven decoding, but it lets a reader
  **skip an entire array without descending into it** (used by scanning) and
  bounds-check the container in one step. Decoders read `count` and decode that
  many elements; `contentSize` is used only for bounds validation / skipping.

### `OBJECT` (0x11)

```
[ 0x11 ][ u32(contentSize) ][ u32(keyCount) ] then keyCount repetitions of:
        [ u32(keyByteLength) ][ UTF-8 key bytes ][ encoded value ]
```

- `contentSize` = `4 (the keyCount field) + sum over entries of
  (4 + keyByteLength + sizeof(value))`.
- `keyCount` = number of key/value pairs.
- **Keys have no type byte** — they are always length-prefixed UTF-8.
- Values are fully-encoded values (type byte + payload), recursively.
- Total bytes on the wire for an object = `1 + 4 + contentSize`.
- Key order is preserved as the producer emits it (JS `Object.keys` insertion
  order in the reference implementation).

## Value size (for scanning / skipping)

To compute the total on-wire size of a value given only its first bytes (used to
walk a stream of concatenated values without fully decoding each one):

| Type                                  | Total size in bytes    |
|---------------------------------------|------------------------|
| `NULL`, `FALSE`, `TRUE`               | `1`                    |
| `INT`, `FLOAT`, `DATE`, `POINTER`     | `1 + 8` = `9`          |
| `OID`                                 | `1 + 12` = `13`        |
| `STRING`, `BINARY`                    | `1 + 4 + length`       |
| `ARRAY`, `OBJECT`                     | `1 + 4 + contentSize`  |

For `STRING`/`BINARY`, read the `uint32` immediately after the type byte to get
`length`. For `ARRAY`/`OBJECT`, read the `uint32` immediately after the type byte
to get `contentSize`.

## Streams & files

- A single `encode()` call emits exactly one top-level value.
- A file may contain **multiple top-level values concatenated** with no separator
  or header (produced by appending). Readers locate successive values using the
  value-size rules above: read one value, advance by its total size, repeat until
  end of stream.
- There is **no file header, no magic number, and no version byte.** The stream
  is a bare sequence of encoded values.

## Bounds checking (decoder requirements)

A conformant decoder must validate, before every read, that enough bytes remain,
and throw rather than read out of bounds. The reference implementation checks, at
minimum:

- at least 1 byte remains before reading a type byte
  (*"Unexpected end of data"*);
- 8 bytes remain for `INT` / `FLOAT` / `DATE` / `POINTER` payloads;
- 12 bytes remain for `OID`;
- 4 bytes remain for each length/size/count/keyLength field, and then that many
  content bytes remain for `STRING` / `BINARY` / key bytes / container content;
- an unknown type byte throws *"Unknown type byte: 0x…"*.

## Worked examples

Bytes shown in hex, space-separated. All little-endian.

### `42` (a safe integer → `INT`)

```
03  2A 00 00 00 00 00 00 00
^type          ^ i64(42)
```
9 bytes total.

### `"hi"` (→ `STRING`)

```
05  02 00 00 00  68 69
^type ^u32(2)    ^'h''i'
```
7 bytes total.

### `[1, true]` (→ `ARRAY`)

```
10  0E 00 00 00  02 00 00 00  03 01 00 00 00 00 00 00 00  02
^type ^size(14)  ^count(2)    ^INT 1 (9 bytes)            ^TRUE
```
19 bytes total = `1 + 4 + 14`. contentSize `14` = `4 (count) + 9 (INT) + 1 (TRUE)`.

### `{ "a": 1 }` (→ `OBJECT`)

```
11  12 00 00 00  01 00 00 00  01 00 00 00  61  03 01 00 00 00 00 00 00 00
^type ^size(18)  ^keyCount(1) ^keyLen(1)   ^'a' ^INT 1 (9 bytes)
```
23 bytes total = `1 + 4 + 18`. contentSize `18` =
`4 (keyCount) + 4 (keyLen) + 1 (key) + 9 (INT value)`.

## Type dispatch on encode (producer rules)

The reference producer chooses a type byte from a JS value as follows (order
matters — the first match wins):

1. `null` → `NULL`
2. `false` → `FALSE`
3. `true` → `TRUE`
4. `instanceof ObjectId` → `OID`
5. `instanceof Date` → `DATE`
6. `instanceof Pointer` → `POINTER`
7. `instanceof Uint8Array` → `BINARY`
8. `typeof === 'number'`:
   - integer && safe integer → `INT`
   - otherwise → `FLOAT`
9. `typeof === 'string'` → `STRING`
10. `Array.isArray` → `ARRAY`
11. `typeof === 'object'` → `OBJECT`
12. anything else → error *"Unsupported type: …"*

`undefined`, functions, symbols, and `BigInt` are **not** supported inputs.
