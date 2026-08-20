package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

func run(args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: geopixels-archive <ingest|serve> [options]")
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
	case "serve":
		flags := flag.NewFlagSet("serve", flag.ContinueOnError)
		flags.SetOutput(output)
		dbPath := flags.String("db", "data/archive.db", "SQLite archive path")
		listen := flags.String("listen", "127.0.0.1:8080", "HTTP listen address")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		archive, err := OpenArchive(*dbPath)
		if err != nil {
			return err
		}
		defer archive.Close()
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
