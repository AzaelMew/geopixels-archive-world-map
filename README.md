# GeoPixels Archive

Build and serve a colour-only historical GeoPixels map from daily dumps or PostgreSQL CSV exports. Versions and native PNG tiles are stored in SQLite and viewed with MapLibre.

## Requirements

- Go 1.25+
- C compiler for `go-sqlite3`
- Node.js for viewer tests

## Build and test

```sh
go build -o geopixels-archive .
go test ./... -count=1
go test -race ./... -count=1
go vet ./...
node --test viewer_test.js
```

The same checks run in GitHub Actions on pushes and pull requests.

## Create an archive

### GeoPixels daily dumps

Download a dump from <https://dev.geopixels.net/dumps/>. Its directory must contain `metadata.txt`, `gridx.webp`, `gridy.webp`, `color.webp`, and `lastmodified.webp`. Ingest dumps in chronological order:

```sh
./geopixels-archive ingest -db data/archive.db -dump data/source/dump_2025-09-27
./geopixels-archive ingest -db data/archive.db -dump data/source/dump_2025-09-28
```

Use `-limit N` only for disposable test ingests.

### PostgreSQL CSV

The CSV must contain `gridx`, `gridy`, `color`, and `lastmodified` headers. Extra columns such as `userid` are ignored. Use `color=-1` for deletions.

```sh
./geopixels-archive ingest-postgres \
  -db data/archive.db \
  -csv pixels.csv \
  -label 2026-08-27
```

## Serve

```sh
./geopixels-archive serve -db data/archive.db -listen 127.0.0.1:8080
```

Open <http://127.0.0.1:8080/>.

Serving is read-only. Tile responses are immutable and cacheable by browsers and CDNs; invalid requests and server errors use `Cache-Control: no-store`.

## Rebuild incompatible tiles

Back up the database first, then rebuild tiles from its existing version history:

```sh
cp data/archive.db data/archive.backup.db
./geopixels-archive rebuild-tiles -db data/archive.db
```

No source dump re-ingestion is required.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream licences.
