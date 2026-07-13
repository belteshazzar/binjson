# db

A command-line tool for the document database (`src/db.js`): create
collections and indexes, and insert/find/update/delete documents, all from
the shell.

```
db <name> <command> [args] [options]
```

`<name>` selects (creating if needed) an OPFS subdirectory holding that
database's catalog and collection/index files. If `<command>` is omitted it
defaults to `collections`.

## Where files go

This tool runs under Node via [`node-opfs`](https://www.npmjs.com/package/node-opfs),
which backs OPFS with real files under `~/.node-opfs` by default (same as
`bplustree`/`rtree`/`textindex`/`textlog`). A database named `mydb` lives at
`~/.node-opfs/mydb/` — one `__catalog__.bj` file plus one file per collection
and per index.

## Commands

| Command | Description |
| --- | --- |
| `collections` | List collection names (default) |
| `drop-collection <coll>` | Drop a collection and its indexes |
| `insert <coll> <doc>` | Insert one document |
| `find <coll> [filter]` | Find matching documents (`{}` if omitted) |
| `find-one <coll> [filter]` | Find the first matching document |
| `count <coll> [filter]` | Count matching documents |
| `delete-one <coll> [filter]` | Delete the first matching document |
| `replace-one <coll> <filter> <doc>` | Replace the first matching document |
| `update-one <coll> <filter> <update>` | Apply update operators to the first matching document |
| `update-many <coll> <filter> <update>` | Apply update operators to every matching document |
| `create-index <coll> <keys>` | Create an index, e.g. `'{"team":1}'` |
| `drop-index <coll> <indexName>` | Drop an index |
| `list-indexes <coll>` | List a collection's indexes |
| `find-by-index <coll> <indexName> <values>` | Equality lookup via an index |

Aliases: `collections` also accepts `list`.

## Documents, filters, and query operators

`<doc>`/`<filter>`/`<keys>`/`<values>` are JSON. Filters support the query
engine's operators as plain JSON keys:

```sh
db mydb find users '{"age":{"$gte":18,"$lt":65}}'
db mydb find users '{"$or":[{"team":"core"},{"team":"kernel"}]}'
```

`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$not`,
`$and`, `$or`, `$nor` are supported; dotted paths (`"address.city"`) resolve
nested fields. See `docs/db-plan.md` (milestone 3) for the exact matching
rules and current limitations.

`$text` (requires a `'text'` index, `create-index posts '{"body":"text"}'`)
and `$near`/`$geoWithin` (require a `'2dsphere'` index, GeoJSON Point values
only) are also supported — see `docs/db-plan.md` (milestone 6):

```sh
db mydb create-index posts '{"body":"text"}'
db mydb find posts '{"$text":{"$search":"fox"}}'

db mydb create-index places '{"location":"2dsphere"}'
db mydb find places '{"location":{"$near":{"$geometry":{"type":"Point","coordinates":[-0.12,51.5]},"$maxDistance":1000}}}'
db mydb find places '{"location":{"$geoWithin":{"$box":[[-10,40],[10,60]]}}}'
```

Note: `$near`/`$geoWithin` distances here are in **kilometers**, not the
meters/radians real MongoDB uses for the equivalent operators.

`ObjectId` and `Date` values use MongoDB's Extended JSON literals:

```sh
db mydb find-one users '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}'
db mydb insert events '{"name":"launch","at":{"$date":"2026-01-01T00:00:00Z"}}'
```

A bare hex string does **not** match an `ObjectId` field — same as the real
MongoDB driver, `_id` and `ObjectId` values are a distinct type from strings.

## Update operators

`<update>` for `update-one`/`update-many` is an object of `$set`/`$unset`/
`$inc`/`$push`/`$pull` operators — a plain replacement document is rejected,
use `replace-one` for that:

```sh
db mydb update-one users '{"name":"Ada"}' '{"$set":{"team":"core"},"$inc":{"visits":1}}'
db mydb update-many users '{"team":"core"}' '{"$push":{"tags":"reviewed"}}'
```

See `docs/db-plan.md` (milestone 4) for the exact rules and current
limitations (top-level fields only, no dotted update paths yet).

## Options

| Option | Applies to | Description |
| --- | --- | --- |
| `--sort <json>` | `find` | Sort spec, e.g. `'{"age":1}'` or `'{"age":-1}'` |
| `--skip <n>` | `find` | Number of matches to skip (after sort) |
| `--limit <n>` | `find` | Max matches to return (after skip) |
| `--project <json>` | `find` | Projection, e.g. `'{"name":1}'` or `'{"age":0}'` |
| `--upsert` | `replace-one`, `update-one`, `update-many` | Insert if nothing matched |
| `--name <name>` | `create-index` | Index name (default: `field_1[_field2_1...]`) |
| `--order <n>` | any file-creating command | B+ tree order for new files (default 32, min 3) |
| `-h`, `--help` | | Show help |

## Examples

```sh
db mydb insert users '{"name":"Ada","team":"core","age":36}'
db mydb insert users '{"name":"Grace","team":"core","age":85}'

db mydb collections
# 0: users

db mydb find users '{"team":"core"}' --sort '{"age":-1}'
# 0: { name: "Grace", team: "core", age: 85, _id: ObjectId(...) }
# 1: { name: "Ada", team: "core", age: 36, _id: ObjectId(...) }

db mydb create-index users '{"team":1}'
db mydb find-by-index users team_1 '["core"]'

db mydb replace-one users '{"name":"Ada"}' '{"name":"Ada","team":"core","age":37}'
db mydb update-one users '{"name":"Ada"}' '{"$inc":{"age":1}}'
db mydb delete-one users '{"name":"Grace"}'
db mydb count users
```

## Running

Requires [`node-opfs`](https://www.npmjs.com/package/node-opfs) (installed
as a dev dependency). Run it directly:

```sh
node bin/db.js mydb collections
```

or, once the package is installed, via the `db` bin.
