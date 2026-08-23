package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/image/webp"
)

const (
	gridSize = 25.0
	tileSize = 256
	maxZoom  = 13
)

type tileCoord struct{ X, Y int }

type projectedBounds struct{ West, East, South, North float64 }

func colorIntToRGBA(value int32) color.NRGBA {
	if value == -1 {
		return color.NRGBA{}
	}
	return color.NRGBA{R: uint8(value >> 16), G: uint8(value >> 8), B: uint8(value), A: 255}
}

func majority4(values ...color.NRGBA) color.NRGBA {
	counts := map[color.NRGBA]int{}
	for _, value := range values {
		if value.A != 0 {
			counts[value]++
		}
	}
	best := color.NRGBA{}
	bestCount := 0
	for _, value := range values {
		if value.A != 0 && counts[value] > bestCount {
			best, bestCount = value, counts[value]
		}
	}
	return best
}

func floorDiv(value, divisor int) int {
	quotient, remainder := value/divisor, value%divisor
	if remainder < 0 {
		quotient--
	}
	return quotient
}

func cellsPerTexel(zoom int) int { return 1 << (maxZoom - zoom) }

func cellsPerTile(zoom int) int { return tileSize * cellsPerTexel(zoom) }

func gridCellTile(gridX, gridY int32, zoom int) tileCoord {
	span := cellsPerTile(zoom)
	return tileCoord{floorDiv(int(gridX), span), floorDiv(int(gridY), span)}
}

func nativeTileBounds(zoom, x, y int) projectedBounds {
	span := cellsPerTile(zoom)
	gx0, gy0 := x*span, y*span
	// Grid coordinates name cell centres, so tile edges sit half a cell outside.
	return projectedBounds{
		West:  (float64(gx0) - 0.5) * gridSize,
		East:  (float64(gx0+span) - 0.5) * gridSize,
		South: (float64(gy0) - 0.5) * gridSize,
		North: (float64(gy0+span) - 0.5) * gridSize,
	}
}

type Event struct {
	GridX, GridY int32
	Color        int32
	LastModified int64
}

type Dump struct {
	Label           string
	LastModifiedMin int64
	DeclaredCount   int
	Width, Height   int
	Events          []Event
}

func ReadDump(dir string, limit int) (*Dump, error) {
	meta, err := readMetadata(filepath.Join(dir, "metadata.txt"))
	if err != nil {
		return nil, err
	}
	count, err := strconv.Atoi(meta["count"])
	if err != nil || count < 0 {
		return nil, fmt.Errorf("invalid metadata count %q", meta["count"])
	}
	base, err := strconv.ParseInt(meta["lastmod_min"], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid metadata lastmod_min %q", meta["lastmod_min"])
	}
	if limit > 0 && limit < count {
		count = limit
	}

	columns := make([][]uint32, 4)
	width, height := 0, 0
	for i, name := range []string{"gridx", "gridy", "color", "lastmodified"} {
		values, w, h, err := readPackedWebP(filepath.Join(dir, name+".webp"), count)
		if err != nil {
			return nil, fmt.Errorf("decode %s: %w", name, err)
		}
		if i == 0 {
			width, height = w, h
		} else if w != width || h != height {
			return nil, fmt.Errorf("column %s is %dx%d, expected %dx%d", name, w, h, width, height)
		}
		columns[i] = values
	}

	events := make([]Event, count)
	for i := range events {
		events[i] = Event{
			GridX:        int32(columns[0][i]),
			GridY:        int32(columns[1][i]),
			Color:        int32(columns[2][i]),
			LastModified: base + int64(columns[3][i]),
		}
	}
	return &Dump{
		Label:           strings.TrimPrefix(filepath.Base(filepath.Clean(dir)), "dump_"),
		LastModifiedMin: base,
		DeclaredCount:   mustAtoi(meta["count"]),
		Width:           width,
		Height:          height,
		Events:          events,
	}, nil
}

func readMetadata(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	meta := map[string]string{}
	s := bufio.NewScanner(f)
	for s.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(s.Text()), "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid metadata line %q", s.Text())
		}
		meta[key] = value
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	return meta, nil
}

func readPackedWebP(path string, count int) ([]uint32, int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, 0, err
	}
	defer f.Close()
	decoded, err := webp.Decode(f)
	if err != nil {
		return nil, 0, 0, err
	}
	img, ok := decoded.(*image.NRGBA)
	if !ok {
		return nil, 0, 0, fmt.Errorf("unsupported WebP pixel model %T; packed columns require unassociated RGBA bytes", decoded)
	}
	width, height := img.Bounds().Dx(), img.Bounds().Dy()
	if count > width*height {
		return nil, 0, 0, fmt.Errorf("metadata count %d exceeds image capacity %d", count, width*height)
	}
	values := make([]uint32, count)
	for i := range count {
		x, y := i%width, i/width
		offset := img.PixOffset(x+img.Rect.Min.X, y+img.Rect.Min.Y)
		values[i] = binary.LittleEndian.Uint32(img.Pix[offset:offset+4]) - uint32(1<<31)
	}
	return values, width, height, nil
}

func mustAtoi(value string) int {
	n, _ := strconv.Atoi(value)
	return n
}
