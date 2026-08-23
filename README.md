# GeoPixels historical world-map archive (local MVP)

Local, colour-only GeoPixels archive: reverse the daily lossless-WebP dumps, keep explicit deletion tombstones, materialize versioned native-grid PNG tiles in SQLite, and browse them with GeoPixels' MapLibre design.

## What the dumps contain

`https://dev.geopixels.net/dumps/` currently lists 308 daily folders from `2025-09-27` through `2026-07-31`, totaling **561,770,505 bytes** compressed. Each folder contains `metadata.txt` plus `gridx.webp`, `gridy.webp`, `color.webp`, `userid.webp`, and `lastmodified.webp`.

The WebPs are table columns, not map images. Each RGBA texel is a little-endian uint32 offset by `2^31`; `lastmodified` also adds `lastmod_min`. Each folder is a UTC day of pixel-history events (a delta), not a full snapshot. Colours are unrestricted `0xRRGGBB`; `-1` is an explicit deletion.

Grid cell `(x,y)` is centered at EPSG:3857 metres `(x*25,y*25)`. Y increases north. At archive level 13, one 256×256 PNG texel is exactly one 25-metre GeoPixels cell; level 12 represents 2×2 cells per texel, level 11 represents 4×4, and so on. Native tile X/Y are signed and increase east/north.

## Build and test

Requires Go 1.25+, a C compiler for `go-sqlite3`, and network access for MapLibre plus the GeoPixels vector tiles, sprites, and fonts.

```sh
go test ./...
go vet ./...
go build -o geopixels-archive .
```

The tests cover packed-WebP parsing, signed floor division, exact native bounds, one-cell/one-texel shape preservation, north/south parent orientation, RGB/deletion conversion, majority non-transparent lower levels, historical tombstones, signed HTTP PNGs, format compatibility, tile rebuilding, and the CLI.

## Download a dump without extracting or copying it

```sh
DATE=2025-09-27
mkdir -p "data/source/dump_$DATE"
for FILE in metadata.txt gridx.webp gridy.webp color.webp userid.webp lastmodified.webp; do
  curl -fsSL "https://dev.geopixels.net/dumps/dump_$DATE/$FILE" -o "data/source/dump_$DATE/$FILE"
done
```

`userid.webp` is retained with the source but deliberately not ingested.

## Ingest

Ingest folders in chronological order. `-limit` is only for a disposable tracer run.

```sh
./geopixels-archive ingest -db data/subset.db -dump data/source/dump_2026-07-31 -limit 5000
./geopixels-archive ingest -db data/archive.db -dump data/source/dump_2025-09-27
./geopixels-archive ingest -db data/archive.db -dump data/source/dump_2025-09-28
```

### Stream rows from PostgreSQL 18

`ingest-postgres` reads a completed PostgreSQL `COPY ... CSV HEADER` file, ignores `userid`, keeps the newest `lastmodified` row per coordinate, applies the resulting changes to `state`, and compiles only affected native tiles and parents. No PostgreSQL driver or database credentials are added to this project. The export is staged first so a failed producer cannot commit a partial archive version.

If `PixelsHistory` already represents the complete state you want and you do not need separate historical dates, compile it as one version:

```sh
set -euo pipefail
CSV=$(mktemp)
trap 'rm -f "$CSV"' EXIT
LABEL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
psql "$DATABASE_URL" -X -q --set ON_ERROR_STOP=1 -c '
COPY (
  SELECT gridx, gridy, color, userid, lastmodified
  FROM PixelsHistory
  ORDER BY lastmodified, userid, gridx, gridy
) TO STDOUT WITH (FORMAT csv, HEADER true);
' > "$CSV"
./geopixels-archive ingest-postgres \
  -db data/archive.db \
  -csv "$CSV" \
  -label "$LABEL"
```

For the next ingest, export rows modified at or after the newest compiled timestamp:

```sh
set -euo pipefail
CSV=$(mktemp)
trap 'rm -f "$CSV"' EXIT
LAST=$(sqlite3 data/archive.db 'SELECT COALESCE(MAX(timestamp),0) FROM versions;')
LABEL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
psql "$DATABASE_URL" -X -q --set ON_ERROR_STOP=1 -c "
COPY (
  SELECT gridx, gridy, color, userid, lastmodified
  FROM PixelsHistory
  WHERE lastmodified >= $LAST
  ORDER BY lastmodified, userid, gridx, gridy
) TO STDOUT WITH (FORMAT csv, HEADER true);
" > "$CSV"
./geopixels-archive ingest-postgres \
  -db data/archive.db \
  -csv "$CSV" \
  -label "$LABEL"
```

Each successful run is one selectable archive version. The incremental query deliberately includes rows whose timestamp equals the previous maximum so updates sharing that Unix second are not missed. Input order does not decide conflicts: the greatest `lastmodified` wins per coordinate, with later CSV rows breaking exact timestamp ties. Deletion still requires an explicit `color=-1` row; physically removed PostgreSQL rows cannot be inferred. If `versions` and `changes` are already populated in SQLite, skip export entirely and use `rebuild-tiles` below.

SQLite stores:

- `changes`: one final daily change per coordinate, including `color=-1` tombstones;
- `state`: current non-deleted colour state used during the next ingest;
- `tiles`: full PNG snapshots only for changed native level-13 tiles and their affected parents. Requests select the newest snapshot at or before the chosen version, so unchanged tiles are not duplicated and deletion never means “unchanged”;
- `versions`: label, source, timestamp, event/deletion counts.

Lower zooms use the majority non-transparent colour in each 2×2 block; ties keep the first non-transparent pixel, matching the upstream Wplace behavior.

## Rebuild old XYZ-aligned archives

Tile format `1` is marked with `PRAGMA user_version`. The new server and importer refuse old/unmarked tile databases instead of mixing geometries. Stop any older server binary before rebuilding, because it does not know about this marker. Rebuild from the existing `versions` and `changes` tables; no WebP dump decoding or reinsertion is required:

```sh
cp data/archive.db data/archive-before-native-tiles.db
./geopixels-archive rebuild-tiles -db data/archive.db
```

The command first marks the database incompatible, clears only `state` and `tiles`, then replays each version chronologically in its own transaction. If interrupted, rerun the same command; serving remains blocked until the final native format marker is written. `versions` and `changes` are preserved.

## Run

```sh
./geopixels-archive serve -db data/archive.db -listen 127.0.0.1:8080
curl -i http://127.0.0.1:8080/api/versions
curl -o tile.png http://127.0.0.1:8080/tiles/1/13/-1/0.png
```

Open <http://127.0.0.1:8080/>. The version selector appears automatically when more than one dump is ingested. The browser uses the GeoPixels map style, converts the viewport to EPSG:3857, requests signed native tiles, and places each texture at its exact half-cell-adjusted projected bounds through GeoPixels' `PixelTileLayer`. Horizontal world copies repeat indefinitely while reusing canonical archive tiles. Map position and version are kept in the URL.

## Deliberate MVP scope

Colour history only. No user IDs, profiles, moderation data, authentication, painting, live scraping, uploads, or admin UI. The HTTP server is local and read-only; add deployment hardening only if it is exposed beyond localhost.

See `THIRD_PARTY_NOTICES.md` for the upstream code/reference licenses.
