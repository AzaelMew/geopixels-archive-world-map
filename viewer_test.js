const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const bounds = (west, east, south = -1, north = 1) => ({
  getWest: () => west,
  getEast: () => east,
  getSouth: () => south,
  getNorth: () => north,
});
const tileCenterLng = x => ((x * 256 + 127.5) * 25) / 6378137 * 180 / Math.PI;
const key = ({x, y, world}) => `${x}/${y}@${world}`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const response = (status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  blob: async () => ({status}),
});

function loadViewerFunctions(options = {}) {
  const html = fs.readFileSync('index.html', 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(match, 'inline viewer script not found');

  let zoom = options.zoom ?? 1;
  let currentBounds = options.bounds ?? bounds(-0.01, 0.01);
  const fetchCalls = [];
  const fetchResponses = options.fetchResponses ?? new Map();
  const controls = [];
  const createdElements = [];

  class MockMap {
    constructor() { this.events = new Map(); }
    addControl(control) {
      controls.push(control);
      if (control.onAdd) control.onAdd(this);
    }
    on(name, handler) { this.events.set(name, handler); }
    getZoom() { return zoom; }
    getBounds() { return currentBounds; }
    triggerRepaint() {}
  }
  class MockPopup {
    setLngLat() { return this; }
    setHTML() { return this; }
    addTo() { return this; }
  }
  class MockPixelTileLayer {
    constructor() {
      this.tiles = new Map();
      this.map = {triggerRepaint() {}};
    }
    setTile(tileKey) { this.tiles.set(tileKey, {hidden: false}); }
    hasTile(tileKey) { return this.tiles.has(tileKey); }
    removeTile(tileKey) { this.tiles.delete(tileKey); }
    clear() { this.tiles.clear(); }
  }

  const sandbox = {
    AbortController,
    URLSearchParams,
    clearTimeout() {},
    console: {...console, error() {}},
    createImageBitmap: async () => ({width: 256, height: 256, close() {}}),
    document: {
      querySelector: () => ({}),
      createElement: () => {
        const element = {remove() {}};
        createdElements.push(element);
        return element;
      },
    },
    fetch: async url => {
      fetchCalls.push(url);
      const value = fetchResponses.get(url);
      if (value instanceof Error) throw value;
      if (value?.then) return value;
      return value ?? response();
    },
    history: {replaceState() {}},
    location: {pathname: '/', search: ''},
    maplibregl: {Map: MockMap, NavigationControl: class {}, Popup: MockPopup},
    PixelTileLayer: MockPixelTileLayer,
    setTimeout: callback => { queueMicrotask(callback); return 1; },
  };
  const context = {
    ...sandbox,
    zoomForTest: value => { zoom = value; },
    boundsForTest: value => { currentBounds = value; },
  };
  vm.runInNewContext(`${match[1]}
    globalThis.__viewerTest={
      prioritizeNativeTiles,
      nativeZoomThreshold,
      movingDataLevel,
      settledDataLevel,
      scheduleTileRefresh,
      performRefresh,
      appVersion: typeof appVersion==='undefined'?null:appVersion,
      creditText: credit.textContent,
      setZoom(value){zoomForTest(value)},
      setBounds(value){boundsForTest(value)},
      setTargets(tiles){visibleNativeTiles=()=>tiles},
      setLayer(layer){pixelTileLayer=layer},
      setState(version,level){archiveVersion=version;displayedLevel=level},
      getState(){return {displayedLevel,lastViewportSignature,refreshGeneration}},
    };
  `, context);
  return {
    ...context.__viewerTest,
    fetchCalls,
    fetchResponses,
    MockPixelTileLayer,
    createdElements,
  };
}

async function spinUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

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

test('native z13 transition remains at actual MapLibre zoom 10.5', () => {
  const viewer = loadViewerFunctions({zoom: 10.4999});
  assert.equal(viewer.nativeZoomThreshold, 10.5);
  assert.equal(viewer.movingDataLevel(), 10);
  viewer.setZoom(10.5);
  assert.equal(viewer.movingDataLevel(), 13);
  assert.equal(viewer.settledDataLevel(), 13);
});

test('rendered credit uses the centrally defined application version', () => {
  const {appVersion, creditText} = loadViewerFunctions();
  assert.equal(appVersion, '0.1.0');
  assert.equal(creditText, `By Azael - V${appVersion}`);
});

test('native z13 starts first and exposes z12 transitional coverage while it loads', async () => {
  const native = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', native.promise],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'native', true);
  await spinUntil(() => layer.hasTile('fallback/v/13/0/0@0'), 'z12 transition never became visible');

  assert.deepEqual(viewer.fetchCalls.slice(0, 2), [
    '/tiles/v/13/0/0.png?optional=1',
    '/tiles/v/12/0/0.png?optional=1',
  ]);
  assert.equal(layer.tiles.get('fallback/v/13/0/0@0').hidden, false);

  native.resolve(response());
  assert.equal(await refresh, true);
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), false);
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
});

test('moving across 10.5 immediately schedules z13 with z12 transition coverage', async () => {
  const native = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', native.promise],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  viewer.scheduleTileRefresh(false);
  await spinUntil(() => layer.hasTile('fallback/v/13/0/0@0'), 'moving refresh did not load z12 transition coverage');
  assert.equal(viewer.fetchCalls[0], '/tiles/v/13/0/0.png?optional=1');
  native.resolve(response());
});

test('native children replace each coarse parent atomically and independently', async () => {
  const centerSibling = deferred();
  const edge = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/13/1/0.png?optional=1', centerSibling.promise],
    ['/tiles/v/13/4/0.png?optional=1', edge.promise],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  layer.tiles.set('v/12/2/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 4, y: 0, world: 0}, {x: 1, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'native', false);
  await spinUntil(() => layer.hasTile('v/13/0/0@0'), 'first center child never loaded');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, true, 'partial native coverage leaked over its coarse parent');
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, false);

  centerSibling.resolve(response());
  await spinUntil(() => layer.tiles.get('v/13/1/0@0')?.hidden === false, 'complete center parent never transitioned');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, true, 'replaced center parent still bleeds through native transparency');
  assert.equal(layer.tiles.get('v/12/2/0@0').hidden, false, 'unfinished edge lost coarse coverage');

  edge.resolve(response());
  assert.equal(await refresh, true);
  assert.equal(layer.tiles.get('v/12/2/0@0').hidden, true);
});

test('moving before the transition finishes keeps revealed native regions native', async () => {
  const edge = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/13/1/0.png?optional=1', response()],
    ['/tiles/v/13/4/0.png?optional=1', edge.promise],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  layer.tiles.set('v/12/2/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 4, y: 0, world: 0}, {x: 1, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  const first = viewer.performRefresh('v', 13, 'sig1', false);
  await spinUntil(() => layer.tiles.get('v/12/0/0@0')?.hidden === true, 'center parent never retired');

  // User moves: a new refresh supersedes the unfinished one.
  const second = viewer.performRefresh('v', 13, 'sig2', false);
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, true, 'move reset a completed region back to fallback');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
  assert.equal(layer.tiles.get('v/13/1/0@0').hidden, false);

  edge.resolve(response());
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, true);
});

test('failed edge coverage leaves coarse coverage without hiding completed center native tiles', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/13/4/0.png?optional=1', new Error('edge failed')],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  layer.tiles.set('v/12/2/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 4, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'native', false), false);
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, true);
  assert.equal(layer.tiles.get('v/12/2/0@0').hidden, false);
});

test('fast zoom out and back in during transition completes the native refresh', async () => {
  // settled z13 region backed only by a retained fallback (native 204), then a
  // coarse settle, then straight back in: the z13 settled refresh runs with
  // allowFallback=false and must count the retained fallback complete instead
  // of restaging forever.
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response(204)],
    ['/tiles/v/12/0/0.png?optional=1', response()],
    ['/tiles/v/10/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.6, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 13);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig', true), true,
    'initial native settle should complete via retained fallback');
  assert.equal(layer.tiles.get('fallback/v/13/0/0@0')?.hidden, false,
    'z12 fallback coverage visible for the intentional-missing native');
  await viewer.performRefresh('v', 10, 'sig-coarse', true);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);
  const result = await viewer.performRefresh('v', 13, 'sig-back', false);
  assert.equal(result, true, 'returning to native after fast zoom out/in should complete');
});

test('completing a refresh keeps settled fallback coverage visible alongside natives', async () => {
  // an intentional-missing target whose retained z12 fallback is already on
  // screen, next to a native-loaded sibling; completing the refresh must keep
  // the settled fallback visible instead of restaging the region.
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/13/1/0.png?optional=1', response(204)],
    ['/tiles/v/12/0/0.png?optional=1', response()],
    ['/tiles/v/11/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.6, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('fallback/v/13/1/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 13);
  viewer.setTargets([{x: 0, y: 0, world: 0}, {x: 1, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig', true), true);
  const fb = layer.tiles.get('fallback/v/13/1/0@0');
  assert.ok(fb, 'completion sweep removed the retained fallback of a live cell');
  assert.equal(fb.hidden, false, 'completion sweep re-hid the settled fallback');
  assert.equal(layer.tiles.get('v/13/0/0@0')?.hidden, false, 'sweep hid a loaded native');
});

test('settling at a lower level does not hide or evict retained z13 coverage', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/10/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.4, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  // State left behind by a completed native session: revealed z13 children plus
  // their retired coarse parents and a retained fallback for an empty tile.
  layer.tiles.set('v/13/1/1@0', {hidden: false});
  layer.tiles.set('v/13/-1/-1@0', {hidden: false});
  layer.tiles.set('v/12/0/0@0', {hidden: true});
  layer.tiles.set('fallback/v/13/2/2@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 13);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.performRefresh('v', 10, 'coarse', true);
  assert.equal(layer.tiles.get('v/13/1/1@0')?.hidden, false, 'coarse settle hid live native coverage');
  assert.equal(layer.tiles.get('v/13/-1/-1@0')?.hidden, false, 'coarse settle hid a visible sibling world copy');
  assert.ok(layer.tiles.has('fallback/v/13/2/2@0'), 'coarse settle evicted retained empty-tile fallback');
});

test('aborted edge coverage does not hide completed center native tiles', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/13/4/0.png?optional=1', new DOMException('aborted', 'AbortError')],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  layer.tiles.set('v/12/2/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 4, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'native', false), false);
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
  assert.equal(layer.tiles.get('v/12/0/0@0').hidden, true);
  assert.equal(layer.tiles.get('v/12/2/0@0').hidden, false);
});

test('transient native failure shows z12 coverage but keeps the refresh incomplete for retry', async () => {
  const flaky = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', flaky.promise.then(() => { throw new Error('flaky'); })],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  const first = viewer.performRefresh('v', 13, 'sigA', true);
  await spinUntil(() => layer.hasTile('fallback/v/13/0/0@0'), 'fallback coverage never appeared after native failure');
  flaky.resolve();
  assert.equal(await first, false, 'failed native tile must not report the viewport complete');
  const state = viewer.getState();
  assert.notEqual(state.lastViewportSignature, 'sigA', 'completed signature would suppress every retry');
  assert.equal(state.displayedLevel, 12);

  fetchResponses.set('/tiles/v/13/0/0.png?optional=1', response());
  assert.equal(await viewer.performRefresh('v', 13, 'sigB', true), true);
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), false);
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false);
  const settled = viewer.getState();
  assert.equal(settled.displayedLevel, 13);
  assert.equal(settled.lastViewportSignature, 'sigB');
});

test('intentional missing native tile with available parent coverage completes its transition', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/-1/0.png?optional=1', response(204)],
    ['/tiles/v/12/-1/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: -1, y: 0, world: 1}]);

  assert.equal(await viewer.performRefresh('v', 13, 'native', true), true,
    'a fully-covered region must complete even when every native tile is intentionally missing');
  const settled = viewer.getState();
  assert.equal(settled.displayedLevel, 13);
  assert.equal(settled.lastViewportSignature, 'native');
});

test('intentional missing native tile retains its z12 transitional coverage', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/-1/0.png?optional=1', response(204)],
    ['/tiles/v/12/-1/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: -1, y: 0, world: 1}]);

  assert.equal(await viewer.performRefresh('v', 13, 'native', true), true);
  assert.equal(layer.hasTile('fallback/v/13/-1/0@1'), true);
  assert.equal(layer.tiles.get('fallback/v/13/-1/0@1').hidden, false);
});

test('intentional missing lower-level tile keeps existing empty-tile behavior', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/12/0/0.png?optional=1', response(204)],
    ['/tiles/v/11/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.4, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 11);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 12, 'coarse', true), true);
  assert.equal(layer.hasTile('fallback/v/12/0/0@0'), false);
});

test('native refresh requests exactly the visible z13 targets without viewport padding', async () => {
  const viewer = loadViewerFunctions({zoom: 10.5});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: -1, y: 2, world: 0}, {x: 3, y: 4, world: 1}]);

  assert.equal(await viewer.performRefresh('v', 13, 'native', false), true);
  assert.deepEqual(viewer.fetchCalls.filter(url => url.includes('/13/')).sort(), [
    '/tiles/v/13/-1/2.png?optional=1',
    '/tiles/v/13/3/4.png?optional=1',
  ]);
});
