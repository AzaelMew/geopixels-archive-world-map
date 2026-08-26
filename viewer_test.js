const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadViewerFunctions() {
  const html = fs.readFileSync('index.html', 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(match, 'inline viewer script not found');
  class MockMap { addControl() {} on() {} }
  class MockPopup {
    setLngLat() { return this; }
    setHTML() { return this; }
    addTo() { return this; }
  }
  const sandbox = {
    AbortController,
    URLSearchParams,
    clearTimeout,
    console,
    createImageBitmap: async () => {},
    document: {
      querySelector: () => ({}),
      createElement: () => ({remove() {}}),
    },
    fetch: async () => {},
    history: {replaceState() {}},
    location: {pathname: '/', search: ''},
    maplibregl: {Map: MockMap, NavigationControl: class {}, Popup: MockPopup},
    PixelTileLayer: class {},
    setTimeout,
  };
  vm.runInNewContext(`${match[1]}\nglobalThis.__viewerTest={prioritizeNativeTiles,nativeZoomThreshold};`, sandbox);
  return sandbox.__viewerTest;
}

const bounds = (west, east, south = -1, north = 1) => ({
  getWest: () => west,
  getEast: () => east,
  getSouth: () => south,
  getNorth: () => north,
});
const tileCenterLng = x => ((x * 256 + 127.5) * 25) / 6378137 * 180 / Math.PI;
const key = ({x, y, world}) => `${x}/${y}@${world}`;

test('visible native tiles are ordered center-first without changing the target set', () => {
  const {prioritizeNativeTiles} = loadViewerFunctions();
  const tiles = [
    {x: 4, y: 0, world: 0},
    {x: 0, y: 0, world: 0},
    {x: -4, y: 0, world: 0},
    {x: 0, y: 3, world: 0},
  ];
  const ordered = prioritizeNativeTiles(tiles, 13, bounds(-0.01, 0.01));
  assert.equal(key(ordered[0]), '0/0@0');
  assert.deepEqual([...ordered].map(key).sort(), [...tiles].map(key).sort());
  assert.equal(key(tiles[0]), '4/0@0', 'priority sorting mutated the generated target list');
});

test('priority uses signed coordinates and the displayed world copy', () => {
  const {prioritizeNativeTiles} = loadViewerFunctions();
  const signed = [{x: 1, y: 0, world: 0}, {x: -2, y: 0, world: 0}];
  const signedCenter = tileCenterLng(-2);
  assert.equal(prioritizeNativeTiles(signed, 13, bounds(signedCenter - 0.01, signedCenter + 0.01))[0].x, -2);

  const copies = [{x: 0, y: 0, world: 0}, {x: 0, y: 0, world: 1}];
  assert.equal(prioritizeNativeTiles(copies, 13, bounds(359.99, 360.01))[0].world, 1);

  const antimeridian = [{x: 0, y: 0, world: 0}, {x: 3130, y: 0, world: 0}];
  assert.equal(prioritizeNativeTiles(antimeridian, 13, bounds(179, -179))[0].x, 3130);
});

test('native z13 transition remains at MapLibre zoom 10.5', () => {
  const {nativeZoomThreshold} = loadViewerFunctions();
  assert.equal(nativeZoomThreshold, 10.5);
});
