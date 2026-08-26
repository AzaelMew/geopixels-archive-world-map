package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type postgresCSVEventReader struct {
	reader  *csv.Reader
	columns map[string]int
	row     int
}

func newPostgresCSVEventReader(input io.Reader) (*postgresCSVEventReader, error) {
	reader := csv.NewReader(input)
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read PostgreSQL CSV header: %w", err)
	}
	columns := map[string]int{}
	for index, name := range header {
		columns[strings.ToLower(strings.TrimSpace(name))] = index
	}
	for _, required := range []string{"gridx", "gridy", "color", "lastmodified"} {
		if _, ok := columns[required]; !ok {
			return nil, fmt.Errorf("PostgreSQL CSV is missing %q column", required)
		}
	}
	return &postgresCSVEventReader{reader: reader, columns: columns, row: 1}, nil
}

func (r *postgresCSVEventReader) Next() (Event, error) {
	record, err := r.reader.Read()
	if err != nil {
		return Event{}, err
	}
	r.row++
	parse := func(name string, bits int) (int64, error) {
		index := r.columns[name]
		if index >= len(record) {
			return 0, fmt.Errorf("PostgreSQL CSV row %d has no %s value", r.row, name)
		}
		value, err := strconv.ParseInt(strings.TrimSpace(record[index]), 10, bits)
		if err != nil {
			return 0, fmt.Errorf("PostgreSQL CSV row %d invalid %s: %w", r.row, name, err)
		}
		return value, nil
	}
	gridX, err := parse("gridx", 32)
	if err != nil {
		return Event{}, err
	}
	gridY, err := parse("gridy", 32)
	if err != nil {
		return Event{}, err
	}
	colorValue, err := parse("color", 32)
	if err != nil {
		return Event{}, err
	}
	modified, err := parse("lastmodified", 64)
	if err != nil {
		return Event{}, err
	}
	return Event{GridX: int32(gridX), GridY: int32(gridY), Color: int32(colorValue), LastModified: modified}, nil
}

func run(args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: geopixels-archive <ingest|ingest-postgres|rebuild-tiles|serve> [options]")
	}
	switch args[0] {
	case "ingest":
		flags := flag.NewFlagSet("ingest", flag.ContinueOnError)
		flags.SetOutput(output)
		dbPath := flags.String("db", "data/archive.db", "SQLite archive path")
		dumpPath := flags.String("dump", "", "GeoPixels dump directory")
		limit := flags.Int("limit", 0, "only ingest the first N events (test runs)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *dumpPath == "" {
			return errors.New("-dump is required")
		}
		dump, err := ReadDump(*dumpPath, *limit)
		if err != nil {
			return err
		}
		archive, err := OpenArchive(*dbPath)
		if err != nil {
			return err
		}
		defer archive.Close()
		result, err := archive.IngestDump(dump, *dumpPath)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	case "ingest-postgres":
		flags := flag.NewFlagSet("ingest-postgres", flag.ContinueOnError)
		flags.SetOutput(output)
		dbPath := flags.String("db", "data/archive.db", "SQLite archive path")
		csvPath := flags.String("csv", "", "completed PostgreSQL COPY CSV file")
		label := flags.String("label", "", "archive version label")
		source := flags.String("source", "postgres:PixelsHistory", "version source description")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *label == "" {
			return errors.New("-label is required")
		}
		if *csvPath == "" {
			return errors.New("-csv is required; ingest only a completed PostgreSQL COPY file")
		}
		file, err := os.Open(*csvPath)
		if err != nil {
			return err
		}
		defer file.Close()
		events, err := newPostgresCSVEventReader(file)
		if err != nil {
			return err
		}
		archive, err := OpenArchive(*dbPath)
		if err != nil {
			return err
		}
		defer archive.Close()
		result, err := archive.IngestEvents(*label, *source, -1, events.Next)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	case "rebuild-tiles":
		flags := flag.NewFlagSet("rebuild-tiles", flag.ContinueOnError)
		flags.SetOutput(output)
		dbPath := flags.String("db", "data/archive.db", "SQLite archive path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		archive, err := OpenArchive(*dbPath)
		if err != nil {
			return err
		}
		defer archive.Close()
		result, err := archive.RebuildTiles(output)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	case "serve":
		flags := flag.NewFlagSet("serve", flag.ContinueOnError)
		flags.SetOutput(output)
		dbPath := flags.String("db", "data/archive.db", "SQLite archive path")
		listen := flags.String("listen", "127.0.0.1:8080", "HTTP listen address")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		archive, err := OpenArchiveForServing(*dbPath)
		if err != nil {
			return err
		}
		defer archive.Close()
		if err := archive.RequireNativeTileFormat(); err != nil {
			return err
		}
		fmt.Fprintf(output, "GeoPixels archive: http://%s\n", *listen)
		server := &http.Server{Addr: *listen, Handler: NewHandler(archive), ReadHeaderTimeout: 5 * time.Second}
		return server.ListenAndServe()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		log.Fatal(err)
	}
}
