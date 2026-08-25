package main

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

//go:embed index.html
var viewerHTML []byte

//go:embed pixel-tile-layer.js
var pixelTileLayerJS []byte

//go:embed geopixels-style.json
var geopixelsStyle []byte

//go:embed favicon.ico
var faviconICO []byte

func rewriteMapStyle(style, proxyBase string) string {
	return strings.ReplaceAll(style, "http://localhost:5039/", proxyBase)
}

func styleAssetMethodAllowed(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}

func styleAssetPathAllowed(path string) bool {
	for _, prefix := range []string{"/tiles/", "/natural_earth/", "/sprites/", "/fonts/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func scrubStyleProxyHeaders(header http.Header) {
	header.Del("Authorization")
	header.Del("Proxy-Authorization")
	header.Del("Cookie")
}

type Version struct {
	ID            int64  `json:"id"`
	Label         string `json:"label"`
	Timestamp     int64  `json:"timestamp"`
	Source        string `json:"source"`
	EventCount    int    `json:"eventCount"`
	DeclaredCount int    `json:"declaredCount"`
	Deletions     int    `json:"deletions"`
}

func (v Version) IDString() string { return strconv.FormatInt(v.ID, 10) }

func NewHandler(archive *Archive) http.Handler {
	mux := http.NewServeMux()
	styleTarget, _ := url.Parse("https://geopixels.net")
	styleProxy := httputil.NewSingleHostReverseProxy(styleTarget)
	direct := styleProxy.Director
	styleProxy.Director = func(request *http.Request) {
		direct(request)
		request.Host = styleTarget.Host
		scrubStyleProxyHeaders(request.Header)
	}
	styleProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "upstream style error", http.StatusBadGateway)
	}
	styleAssets := http.StripPrefix("/geopixels-style", styleProxy)
	mux.HandleFunc("/geopixels-style/", func(w http.ResponseWriter, r *http.Request) {
		if !styleAssetMethodAllowed(r.Method) {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !styleAssetPathAllowed(strings.TrimPrefix(r.URL.Path, "/geopixels-style")) {
			http.NotFound(w, r)
			return
		}
		scrubStyleProxyHeaders(r.Header)
		styleAssets.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /map-style.json", func(w http.ResponseWriter, r *http.Request) {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		proxyBase := scheme + "://" + r.Host + "/geopixels-style/"
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(rewriteMapStyle(string(geopixelsStyle), proxyBase)))
	})
	mux.HandleFunc("GET /pixel-tile-layer.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(pixelTileLayerJS)
	})
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/x-icon")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		_, _ = w.Write(faviconICO)
	})
	mux.HandleFunc("GET /api/versions", func(w http.ResponseWriter, _ *http.Request) {
		rows, err := archive.DB.Query(`SELECT id,label,timestamp,source,event_count,declared_count,deletion_count
			FROM versions ORDER BY timestamp,id`)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		versions := []Version{}
		for rows.Next() {
			var version Version
			if err := rows.Scan(&version.ID, &version.Label, &version.Timestamp, &version.Source, &version.EventCount, &version.DeclaredCount, &version.Deletions); err != nil {
				http.Error(w, "database error", http.StatusInternalServerError)
				return
			}
			versions = append(versions, version)
		}
		if err := rows.Err(); err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(versions)
	})
	mux.HandleFunc("GET /tiles/{version}/{z}/{x}/{file}", func(w http.ResponseWriter, r *http.Request) {
		version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
		if err != nil {
			http.Error(w, "invalid version", http.StatusBadRequest)
			return
		}
		file := r.PathValue("file")
		if !strings.HasSuffix(file, ".png") {
			http.NotFound(w, r)
			return
		}
		coordinates := make([]int, 3)
		for i, value := range []string{r.PathValue("z"), r.PathValue("x"), strings.TrimSuffix(file, ".png")} {
			coordinates[i], err = strconv.Atoi(value)
			if err != nil {
				http.Error(w, "invalid tile coordinate", http.StatusBadRequest)
				return
			}
		}
		data, err := archive.GetTile(version, coordinates[0], coordinates[1], coordinates[2])
		if errors.Is(err, errInvalidTile) {
			http.Error(w, "invalid tile coordinate", http.StatusBadRequest)
			return
		}
		if errors.Is(err, sql.ErrNoRows) {
			if r.URL.Query().Get("optional") == "1" {
				var versionExists bool
				if queryErr := archive.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM versions WHERE id=?)", version).Scan(&versionExists); queryErr != nil {
					http.Error(w, "database error", http.StatusInternalServerError)
					return
				}
				if versionExists {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		etag := fmt.Sprintf(`"%d-%d-%d-%d"`, version, coordinates[0], coordinates[1], coordinates[2])
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(viewerHTML)
	})
	return mux
}
