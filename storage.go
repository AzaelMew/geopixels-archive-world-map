package main

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"

	_ "github.com/mattn/go-sqlite3"
)

type Archive struct{ DB *sql.DB }

var errInvalidTile = errors.New("invalid tile coordinate")

type IngestResult struct {
	VersionID    int64
	Events       int
	Deletions    int
	ChangedTiles int
}

func OpenArchive(path string) (*Archive, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, err
	}
	// ponytail: serialize SQLite access; raise this only if local read throughput matters.
	db.SetMaxOpenConns(1)
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
	return &Archive{DB: db}, nil
}

func (a *Archive) Close() error {
	_, _ = a.DB.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return a.DB.Close()
}

func (a *Archive) IngestDump(dump *Dump, source string) (_ IngestResult, err error) {
	if len(dump.Events) == 0 {
		return IngestResult{}, errors.New("dump contains no events")
	}
	minTimestamp, maxTimestamp := dump.Events[0].LastModified, dump.Events[0].LastModified
	deletions := 0
	for _, event := range dump.Events {
		minTimestamp = min(minTimestamp, event.LastModified)
		maxTimestamp = max(maxTimestamp, event.LastModified)
		if event.Color == -1 {
			deletions++
		} else if event.Color < 0 || event.Color > 0xffffff {
			return IngestResult{}, fmt.Errorf("invalid color %d at %d,%d", event.Color, event.GridX, event.GridY)
		}
	}
	var latest sql.NullInt64
	if err := a.DB.QueryRow("SELECT MAX(timestamp) FROM versions").Scan(&latest); err != nil {
		return IngestResult{}, err
	}
	if latest.Valid && minTimestamp < latest.Int64 {
		return IngestResult{}, fmt.Errorf("dump starts at %d before latest archived timestamp %d", minTimestamp, latest.Int64)
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
	result, err := tx.Exec(`INSERT INTO versions(label,timestamp,source,event_count,declared_count,deletion_count)
		VALUES(?,?,?,?,?,?)`, dump.Label, maxTimestamp, source, len(dump.Events), dump.DeclaredCount, deletions)
	if err != nil {
		return IngestResult{}, err
	}
	versionID, err := result.LastInsertId()
	if err != nil {
		return IngestResult{}, err
	}
	putChange, err := tx.Prepare(`INSERT INTO changes(version_id,grid_x,grid_y,color,modified) VALUES(?,?,?,?,?)
		ON CONFLICT(version_id,grid_x,grid_y) DO UPDATE SET color=excluded.color, modified=excluded.modified`)
	if err != nil {
		return IngestResult{}, err
	}
	defer putChange.Close()
	putState, err := tx.Prepare(`INSERT INTO state(grid_x,grid_y,color,modified) VALUES(?,?,?,?)
		ON CONFLICT(grid_x,grid_y) DO UPDATE SET color=excluded.color, modified=excluded.modified`)
	if err != nil {
		return IngestResult{}, err
	}
	defer putState.Close()
	deleteState, err := tx.Prepare("DELETE FROM state WHERE grid_x=? AND grid_y=?")
	if err != nil {
		return IngestResult{}, err
	}
	defer deleteState.Close()

	affected := map[tileCoord]struct{}{}
	for _, event := range dump.Events {
		if _, err = putChange.Exec(versionID, event.GridX, event.GridY, event.Color, event.LastModified); err != nil {
			return IngestResult{}, err
		}
		if event.Color == -1 {
			_, err = deleteState.Exec(event.GridX, event.GridY)
		} else {
			_, err = putState.Exec(event.GridX, event.GridY, event.Color, event.LastModified)
		}
		if err != nil {
			return IngestResult{}, err
		}
		for _, tile := range gridCellTiles(event.GridX, event.GridY, maxZoom) {
			affected[tile] = struct{}{}
		}
	}

	stored := 0
	for tile := range affected {
		img, err := renderBaseTile(tx, tile.X, tile.Y)
		if err != nil {
			return IngestResult{}, err
		}
		if err = storeTile(tx, versionID, maxZoom, tile.X, tile.Y, img); err != nil {
			return IngestResult{}, err
		}
		stored++
	}
	children := affected
	for zoom := maxZoom - 1; zoom >= 0; zoom-- {
		parents := map[tileCoord]struct{}{}
		for child := range children {
			parents[tileCoord{child.X / 2, child.Y / 2}] = struct{}{}
		}
		for parent := range parents {
			img, err := mergeParentTile(tx, versionID, zoom, parent.X, parent.Y)
			if err != nil {
				return IngestResult{}, err
			}
			if err = storeTile(tx, versionID, zoom, parent.X, parent.Y, img); err != nil {
				return IngestResult{}, err
			}
			stored++
		}
		children = parents
	}
	if err = tx.Commit(); err != nil {
		return IngestResult{}, err
	}
	return IngestResult{VersionID: versionID, Events: len(dump.Events), Deletions: deletions, ChangedTiles: stored}, nil
}

func renderBaseTile(tx *sql.Tx, x, y int) (*image.NRGBA, error) {
	gx1, gy1 := tilePixelToGrid(maxZoom, x, y, 0, 0)
	gx2, gy2 := tilePixelToGrid(maxZoom, x, y, tileSize-1, tileSize-1)
	minX, maxX := min(gx1, gx2)-1, max(gx1, gx2)+1
	minY, maxY := min(gy1, gy2)-1, max(gy1, gy2)+1
	rows, err := tx.Query("SELECT grid_x,grid_y,color FROM state WHERE grid_x BETWEEN ? AND ? AND grid_y BETWEEN ? AND ?", minX, maxX, minY, maxY)
	if err != nil {
		return nil, err
	}
	colors := map[uint64]int32{}
	for rows.Next() {
		var gx, gy int32
		var value int32
		if err := rows.Scan(&gx, &gy, &value); err != nil {
			rows.Close()
			return nil, err
		}
		colors[gridKey(gx, gy)] = value
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	for py := range tileSize {
		for px := range tileSize {
			gx, gy := tilePixelToGrid(maxZoom, x, y, px, py)
			if value, ok := colors[gridKey(gx, gy)]; ok {
				img.SetNRGBA(px, py, colorIntToRGBA(value))
			}
		}
	}
	return img, nil
}

func gridKey(x, y int32) uint64 { return uint64(uint32(x))<<32 | uint64(uint32(y)) }

func mergeParentTile(tx *sql.Tx, versionID int64, zoom, x, y int) (*image.NRGBA, error) {
	children := make([]*image.NRGBA, 4)
	for i := range 4 {
		child, err := getTileImage(tx, versionID, zoom+1, x*2+i%2, y*2+i/2)
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
	if zoom < 0 || zoom > maxZoom || x < 0 || y < 0 || x >= 1<<zoom || y >= 1<<zoom {
		return nil, fmt.Errorf("%w: %d/%d/%d", errInvalidTile, zoom, x, y)
	}
	var data []byte
	err := a.DB.QueryRow(`SELECT data FROM tiles WHERE z=? AND x=? AND y=? AND version_id<=?
		AND EXISTS (SELECT 1 FROM versions WHERE id=?)
		ORDER BY version_id DESC LIMIT 1`, zoom, x, y, versionID, versionID).Scan(&data)
	return data, err
}
