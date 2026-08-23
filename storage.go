package main

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

type Archive struct{ DB *sql.DB }

const nativeTileFormatVersion = 1

var (
	errInvalidTile            = errors.New("invalid tile coordinate")
	errIncompatibleTileFormat = errors.New("archive tiles use an incompatible format; run rebuild-tiles")
)

type IngestResult struct {
	VersionID    int64
	Events       int
	Deletions    int
	ChangedTiles int
}

func OpenArchive(path string) (*Archive, error) {
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	db, err := sql.Open("sqlite3", path+separator+"_txlock=immediate")
	if err != nil {
		return nil, err
	}
	// ponytail: serialize SQLite access; raise this only if local read throughput matters.
	db.SetMaxOpenConns(1)
	var existingSchema int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('versions','tiles')").Scan(&existingSchema); err != nil {
		db.Close()
		return nil, err
	}
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA busy_timeout=20000",
		`CREATE TABLE IF NOT EXISTS versions (
			id INTEGER PRIMARY KEY,
			label TEXT NOT NULL UNIQUE,
			timestamp INTEGER NOT NULL,
			source TEXT NOT NULL,
			event_count INTEGER NOT NULL,
			declared_count INTEGER NOT NULL,
			deletion_count INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS changes (
			version_id INTEGER NOT NULL REFERENCES versions(id),
			grid_x INTEGER NOT NULL,
			grid_y INTEGER NOT NULL,
			color INTEGER NOT NULL,
			modified INTEGER NOT NULL,
			PRIMARY KEY (version_id, grid_x, grid_y)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS state (
			grid_x INTEGER NOT NULL,
			grid_y INTEGER NOT NULL,
			color INTEGER NOT NULL,
			modified INTEGER NOT NULL,
			PRIMARY KEY (grid_x, grid_y)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS tiles (
			version_id INTEGER NOT NULL REFERENCES versions(id),
			z INTEGER NOT NULL,
			x INTEGER NOT NULL,
			y INTEGER NOT NULL,
			data BLOB NOT NULL,
			PRIMARY KEY (version_id, z, x, y)
		) WITHOUT ROWID`,
		"CREATE INDEX IF NOT EXISTS tiles_history ON tiles(z, x, y, version_id DESC)",
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, err
		}
	}
	if existingSchema == 0 {
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version=%d", nativeTileFormatVersion)); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &Archive{DB: db}, nil
}

func (a *Archive) Close() error {
	_, _ = a.DB.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return a.DB.Close()
}

func (a *Archive) RequireNativeTileFormat() error {
	var version int
	if err := a.DB.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version != nativeTileFormatVersion {
		return fmt.Errorf("%w (found %d, need %d)", errIncompatibleTileFormat, version, nativeTileFormatVersion)
	}
	return nil
}

func (a *Archive) IngestDump(dump *Dump, source string) (_ IngestResult, err error) {
	index := 0
	return a.IngestEvents(dump.Label, source, dump.DeclaredCount, func() (Event, error) {
		if index == len(dump.Events) {
			return Event{}, io.EOF
		}
		event := dump.Events[index]
		index++
		return event, nil
	})
}

func (a *Archive) IngestEvents(label, source string, declaredCount int, next func() (Event, error)) (_ IngestResult, err error) {
	if err := a.RequireNativeTileFormat(); err != nil {
		return IngestResult{}, err
	}
	first, err := next()
	if errors.Is(err, io.EOF) {
		return IngestResult{}, errors.New("dump contains no events")
	}
	if err != nil {
		return IngestResult{}, err
	}
	tx, err := a.DB.Begin()
	if err != nil {
		return IngestResult{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	// BEGIN IMMEDIATE (configured in OpenArchive) serializes this watermark check across processes.
	var latest sql.NullInt64
	if err := tx.QueryRow("SELECT MAX(timestamp) FROM versions").Scan(&latest); err != nil {
		return IngestResult{}, err
	}
	result, err := tx.Exec(`INSERT INTO versions(label,timestamp,source,event_count,declared_count,deletion_count)
		VALUES(?,?,?,?,?,?)`, label, first.LastModified, source, 0, 0, 0)
	if err != nil {
		return IngestResult{}, err
	}
	versionID, err := result.LastInsertId()
	if err != nil {
		return IngestResult{}, err
	}
	putChange, err := tx.Prepare(`INSERT INTO changes(version_id,grid_x,grid_y,color,modified) VALUES(?,?,?,?,?)
		ON CONFLICT(version_id,grid_x,grid_y) DO UPDATE SET color=excluded.color, modified=excluded.modified
		WHERE excluded.modified>=changes.modified`)
	if err != nil {
		return IngestResult{}, err
	}
	defer putChange.Close()
	minTimestamp, maxTimestamp := first.LastModified, first.LastModified
	events, deletions := 0, 0
	put := func(event Event) error {
		if event.LastModified < 0 {
			return fmt.Errorf("invalid lastmodified %d at %d,%d", event.LastModified, event.GridX, event.GridY)
		}
		if event.Color != -1 && (event.Color < 0 || event.Color > 0xffffff) {
			return fmt.Errorf("invalid color %d at %d,%d", event.Color, event.GridX, event.GridY)
		}
		minTimestamp = min(minTimestamp, event.LastModified)
		maxTimestamp = max(maxTimestamp, event.LastModified)
		events++
		if event.Color == -1 {
			deletions++
		}
		if _, err = putChange.Exec(versionID, event.GridX, event.GridY, event.Color, event.LastModified); err != nil {
			return err
		}
		return nil
	}
	if err := put(first); err != nil {
		return IngestResult{}, err
	}
	for {
		event, readErr := next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return IngestResult{}, readErr
		}
		if err := put(event); err != nil {
			return IngestResult{}, err
		}
	}
	if latest.Valid && minTimestamp < latest.Int64 {
		return IngestResult{}, fmt.Errorf("dump starts at %d before latest archived timestamp %d", minTimestamp, latest.Int64)
	}
	if declaredCount < 0 {
		declaredCount = events
	}
	if _, err := tx.Exec(`UPDATE versions SET timestamp=?,event_count=?,declared_count=?,deletion_count=? WHERE id=?`,
		maxTimestamp, events, declaredCount, deletions, versionID); err != nil {
		return IngestResult{}, err
	}

	putState, err := tx.Prepare(`INSERT INTO state(grid_x,grid_y,color,modified) VALUES(?,?,?,?)
		ON CONFLICT(grid_x,grid_y) DO UPDATE SET color=excluded.color, modified=excluded.modified
		WHERE excluded.modified>=state.modified`)
	if err != nil {
		return IngestResult{}, err
	}
	defer putState.Close()
	deleteState, err := tx.Prepare("DELETE FROM state WHERE grid_x=? AND grid_y=? AND modified<=?")
	if err != nil {
		return IngestResult{}, err
	}
	defer deleteState.Close()
	rows, err := tx.Query("SELECT grid_x,grid_y,color,modified FROM changes WHERE version_id=?", versionID)
	if err != nil {
		return IngestResult{}, err
	}
	affected := map[tileCoord]struct{}{}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.GridX, &event.GridY, &event.Color, &event.LastModified); err != nil {
			rows.Close()
			return IngestResult{}, err
		}
		if event.Color == -1 {
			_, err = deleteState.Exec(event.GridX, event.GridY, event.LastModified)
		} else {
			_, err = putState.Exec(event.GridX, event.GridY, event.Color, event.LastModified)
		}
		if err != nil {
			rows.Close()
			return IngestResult{}, err
		}
		affected[gridCellTile(event.GridX, event.GridY, maxZoom)] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return IngestResult{}, err
	}
	if err := rows.Close(); err != nil {
		return IngestResult{}, err
	}

	stored, err := compileTiles(tx, versionID, affected)
	if err != nil {
		return IngestResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return IngestResult{}, err
	}
	return IngestResult{VersionID: versionID, Events: events, Deletions: deletions, ChangedTiles: stored}, nil
}

func compileTiles(tx *sql.Tx, versionID int64, affected map[tileCoord]struct{}) (int, error) {
	stored := 0
	for tile := range affected {
		img, err := renderBaseTile(tx, tile.X, tile.Y)
		if err != nil {
			return 0, err
		}
		if err := storeTile(tx, versionID, maxZoom, tile.X, tile.Y, img); err != nil {
			return 0, err
		}
		stored++
	}
	children := affected
	for zoom := maxZoom - 1; zoom >= 0; zoom-- {
		parents := map[tileCoord]struct{}{}
		for child := range children {
			// Native tile coordinates are signed; Go's truncation toward zero is wrong west/south of the origin.
			parents[tileCoord{floorDiv(child.X, 2), floorDiv(child.Y, 2)}] = struct{}{}
		}
		for parent := range parents {
			img, err := mergeParentTile(tx, versionID, zoom, parent.X, parent.Y)
			if err != nil {
				return 0, err
			}
			if err := storeTile(tx, versionID, zoom, parent.X, parent.Y, img); err != nil {
				return 0, err
			}
			stored++
		}
		children = parents
	}
	return stored, nil
}

type RebuildResult struct {
	Versions int `json:"versions"`
	Changes  int `json:"changes"`
	Tiles    int `json:"tiles"`
}

type rebuildVersion struct {
	ID    int64
	Label string
}

func (a *Archive) RebuildTiles(output io.Writer) (RebuildResult, error) {
	if output == nil {
		output = io.Discard
	}
	rows, err := a.DB.Query("SELECT id,label FROM versions ORDER BY timestamp,id")
	if err != nil {
		return RebuildResult{}, err
	}
	versions := []rebuildVersion{}
	var previousID int64
	for rows.Next() {
		var version rebuildVersion
		if err := rows.Scan(&version.ID, &version.Label); err != nil {
			rows.Close()
			return RebuildResult{}, err
		}
		// Tile inheritance uses version_id<=selected, so chronological IDs must be monotonic.
		if len(versions) > 0 && version.ID <= previousID {
			rows.Close()
			return RebuildResult{}, fmt.Errorf("version IDs are not chronological at %s (%d after %d)", version.Label, version.ID, previousID)
		}
		versions = append(versions, version)
		previousID = version.ID
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RebuildResult{}, err
	}
	if err := rows.Close(); err != nil {
		return RebuildResult{}, err
	}

	reset, err := a.DB.Begin()
	if err != nil {
		return RebuildResult{}, err
	}
	if _, err := reset.Exec("PRAGMA user_version=0"); err != nil {
		reset.Rollback()
		return RebuildResult{}, err
	}
	if _, err := reset.Exec("DELETE FROM tiles"); err != nil {
		reset.Rollback()
		return RebuildResult{}, err
	}
	if _, err := reset.Exec("DELETE FROM state"); err != nil {
		reset.Rollback()
		return RebuildResult{}, err
	}
	if err := reset.Commit(); err != nil {
		return RebuildResult{}, err
	}

	result := RebuildResult{Versions: len(versions)}
	for index, version := range versions {
		changes, tiles, err := a.rebuildVersionTiles(version.ID)
		if err != nil {
			return RebuildResult{}, fmt.Errorf("rebuild %s: %w", version.Label, err)
		}
		result.Changes += changes
		result.Tiles += tiles
		fmt.Fprintf(output, "[%d/%d] %s: %d changes, %d tiles\n", index+1, len(versions), version.Label, changes, tiles)
	}
	if _, err := a.DB.Exec(fmt.Sprintf("PRAGMA user_version=%d", nativeTileFormatVersion)); err != nil {
		return RebuildResult{}, err
	}
	return result, nil
}

func (a *Archive) rebuildVersionTiles(versionID int64) (_ int, _ int, err error) {
	tx, err := a.DB.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	putState, err := tx.Prepare(`INSERT INTO state(grid_x,grid_y,color,modified) VALUES(?,?,?,?)
		ON CONFLICT(grid_x,grid_y) DO UPDATE SET color=excluded.color, modified=excluded.modified`)
	if err != nil {
		return 0, 0, err
	}
	defer putState.Close()
	deleteState, err := tx.Prepare("DELETE FROM state WHERE grid_x=? AND grid_y=?")
	if err != nil {
		return 0, 0, err
	}
	defer deleteState.Close()
	rows, err := tx.Query("SELECT grid_x,grid_y,color,modified FROM changes WHERE version_id=? ORDER BY grid_x,grid_y", versionID)
	if err != nil {
		return 0, 0, err
	}
	affected := map[tileCoord]struct{}{}
	changes := 0
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.GridX, &event.GridY, &event.Color, &event.LastModified); err != nil {
			rows.Close()
			return 0, 0, err
		}
		if event.Color == -1 {
			_, err = deleteState.Exec(event.GridX, event.GridY)
		} else {
			_, err = putState.Exec(event.GridX, event.GridY, event.Color, event.LastModified)
		}
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		affected[gridCellTile(event.GridX, event.GridY, maxZoom)] = struct{}{}
		changes++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	tiles, err := compileTiles(tx, versionID, affected)
	if err != nil {
		return 0, 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, 0, err
	}
	return changes, tiles, nil
}

func renderBaseTile(tx *sql.Tx, x, y int) (*image.NRGBA, error) {
	gx0, gy0 := x*tileSize, y*tileSize
	rows, err := tx.Query("SELECT grid_x,grid_y,color FROM state WHERE grid_x BETWEEN ? AND ? AND grid_y BETWEEN ? AND ?", gx0, gx0+tileSize-1, gy0, gy0+tileSize-1)
	if err != nil {
		return nil, err
	}
	img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	for rows.Next() {
		var gx, gy int
		var value int32
		if err := rows.Scan(&gx, &gy, &value); err != nil {
			rows.Close()
			return nil, err
		}
		// One z13 texel is exactly one source cell; grid Y grows north while PNG Y grows down.
		img.SetNRGBA(gx-gx0, tileSize-1-(gy-gy0), colorIntToRGBA(value))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return img, nil
}

func mergeParentTile(tx *sql.Tx, versionID int64, zoom, x, y int) (*image.NRGBA, error) {
	// PNG Y grows downward, but native tile Y grows northward.
	childCoords := [4]tileCoord{
		{X: x * 2, Y: y*2 + 1}, {X: x*2 + 1, Y: y*2 + 1},
		{X: x * 2, Y: y * 2}, {X: x*2 + 1, Y: y * 2},
	}
	children := make([]*image.NRGBA, len(childCoords))
	for i, coord := range childCoords {
		child, err := getTileImage(tx, versionID, zoom+1, coord.X, coord.Y)
		if err != nil {
			return nil, err
		}
		children[i] = child
	}
	out := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	for py := range tileSize {
		for px := range tileSize {
			child := children[(py/(tileSize/2))*2+px/(tileSize/2)]
			sx, sy := (px%(tileSize/2))*2, (py%(tileSize/2))*2
			out.SetNRGBA(px, py, majority4(
				child.NRGBAAt(sx, sy), child.NRGBAAt(sx+1, sy),
				child.NRGBAAt(sx, sy+1), child.NRGBAAt(sx+1, sy+1),
			))
		}
	}
	return out, nil
}

func getTileImage(tx *sql.Tx, versionID int64, zoom, x, y int) (*image.NRGBA, error) {
	var data []byte
	err := tx.QueryRow(`SELECT data FROM tiles WHERE z=? AND x=? AND y=? AND version_id<=?
		ORDER BY version_id DESC LIMIT 1`, zoom, x, y, versionID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize)), nil
	}
	if err != nil {
		return nil, err
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	out := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	draw.Draw(out, out.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	return out, nil
}

func storeTile(tx *sql.Tx, versionID int64, zoom, x, y int, img image.Image) error {
	var data bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := encoder.Encode(&data, img); err != nil {
		return err
	}
	_, err := tx.Exec("INSERT INTO tiles(version_id,z,x,y,data) VALUES(?,?,?,?,?)", versionID, zoom, x, y, data.Bytes())
	return err
}

func (a *Archive) GetTile(versionID int64, zoom, x, y int) ([]byte, error) {
	if err := a.RequireNativeTileFormat(); err != nil {
		return nil, err
	}
	if zoom < 0 || zoom > maxZoom {
		return nil, fmt.Errorf("%w: %d/%d/%d", errInvalidTile, zoom, x, y)
	}
	var data []byte
	err := a.DB.QueryRow(`SELECT data FROM tiles WHERE z=? AND x=? AND y=? AND version_id<=?
		AND EXISTS (SELECT 1 FROM versions WHERE id=?)
		ORDER BY version_id DESC LIMIT 1`, zoom, x, y, versionID, versionID).Scan(&data)
	return data, err
}
