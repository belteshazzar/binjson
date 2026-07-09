# binjson

A command-line tool for viewing and editing binjson files. A binjson file is a
flat, append-only sequence of top-level records; this tool can decode them and
append, replace, or remove records.

```
binjson <file.bj> <command> [args] [options]
```

If `<command>` is omitted it defaults to `list`.

Records are addressed either by **index** (their position in the file, starting
at `0`) or by **byte offset** (their absolute position in bytes, as used by
binjson `Pointer` values).

## Commands

### Viewing

| Command | Description |
| --- | --- |
| `list` | Print every record with its byte offset and size (default) |
| `get <index>` | Print a single record by its position |
| `read <offset>` | Decode the record at a byte offset (a `Pointer` target) |
| `count` | Print the number of records |
| `info` | Print file size and record count |

Aliases: `list` also accepts `dump`/`decode`; `info` accepts `stats`.

### Editing

| Command | Description |
| --- | --- |
| `append <value>` | Append a record to the end (creates the file if needed) |
| `write <value>` | Replace the entire file with a single record |
| `set <index> <value>` | Replace the record at `<index>` (rewrites the file) |
| `delete <index>` | Remove the record at `<index>` (rewrites the file) |

Aliases: `append` also accepts `add`; `set` accepts `replace`; `delete` accepts
`del`/`remove`.

## Values

Values are parsed as JSON when possible, and fall back to a raw string
otherwise:

- `'{"id":1,"label":"first"}'` → object
- `'[1,2,3]'` → array
- `42` → number
- `true` → boolean
- `'"text"'` → string `"text"`
- `text` → string `"text"` (not valid JSON, kept literally)

## Options

| Option | Description |
| --- | --- |
| `-h`, `--help` | Show help |

## Behavior notes

- `append` and `write` create the file if it does not exist; every other command
  requires the file to already exist.
- `list`, `count`, and `info` stream the file one record at a time, so the whole
  file never has to be held in memory.
- `set` and `delete` rewrite the entire file. Because binjson `Pointer` values
  reference absolute byte offsets, any `Pointer` records will no longer point at
  the same records after a rewrite.
- `get` and `read` exit non-zero when the requested record is not found.

## Examples

Append records (the file is created on first `append`):

```sh
binjson data.bj append '{"id":1,"label":"first"}'
binjson data.bj append '[1,2,3]'
binjson data.bj append '"hello"'
binjson data.bj append 42
```

List everything with byte offsets and sizes:

```sh
binjson data.bj list
# @ 0 (43 bytes, entry: 0)
# {
#   id: 1
#   label: "first"
# }
# @ 43 (36 bytes, entry: 1)
# ...

# or simply:
binjson data.bj
```

Inspect a single record by index, or decode one at a byte offset:

```sh
binjson data.bj get 2
binjson data.bj read 43
```

Count records and show file stats:

```sh
binjson data.bj count
binjson data.bj info
# file:    data.bj
# size:    98 bytes
# records: 4
```

Replace a record, delete a record, or overwrite the whole file:

```sh
binjson data.bj set 1 '{"replaced":true}'
binjson data.bj delete 2
binjson data.bj write '{"only":"record"}'
```

Use exit codes in a script:

```sh
if binjson data.bj get 0 > /dev/null; then
  echo "file has at least one record"
fi
```

## Running

The tool requires [`node-opfs`](https://www.npmjs.com/package/node-opfs) to
provide OPFS storage under Node.js (installed as a dev dependency). Run it
directly:

```sh
node bin/binjson.js data.bj list
```

or, once the package is installed, via the `binjson` bin. The legacy
`binjson-decode` bin name is kept as an alias, so `binjson-decode <file.bj>`
still works and defaults to `list`.
