package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"math"
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

var mercatorHalfWorld = math.Pi * 6378137.0

type tileCoord struct{ X, Y int }

func colorIntToRGBA(value int32) color.NRGBA {
	if value == -1 {
		return color.NRGBA{}
	}
	return color.NRGBA{R: uint8(value >> 16), G: uint8(value >> 8), B: uint8(value), A: 255}
}

func majority4(values ...color.NRGBA) color.NRGBA {
	counts := map[color.NRGBA]int{}
	best := color.NRGBA{}
	bestCount := 0
	for _, value := range values {
		if value.A == 0 {
			continue
		}
		counts[value]++
		if counts[value] > bestCount {
			best, bestCount = value, counts[value]
		}
	}
	return best
}

func gridToTile(gridX, gridY int32, zoom int) (int, int) {
	return mercatorToTile(float64(gridX)*gridSize, float64(gridY)*gridSize, zoom)
}

func mercatorToTile(mx, my float64, zoom int) (int, int) {
	n := 1 << zoom
	x := int(math.Floor((mx + mercatorHalfWorld) / (2 * mercatorHalfWorld) * float64(n)))
	y := int(math.Floor((mercatorHalfWorld - my) / (2 * mercatorHalfWorld) * float64(n)))
	return min(max(x, 0), n-1), min(max(y, 0), n-1)
}

func tilePixelToGrid(zoom, x, y, pixelX, pixelY int) (int32, int32) {
	pixels := float64(tileSize * (int(1) << zoom))
	mx := (float64(x*tileSize+pixelX)+0.5)/pixels*(2*mercatorHalfWorld) - mercatorHalfWorld
	my := mercatorHalfWorld - (float64(y*tileSize+pixelY)+0.5)/pixels*(2*mercatorHalfWorld)
	return int32(math.Round(mx / gridSize)), int32(math.Round(my / gridSize))
}

func gridCellTiles(gridX, gridY int32, zoom int) []tileCoord {
	cx, cy := float64(gridX)*gridSize, float64(gridY)*gridSize
	west, east := cx-gridSize/2, math.Nextafter(cx+gridSize/2, math.Inf(-1))
	south, north := cy-gridSize/2, math.Nextafter(cy+gridSize/2, math.Inf(-1))
	minX, minY := mercatorToTile(west, north, zoom)
	maxX, maxY := mercatorToTile(east, south, zoom)
	result := make([]tileCoord, 0, 4)
	for x := minX; x <= maxX; x++ {
		for y := minY; y <= maxY; y++ {
			result = append(result, tileCoord{x, y})
		}
	}
	return result
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
