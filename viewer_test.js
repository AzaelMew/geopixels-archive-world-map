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
  const bitmapCloses = [];
  let nextBitmapId = 1;
  const bitmapCloseCounts = new Map();
  const trackBitmap = async () => {
    const id = nextBitmapId++;
    return {id, width: 256, height: 256,
      close() { bitmapCloseCounts.set(id, (bitmapCloseCounts.get(id) || 0) + 1); bitmapCloses.push(id); }};
  };
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
    setTimeout: options.setTimeoutOverride
      ? (callback, delay) => {
          // Record long timers (retry backoff) for manual firing; short ones
          // (fallback delay) still run via microtask like the default mock.
          if (delay >= 1000) return options.setTimeoutOverride(callback, delay);
          queueMicrotask(callback); return 1;
        }
      : (callback => { queueMicrotask(callback); return 1; }),
    createImageBitmap: options.createImageBitmap || trackBitmap,
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
      let value = fetchResponses.get(url);
      if (typeof value === 'function') value = value(); // dynamic stub support
      if (value instanceof Error) throw value;
      if (value?.then) return value;
      return value ?? response();
    },
    history: {replaceState() {}},
    location: {pathname: '/', search: ''},
    maplibregl: {Map: MockMap, NavigationControl: class {}, Popup: MockPopup},
    PixelTileLayer: MockPixelTileLayer,
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
    bitmapCloses,
    bitmapCloseCounts,
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

test('real threshold crossing from displayed z11 starts z13 immediately with concurrent z12 coverage', async () => {
  // The real policy path: 10.49 settles at z11 (movingDataLevel 10 -> settled 11),
  // crossing to exactly 10.5 must start native z13 right away while z12
  // transitional parents load concurrently, and a completed center child is not
  // gated by a slow edge target.
  const centerDetail = deferred(), edgeDetail = deferred(), slowParent = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', centerDetail.promise.then(response)],
    ['/tiles/v/13/4/0.png?optional=1', edgeDetail.promise.then(response)],
    ['/tiles/v/12/0/0.png?optional=1', slowParent.promise.then(response)],
    ['/tiles/v/12/2/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 11);
  viewer.setTargets([{x: 4, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'crossing', true);
  // z13 fetches fire immediately; z12 parents are requested concurrently (not
  // sequenced after some parent gate): all four URLs land in the same pool pass.
  await spinUntil(() =>
    viewer.fetchCalls.includes('/tiles/v/13/0/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/13/4/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/12/0/0.png?optional=1'),
    'z13 or z12 transitional fetches never fired');
  // Real ordering assertion: the center z13 detail request must be issued
  // before the far-edge z12 transitional parent (center-first, z13 not gated).
  assert.ok(viewer.fetchCalls.indexOf('/tiles/v/13/0/0.png?optional=1') <
    viewer.fetchCalls.lastIndexOf('/tiles/v/12/2/0.png?optional=1'),
    'z13 center request must precede edge z12 transitional fetch');
  slowParent.resolve(); await spinUntil(() => true, '');
  await new Promise(r => setImmediate(r));
  assert.equal(layer.tiles.get('fallback/v/13/4/0@0')?.hidden ?? undefined, false,
    'ready z12 transitional coverage (cropped parent) stays revealed while children load');
  centerDetail.resolve();
  await spinUntil(() => layer.hasTile('v/13/0/0@0'), 'center native never became visible');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false,
    'center child revealed before slow edge finished');
  edgeDetail.resolve();
  assert.equal(await refresh, true);
});

test('slow sibling in the SAME z11 parent does not delay ready native center', async () => {
  // z11 -> z13: scale = 2^(13-11) = 4, so x=0 AND x=1 both sit in z11 parent 0.
  // One lagging child inside that parent must not hold back its finished sibling.
  const fastDetail = deferred(), slowSibling = deferred(), sameParent12 = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', fastDetail.promise.then(response)],
    ['/tiles/v/13/1/0.png?optional=1', slowSibling.promise.then(response)],
    ['/tiles/v/12/0/0.png?optional=1', sameParent12.promise.then(response)],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 11);
  viewer.setTargets([{x: 1, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'crossing-same-parent', true);
  await spinUntil(() =>
    viewer.fetchCalls.includes('/tiles/v/13/0/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/13/1/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/12/0/0.png?optional=1'),
    'z13/z12 fetches for the shared parent never fired');

  // Shared z12 transitional parent arrives first: it covers both children.
  sameParent12.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(layer.tiles.get('fallback/v/13/1/0@0')?.hidden ?? undefined, false,
    'z12 transitional crop should cover the pending sibling region');

  // Fast center child finishes while the sibling is still loading: its native
  // quad must be revealed immediately — a pending sibling inside the SAME
  // z11 parent (16-child group under old grouping) must not withhold it.
  fastDetail.resolve();
  await spinUntil(() => layer.hasTile('v/13/0/0@0'),
    'ready native child inside a partially-covered group was withheld');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false,
    'native child hidden behind unfinished siblings in the same z11 parent');

  slowSibling.resolve();
  await spinUntil(() => layer.hasTile('v/13/1/0@0'), 'sibling native never revealed');
  assert.equal(await refresh, true);
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
  // Spec: below 10.5 cached z13 stays cached but is hidden (no GPU cost under
  // coarse coverage); zooming back to 10.5+ reuses it.
  assert.equal(layer.tiles.get('v/13/1/1@0')?.hidden, true, 'stale native coverage kept rendered below threshold');
  assert.ok(layer.tiles.has('v/13/1/1@0'), 'coarse settle evicted cached native coverage');
  assert.equal(layer.tiles.get('v/13/-1/-1@0')?.hidden, true, 'sibling world copy kept rendered below threshold');
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

test('detail win closes the delayed discarded fallback bitmap exactly once', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response()],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig', true), true);
  await new Promise(resolve => setImmediate(resolve));
  // Every bitmap that was created got closed exactly once (uploaded fallback
  // bitmaps are consumed-then-closed; no leaks, no double closes).
  assert.ok(viewer.bitmapCloseCounts.size >= 1, 'no bitmap ownership path ran');
  for (const [id, count] of viewer.bitmapCloseCounts) {
    assert.equal(count, 1, `bitmap #${id} closed ${count} times`);
  }
});

test('stale-generation fallback result has its bitmap closed', async () => {
  const gate = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', gate.promise.then(response)],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  // Supersede: a newer refresh bumps the generation while the stale refresh's
  // fallback parent fetch is still in flight.
  const stale = viewer.performRefresh('v', 13, 'sig-stale', true);
  await spinUntil(() => viewer.fetchCalls.includes('/tiles/v/12/0/0.png?optional=1'),
    'stale refresh never requested fallback parents');
  await viewer.performRefresh('v', 11, 'sig-newer', true);
  gate.resolve();
  assert.equal(await stale, false);
  await new Promise(resolve => setImmediate(resolve));
  // Every created bitmap (stale fallback crops etc.) ended closed exactly once
  // — the superseded refresh's fallback bitmaps all leak-proof.
  assert.ok(viewer.bitmapCloseCounts.size >= 1, 'no bitmap ownership path ran');
  for (const [id, count] of viewer.bitmapCloseCounts) {
    assert.equal(count, 1, `bitmap #${id} closed ${count} times`);
  }
});

test('applied fallback is uploaded then closed exactly once, reused fallback never closed', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response(204)], // detail intentionally absent
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('fallback/v/13/0/0@0', {hidden: false}); // cached/reused fallback entry
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig', true), true);
  await new Promise(resolve => setImmediate(resolve));
  if (viewer.bitmapCloseCounts.size > 0) {
    // A fresh bitmap was built and applied: uploaded then closed exactly once.
    for (const [id, count] of viewer.bitmapCloseCounts) {
      assert.equal(count, 1, `applied-fallback bitmap #${id} closed ${count} times`);
    }
  }
  // The pre-existing (reused) cache entry must never be "closed" or evicted as
  // though it owned a fresh bitmap — it stays resident and visible.
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), true,
    'reused cached fallback entry was discarded');
  assert.equal(layer.tiles.get('fallback/v/13/0/0@0')?.hidden ?? undefined, false,
    'reused cached fallback entry no longer visible');
});

test('failed native settle schedules a bounded retry without user movement', async () => {
  const timers = [];
  let nativeFlaky = true;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => {
      if (nativeFlaky) throw new Error('transient');
      return response();
    }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  // Settled schedule at zoom >= 10.5: coarse completes (z12), then detail z13
  // fails transiently -> fallback shown -> incomplete -> a retry timer is armed.
  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));
  assert.ok(timers.length > 0, 'no retry timer armed after failed native settle');
  assert.equal(layer.tiles.get('fallback/v/13/0/0@0')?.hidden ?? undefined, false,
    'z12 coverage should still become visible after the failure');

  // Retry fires automatically and succeeds now that the tile loads.
  nativeFlaky = false;
  fetchResponses.set('/tiles/v/13/0/0.png?optional=1', response());
  timers[0].callback();
  await spinUntil(() => layer.tiles.get('v/13/0/0@0') && !layer.tiles.get('v/13/0/0@0').hidden,
    'automatic retry never replaced z12 with native z13');
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), false,
    'native success did not retire its z12 fallback');
});

test('retry state machine: full backoff sequence then success', async () => {
  const timers = [];
  let attempts = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => {
      attempts++;
      if (attempts < 4) throw new Error(`transient ${attempts}`);
      return response();
    }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), true,
    'initial failure did not show z12 coverage');

  // Fail retries #1..#3 (delays 2000/4000/8000), success on the last one.
  for (const expected of [2000, 4000, 8000]) {
    assert.equal(timers[0].delay, expected,
      `expected ${expected}ms backoff before this retry`);
    timers.shift().callback();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    if (expected !== 8000) assert.ok(timers.length > 0, `no retry armed after attempt with backoff ${expected}`);
  }
  await spinUntil(() => layer.tiles.get('v/13/0/0@0') && !layer.tiles.get('v/13/0/0@0').hidden,
    'final retry never revealed native z13');
  assert.equal(attempts, 4, 'unexpected total native attempt count');
});

test('retry state machine: stops after max attempts, no infinite loop', async () => {
  const timers = [];
  let fired = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { throw new Error('always down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (++fired <= 3) { timers.push({callback, delay}); return timers.length; } return ++fired; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));
  // Drain all scheduled retries: after 3 failed attempts no more may arm.
  while (timers.length) {
    const t = timers.shift();
    t.callback();
    for (let i = 0; i < 40 && !timers.length; i++) await new Promise(r => setImmediate(r));
  }
  assert.ok(fired <= 4, `retry loop not bounded: ${fired - 1} auto retries`);
  assert.equal(layer.hasTile('fallback/v/13/0/0@0'), true,
    'z12 fallback lost during exhausted retries');
});

test('viewport change invalidates the pending retry', async () => {
  const timers = [];
  let detailCalls = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { detailCalls++; throw new Error('down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));
  assert.ok(timers.length > 0, 'retry never armed');

  // Move elsewhere: superseding move changes signature + bumps generation.
  viewer.setTargets([{x: 5, y: 5, world: 1}]);
  timers[0].callback();
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(detailCalls, 1, 'stale-viewport retry must not re-request natives');
});

test('archive version change invalidates the pending retry', async () => {
  const timers = [];
  let v13Calls = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { v13Calls++; throw new Error('down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));

  viewer.setState('w', 13); // archive version switch invalidates everything
  timers[0].callback();
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(v13Calls, 1, 'old-version retry must not fetch stale tiles');
});

test('zoom below threshold invalidates the pending retry', async () => {
  const timers = [];
  let v13Calls = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { v13Calls++; throw new Error('down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(r => setImmediate(r));

  viewer.setZoom(10.49);
  timers[0].callback();
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(v13Calls, 1, 'z13 retry ran below the native threshold');
});

test('intentional 204 native settle does not arm transient retries', async () => {
  const timers = [];
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response(204)],
    ['/tiles/v/12/0/0.png?optional=1', response(204)],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => { if (delay >= 1000) { timers.push({callback, delay}); return timers.length; } queueMicrotask(callback); return 1; },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(timers.length, 0, 'all-empty region armed a transient retry');
});
