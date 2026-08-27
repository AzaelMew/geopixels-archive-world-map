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
  const bitmapCreates = [];
  let nextBitmapId = 1;
  const bitmapCloseCounts = new Map();
  const trackBitmap = async (...args) => {
    const id = nextBitmapId++;
    bitmapCreates.push({id, cropped: args.length > 2});
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
    setTile(tileKey, bitmap) { this.tiles.set(tileKey, {hidden: false, bitmapId: bitmap?.id}); }
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
    bitmapCreates,
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

test('z12 regions in the same z11 parent reveal independently after atomic replacement coverage', async () => {
  // z11 -> z13: x=0 and x=2 share z11 parent 0, but belong to separate
  // z12 parents (0 and 1). This fails if transition groups remain at z11.
  const fastDetail = deferred(), slowDetail = deferred();
  const fastParent12 = deferred(), slowParent12 = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', fastDetail.promise.then(response)],
    ['/tiles/v/13/2/0.png?optional=1', slowDetail.promise.then(response)],
    ['/tiles/v/12/0/0.png?optional=1', fastParent12.promise.then(response)],
    ['/tiles/v/12/1/0.png?optional=1', slowParent12.promise.then(response)],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/11/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 11);
  viewer.setTargets([{x: 2, y: 0, world: 0}, {x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'crossing-same-parent', true);
  await spinUntil(() =>
    viewer.fetchCalls.includes('/tiles/v/13/0/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/13/2/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/12/0/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/12/1/0.png?optional=1'),
    'z13/z12 fetches for both z12 regions never fired');

  fastParent12.resolve();
  fastDetail.resolve();
  await spinUntil(() => layer.hasTile('v/13/0/0@0'),
    'ready native child inside a finished z12 region was withheld');
  assert.equal(layer.tiles.get('v/11/0/0@0').hidden, false,
    'z11 parent was retired before the other z12 region had replacement coverage');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, true,
    'native child revealed over an uncovered z11 sibling region');
  assert.equal(layer.hasTile('v/13/2/0@0'), false,
    'slow sibling unexpectedly completed before its promises resolved');

  slowParent12.resolve();
  await spinUntil(() => layer.tiles.get('fallback/v/13/2/0@0')?.hidden === false,
    'slow z12 region did not retain transitional coverage');
  assert.equal(layer.tiles.get('v/11/0/0@0').hidden, true,
    'z11 parent remained visible under complete z12/native replacement coverage');
  assert.equal(layer.tiles.get('v/13/0/0@0').hidden, false,
    'ready native region did not reveal after sibling fallback coverage arrived');
  slowDetail.resolve();
  await spinUntil(() => layer.hasTile('v/13/2/0@0'), 'slow native child never revealed');
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
  const detail = deferred(), parent = deferred();
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', detail.promise.then(response)],
    ['/tiles/v/12/0/0.png?optional=1', parent.promise.then(response)],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  const refresh = viewer.performRefresh('v', 13, 'sig', true);
  await spinUntil(() =>
    viewer.fetchCalls.includes('/tiles/v/13/0/0.png?optional=1') &&
    viewer.fetchCalls.includes('/tiles/v/12/0/0.png?optional=1'),
    'detail and delayed fallback did not both start');
  detail.resolve();
  assert.equal(await refresh, true);
  parent.resolve();
  await spinUntil(() => viewer.bitmapCreates.some(bitmap => bitmap.cropped),
    'delayed fresh fallback crop never materialized');
  // Uploaded detail ownership transfers to the layer, then the source bitmap
  // closes exactly once after upload.
  const detailId = layer.tiles.get('v/13/0/0@0')?.bitmapId;
  assert.ok(detailId, 'native detail bitmap was never uploaded');
  assert.equal(viewer.bitmapCloseCounts.get(detailId), 1,
    `uploaded detail bitmap #${detailId} did not close exactly once`);

  // Cropped fallback bitmaps use createImageBitmap's crop overload. Detail won,
  // so every delayed crop is discarded and must still close exactly once.
  const fallbackCrops = viewer.bitmapCreates.filter(bitmap => bitmap.cropped);
  assert.ok(fallbackCrops.length >= 1, 'delayed fresh fallback crop never materialized');
  for (const {id} of fallbackCrops) {
    assert.equal(viewer.bitmapCloseCounts.get(id), 1,
      `discarded fallback bitmap #${id} did not close exactly once`);
  }
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

test('fresh applied fallback is uploaded then closed exactly once', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response(204)],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig-fresh', true), true);
  const fallback = layer.tiles.get('fallback/v/13/0/0@0');
  assert.ok(fallback?.bitmapId, 'fresh fallback bitmap was not uploaded');
  assert.equal(viewer.bitmapCloseCounts.get(fallback.bitmapId), 1,
    `uploaded fallback bitmap #${fallback.bitmapId} did not close exactly once`);
  for (const [id, count] of viewer.bitmapCloseCounts) {
    assert.equal(count, 1, `bitmap #${id} closed ${count} times`);
  }
});

test('reused resident fallback creates or closes no fresh bitmap', async () => {
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', response(204)],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({zoom: 10.5, fetchResponses});
  const layer = new viewer.MockPixelTileLayer();
  const resident = {hidden: false, bitmapId: 'resident-webgl-tile'};
  layer.tiles.set('fallback/v/13/0/0@0', resident);
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  assert.equal(await viewer.performRefresh('v', 13, 'sig-reused', true), true);
  assert.strictEqual(layer.tiles.get('fallback/v/13/0/0@0'), resident,
    'reused cached fallback entry was replaced or evicted');
  assert.equal(resident.hidden, false, 'reused cached fallback entry was hidden');
  assert.equal(viewer.bitmapCreates.length, 0,
    'reused cached fallback incorrectly created a fresh bitmap');
  assert.equal(viewer.bitmapCloseCounts.size, 0,
    'reused cached fallback incorrectly closed bitmap ownership');
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

test('successful retry settles alongside a genuinely empty 204 region', async () => {
  const timers = [];
  let nativeAttempts = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => {
      nativeAttempts++;
      if (nativeAttempts === 1) throw new Error('transient');
      return response();
    }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
    ['/tiles/v/13/2/0.png?optional=1', response(204)],
    ['/tiles/v/12/1/0.png?optional=1', response(204)],
    ['/tiles/v/11/0/0.png?optional=1', response(204)],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => {
      if (delay >= 1000) { timers.push({callback, delay}); return timers.length; }
      queueMicrotask(callback); return 1;
    },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}, {x: 2, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1, 'retry never armed');
  assert.equal(timers[0].delay, 2000);
  timers.shift().callback();
  for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));

  assert.equal(nativeAttempts, 2, 'recovered native was requested more than once');
  assert.equal(timers.length, 0,
    'intentional empty 204 region kept the successful native retry incomplete');
  assert.equal(layer.tiles.get('v/13/0/0@0')?.hidden, false,
    'recovered native tile was not revealed');
  assert.equal(viewer.getState().displayedLevel, 13,
    'successful mixed native/empty retry did not settle the viewport at z13');
});

test('new viewport receives a fresh retry budget after the old one is exhausted', async () => {
  const timers = [];
  let oldCalls = 0, newCalls = 0, newFlaky = true;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { oldCalls++; throw new Error('old viewport down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
    ['/tiles/v/13/5/0.png?optional=1', () => {
      newCalls++;
      if (newFlaky) throw new Error('new viewport transient');
      return response();
    }],
    ['/tiles/v/12/2/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => {
      if (delay >= 1000) { timers.push({callback, delay}); return timers.length; }
      queueMicrotask(callback); return 1;
    },
  });
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1, 'old viewport retry never armed');
  for (const expected of [2000, 4000, 8000]) {
    const timer = timers.shift();
    assert.equal(timer.delay, expected);
    timer.callback();
    for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  }
  assert.equal(oldCalls, 4, 'old viewport did not exhaust exactly three retries');
  assert.equal(timers.length, 0);

  viewer.setTargets([{x: 5, y: 0, world: 0}]);
  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1,
    'new viewport inherited the exhausted retry budget');
  assert.equal(newCalls, 1, 'new viewport initial native attempt did not run');
  assert.equal(timers[0].delay, 2000, 'new viewport did not restart backoff at 2s');
  newFlaky = false;
  timers.shift().callback();
  await spinUntil(() => layer.tiles.get('v/13/5/0@0')?.hidden === false,
    'new viewport retry did not recover native detail');
  assert.equal(newCalls, 2);
  assert.equal(timers.length, 0);
});

test('retry state machine: stops after max attempts, no infinite loop', async () => {
  const timers = [];
  let attempts = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { attempts++; throw new Error('always down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => {
      if (delay >= 1000) { timers.push({callback, delay}); return timers.length; }
      queueMicrotask(callback); return 1;
    },
  });
  const layer = new viewer.MockPixelTileLayer();
  layer.tiles.set('v/12/0/0@0', {hidden: false});
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1, 'initial retry never scheduled');
  for (const expected of [2000, 4000, 8000]) {
    assert.equal(timers.length, 1, 'unexpected concurrent retry timer count');
    assert.equal(timers[0].delay, expected, `wrong retry delay before attempt ${attempts + 1}`);
    timers.shift().callback();
    for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  }
  assert.equal(attempts, 4, 'expected initial request plus exactly three retries');
  assert.equal(timers.length, 0, 'retry #4 was scheduled after the configured maximum');
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

test('raw zoom change above threshold invalidates the pending retry', async () => {
  const timers = [];
  let v13Calls = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => { v13Calls++; throw new Error('down'); }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => {
      if (delay >= 1000) { timers.push({callback, delay}); return timers.length; }
      queueMicrotask(callback); return 1;
    },
  });
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1, 'retry never armed');
  viewer.setZoom(10.7); // same z13 target set, different raw MapLibre zoom
  timers.shift().callback();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(v13Calls, 1, 'stale retry ran after raw zoom changed above 10.5');
  assert.equal(timers.length, 0);
});

test('raw zoom change during an in-flight retry prevents further chaining', async () => {
  const timers = [], retryGate = deferred();
  let v13Calls = 0;
  const fetchResponses = new Map([
    ['/tiles/v/13/0/0.png?optional=1', () => {
      v13Calls++;
      if (v13Calls === 1) throw new Error('initial failure');
      return retryGate.promise;
    }],
    ['/tiles/v/12/0/0.png?optional=1', response()],
  ]);
  const viewer = loadViewerFunctions({
    zoom: 10.6,
    fetchResponses,
    setTimeoutOverride: (callback, delay) => {
      if (delay >= 1000) { timers.push({callback, delay}); return timers.length; }
      queueMicrotask(callback); return 1;
    },
  });
  const layer = new viewer.MockPixelTileLayer();
  viewer.setLayer(layer);
  viewer.setState('v', 12);
  viewer.setTargets([{x: 0, y: 0, world: 0}]);

  await viewer.scheduleTileRefresh(true);
  await spinUntil(() => timers.length === 1, 'retry never armed');
  timers.shift().callback();
  await spinUntil(() => v13Calls === 2, 'retry request never entered flight');
  viewer.setZoom(10.7);
  retryGate.resolve(new Error('retry failed after zoom changed'));
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
  assert.equal(timers.length, 0,
    'stale in-flight retry chained another attempt after raw zoom changed');
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
