package main

import (
	"bytes"
	"encoding/json"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestReadDumpReversesPackedWebPColumns(t *testing.T) {
	d, err := ReadDump("testdata/dump_2026-04-03", 0)
	if err != nil {
		t.Fatal(err)
	}
	if d.DeclaredCount != 227 || len(d.Events) != 227 || d.Width != 15 || d.Height != 16 {
		t.Fatalf("unexpected shape: metadata=%d events=%d image=%dx%d", d.DeclaredCount, len(d.Events), d.Width, d.Height)
	}
	first := d.Events[0]
	if first.GridX != 136147 || first.GridY != 263342 || first.Color != 15473701 || first.LastModified != 1775253807 {
		t.Fatalf("first event decoded incorrectly: %+v", first)
	}
	last := d.Events[len(d.Events)-1]
	if last.GridX != 107809 || last.GridY != 196449 || last.Color != 16763450 || last.LastModified != 1775257236 {
		t.Fatalf("last event decoded incorrectly: %+v", last)
	}
}

func TestCoordinateConversionUsesEPSG3857CentersAndXYZOrientation(t *testing.T) {
	x, y := gridToTile(0, 0, maxZoom)
	if x != 4096 || y != 4096 {
		t.Fatalf("origin mapped to %d/%d, want 4096/4096", x, y)
	}
	gx, gy := tilePixelToGrid(maxZoom, 4095, 4095, 0, 0)
	if gx != -195 || gy != 195 {
		t.Fatalf("north-west pixel mapped to grid %d,%d, want -195,195", gx, gy)
	}
	if _, y = gridToTile(0, 801500, maxZoom); y != 0 {
		t.Fatalf("north Web Mercator edge mapped to y=%d, want 0", y)
	}
	if x, _ = gridToTile(801500, 0, maxZoom); x != (1<<maxZoom)-1 {
		t.Fatalf("east Web Mercator edge mapped to x=%d", x)
	}
	if got := gridCellTiles(0, 0, maxZoom); len(got) != 4 {
		t.Fatalf("cell crossing the XYZ origin touches %d tiles, want 4: %v", len(got), got)
	}
}

func TestColorAndLowerZoomMajorityPreserveTransparency(t *testing.T) {
	if got := colorIntToRGBA(0x123456); got != (color.NRGBA{R: 0x12, G: 0x34, B: 0x56, A: 0xff}) {
		t.Fatalf("RGB integer decoded as %#v", got)
	}
	if got := colorIntToRGBA(-1); got.A != 0 {
		t.Fatalf("deletion must decode as transparent, got %#v", got)
	}
	red := color.NRGBA{R: 255, A: 255}
	blue := color.NRGBA{B: 255, A: 255}
	clear := color.NRGBA{}
	if got := majority4(clear, red, blue, red); got != red {
		t.Fatalf("majority non-transparent color = %#v, want red", got)
	}
	if got := majority4(red, blue, blue, red); got != red {
		t.Fatalf("2-2 tie = %#v, want first non-transparent red", got)
	}
	if got := majority4(clear, clear, clear, clear); got.A != 0 {
		t.Fatalf("all-transparent block must remain transparent, got %#v", got)
	}
}

func TestIngestKeepsExplicitTombstonesAndHistoricalTiles(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	v1, err := a.IngestDump(&Dump{Label: "v1", DeclaredCount: 2, Events: []Event{
		{GridX: 0, GridY: 0, Color: 0xff0000, LastModified: 10},
		{GridX: 1, GridY: 0, Color: -1, LastModified: 11},
	}}, "fixture-v1")
	if err != nil {
		t.Fatal(err)
	}
	var tombstone int32
	if err := a.DB.QueryRow("SELECT color FROM changes WHERE version_id=? AND grid_x=1 AND grid_y=0", v1.VersionID).Scan(&tombstone); err != nil || tombstone != -1 {
		t.Fatalf("explicit deletion was not stored: color=%d err=%v", tombstone, err)
	}

	readPixel := func(versionID int64) color.NRGBA {
		data, err := a.GetTile(versionID, maxZoom, 4096, 4096)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return color.NRGBAModel.Convert(img.At(0, 0)).(color.NRGBA)
	}
	if got := readPixel(v1.VersionID); got != (color.NRGBA{R: 255, A: 255}) {
		t.Fatalf("v1 source pixel = %#v, want red", got)
	}

	v2, err := a.IngestDump(&Dump{Label: "v2", DeclaredCount: 1, Events: []Event{
		{GridX: 0, GridY: 0, Color: -1, LastModified: 20},
	}}, "fixture-v2")
	if err != nil {
		t.Fatal(err)
	}
	if got := readPixel(v2.VersionID); got.A != 0 {
		t.Fatalf("v2 deleted pixel = %#v, want transparent", got)
	}
	if got := readPixel(v1.VersionID); got != (color.NRGBA{R: 255, A: 255}) {
		t.Fatalf("v1 history changed after v2 deletion: %#v", got)
	}
}

func TestHTTPServesViewerVersionMetadataAndPNGTile(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	version, err := a.IngestDump(&Dump{Label: "2026-01-02", DeclaredCount: 1, Events: []Event{
		{GridX: 0, GridY: 0, Color: 0x123456, LastModified: 123},
	}}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(a)

	versions := httptest.NewRecorder()
	handler.ServeHTTP(versions, httptest.NewRequest(http.MethodGet, "/api/versions", nil))
	if versions.Code != http.StatusOK || versions.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("versions response: status=%d type=%q", versions.Code, versions.Header().Get("Content-Type"))
	}
	var metadata []Version
	if err := json.Unmarshal(versions.Body.Bytes(), &metadata); err != nil || len(metadata) != 1 || metadata[0].Label != "2026-01-02" {
		t.Fatalf("versions JSON = %s err=%v", versions.Body.String(), err)
	}

	tile := httptest.NewRecorder()
	path := "/tiles/" + metadata[0].IDString() + "/13/4096/4096.png"
	handler.ServeHTTP(tile, httptest.NewRequest(http.MethodGet, path, nil))
	if tile.Code != http.StatusOK || tile.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("tile response: status=%d type=%q body=%s", tile.Code, tile.Header().Get("Content-Type"), tile.Body.String())
	}
	config, err := png.DecodeConfig(bytes.NewReader(tile.Body.Bytes()))
	if err != nil || config.Width != tileSize || config.Height != tileSize {
		t.Fatalf("tile config=%+v err=%v", config, err)
	}
	if version.VersionID != metadata[0].ID {
		t.Fatalf("version ID mismatch: ingest=%d API=%d", version.VersionID, metadata[0].ID)
	}

	future := httptest.NewRecorder()
	handler.ServeHTTP(future, httptest.NewRequest(http.MethodGet, "/tiles/999/13/4096/4096.png", nil))
	if future.Code != http.StatusNotFound {
		t.Fatalf("unknown future version returned status %d, want 404", future.Code)
	}

	invalidTile := httptest.NewRecorder()
	handler.ServeHTTP(invalidTile, httptest.NewRequest(http.MethodGet, "/tiles/1/14/0/0.png", nil))
	if invalidTile.Code != http.StatusBadRequest || invalidTile.Body.String() != "invalid tile coordinate\n" {
		t.Fatalf("invalid tile returned status=%d body=%q", invalidTile.Code, invalidTile.Body.String())
	}

	broken, err := OpenArchive(filepath.Join(t.TempDir(), "broken.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := broken.DB.Close(); err != nil {
		t.Fatal(err)
	}
	databaseFailure := httptest.NewRecorder()
	NewHandler(broken).ServeHTTP(databaseFailure, httptest.NewRequest(http.MethodGet, path, nil))
	if databaseFailure.Code != http.StatusInternalServerError || databaseFailure.Body.String() != "database error\n" {
		t.Fatalf("database failure leaked as status=%d body=%q", databaseFailure.Code, databaseFailure.Body.String())
	}
}

func TestCLIIngestsLimitedFixture(t *testing.T) {
	var output bytes.Buffer
	dbPath := filepath.Join(t.TempDir(), "archive.db")
	if err := run([]string{"ingest", "-db", dbPath, "-dump", "testdata/dump_2026-04-03", "-limit", "5"}, &output); err != nil {
		t.Fatal(err)
	}
	a, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	var events int
	if err := a.DB.QueryRow("SELECT event_count FROM versions").Scan(&events); err != nil || events != 5 {
		t.Fatalf("CLI event_count=%d err=%v output=%s", events, err, output.String())
	}
}
