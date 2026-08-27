# AGENTS.md

Agent/human notes for `geopixels-archive-world-map`.

## Viewer versioning (ZeroVer / 0ver)

Policy: https://0ver.org/ — the version stays below `V1.0` indefinitely.
Release numbers are cosmetic markers, not compatibility promises; the version
bumps when there is something worth marking, and that is all.

- **Where:** single constant `const appVersion='...'` near the top of the
  inline script in `index.html`. Nothing else hard-codes the version; the
  bottom-left map credit renders `By Azael - V<appVersion>` from it.
- **Current value:** `'0.1.0'` (first tracked release, pre-1.0).
- **How to release:** change `appVersion` in exactly one place when shipping a
  user-visible behavior change. Format stays `V<major>.<minor>` while ZeroVer
  applies (e.g. `V0.1.0`, `V0.1.1`, … ). Do not derive it from
  archive/database IDs — it is the application version only.
- Tests assert the credit contains both `By Azael` and `appVersion`
  (`node --test viewer_test.js`), so a missed sync fails CI.

## Dev loop

```sh
go build -o geopixels-archive .
./geopixels-archive serve -db data/archive-full.db -listen 127.0.0.1:18080
```

- Frontend behavioral tests: `node --test viewer_test.js`.
- Full gate before pushing: `go test ./... -count=1`, `go test -race ./...`,
  `go vet ./...`, `node --test viewer_test.js`, `git diff --check`.
