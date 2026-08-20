# GeoPixels historical world-map archive (local MVP)

Local, colour-only GeoPixels archive: reverse the daily lossless-WebP dumps, keep explicit deletion tombstones, materialize versioned XYZ PNG tiles in SQLite, and browse them over an OpenStreetMap basemap with MapLibre.

## What the dumps contain

`https://dev.geopixels.net/dumps/` currently lists 308 daily folders from `2025-09-27` through `2026-07-31`, totaling **561,770,505 bytes** compressed. Each folder contains `metadata.txt` plus `gridx.webp`, `gridy.webp`, `color.webp`, `userid.webp`, and `lastmodified.webp`.

The WebPs are table columns, not map images. Each RGBA texel is a little-endian uint32 offset by `2^31`; `lastmodified` also adds `lastmod_min`. Each folder is a UTC day of pixel-history events (a delta), not a full snapshot. Colours are unrestricted `0xRRGGBB`; `-1` is an explicit deletion.

Grid cell `(x,y)` is centered at EPSG:3857 metres `(x*25,y*25)`. Y increases north. The importer clips the slightly rounded edge cells to the Web Mercator world and renders standard XYZ tiles through zoom 13.

## Build and test

Requires Go 1.25+, a C compiler for `go-sqlite3`, and network access for the MapLibre/OSM browser assets.

```sh
go test ./...
go vet ./...
go build -o geopixels-archive .
```

The tests cover packed-WebP parsing, signed coordinates/timestamps, EPSG:3857-to-XYZ conversion, RGB/deletion conversion, majority non-transparent lower zooms, historical tombstones, HTTP PNGs, and the CLI.

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

SQLite stores:

- `changes`: one final daily change per coordinate, including `color=-1` tombstones;
- `state`: current non-deleted colour state used during the next ingest;
- `tiles`: full PNG snapshots only for changed z13 tiles and their affected parents. Requests select the newest snapshot at or before the chosen version, so unchanged tiles are not duplicated and deletion never means “unchanged”;
- `versions`: label, source, timestamp, event/deletion counts.

Lower zooms use the majority non-transparent colour in each 2×2 block; ties keep the first non-transparent pixel, matching the upstream Wplace behavior.

## Run

```sh
./geopixels-archive serve -db data/archive.db -listen 127.0.0.1:8080
curl -i http://127.0.0.1:8080/api/versions
curl -o tile.png http://127.0.0.1:8080/tiles/1/13/1314/2871.png
```

Open <http://127.0.0.1:8080/>. The version selector appears automatically when more than one dump is ingested. Map position and version are kept in the URL.

## Deliberate MVP scope

Colour history only. No user IDs, profiles, moderation data, authentication, painting, live scraping, uploads, or admin UI. The HTTP server is local and read-only; add deployment hardening only if it is exposed beyond localhost.

See `THIRD_PARTY_NOTICES.md` for the upstream code/reference licenses.
