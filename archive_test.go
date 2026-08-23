package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestNativeTileMappingUsesFloorDivision(t *testing.T) {
	cases := map[int]int{-257: -2, -256: -1, -255: -1, -1: -1, 0: 0, 1: 0, 255: 0, 256: 1, 257: 1}
	for grid, want := range cases {
		if got := floorDiv(grid, tileSize); got != want {
			t.Errorf("floorDiv(%d, %d) = %d, want %d", grid, tileSize, got, want)
		}
		if got := gridCellTile(int32(grid), 0, maxZoom); got != (tileCoord{X: want, Y: 0}) {
			t.Errorf("grid cell %d mapped to %+v, want x=%d y=0", grid, got, want)
		}
	}
}

func TestNativeTileBoundsMeetExactlyAtHalfCellBoundaries(t *testing.T) {
	for zoom, want := range map[int]int{maxZoom: 1, maxZoom - 1: 2, maxZoom - 2: 4} {
		if got := cellsPerTexel(zoom); got != want {
			t.Errorf("level %d cells per texel = %d, want %d", zoom, got, want)
		}
	}
	left := nativeTileBounds(maxZoom, -1, 0)
	right := nativeTileBounds(maxZoom, 0, 0)
	if left.East != right.West {
		t.Fatalf("adjacent tile boundary differs: left east %.17g right west %.17g", left.East, right.West)
	}
	if right.West != -gridSize/2 || right.East != (tileSize-0.5)*gridSize {
		t.Fatalf("tile 0 bounds = %+v", right)
	}
	south := nativeTileBounds(maxZoom, 0, 0)
	north := nativeTileBounds(maxZoom, 0, 1)
	if south.North != north.South {
		t.Fatalf("north/south tile boundary differs: south north %.17g north south %.17g", south.North, north.South)
	}
}

func TestFullResolutionTilePreservesNativeShapeOneCellPerTexel(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	shape := []tileCoord{{1, 1}, {2, 1}, {2, 2}, {3, 2}, {3, 3}}
	events := make([]Event, len(shape))
	for i, cell := range shape {
		events[i] = Event{GridX: int32(cell.X), GridY: int32(cell.Y), Color: 0xff0000, LastModified: int64(i + 1)}
	}
	version, err := a.IngestDump(&Dump{Label: "shape", DeclaredCount: len(events), Events: events}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	data, err := a.GetTile(version.VersionID, maxZoom, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	want := map[image.Point]bool{}
	for _, cell := range shape {
		want[image.Pt(cell.X, tileSize-1-cell.Y)] = true
	}
	opaque := 0
	for y := range tileSize {
		for x := range tileSize {
			_, _, _, alpha := decoded.At(x, y).RGBA()
			if alpha != 0 {
				opaque++
				if !want[image.Pt(x, y)] {
					t.Fatalf("unexpected opaque texel at %d,%d", x, y)
				}
			}
		}
	}
	if opaque != len(shape) {
		t.Fatalf("opaque texels = %d, want exactly %d native cells", opaque, len(shape))
	}
}

func TestParentMergePlacesNorthAndSouthChildrenCorrectly(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	tx, err := a.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO versions(id,label,timestamp,source,event_count,declared_count,deletion_count) VALUES(1,'v1',1,'fixture',1,1,0)`); err != nil {
		t.Fatal(err)
	}
	red := color.NRGBA{R: 255, A: 255}
	green := color.NRGBA{G: 255, A: 255}
	blue := color.NRGBA{B: 255, A: 255}
	yellow := color.NRGBA{R: 255, G: 255, A: 255}
	children := map[tileCoord]color.NRGBA{
		{X: 0, Y: 1}: red, {X: 1, Y: 1}: green,
		{X: 0, Y: 0}: blue, {X: 1, Y: 0}: yellow,
	}
	for child, value := range children {
		img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
		draw.Draw(img, img.Bounds(), image.NewUniform(value), image.Point{}, draw.Src)
		if err := storeTile(tx, 1, maxZoom, child.X, child.Y, img); err != nil {
			t.Fatal(err)
		}
	}
	parent, err := mergeParentTile(tx, 1, maxZoom-1, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	for point, want := range map[image.Point]color.NRGBA{
		image.Pt(0, 0): red, image.Pt(tileSize-1, 0): green,
		image.Pt(0, tileSize-1): blue, image.Pt(tileSize-1, tileSize-1): yellow,
	} {
		if got := parent.NRGBAAt(point.X, point.Y); got != want {
			t.Errorf("parent pixel %v = %#v, want %#v", point, got, want)
		}
	}
}

func TestViewerUsesSignedNativeGridTilesAndExactCorners(t *testing.T) {
	html := string(viewerHTML)
	for _, fragment := range []string{
		"style:'/map-style.json'",
		"renderWorldCopies:true",
		"<script src=\"/pixel-tile-layer.js\"></script>",
		"new PixelTileLayer('pixel-tiles')",
		"function nativeTileRange(bounds,z)",
		"function visibleNativeTiles(bounds,z)",
		"Math.floor((bounds.getWest()+180)/360)",
		"world*360",
		"mx/gridSize+0.5",
		"my/gridSize+0.5",
		"function nativeTileCorners(z,x,y,world=0)",
		"(gx0-0.5)*gridSize",
		"imageOrientation:'flipY'",
		"`/tiles/${version}/${z}/${x}/${y}.png`",
		"const maxCachedTiles=256",
		"const tileUsage=new Map()",
		"touchLoadedTile",
		"evictTileCache",
		"async function fetchTileBlob",
		"async function cropParentTile",
		"async function loadFallbackForTile",
		"fallback/${version}/${z}/${x}/${y}@${world}",
		"imageSmoothingEnabled=false",
		"result.blob===null",
		"Promise.race",
		"touchLoadedTile(fallbackKey",
		"new AbortController()",
		"Failed to decode detail tile",
	} {
		if !strings.Contains(html, fragment) {
			t.Errorf("viewer is missing native-grid behavior %q", fragment)
		}
	}
	if strings.Contains(html, "type:'raster',tiles:[`${location.origin}/tiles/") || strings.Contains(html, "function tileCorners(x,y,z)") {
		t.Fatal("viewer still treats archive tiles as standard XYZ raster tiles")
	}
	if strings.Contains(html, "tile.openstreetmap.org") {
		t.Fatal("viewer still uses the placeholder OSM raster style")
	}
	if strings.Contains(html, "if(!active.has(key))pixelTileLayer.removeTile(key)") {
		t.Fatal("viewer still evicts every off-screen tile immediately")
	}
	if strings.Contains(html, "showOnlyLevel") || strings.Contains(html, "const levels=[") {
		t.Fatal("viewer still replaces the whole viewport with a low-resolution level")
	}
}

func TestRewriteMapStyleUsesLocalProxy(t *testing.T) {
	input := `{"sprite":"http://localhost:5039/sprites/ofm","glyphs":"http://localhost:5039/fonts/{fontstack}/{range}.pbf"}`
	want := `{"sprite":"https://archive.example/geopixels-style/sprites/ofm","glyphs":"https://archive.example/geopixels-style/fonts/{fontstack}/{range}.pbf"}`
	if got := rewriteMapStyle(input, "https://archive.example/geopixels-style/"); got != want {
		t.Fatalf("rewritten style = %s, want %s", got, want)
	}
}

func TestStyleProxyOnlyAllowsAssetReadsAndDropsCredentials(t *testing.T) {
	if !styleAssetMethodAllowed(http.MethodGet) || !styleAssetMethodAllowed(http.MethodHead) || styleAssetMethodAllowed(http.MethodPost) {
		t.Fatal("style proxy must allow only GET and HEAD")
	}
	for _, path := range []string{"/tiles/0/0/0.pbf", "/natural_earth/ne2sr/0/0/0.png", "/sprites/ofm.json", "/fonts/Noto/0-255.pbf"} {
		if !styleAssetPathAllowed(path) {
			t.Errorf("style proxy rejected asset path %q", path)
		}
	}
	if styleAssetPathAllowed("/api/account") {
		t.Fatal("style proxy allows non-style upstream paths")
	}
	request := httptest.NewRequest(http.MethodGet, "/geopixels-style/tiles/0/0/0.pbf", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("Proxy-Authorization", "Basic secret")
	request.Header.Set("Cookie", "session=secret")
	scrubStyleProxyHeaders(request.Header)
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
		if request.Header.Get(name) != "" {
			t.Fatalf("style proxy retained sensitive %s header", name)
		}
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
		data, err := a.GetTile(versionID, maxZoom, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return color.NRGBAModel.Convert(img.At(0, tileSize-1)).(color.NRGBA)
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

func TestParentTileInheritsUnchangedSignedChild(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.IngestDump(&Dump{Label: "v1", DeclaredCount: 1, Events: []Event{
		{GridX: -512, GridY: 0, Color: 0xff0000, LastModified: 10},
	}}, "fixture-v1"); err != nil {
		t.Fatal(err)
	}
	v2, err := a.IngestDump(&Dump{Label: "v2", DeclaredCount: 1, Events: []Event{
		{GridX: -1, GridY: 0, Color: 0x0000ff, LastModified: 20},
	}}, "fixture-v2")
	if err != nil {
		t.Fatal(err)
	}
	data, err := a.GetTile(v2.VersionID, maxZoom-1, -1, 0)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if got := color.NRGBAModel.Convert(img.At(0, tileSize-1)).(color.NRGBA); got != (color.NRGBA{R: 255, A: 255}) {
		t.Fatalf("inherited western child = %#v, want red", got)
	}
	if got := color.NRGBAModel.Convert(img.At(tileSize-1, tileSize-1)).(color.NRGBA); got != (color.NRGBA{B: 255, A: 255}) {
		t.Fatalf("current eastern child = %#v, want blue", got)
	}
}

func TestHTTPServesViewerVersionMetadataAndPNGTile(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	version, err := a.IngestDump(&Dump{Label: "2026-01-02", DeclaredCount: 2, Events: []Event{
		{GridX: 0, GridY: 0, Color: 0x123456, LastModified: 123},
		{GridX: -1, GridY: -1, Color: 0x654321, LastModified: 124},
	}}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(a)

	layerScript := httptest.NewRecorder()
	handler.ServeHTTP(layerScript, httptest.NewRequest(http.MethodGet, "/pixel-tile-layer.js", nil))
	if layerScript.Code != http.StatusOK || layerScript.Header().Get("Content-Type") != "text/javascript; charset=utf-8" || !strings.Contains(layerScript.Body.String(), "class PixelTileLayer") {
		t.Fatalf("PixelTileLayer response: status=%d type=%q", layerScript.Code, layerScript.Header().Get("Content-Type"))
	}
	if !strings.Contains(layerScript.Body.String(), "this._quadUploaded = false") {
		t.Fatal("PixelTileLayer does not reset its shared quad after WebGL removal")
	}
	if !strings.Contains(layerScript.Body.String(), "entry.hidden") {
		t.Fatal("PixelTileLayer cannot retain hidden parent fallback textures")
	}
	for _, fragment := range []string{"uniform float u_texelsPerPixel", "gl.LINEAR"} {
		if !strings.Contains(layerScript.Body.String(), fragment) {
			t.Fatalf("PixelTileLayer script is missing %q", fragment)
		}
	}
	mapStyle := httptest.NewRecorder()
	handler.ServeHTTP(mapStyle, httptest.NewRequest(http.MethodGet, "/map-style.json", nil))
	if mapStyle.Code != http.StatusOK || mapStyle.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("map style response: status=%d type=%q", mapStyle.Code, mapStyle.Header().Get("Content-Type"))
	}
	if strings.Contains(mapStyle.Body.String(), "http://localhost:5039/") || !strings.Contains(mapStyle.Body.String(), "http://example.com/geopixels-style/tiles/") {
		t.Fatal("map style URLs were not rewritten through the local proxy")
	}
	blockedStyle := httptest.NewRecorder()
	handler.ServeHTTP(blockedStyle, httptest.NewRequest(http.MethodPost, "/geopixels-style/tiles/0/0/0.pbf", nil))
	if blockedStyle.Code != http.StatusMethodNotAllowed || blockedStyle.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("style proxy POST: status=%d allow=%q", blockedStyle.Code, blockedStyle.Header().Get("Allow"))
	}

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
	path := "/tiles/" + metadata[0].IDString() + "/13/0/0.png"
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
	signed := httptest.NewRecorder()
	handler.ServeHTTP(signed, httptest.NewRequest(http.MethodGet, "/tiles/"+metadata[0].IDString()+"/13/-1/-1.png", nil))
	if signed.Code != http.StatusOK || signed.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("signed tile response: status=%d type=%q body=%s", signed.Code, signed.Header().Get("Content-Type"), signed.Body.String())
	}

	future := httptest.NewRecorder()
	handler.ServeHTTP(future, httptest.NewRequest(http.MethodGet, "/tiles/999/13/0/0.png", nil))
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

func TestUnmarkedArchiveRefusesNativeTilesAndIngest(t *testing.T) {
	a, err := OpenArchive(filepath.Join(t.TempDir(), "archive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.DB.Exec("PRAGMA user_version=0"); err != nil {
		t.Fatal(err)
	}
	if err := a.RequireNativeTileFormat(); !errors.Is(err, errIncompatibleTileFormat) {
		t.Fatalf("format check error = %v, want incompatible format", err)
	}
	if _, err := a.GetTile(1, maxZoom, 0, 0); !errors.Is(err, errIncompatibleTileFormat) {
		t.Fatalf("GetTile error = %v, want incompatible format", err)
	}
	_, err = a.IngestDump(&Dump{Label: "blocked", DeclaredCount: 1, Events: []Event{{GridX: 0, GridY: 0, Color: 1, LastModified: 1}}}, "fixture")
	if !errors.Is(err, errIncompatibleTileFormat) {
		t.Fatalf("IngestDump error = %v, want incompatible format", err)
	}
}

func TestCLIRebuildTilesFromChangesPreservesHistory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "archive.db")
	a, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	v1, err := a.IngestDump(&Dump{Label: "v1", DeclaredCount: 2, Events: []Event{
		{GridX: -1, GridY: 0, Color: 0xff0000, LastModified: 10},
		{GridX: 0, GridY: 0, Color: 0x0000ff, LastModified: 11},
	}}, "fixture-v1")
	if err != nil {
		t.Fatal(err)
	}
	v2, err := a.IngestDump(&Dump{Label: "v2", DeclaredCount: 2, Events: []Event{
		{GridX: -1, GridY: 0, Color: -1, LastModified: 20},
		{GridX: 0, GridY: 0, Color: 0x00ff00, LastModified: 21},
	}}, "fixture-v2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec("DELETE FROM state; DELETE FROM tiles; PRAGMA user_version=0"); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := run([]string{"rebuild-tiles", "-db", dbPath}, &output); err != nil {
		t.Fatalf("rebuild-tiles failed: %v output=%s", err, output.String())
	}
	a, err = OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.RequireNativeTileFormat(); err != nil {
		t.Fatal(err)
	}
	read := func(versionID int64, tileX, pixelX int) color.NRGBA {
		data, err := a.GetTile(versionID, maxZoom, tileX, 0)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return color.NRGBAModel.Convert(img.At(pixelX, tileSize-1)).(color.NRGBA)
	}
	if got := read(v1.VersionID, -1, tileSize-1); got != (color.NRGBA{R: 255, A: 255}) {
		t.Fatalf("rebuilt v1 west pixel = %#v", got)
	}
	if got := read(v1.VersionID, 0, 0); got != (color.NRGBA{B: 255, A: 255}) {
		t.Fatalf("rebuilt v1 east pixel = %#v", got)
	}
	if got := read(v2.VersionID, -1, tileSize-1); got.A != 0 {
		t.Fatalf("rebuilt v2 tombstone = %#v, want transparent", got)
	}
	if got := read(v2.VersionID, 0, 0); got != (color.NRGBA{G: 255, A: 255}) {
		t.Fatalf("rebuilt v2 east pixel = %#v", got)
	}
}

func TestConcurrentIngestSerializesVersionTimestamps(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "archive.db")
	high, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer high.Close()
	low, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer low.Close()

	highWaiting := make(chan struct{})
	releaseHigh := make(chan struct{})
	highCalls := 0
	highResult := make(chan error, 1)
	go func() {
		_, err := high.IngestEvents("high", "fixture", 1, func() (Event, error) {
			highCalls++
			if highCalls == 1 {
				return Event{GridX: 0, GridY: 0, Color: 1, LastModified: 100}, nil
			}
			close(highWaiting)
			<-releaseHigh
			return Event{}, io.EOF
		})
		highResult <- err
	}()
	<-highWaiting
	lowResult := make(chan error, 1)
	go func() {
		calls := 0
		_, err := low.IngestEvents("low", "fixture", 1, func() (Event, error) {
			calls++
			if calls == 1 {
				return Event{GridX: 1, GridY: 0, Color: 2, LastModified: 90}, nil
			}
			return Event{}, io.EOF
		})
		lowResult <- err
	}()
	time.Sleep(100 * time.Millisecond)
	close(releaseHigh)
	if err := <-highResult; err != nil {
		t.Fatalf("high ingest: %v", err)
	}
	if err := <-lowResult; err == nil || !strings.Contains(err.Error(), "before latest archived timestamp") {
		t.Fatalf("low ingest error = %v, want chronological rejection", err)
	}
}

func TestPostgresCSVReaderUsesNamedColumnsAndIgnoresUserID(t *testing.T) {
	reader, err := newPostgresCSVEventReader(strings.NewReader("gridx,gridy,color,userid,lastmodified\n-425000,141086,16049373,5155,1775191405\n"))
	if err != nil {
		t.Fatal(err)
	}
	event, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	want := Event{GridX: -425000, GridY: 141086, Color: 16049373, LastModified: 1775191405}
	if event != want {
		t.Fatalf("CSV event = %+v, want %+v", event, want)
	}
	if _, err := reader.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("second CSV read error = %v, want EOF", err)
	}
	if _, err := newPostgresCSVEventReader(strings.NewReader("gridx,gridy,color\n1,2,3\n")); err == nil {
		t.Fatal("CSV reader accepted a header without lastmodified")
	}
	if err := run([]string{"ingest-postgres", "-label", "missing-file"}, io.Discard); err == nil || !strings.Contains(err.Error(), "-csv is required") {
		t.Fatalf("missing completed CSV error = %v", err)
	}
}

func TestCLIPostgresCSVIngestRollsBackMalformedStream(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "archive.db")
	csvPath := filepath.Join(dir, "broken.csv")
	if err := os.WriteFile(csvPath, []byte("gridx,gridy,color,userid,lastmodified\n1,2,3,4,100\n1,2,not-a-color,4,101\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"ingest-postgres", "-db", dbPath, "-csv", csvPath, "-label", "broken"}, io.Discard); err == nil {
		t.Fatal("malformed PostgreSQL stream succeeded")
	}
	a, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	var versions int
	if err := a.DB.QueryRow("SELECT COUNT(*) FROM versions").Scan(&versions); err != nil || versions != 0 {
		t.Fatalf("failed stream left %d versions: %v", versions, err)
	}
}

func TestCLIPostgresCSVIngestAppliesAndCompilesIncrementalChanges(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "archive.db")
	firstCSV := filepath.Join(dir, "first.csv")
	secondCSV := filepath.Join(dir, "second.csv")
	if err := os.WriteFile(firstCSV, []byte("gridx,gridy,color,userid,lastmodified\n-425000,141086,16049373,5155,1775191405\n-425000,141087,8481136,12611,1774129294\n-424999,141088,1193046,12611,1775191406\n-425000,141086,1,5155,1774000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondCSV, []byte("gridx,gridy,color,userid,lastmodified\n-425000,141086,66051,5155,1775191406\n-425000,141087,-1,12611,1775191501\n-425000,141087,16711680,12611,1775191500\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run([]string{"ingest-postgres", "-db", dbPath, "-csv", firstCSV, "-label", "snapshot"}, &output); err != nil {
		t.Fatalf("first postgres ingest: %v output=%s", err, output.String())
	}
	output.Reset()
	if err := run([]string{"ingest-postgres", "-db", dbPath, "-csv", secondCSV, "-label", "incremental"}, &output); err != nil {
		t.Fatalf("incremental postgres ingest: %v output=%s", err, output.String())
	}
	a, err := OpenArchive(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	var versions int
	if err := a.DB.QueryRow("SELECT COUNT(*) FROM versions").Scan(&versions); err != nil || versions != 2 {
		t.Fatalf("versions=%d err=%v", versions, err)
	}
	read := func(versionID int64, gx, gy int32) color.NRGBA {
		tile := gridCellTile(gx, gy, maxZoom)
		data, err := a.GetTile(versionID, maxZoom, tile.X, tile.Y)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		px := int(gx) - tile.X*tileSize
		py := tileSize - 1 - (int(gy) - tile.Y*tileSize)
		return color.NRGBAModel.Convert(img.At(px, py)).(color.NRGBA)
	}
	if got := read(1, -425000, 141086); got != colorIntToRGBA(16049373) {
		t.Fatalf("historical pixel = %#v", got)
	}
	if got := read(2, -425000, 141086); got != colorIntToRGBA(66051) {
		t.Fatalf("updated pixel = %#v", got)
	}
	if got := read(2, -425000, 141087); got.A != 0 {
		t.Fatalf("deleted pixel = %#v, want transparent", got)
	}
}
