(function () {
  'use strict';

  var FALLBACK_CENTER = [37.7746, -122.4116];
  var FALLBACK_BOUNDS = [[37.747, -122.446], [37.802, -122.377]];
  var MAX_DETOUR = 1.3;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // Sequential, light to dark. Green is reserved for the clean route.
  var HEAT_COLORS = ['#f7d9a8', '#f5c282', '#f2a65a', '#ec8a3c', '#de6a26', '#c44e1c', '#9c3614', '#6f230c'];
  var HEAT_MIN_RATIO = 0.1;
  // Dim yellow, through orange, to saturated red. Trees fill these circles; traffic rings them.
  var HOTSPOT_COLORS = ['#f4d83e', '#ffb224', '#ff7a1a', '#ff4a1c', '#ff1f1f'];
  var HOT_LEVEL = 0.6;
  var TRAFFIC_MIN = 0.4;
  var TRAFFIC_REFRESH = 120000;
  var TRAFFIC_MAX_AGE = 600000;
  var MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
  var OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var LOCATION_FAILED = "Couldn't use your location. Click the map to set a start.";
  var ROUTE_TIMEOUT = 30000;
  var VOICE_TIMEOUT = 60000;
  var RECORD_LIMIT = 30000;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    meta: null,
    groups: null, // null means every group
    monthOverride: null, // null means the current month, and requests leave it out
    asthma: false,
    heatOn: false,
    treesOn: true,
    start: null,
    startIsYou: false,
    here: null,
    locating: false,
    locationFailed: false,
    end: null,
    placeNames: null,
    route: null,
    profile: null,
    profileDirty: false // true when local edits couldn't be saved to the server
  };

  var map = null;
  var mapStyleReady = false;
  var startMarker = null;
  var endMarker = null;
  var mapData = { heat: emptyLines(), hotTrees: emptyLines(), hotTraffic: emptyLines(), routes: emptyLines() };
  var routeTimer, heatTimer, hintTimer;
  var fitOnNextRoute = false;
  var busy = { route: false, ask: false, heat: false };
  var metaLoaded = Promise.resolve();
  var homeBounds = FALLBACK_BOUNDS;
  var homePending = false;
  var localExposure = false;

  // ---- small helpers ----

  function el(tag, opts) {
    var node = document.createElement(tag);
    if (opts && opts.className) node.className = opts.className;
    if (opts && opts.text != null) node.textContent = String(opts.text);
    return node;
  }

  function show(node, visible) { node.hidden = !visible; }

  function setStatus(node, text, isError) {
    node.textContent = text || '';
    node.classList.toggle('is-error', Boolean(isError));
    show(node, Boolean(text));
  }

  // For a line with its height reserved, so messages don't move what's below them.
  function setSlot(node, text, isError) {
    node.textContent = text || '';
    node.classList.toggle('is-error', Boolean(isError));
  }

  function clearChildren(node) { node.replaceChildren(); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function fmt(v, decimals) {
    if (!isNum(v)) return 'n/a';
    return v.toLocaleString('en-US', {
      minimumFractionDigits: decimals || 0,
      maximumFractionDigits: decimals || 0
    });
  }

  function fmtScore(v) { return fmt(v, isNum(v) && Math.abs(v) < 100 ? 1 : 0); }

  function fmtShare(v) { return isNum(v) ? Math.round(v * 100) + '%' : 'n/a'; }

  function isPoint(p) { return Array.isArray(p) && isNum(p[0]) && isNum(p[1]); }

  function plural(n, word) { return fmt(n) + ' ' + word + (n === 1 ? '' : 's'); }

  // ---- network ----

  function endSentence(text) {
    return /[.!?]$/.test(text.trim()) ? text.trim() : text.trim() + '.';
  }

  function detailMessage(body, status) {
    var d = body && body.detail;
    if (typeof d === 'string' && d) return endSentence(d);
    if (Array.isArray(d) && d.length) {
      return endSentence(d.map(function (x) { return (x && x.msg) || String(x); }).join('; '));
    }
    return 'The server returned an error (' + status + ').';
  }

  async function api(path, opts) {
    var res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error("Can't reach the server.");
    }
    var text = await res.text();
    var body = null;
    try { body = JSON.parse(text); } catch (_) { /* handled below */ }
    if (!res.ok) {
      var err = new Error(detailMessage(body, res.status));
      err.status = res.status;
      throw err;
    }
    if (body === null) throw new Error('The server sent an unreadable response.');
    return body;
  }

  function jsonPost(payload) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
  }

  // A channel keeps only its newest request. Older ones are aborted and resolve to STALE.
  var STALE = {};
  function newChannel() { return { ctrl: null }; }
  function cancel(channel) {
    if (channel.ctrl) channel.ctrl.abort();
    channel.ctrl = null;
  }

  async function latest(channel, path, opts, timeoutMs) {
    if (channel.ctrl) channel.ctrl.abort();
    var ctrl = new AbortController();
    channel.ctrl = ctrl;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs || ROUTE_TIMEOUT);
    try {
      var data = await api(path, Object.assign({}, opts, { signal: ctrl.signal }));
      return channel.ctrl === ctrl ? data : STALE;
    } catch (e) {
      if (channel.ctrl !== ctrl) return STALE;
      if (timedOut) throw new Error('The server took too long to respond.');
      if (e && e.name === 'AbortError') return STALE;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  var routeChannel = newChannel();
  var heatChannel = newChannel();
  var askChannel = newChannel();
  var symptomChannel = newChannel();
  var trafficChannel = newChannel();
  var profileChannel = newChannel();

  // ---- map ----

  function emptyLines() { return { type: 'FeatureCollection', features: [] }; }

  function toLngLat(p) { return [p[1], p[0]]; }

  function toLngLatBounds(b) {
    return [toLngLat(b[0]), toLngLat(b[1])];
  }

  function lineFeature(coords, properties) {
    return {
      type: 'Feature',
      properties: properties,
      geometry: { type: 'LineString', coordinates: coords.map(toLngLat) }
    };
  }

  // MapLibre circle radii are pixels. At this latitude one pixel is 61,880 / 2^zoom metres.
  function metres(scale) {
    var radius = ['*', ['get', 'r'], scale];
    return ['interpolate', ['exponential', 2], ['zoom'],
      10, ['*', radius, 1024 / 61880],
      20, ['*', radius, 1048576 / 61880]];
  }

  function rampExpression(input, from, colors) {
    var expression = ['interpolate', ['linear'], input];
    colors.forEach(function (color, i) {
      expression.push(from + (1 - from) * (i / (colors.length - 1)), color);
    });
    return expression;
  }

  function initMap() {
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: MAP_STYLE,
        bounds: toLngLatBounds(homeBounds),
        fitBoundsOptions: { padding: 24 },
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        renderWorldCopies: false,
        minZoom: 10,
        maxZoom: 19
      });
    } catch (e) {
      map = null;
      $('tile-status').textContent = "This browser can't draw the map because WebGL is off.";
      $('tile-status').classList.add('is-error');
      show($('tile-status'), true);
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: OSM_CREDIT }), 'bottom-right');

    map.on('style.load', addDataLayers);
    map.on('click', onMapClick);

    var usedBackup = false;
    var tileErrors = 0;
    map.on('error', function () {
      if (!mapStyleReady && !usedBackup) {
        // The basemap service can't be reached: plain OSM tiles keep the demo on its feet.
        usedBackup = true;
        map.setStyle({
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 19
            }
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
        });
        return;
      }
      tileErrors += 1;
      if (tileErrors >= 6) setStatus($('tile-status'), "Map background didn't load. Check the network.", true);
    });
    map.on('idle', function () {
      if (tileErrors < 6) setStatus($('tile-status'), '');
      tileErrors = 0;
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        map.resize();
        if (homePending) fitHome();
      }).observe($('map'));
    }
    fitHome();
  }

  // The dark style is close to black: lift it to charcoal, with thin grey roads and quiet labels.
  function tuneBasemap() {
    var fills = {
      water: '#111316', landuse_residential: '#1d1f23', landcover_wood: '#202327', landuse_park: '#202327',
      landcover_ice_shelf: '#1b1d20', landcover_glacier: '#1b1d20', building: '#23262a',
      road_area_pier: '#1b1d20', 'aeroway-area': '#23262a'
    };
    var lines = {
      waterway: '#111316', road_pier: '#2f3237', highway_path: '#34383e', highway_minor: '#3c4046',
      highway_major_casing: '#2a2d31', highway_major_inner: '#4b5057', highway_major_subtle: '#4b5057',
      highway_motorway_casing: '#2a2d31', highway_motorway_inner: '#5a6068', highway_motorway_subtle: '#50555c',
      railway_transit: '#2d3035', railway_transit_dashline: '#1b1d20', railway_minor: '#2d3035',
      railway_minor_dashline: '#1b1d20', railway: '#2d3035', railway_dashline: '#1b1d20',
      'aeroway-taxiway': '#2d3035', 'aeroway-runway-casing': '#2d3035', 'aeroway-runway': '#23262a',
      boundary_state: '#3a3e44', 'boundary_country_z0-4': '#3a3e44', 'boundary_country_z5-': '#3a3e44'
    };
    function byZoom(z11, z13, z15, z18) {
      return ['interpolate', ['linear'], ['zoom'], 11, z11, 13, z13, 15, z15, 18, z18];
    }
    var widths = {
      highway_path: byZoom(0.2, 0.3, 0.6, 1.5),
      highway_minor: byZoom(0.2, 0.5, 1, 3),
      highway_major_inner: byZoom(0.5, 0.9, 1.8, 5),
      highway_major_subtle: byZoom(0.5, 0.9, 1.8, 5),
      highway_motorway_inner: byZoom(0.8, 1.3, 2.4, 6),
      highway_motorway_subtle: byZoom(0.8, 1.3, 2.4, 6)
    };
    map.getStyle().layers.forEach(function (layer) {
      var id = layer.id;
      if (widths[id]) map.setPaintProperty(id, 'line-width', widths[id]);
      if (id === 'highway_major_casing' || id === 'highway_motorway_casing') map.setPaintProperty(id, 'line-opacity', 0);
      if (layer.type === 'background') map.setPaintProperty(id, 'background-color', '#1b1d20');
      else if (fills[id]) map.setPaintProperty(id, 'fill-color', fills[id]);
      else if (lines[id]) map.setPaintProperty(id, 'line-color', lines[id]);
      else if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        map.setPaintProperty(id, 'text-color', id === 'water_name' ? '#5f6b78' : '#8d9299');
        map.setPaintProperty(id, 'text-halo-color', '#17191c');
        map.setPaintProperty(id, 'text-halo-width', 1);
      }
    });
  }

  function addCircleLayer(id, source, paint, filter, before) {
    var layer = { id: id, type: 'circle', source: source, paint: paint };
    if (filter) layer.filter = filter;
    map.addLayer(layer, before);
  }

  // Runs on every style load, because changing style drops custom layers.
  function addDataLayers() {
    mapStyleReady = true;
    try { tuneBasemap(); } catch (_) { /* the backup raster style has nothing to tune */ }
    // Above roads and buildings, under the street names. The style's first symbol layer is a
    // water label underneath all of those, so it can't be the anchor.
    var styleLayers = map.getStyle().layers;
    var lastShape = styleLayers.reduce(function (at, l, i) {
      return l.id === 'building' || l.id.indexOf('highway_motorway') === 0 || l.id.indexOf('railway') === 0 ? i : at;
    }, -1);
    var labels = styleLayers.find(function (l, i) { return i > lastShape && l.type === 'symbol'; });
    var below = labels ? labels.id : undefined;

    ['heat', 'hotTrees', 'hotTraffic', 'routes'].forEach(function (id) {
      if (map.getSource(id)) return;
      map.addSource(id, { type: 'geojson', data: mapData[id], tolerance: 0.5, buffer: 32, maxzoom: 15 });
    });

    // Street detail, off by default, sits under the circles.
    map.addLayer({
      id: 'heat',
      type: 'line',
      source: 'heat',
      layout: { 'line-cap': 'round', visibility: state.heatOn ? 'visible' : 'none' },
      paint: {
        'line-color': rampExpression(['get', 'r'], HEAT_MIN_RATIO, HEAT_COLORS),
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 13, 1.4, 15, 3, 18, 7],
        'line-opacity': 0.9
      }
    }, below);

    var color = rampExpression(['get', 'level'], 0, HOTSPOT_COLORS);
    var isHot = ['>=', ['get', 'level'], HOT_LEVEL];

    // Circles are sized in metres, so a block covers the same ground at every zoom.
    // Out-of-season blocks keep their colour but fade.
    addCircleLayer('trees-halo', 'hotTrees', {
      'circle-radius': metres(1.5), 'circle-color': color, 'circle-opacity': 0.12, 'circle-blur': 0.6
    }, isHot, below);
    addCircleLayer('trees-core', 'hotTrees', {
      'circle-radius': metres(1),
      'circle-color': color,
      'circle-opacity': ['interpolate', ['linear'], ['get', 'season'], 0, 0.42, 1, 0.8],
      'circle-stroke-width': 1,
      'circle-stroke-color': color,
      'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'season'], 0, 0.5, 1, 0.95]
    }, null, below);

    // Slow traffic is drawn on the streets themselves, on the same colour scale.
    map.addLayer({
      id: 'traffic-lines',
      type: 'line',
      source: 'hotTraffic',
      // Same bar as "heavy traffic" in the route numbers. Lighter slowdowns are mostly traffic lights.
      filter: ['>=', ['get', 'level'], TRAFFIC_MIN],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': rampExpression(['get', 'level'], TRAFFIC_MIN, HOTSPOT_COLORS),
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 13, 2.2, 15, 4, 18, 9],
        'line-opacity': 0.95
      }
    }, below);

    syncHotspotLayers();

    // Over everything: the routes are the point of the page.
    function routeLine(id, role, paint) {
      map.addLayer({
        id: id,
        type: 'line',
        source: 'routes',
        filter: ['==', ['get', 'role'], role],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: paint
      });
    }
    routeLine('route-short-casing', 'shortest', { 'line-color': '#101214', 'line-width': 6.5 });
    routeLine('route-short', 'shortest', { 'line-color': '#c9ced6', 'line-width': 3.5 });
    routeLine('route-clean-glow', 'clean', { 'line-color': '#2ee6a6', 'line-width': 18, 'line-blur': 10, 'line-opacity': 0.5 });
    routeLine('route-clean-casing', 'clean', { 'line-color': '#0d1412', 'line-width': 8 });
    routeLine('route-clean', 'clean', { 'line-color': '#2ee6a6', 'line-width': 5 });

    scheduleHotspots(0);
  }

  function setMapData(id, data) {
    mapData[id] = data;
    if (map && mapStyleReady && map.getSource(id)) map.getSource(id).setData(data);
  }

  function setLayerVisible(id, visible) {
    if (map && mapStyleReady && map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  // A hidden tab or pane has no size, and fitting to that gives a useless zoom.
  // Wait for a real size before fitting.
  function mapPadding() {
    if (window.innerWidth < 900) return { top: 130, bottom: 220, left: 30, right: 30 };
    return { top: 60, bottom: 60, left: (sidebarOpen ? 444 : 80), right: 390 };
  }

  function fitHome() {
    if (!map) return;
    var box = map.getContainer();
    homePending = !(box.clientWidth > 0 && box.clientHeight > 0);
    if (!homePending) map.fitBounds(toLngLatBounds(homeBounds), { padding: Math.min(24, box.clientWidth / 20), animate: false });
  }

  function fitPoints(points) {
    if (!map || !points.length) return;
    var bounds = new maplibregl.LngLatBounds();
    points.forEach(function (p) { bounds.extend(toLngLat(p)); });
    map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 16, duration: 500 });
  }

  function pinLabel(which) {
    if (which === 'end') return 'B';
    return state.startIsYou ? 'You' : 'A';
  }

  function placeMarker(which, point) {
    if (!map) return;
    var marker = which === 'start' ? startMarker : endMarker;
    if (!point) {
      if (marker) marker.remove();
      if (which === 'start') startMarker = null; else endMarker = null;
      return;
    }
    if (!marker) {
      var pin = el('div', { className: 'marker-pin' });
      marker = new maplibregl.Marker({ element: pin, anchor: 'center', draggable: true })
        .setLngLat(toLngLat(point))
        .addTo(map);
      marker.on('dragend', function () {
        var ll = marker.getLngLat();
        setPoint(which, [ll.lat, ll.lng]);
        forgetPlaceNames();
        updateHint();
        runRoute();
      });
      if (which === 'start') startMarker = marker; else endMarker = marker;
    } else {
      marker.setLngLat(toLngLat(point));
    }
    var element = marker.getElement();
    element.textContent = pinLabel(which);
    element.classList.toggle('is-you', which === 'start' && state.startIsYou);
    element.setAttribute('aria-label', which === 'end' ? 'End. Drag to move.' : pinLabel('start') + ' is the start. Drag to move.');
  }

  function setPoint(which, point, isYou) {
    if (which === 'start') state.startIsYou = Boolean(point && isYou);
    state[which] = point;
    placeMarker(which, point);
  }

  function setBusy(key, on) {
    busy[key] = on;
    show($('map-progress'), busy.route || busy.ask || busy.heat);
    show($('map-progress-label'), busy.route || busy.ask);
  }

  function forgetPlaceNames() {
    state.placeNames = null;
    $('preset').value = '';
  }

  function onMapClick(e) {
    if (!$('onboarding').hidden) return;
    var target = e.originalEvent && e.originalEvent.target;
    if (target && target.closest && target.closest('.marker-pin')) return;
    var point = [e.lngLat.lat, e.lngLat.lng];
    if (!state.start || state.startIsYou) {
      // A click always beats the detected location.
      setPoint('start', point);
      forgetPlaceNames();
      setStatus($('ask-status'), '');
      if (state.end) runRoute();
    } else if (!state.end) {
      setPoint('end', point);
      forgetPlaceNames();
      runRoute();
    } else {
      flashHint('Drag A or B to change the walk, or clear it in the panel.');
      return;
    }
    updateHint();
  }

  function updateHint() {
    clearTimeout(hintTimer);
    $('map').classList.toggle('picking', !(state.start && state.end) || state.startIsYou);
    show($('clear-route'), Boolean((state.start && !state.startIsYou) || state.end));
    var text = '';
    if (!state.start) {
      if (state.locating) text = 'Finding your location...';
      else if (state.locationFailed) text = LOCATION_FAILED;
      else text = 'Click the map to set your start';
    } else if (!state.end && !state.startIsYou) {
      text = 'Now click to set your end';
    }
    $('map-hint-text').textContent = text;
    show($('location-retry'), text === LOCATION_FAILED);
    show($('map-hint'), Boolean(text));
  }

  function flashHint(text) {
    $('map-hint-text').textContent = text;
    show($('location-retry'), false);
    show($('map-hint'), true);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { show($('map-hint'), false); }, 3500);
  }

  // ---- sidebar ----

  var SIDEBAR_KEY = 'cleanroute.sidebar';
  var sidebarOpen = true;

  function setSidebar(open) {
    sidebarOpen = open;
    var bar = $('sidebar');
    bar.classList.toggle('is-hidden', !open);
    bar.inert = !open;
    $('sidebar-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('sidebar-toggle-label').textContent = open ? 'Hide details' : 'Show details';
  }

  function initSidebar() {
    var saved = null;
    try { saved = window.localStorage.getItem(SIDEBAR_KEY); } catch (_) { saved = null; }
    setSidebar(saved === null ? window.innerWidth >= 900 : saved === '1');
    $('sidebar-toggle').addEventListener('click', function () {
      setSidebar(!sidebarOpen);
      try { window.localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0'); } catch (_) { /* this visit only */ }
    });
  }

  // ---- controls ----

  function renderChips() {
    var box = $('chips');
    clearChildren(box);
    var groups = (state.meta && state.meta.groups) || [];
    box.appendChild(makeChip('All', null));
    groups.forEach(function (g) { box.appendChild(makeChip(g.label, g.id)); });
    syncChips();
  }

  function makeChip(label, id) {
    var chip = el('button', { className: 'chip', text: label });
    chip.type = 'button';
    chip.dataset.group = id === null ? '' : id;
    chip.addEventListener('click', function () { toggleGroup(id); });
    return chip;
  }

  function toggleGroup(id) {
    if (id === null) {
      state.groups = null;
    } else {
      var next = (state.groups || []).slice();
      var at = next.indexOf(id);
      if (at >= 0) next.splice(at, 1); else next.push(id);
      state.groups = next.length ? next : null;
    }
    syncChips();
    controlsChanged();
  }

  function syncChips() {
    Array.prototype.forEach.call($('chips').children, function (chip) {
      var id = chip.dataset.group;
      var on = id === '' ? state.groups === null : Boolean(state.groups && state.groups.indexOf(id) >= 0);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncBloomNote();
  }

  function currentMonth() { return new Date().getMonth() + 1; }

  function activeMonth() { return state.monthOverride || currentMonth(); }

  function syncBloomNote() {
    var note = $('bloom-note');
    var groups = (state.meta && state.meta.groups) || [];
    if (!groups.length) { note.textContent = ''; return; }
    var month = activeMonth();
    var when = state.monthOverride ? ' in ' + MONTHS[month - 1] : '';
    var mine = state.groups
      ? groups.filter(function (g) { return state.groups.indexOf(g.id) >= 0; })
      : groups;
    var inBloom = mine.filter(function (g) {
      return Array.isArray(g.bloom_months) && g.bloom_months.indexOf(month) >= 0;
    }).map(function (g) { return g.label; });
    if (inBloom.length) {
      note.textContent = (state.monthOverride ? 'In bloom' + when : 'In bloom now') + ': ' + inBloom.join(', ');
    } else {
      note.textContent = (state.groups ? 'None of your trees are in season' : 'No listed trees are in season') + when;
    }
  }

  function syncMonth() {
    $('month-value').textContent = MONTHS[activeMonth() - 1];
    show($('month-tag'), Boolean(state.monthOverride));
    syncBloomNote();
  }

  function controlsChanged() {
    scheduleRoute(250);
    scheduleHeat(250);
    scheduleHotspots(250);
  }

  function groupLabel(id) {
    var groups = (state.meta && state.meta.groups) || [];
    var g = groups.find(function (x) { return x.id === id; });
    return g ? g.label : id;
  }

  function groupsLabel() {
    if (state.groups === null) return 'All tree allergens';
    return state.groups.map(groupLabel).join(', ');
  }

  function renderPresets() {
    var presets = (state.meta && state.meta.presets) || [];
    var select = $('preset');
    while (select.options.length > 1) select.remove(1);
    presets.forEach(function (p, i) {
      var opt = el('option', { text: p.name });
      opt.value = String(i);
      select.appendChild(opt);
    });
    show($('preset-field'), presets.length > 0);
  }

  function bindControls() {
    var select = $('month-select');
    MONTHS.forEach(function (name, i) {
      var opt = el('option', { text: name });
      opt.value = String(i + 1);
      select.appendChild(opt);
    });
    $('month-plan').addEventListener('click', function () {
      select.value = String(activeMonth());
      show($('month-plan'), false);
      show($('month-picker'), true);
      select.focus();
    });
    select.addEventListener('change', function () {
      var chosen = Number(select.value);
      state.monthOverride = chosen === currentMonth() ? null : chosen;
      syncMonth();
      controlsChanged();
    });
    $('month-today').addEventListener('click', function () {
      var changed = state.monthOverride !== null;
      state.monthOverride = null;
      show($('month-picker'), false);
      show($('month-plan'), true);
      syncMonth();
      if (changed) controlsChanged();
      $('month-plan').focus();
    });
    $('asthma').addEventListener('change', function (e) {
      state.asthma = e.target.checked;
      syncTraffic();
      controlsChanged();
    });
    $('heat-toggle').addEventListener('change', function (e) {
      state.heatOn = e.target.checked;
      setLayerVisible('heat', state.heatOn);
      if (state.heatOn) {
        scheduleHeat(0);
      } else {
        clearTimeout(heatTimer);
        cancel(heatChannel);
        setBusy('heat', false);
        setStatus($('heat-status'), '');
        show($('heat-retry'), false);
      }
    });
    $('trees-toggle').addEventListener('change', function (e) {
      state.treesOn = e.target.checked;
      syncHotspotLayers();
      if (state.treesOn) scheduleHotspots(0);
    });
    $('traffic-toggle').addEventListener('change', function (e) {
      trafficTouched = true;
      trafficOn = e.target.checked;
      syncTraffic();
      if (trafficOn) scheduleHotspots(0);
    });
    $('hotspot-retry').addEventListener('click', function () { scheduleHotspots(0); });
    $('location-retry').addEventListener('click', function () {
      locationAsked = false;
      requestLocation();
    });
    $('preset').addEventListener('change', function (e) {
      if (e.target.value === '') return;
      var presets = (state.meta && state.meta.presets) || [];
      var preset = presets[Number(e.target.value)];
      if (!preset || !isPoint(preset.start) || !isPoint(preset.end)) return;
      setPoint('start', preset.start);
      setPoint('end', preset.end);
      state.placeNames = preset.name;
      setStatus($('ask-status'), '');
      updateHint();
      fitOnNextRoute = true;
      runRoute();
    });
    $('clear-route').addEventListener('click', clearWalk);
    // There are no accounts: signing out forgets this browser's profile and returns to the landing page.
    $('sign-out').addEventListener('click', function () {
      clearTimeout(putTimer);
      putTimer = null;
      storeClear();
      window.location.href = './';
    });
    $('route-retry').addEventListener('click', function () { runRoute(); });
    $('heat-retry').addEventListener('click', function () { scheduleHeat(0); });
    $('meta-retry').addEventListener('click', loadMeta);
    $('profile-retry').addEventListener('click', function () { loadProfile(storeGet()); });
  }

  // ---- route ----

  function scheduleRoute(delay) {
    clearTimeout(routeTimer);
    if (!(state.start && state.end)) return;
    routeTimer = setTimeout(runRoute, delay);
  }

  function clearWalk() {
    setPoint('start', state.here, Boolean(state.here));
    setPoint('end', null);
    forgetPlaceNames();
    setStatus($('ask-status'), '');
    clearRouteResult();
    updateHint();
  }

  // Remove every trace of the current route, including anything still on its way.
  function clearRouteResult() {
    clearTimeout(routeTimer);
    cancel(routeChannel);
    setBusy('route', false);
    state.route = null;
    setMapData('routes', emptyLines());
    show($('stats'), false);
    $('stats').classList.remove('is-stale');
    show($('details'), false);
    show($('route-query'), false);
    show($('route-error'), false);
    localExposure = false;
    renderBadges();
    updateHint();
  }

  function showRouteError(message) {
    clearRouteResult();
    $('route-error-text').textContent = message;
    show($('route-error'), true);
  }

  async function runRoute() {
    clearTimeout(routeTimer);
    if (!(state.start && state.end)) return;

    var request = routeRequest();
    var context = describeRequest();

    show($('route-error'), false);
    setBusy('route', true);
    $('stats').classList.add('is-stale');
    $('stats').setAttribute('aria-busy', 'true');

    var data;
    try {
      data = await latest(routeChannel, '/api/route', jsonPost(request), ROUTE_TIMEOUT);
    } catch (e) {
      // Never leave old numbers on screen for settings they don't describe.
      $('stats').removeAttribute('aria-busy');
      showRouteError(e.status === 400 ? e.message : 'Route failed: ' + e.message);
      return;
    }
    if (data === STALE) return;

    $('stats').removeAttribute('aria-busy');
    setBusy('route', false);
    $('stats').classList.remove('is-stale');

    if (!data || !data.shortest || !data.clean || !Array.isArray(data.clean.coords)) {
      showRouteError('Route failed: the server response was incomplete.');
      return;
    }

    state.route = data;
    drawRoutes(data);
    renderResult(data, context);
    updateHint();
  }

  function routeRequest() {
    var request = {
      start: state.start,
      end: state.end,
      max_detour: MAX_DETOUR
    };
    if (state.monthOverride) request.month = state.monthOverride;
    if (state.profile) {
      // The server applies the saved profile. Explicit values override it, so send
      // them only when the server's copy is behind, or when no trees are picked.
      request.profile_id = state.profile.profile_id;
      if (state.profileDirty) {
        request.groups = state.groups;
        request.asthma = state.asthma;
      } else if (state.groups === null) {
        request.groups = null;
      }
    } else {
      request.groups = state.groups;
      request.asthma = state.asthma;
    }
    return request;
  }

  function describeRequest() {
    var parts = [];
    if (state.placeNames) parts.push(state.placeNames);
    parts.push(MONTHS[activeMonth() - 1]);
    return parts.join(' \u00b7 ');
  }

  function drawRoutes(data) {
    var shortest = data.shortest.coords || [];
    var clean = data.clean.coords || [];
    var routes = emptyLines();
    if (shortest.length > 1) routes.features.push(lineFeature(shortest, { role: 'shortest' }));
    if (clean.length > 1) routes.features.push(lineFeature(clean, { role: 'clean' }));
    setMapData('routes', routes);
    if (fitOnNextRoute) {
      fitOnNextRoute = false;
      fitPoints(shortest.concat(clean));
    }
  }

  function sameCoords(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }

  function renderResult(data, context) {
    var summary = data.summary || {};
    var pct = isNum(summary.exposure_reduction_pct) ? Math.round(summary.exposure_reduction_pct) : 0;
    var same = sameCoords(data.shortest.coords, data.clean.coords);
    var asthma = Boolean(data.applied && data.applied.asthma);
    var showAir = asthma && isNum(summary.air_reduction_pct);
    var noTreesInSeason = Array.isArray(summary.in_season) && summary.in_season.length === 0;

    show($('stats'), true);

    // Out of season the percentage is a share of almost nothing, so it can't be the headline.
    var pollenTitle = '';
    if (same) pollenTitle = 'The shortest route is already the cleanest.';
    else if (noTreesInSeason) pollenTitle = 'None of your trees are in season';
    else if (pct <= 0) pollenTitle = 'No less pollen on this walk';
    var showFigure = !same && pct > 0;
    $('stat-pollen-title').textContent = pollenTitle;
    show($('stat-pollen-title'), Boolean(pollenTitle));
    show($('stat-pollen-head'), showFigure);
    show($('stat-pollen-track'), showFigure);
    $('stat-pollen-track').classList.toggle('is-dim', noTreesInSeason);
    if (showFigure) {
      $('stat-pollen-value').textContent = pct + '%';
      $('stat-pollen-label').textContent = noTreesInSeason ? 'when in season' : 'Less estimated pollen';
      setBar($('stat-pollen-bar'), pct);
    }
    var wide = summary.reduction_within_100m_pct;
    $('stat-pollen-note').textContent = same
      ? (isNum(data.shortest.minutes) ? fmt(data.shortest.minutes, 1) + ' min, with no cleaner option within the detour limit.' : '')
      : (showFigure && !noTreesInSeason
        ? 'Trees within 25 m' + (isNum(wide) ? '. ' + Math.round(wide) + '% counting trees within 100 m.' : '.')
        : '');

    // Traffic doesn't depend on the month, so this stat ignores the season.
    show($('stat-air'), showAir);
    if (showAir) {
      var air = Math.round(summary.air_reduction_pct);
      show($('stat-air-title'), air <= 0);
      show($('stat-air-head'), air > 0);
      show($('stat-air-track'), air > 0);
      $('stat-air-value').textContent = air + '%';
      if (air > 0) setBar($('stat-air-bar'), air);
      $('stat-air-note').textContent = data.traffic_live === true ? 'Road type + live TomTom congestion' : 'Road type only';
    }

    $('stat-time').textContent = same ? '' : extraTimeText(summary.extra_minutes);
    show($('stat-time'), !same);
    $('stat-context').textContent = context;
    renderStatsFoot();

    renderCompare(data.shortest, data.clean, data.traffic_live === true, asthma);
    renderSpecies($('species-short'), data.shortest.top_species);
    renderSpecies($('species-clean'), data.clean.top_species);

    var hasExplanation = typeof data.explanation === 'string' && data.explanation.trim() !== '';
    $('explanation').textContent = hasExplanation ? data.explanation : '';
    show($('explanation-block'), hasExplanation);

    show($('route-query'), true);
    $('elastic-query').textContent = data.elastic_query
      ? JSON.stringify(data.elastic_query, null, 2)
      : 'No Elastic query for this route. The server did not return one.';

    show($('details'), true);

    localExposure = data.shortest.exposure_source === 'local' || data.clean.exposure_source === 'local';
    renderBadges();
  }

  function setBar(bar, pct) {
    bar.style.transform = 'scaleX(' + Math.max(0, Math.min(pct, 100)) / 100 + ')';
  }

  function renderStatsFoot() {
    var parts = [];
    var trees = state.meta && state.meta.data && state.meta.data.trees;
    if (isNum(trees)) parts.push('Based on ' + fmt(trees) + ' street trees');
    if (state.route && state.route.traffic_live === true && trafficLive && trafficClockText) {
      parts.push((trafficSource || 'Live') + ' traffic ' + trafficClockText);
    }
    $('stat-foot').textContent = parts.join(' \u00b7 ');
    show($('stat-foot'), parts.length > 0);
  }

  function extraTimeText(minutes) {
    if (!isNum(minutes)) return 'Extra time unknown';
    var rounded = Math.round(minutes * 10) / 10;
    if (rounded > 0) return '+' + fmt(rounded, 1) + ' min';
    if (rounded < 0) return '\u2212' + fmt(-rounded, 1) + ' min';
    return 'No extra time';
  }

  function renderCompare(shortest, clean, trafficLive, asthma) {
    var heavyTraffic = ['Time in heavy traffic', fmtShare(shortest.congested_share), fmtShare(clean.congested_share)];
    var rows = [['Minutes', fmt(shortest.minutes, 1), fmt(clean.minutes, 1)]];
    if (asthma) {
      rows.push(['Traffic pollution score', fmtScore(shortest.air_exposure), fmtScore(clean.air_exposure)]);
      if (trafficLive) rows.push(heavyTraffic);
      rows.push(['Next to major roads', fmtShare(shortest.major_road_share), fmtShare(clean.major_road_share)]);
    }
    rows.push(['Exposure', fmt(shortest.exposure), fmt(clean.exposure)]);
    rows.push(['Allergenic trees near', fmt(shortest.allergenic_trees_near), fmt(clean.allergenic_trees_near)]);
    if (!asthma) {
      rows.push(['Major road share', fmtShare(shortest.major_road_share), fmtShare(clean.major_road_share)]);
      if (trafficLive) rows.push(heavyTraffic);
    }
    rows.push(['Pollution zone share', fmtShare(shortest.pollution_zone_share), fmtShare(clean.pollution_zone_share)]);
    var body = $('compare-body');
    clearChildren(body);
    rows.forEach(function (r) {
      var tr = el('tr');
      var th = el('th', { text: r[0] });
      th.scope = 'row';
      tr.appendChild(th);
      tr.appendChild(el('td', { className: 'num', text: r[1] }));
      tr.appendChild(el('td', { className: 'num', text: r[2] }));
      body.appendChild(tr);
    });
  }

  function renderSpecies(list, species) {
    clearChildren(list);
    if (!Array.isArray(species) || !species.length) {
      list.appendChild(el('li', { className: 'species-meta', text: 'None recorded near this route.' }));
      return;
    }
    species.slice(0, 5).forEach(function (s) {
      var li = el('li');
      li.appendChild(el('span', { className: 'species-common', text: s.common || s.species || 'Unknown' }));
      var meta = el('span', { className: 'species-meta' });
      if (s.common && s.species) {
        meta.appendChild(el('span', { className: 'species-latin', text: s.species }));
        meta.appendChild(document.createTextNode(', '));
      }
      meta.appendChild(document.createTextNode(isNum(s.trees) ? plural(s.trees, 'tree') : 'tree count unknown'));
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  // ---- heat layer ----

  function scheduleHeat(delay) {
    clearTimeout(heatTimer);
    if (!state.heatOn) return;
    heatTimer = setTimeout(loadHeat, delay);
  }

  async function loadHeat() {
    if (!state.heatOn) return;
    var params = new URLSearchParams();
    if (state.monthOverride) params.set('month', String(state.monthOverride));
    if (state.groups) params.set('groups', state.groups.join(','));
    params.set('asthma', state.asthma ? 'true' : 'false');

    show($('heat-retry'), false);
    setBusy('heat', true);

    var data;
    try {
      data = await latest(heatChannel, '/api/segments?' + params.toString(), {}, ROUTE_TIMEOUT);
    } catch (e) {
      // Drop old colours: they describe different settings.
      setBusy('heat', false);
      setMapData('heat', emptyLines());
      setStatus($('heat-status'), 'Street layer failed: ' + e.message, true);
      show($('heat-retry'), true);
      return;
    }
    if (data === STALE) return;
    setBusy('heat', false);

    var segments = Array.isArray(data.segments) ? data.segments : [];
    var drawn = drawHeat(segments, data.max);
    setStatus($('heat-status'), drawn ? '' : 'No estimated exposure on any street for these settings.');
  }

  function drawHeat(segments, max) {
    var scale = isNum(max) && max > 0 ? max : 0;
    var heat = emptyLines();
    if (scale) {
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || !Array.isArray(seg.c) || seg.c.length < 2 || !isNum(seg.e)) continue;
        var ratio = Math.min(seg.e / scale, 1);
        if (ratio < HEAT_MIN_RATIO) continue;
        heat.features.push(lineFeature(seg.c, { r: Math.round(ratio * 100) / 100 }));
      }
    }
    setMapData('heat', heat);
    return heat.features.length;
  }

  // ---- traffic status ----

  var trafficLive = false;
  var trafficOn = false;
  var trafficTouched = false;
  var trafficFetchedAt = 0;
  var trafficClockText = '';
  var trafficSource = '';

  function trafficVisible() { return trafficLive && trafficOn; }

  // Off the page entirely unless the feed is live. On by default for people with asthma.
  function syncTraffic() {
    if (!trafficTouched) {
      var next = state.asthma;
      if (next && !trafficOn) scheduleHotspots(0);
      trafficOn = next;
    }
    $('traffic-toggle').checked = trafficOn;
    show($('traffic-switch'), trafficLive);
    show($('legend-ring'), trafficVisible());
    show($('traffic-status'), trafficLive);
    syncHotspotLayers();
    renderStatsFoot();
  }

  function trafficClock(iso) {
    var when = new Date(iso);
    if (!iso || isNaN(when.getTime())) return '';
    return when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  }

  function endTraffic() {
    trafficLive = false;
    setMapData('hotTraffic', emptyLines());
    syncTraffic();
  }

  async function loadTraffic() {
    var data;
    try {
      data = await latest(trafficChannel, '/api/traffic', {}, ROUTE_TIMEOUT);
    } catch (_) {
      // The timestamp stays honest through a blip. After that, say nothing about traffic.
      if (Date.now() - trafficFetchedAt > TRAFFIC_MAX_AGE) endTraffic();
      return;
    }
    if (data === STALE) return;
    if (data.live !== true) {
      endTraffic();
      return;
    }
    trafficLive = true;
    trafficFetchedAt = Date.now();
    trafficClockText = trafficClock(data.updated);
    trafficSource = data.source || '';
    $('traffic-status').textContent = (trafficClockText ? 'Traffic updated ' + trafficClockText : 'Traffic') + (trafficSource ? ' \u00b7 ' + trafficSource : '');
    setMapData('hotTraffic', trafficFeatures(data.segments));
    syncTraffic();
  }

  // ---- hotspot circles ----

  var hotspotChannel = newChannel();
  var hotspotTimer = null;

  function setLayersVisible(ids, visible) {
    ids.forEach(function (id) { setLayerVisible(id, visible); });
  }

  function syncHotspotLayers() {
    setLayersVisible(['trees-halo', 'trees-core'], state.treesOn);
    setLayersVisible(['traffic-lines'], trafficVisible());
  }

  function scheduleHotspots(delay) {
    clearTimeout(hotspotTimer);
    hotspotTimer = setTimeout(function () {
      if (state.treesOn) loadHotspots();
    }, delay);
  }

  function trafficFeatures(segments) {
    return {
      type: 'FeatureCollection',
      features: (Array.isArray(segments) ? segments : []).map(function (s) {
        return {
          type: 'Feature',
          properties: { level: s.level },
          geometry: { type: 'LineString', coordinates: s.c.map(toLngLat) }
        };
      })
    };
  }

  function hotspotFeatures(cells) {
    return {
      type: 'FeatureCollection',
      features: cells.filter(function (c) { return c && isPoint(c.point) && isNum(c.level); }).map(function (c) {
        return {
          type: 'Feature',
          properties: {
            level: c.level,
            season: isNum(c.season) ? c.season : 1,
            // Metres. Tiles are about 240 m wide, so neighbouring circles rarely overlap.
            r: 25 + 85 * c.level
          },
          geometry: { type: 'Point', coordinates: toLngLat(c.point) }
        };
      })
    };
  }

  function renderHotspotStatus(message, treeCells) {
    var note = message;
    if (!note && state.treesOn && treeCells === 0) note = 'No tree hotspots for these settings.';
    setStatus($('hotspot-status'), note, Boolean(message));
    show($('hotspot-retry'), Boolean(message));
  }

  async function loadHotspots() {
    if (!map) return;
    var params = new URLSearchParams();
    if (state.monthOverride) params.set('month', String(state.monthOverride));
    if (state.groups) params.set('groups', state.groups.join(','));
    var data;
    try {
      data = await latest(hotspotChannel, '/api/hotspots?' + params.toString(), {}, ROUTE_TIMEOUT);
    } catch (e) {
      // Old circles describe other settings, so they go too.
      setMapData('hotTrees', emptyLines());
      renderHotspotStatus('Tree circles failed: ' + e.message, null);
      return;
    }
    if (data === STALE) return;
    var cells = Array.isArray(data.cells) ? data.cells : [];
    setMapData('hotTrees', hotspotFeatures(cells));
    if (data.query) {
      $('hotspot-query').textContent = JSON.stringify(data.query, null, 2);
      show($('hotspot-query-block'), true);
    }
    renderHotspotStatus('', cells.length);
  }

  function renderLegendSteps() {
    HOTSPOT_COLORS.forEach(function (color) {
      var step = el('span');
      step.style.background = color;
      $('legend-steps').appendChild(step);
    });
  }

  // ---- current location ----

  var locationAsked = false;

  function insideCoverage(p) {
    var b = homeBounds;
    return p[0] >= b[0][0] && p[0] <= b[1][0] && p[1] >= b[0][1] && p[1] <= b[1][1];
  }

  function locationFailed() {
    state.locating = false;
    state.here = null;
    state.locationFailed = true;
    if (state.end && !state.start) setStatus($('ask-status'), LOCATION_FAILED, true);
    updateHint();
  }

  function requestLocation() {
    if (locationAsked) return;
    locationAsked = true;
    state.locationFailed = false;
    if (!navigator.geolocation) {
      locationFailed();
      return;
    }
    state.locating = true;
    updateHint();
    navigator.geolocation.getCurrentPosition(function (pos) {
      var point = [pos.coords.latitude, pos.coords.longitude];
      // Coverage comes from /api/meta, so wait for it before judging the position.
      metaLoaded.then(function () {
        if (!insideCoverage(point)) {
          locationFailed();
          return;
        }
        state.locating = false;
        state.here = point;
        if (!state.start) {
          setPoint('start', point, true);
          setStatus($('ask-status'), '');
          if (state.end) {
            fitOnNextRoute = true;
            runRoute();
          }
        }
        updateHint();
      });
    }, locationFailed, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  }

  function noStartMessage() {
    return state.locating ? 'Finding your location...' : LOCATION_FAILED;
  }

  // ---- voice and text ----

  function setAskBusy(on) {
    if (on) setStatus($('ask-status'), '');
    setBusy('ask', Boolean(on));
    $('ask-submit').disabled = Boolean(on);
  }

  async function sendAsk(path, opts, timeout) {
    setAskBusy(true);
    var data;
    try {
      data = await latest(askChannel, path, opts, timeout);
    } catch (e) {
      setAskBusy(false);
      setStatus($('ask-status'), "Couldn't read that: " + e.message + ' The controls and map still work.', true);
      return;
    }
    if (data === STALE) return;
    setAskBusy(false);
    applyParsed(data);
  }

  function goToPlace(point, name) {
    setPoint('end', point);
    state.placeNames = 'To ' + name;
    $('preset').value = '';
    updateHint();
    if (!state.start) {
      setStatus($('ask-status'), noStartMessage(), !state.locating);
      return;
    }
    fitOnNextRoute = true;
    runRoute();
  }

  async function sendDestination(text) {
    setAskBusy(true);
    var data;
    try {
      data = await latest(askChannel, '/api/geocode', jsonPost({ text: text }), ROUTE_TIMEOUT);
      if (data !== STALE && !isPoint(data.point)) throw new Error('the server response was incomplete.');
    } catch (e) {
      setAskBusy(false);
      setStatus($('ask-status'), e.status === 404 ? e.message : "Couldn't look that up: " + e.message, true);
      return;
    }
    if (data === STALE) return;
    setAskBusy(false);
    goToPlace(data.point, data.name || text);
  }

  // ---- place search ----

  var LEADING_WORDS = /^\s*(please\s+)?((take|walk|get|bring)\s+me\s+to|go\s+to|walk\s+to|directions\s+to)\s+/i;
  var placesChannel = newChannel();
  var placeTimer = null;
  var placeResults = [];
  var placeActive = -1;
  var placeQuery = '';

  function placeText(raw) { return raw.replace(LEADING_WORDS, '').trim(); }

  // Only a real sentence goes to the slower parser: everything else is a place search.
  function isSentence(raw) {
    return /\b(allerg\w*|asthma)\b|\bi'?m\b/i.test(raw)
      || /\b(take|walk|bring|get)\s+me\s+from\b/i.test(raw)
      || /\bfrom\b.+\bto\b/i.test(raw);
  }

  function placesUrl(query) {
    var params = new URLSearchParams();
    params.set('q', query);
    if (state.start) {
      params.set('lat', String(state.start[0]));
      params.set('lon', String(state.start[1]));
    }
    return '/api/places?' + params.toString();
  }

  function usablePlaces(data) {
    return (data && Array.isArray(data.results) ? data.results : []).filter(function (r) {
      return r && r.name && isPoint(r.point);
    }).slice(0, 8);
  }

  function closePlaces() {
    clearTimeout(placeTimer);
    cancel(placesChannel);
    placeResults = [];
    placeActive = -1;
    placeQuery = '';
    clearChildren($('place-list'));
    show($('place-list'), false);
    var input = $('ask-input');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function renderPlaces() {
    var list = $('place-list');
    var input = $('ask-input');
    clearChildren(list);
    placeResults.forEach(function (place, i) {
      var li = el('li', { className: 'place-option' });
      li.id = 'place-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === placeActive ? 'true' : 'false');
      li.appendChild(el('span', { className: 'place-name', text: place.name }));
      if (place.detail) li.appendChild(el('span', { className: 'place-detail', text: place.detail }));
      // Keep focus in the box, so the blur doesn't close the list before the click lands.
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { choosePlace(place); });
      list.appendChild(li);
    });
    var open = placeResults.length > 0;
    show(list, open);
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (placeActive >= 0) input.setAttribute('aria-activedescendant', 'place-' + placeActive);
    else input.removeAttribute('aria-activedescendant');
  }

  function choosePlace(place) {
    $('ask-input').value = place.name;
    closePlaces();
    setStatus($('ask-status'), '');
    show($('transcript'), false);
    goToPlace(place.point, place.name);
  }

  function onPlaceInput() {
    var raw = $('ask-input').value;
    var query = placeText(raw);
    clearTimeout(placeTimer);
    setStatus($('ask-status'), '');
    if (query.length < 2 || isSentence(raw)) {
      closePlaces();
      return;
    }
    placeTimer = setTimeout(async function () {
      var data;
      try {
        data = await latest(placesChannel, placesUrl(query), {}, 5000);
      } catch (_) {
        // Suggestions are a convenience. Pressing Go still reports what went wrong.
        placeResults = [];
        placeActive = -1;
        renderPlaces();
        return;
      }
      if (data === STALE) return;
      placeResults = usablePlaces(data);
      placeActive = -1;
      placeQuery = query;
      renderPlaces();
    }, 150);
  }

  function onPlaceKey(e) {
    if (e.key === 'Escape') {
      if (placeResults.length) e.preventDefault();
      closePlaces();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!placeResults.length) return;
    e.preventDefault();
    var step = e.key === 'ArrowDown' ? 1 : -1;
    var count = placeResults.length;
    if (placeActive < 0) placeActive = step > 0 ? 0 : count - 1;
    else placeActive = (placeActive + step + count) % count;
    renderPlaces();
    $('place-' + placeActive).scrollIntoView({ block: 'nearest' });
  }

  async function submitWhereTo(raw) {
    if (placeActive >= 0 && placeResults[placeActive]) {
      choosePlace(placeResults[placeActive]);
      return;
    }
    if (isSentence(raw)) {
      closePlaces();
      sendAsk('/api/parse', jsonPost({ text: raw }), ROUTE_TIMEOUT);
      return;
    }
    var query = placeText(raw);
    if (query === placeQuery && placeResults.length) {
      choosePlace(placeResults[0]);
      return;
    }
    closePlaces();
    show($('transcript'), false);
    if (query.length >= 2) {
      // The list may not have arrived yet, so ask for the first result now.
      var data = null;
      setAskBusy(true);
      try {
        data = await latest(placesChannel, placesUrl(query), {}, 5000);
      } catch (_) {
        data = null; // the geocoder below gives the real answer or the real error
      }
      if (data === STALE) return;
      setAskBusy(false);
      var first = usablePlaces(data)[0];
      if (first) {
        choosePlace(first);
        return;
      }
    }
    sendDestination(query);
  }

  function applyParsed(data) {
    var transcript = $('transcript');
    if (data.transcript) {
      transcript.textContent = 'Heard: "' + data.transcript + '"';
      show(transcript, true);
    } else {
      show(transcript, false);
    }

    var problems = [];
    var notes = [];
    var named = Array.isArray(data.groups) && data.groups.length > 0;

    if (state.profile) {
      // The profile owns trees and asthma. This box only needs a destination.
      if (named) notes.push('Using your saved profile for trees. Use Edit to change it.');
    } else {
      // Null or missing means not mentioned, so the current choices stand.
      if (named) {
        var known = ((state.meta && state.meta.groups) || []).map(function (g) { return g.id; });
        var usable = known.length
          ? data.groups.filter(function (id) { return known.indexOf(id) >= 0; })
          : data.groups;
        if (usable.length) state.groups = usable;
        else problems.push("That tree isn't in the data, so the tree selection was left as it was.");
        syncChips();
      }
      if (data.asthma === true) {
        state.asthma = true;
        $('asthma').checked = true;
      }
    }

    var moved = false;
    ['start', 'end'].forEach(function (which) {
      var point = data[which];
      var placeName = data[which + '_text'];
      if (isPoint(point)) {
        setPoint(which, point);
        moved = true;
      } else if (placeName) {
        // The named place wasn't found: don't keep routing to the old pin.
        setPoint(which, null);
        moved = true;
        problems.push('Couldn\'t find "' + placeName + '". Click the map to set the ' + which + '.');
      }
    });

    // Asked for a destination only: the walk starts from You, and never from a guess.
    if (isPoint(data.end) && !state.start) problems.push(noStartMessage());

    if (moved) {
      var hasStart = data.start_text && isPoint(data.start);
      var hasEnd = data.end_text && isPoint(data.end);
      state.placeNames = hasStart && hasEnd
        ? data.start_text + ' to ' + data.end_text
        : hasEnd ? 'To ' + data.end_text : null;
      $('preset').value = '';
    }

    if (!(state.start && state.end)) {
      clearRouteResult();
      if (!problems.length) {
        problems.push(state.start ? 'Say or type a destination, or click the map.' : "We didn't catch a place. Try again, or click the map.");
      }
    }

    if (problems.length) setStatus($('ask-status'), problems.concat(notes).join(' '), true);
    else if (notes.length) setStatus($('ask-status'), notes.join(' '));

    updateHint();
    scheduleHeat(0);
    scheduleHotspots(0);
    if (state.start && state.end) {
      if (moved) fitOnNextRoute = true;
      runRoute();
    }
  }

  function bindAsk() {
    var input = $('ask-input');
    $('ask-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) {
        setStatus($('ask-status'), 'Type where you want to go first.', true);
        input.focus();
        return;
      }
      submitWhereTo(text);
    });
    input.addEventListener('input', onPlaceInput);
    input.addEventListener('keydown', onPlaceKey);
    input.addEventListener('blur', closePlaces);
    makeMic({
      button: $('mic'),
      label: $('mic-label'),
      note: $('mic-note'),
      onAudio: function (blob, filename) {
        var form = new FormData();
        form.append('file', blob, filename);
        sendAsk('/api/voice', { method: 'POST', body: form }, VOICE_TIMEOUT);
      }
    });
  }

  // ---- microphone ----

  function pickAudioFormat() {
    var options = [
      { mime: 'audio/webm;codecs=opus', name: 'speech.webm' },
      { mime: 'audio/webm', name: 'speech.webm' },
      { mime: 'audio/mp4', name: 'speech.mp4' }
    ];
    for (var i = 0; i < options.length; i++) {
      if (MediaRecorder.isTypeSupported(options[i].mime)) return options[i];
    }
    return { mime: '', name: 'speech.webm' };
  }

  // cfg: button, label, note, onAudio(blob, filename), and optional canStart()
  function makeMic(cfg) {
    var recorder = null;
    var stopTimer = null;
    var ready = navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder;

    function fail(reason) {
      setStatus(cfg.note, reason + ' The text box still works.', true);
    }

    if (!ready) {
      cfg.button.disabled = true;
      fail(window.isSecureContext
        ? 'Voice recording is not available in this browser.'
        : 'The mic needs HTTPS or localhost.');
      return;
    }

    cfg.button.addEventListener('click', function () {
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      } else if (!cfg.canStart || cfg.canStart()) {
        start();
      }
    });

    async function start() {
      var stream;
      setStatus(cfg.note, '');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        var name = e && e.name;
        fail(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Mic permission was refused.'
          : name === 'NotFoundError' ? 'No microphone found.' : 'The mic could not start.');
        return;
      }

      var format = pickAudioFormat();
      var chunks = [];
      try {
        recorder = format.mime ? new MediaRecorder(stream, { mimeType: format.mime }) : new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        fail('The mic could not start.');
        return;
      }

      recorder.addEventListener('dataavailable', function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      });
      recorder.addEventListener('stop', function () {
        clearTimeout(stopTimer);
        stream.getTracks().forEach(function (t) { t.stop(); });
        cfg.label.textContent = 'Speak';
        cfg.button.classList.remove('is-recording');
        setStatus(cfg.note, '');
        var blob = new Blob(chunks, { type: recorder.mimeType || format.mime || 'audio/webm' });
        if (!blob.size) {
          setStatus(cfg.note, 'No audio was captured. Try again, or type instead.', true);
          return;
        }
        cfg.onAudio(blob, format.name);
      });

      recorder.start();
      cfg.label.textContent = 'Stop';
      cfg.button.classList.add('is-recording');
      setStatus(cfg.note, 'Recording. Press Stop when you finish.');
      stopTimer = setTimeout(function () {
        if (recorder && recorder.state === 'recording') recorder.stop();
      }, RECORD_LIMIT);
    }
  }

  // ---- profile ----

  var STORE_KEY = 'cleanroute.profile_id';
  var storageWorks = true;
  var putTimer = null;
  var putInFlight = null;

  function storeGet() {
    try { return window.localStorage.getItem(STORE_KEY); } catch (_) { return null; }
  }

  function storeSet(id) {
    try {
      window.localStorage.setItem(STORE_KEY, id);
      storageWorks = true;
    } catch (_) {
      storageWorks = false;
    }
  }

  function storeClear() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (_) { /* nothing stored then */ }
  }

  function isProfile(p) {
    return Boolean(p && typeof p.profile_id === 'string' && p.profile_id);
  }

  // Copy a profile into the live settings used by the route and street layer.
  function adoptProfile(p) {
    state.profile = p;
    state.groups = Array.isArray(p.groups) && p.groups.length ? p.groups.slice() : null;
    state.asthma = Boolean(p.asthma);
    $('asthma').checked = state.asthma;
    syncChips();
    syncMode();
    syncTraffic();
  }

  function syncMode() {
    show($('manual-controls'), !state.profile);
    renderProfileSummary();
  }

  function renderProfileSummary() {
    var summary = $('profile-summary');
    var edit = $('profile-edit');
    show(edit, true);
    show($('sign-out'), Boolean(state.profile));
    if (!state.profile) {
      summary.textContent = 'No profile. Choosing trees by hand.';
      edit.textContent = 'Set up a profile';
      return;
    }
    var parts = (state.groups || []).map(function (id) { return groupLabel(id).toLowerCase(); });
    if (!parts.length) parts.push('all trees');
    if (state.asthma) parts.push('asthma');
    summary.textContent = state.profile.name + ': ' + parts.join(', ') + (state.profileDirty ? ' (not saved)' : '');
    edit.textContent = 'Edit';
  }

  async function loadProfile(id) {
    if (!id) return;
    show($('profile-error'), false);
    show($('profile-edit'), false);
    show($('sign-out'), false);
    $('profile-summary').textContent = 'Loading your profile...';
    var data;
    try {
      data = await latest(profileChannel, '/api/profile/' + encodeURIComponent(id), {}, ROUTE_TIMEOUT);
      if (data !== STALE && !isProfile(data)) throw new Error('the server response was incomplete.');
    } catch (e) {
      if (e.status === 404) {
        storeClear();
        openRegister("We couldn't find your saved profile. Please set it up again.");
        return;
      }
      state.profile = null;
      syncMode();
      $('profile-error-text').textContent = "Couldn't load your profile: " + e.message + ' Choose your trees by hand below.';
      show($('profile-error'), true);
      scheduleHeat(0);
      scheduleHotspots(0);
      scheduleRoute(0);
      return;
    }
    if (data === STALE) return;
    adoptProfile(data);
    state.profileDirty = false;
    renderProfileSummary();
    scheduleHeat(0);
    scheduleHotspots(0);
    scheduleRoute(0);
  }

  function openScreen() {
    $('app').inert = true;
    show($('onboarding'), true);
    $('onboarding').scrollTop = 0;
  }

  function closeScreen() {
    show($('onboarding'), false);
    $('app').inert = false;
    if (map) map.resize();
    syncMode();
    syncTraffic();
    scheduleHeat(0);
    scheduleHotspots(0);
    scheduleRoute(0);
    requestLocation();
    $('ask-input').focus();
  }

  function openRegister(message) {
    show($('ob-ask'), true);
    show($('ob-confirm'), false);
    show($('ob-error'), false);
    setSlot($('ob-status'), message || '', Boolean(message));
    openScreen();
    $('ob-name').focus();
  }

  function openConfirm(heard, isNew) {
    var p = state.profile;
    show($('ob-ask'), false);
    show($('ob-confirm'), true);
    $('ob-confirm-title').textContent = isNew
      ? "Here's what we understood, " + p.name + '.'
      : p.name + ', your allergies';
    $('ob-done').textContent = isNew ? 'Looks right, show the map' : 'Done';
    show($('ob-heard'), Boolean(heard));
    $('ob-heard').textContent = heard ? 'You said: "' + heard + '"' : '';
    setSlot($('ob-save-status'), state.profileDirty ? "These changes aren't saved yet." : '', state.profileDirty);
    show($('ob-storage-note'), !storageWorks);
    renderConfirm();
    openScreen();
  }

  function renderConfirm() {
    var p = state.profile;
    if (!p) return;
    var picked = Array.isArray(p.groups) ? p.groups : [];
    var box = $('ob-chips');
    clearChildren(box);
    var ids = ((state.meta && state.meta.groups) || []).map(function (g) { return g.id; });
    picked.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    ids.forEach(function (id) {
      var chip = el('button', { className: 'chip', text: groupLabel(id) });
      chip.type = 'button';
      chip.setAttribute('aria-pressed', picked.indexOf(id) >= 0 ? 'true' : 'false');
      chip.addEventListener('click', function () { toggleProfileGroup(id); });
      box.appendChild(chip);
    });
    show($('ob-empty-note'), picked.length === 0);
    $('ob-asthma').checked = Boolean(p.asthma);
    renderList($('ob-reasons-block'), $('ob-reasons'), p.reasons);
    renderList($('ob-not-covered-block'), $('ob-not-covered'), p.not_covered);
    renderSymptoms();
  }

  function renderList(block, list, items) {
    clearChildren(list);
    var rows = Array.isArray(items) ? items : [];
    rows.forEach(function (text) { list.appendChild(el('li', { text: text })); });
    show(block, rows.length > 0);
  }

  function toggleProfileGroup(id) {
    var p = state.profile;
    var next = (Array.isArray(p.groups) ? p.groups : []).slice();
    var at = next.indexOf(id);
    if (at >= 0) next.splice(at, 1); else next.push(id);
    p.groups = next;
    state.groups = next.length ? next.slice() : null;
    renderConfirm();
    schedulePut();
  }

  function schedulePut() {
    clearTimeout(putTimer);
    setSlot($('ob-save-status'), 'Saving...');
    putTimer = setTimeout(function () {
      putTimer = null;
      putProfile();
    }, 300);
  }

  function putProfile() {
    var p = state.profile;
    var run = (async function () {
      var data;
      try {
        data = await latest(profileChannel, '/api/profile/' + encodeURIComponent(p.profile_id), Object.assign(
          jsonPost({ groups: p.groups || [], asthma: Boolean(p.asthma) }), { method: 'PUT' }
        ), ROUTE_TIMEOUT);
        if (data !== STALE && !isProfile(data)) throw new Error('the server response was incomplete.');
      } catch (e) {
        state.profileDirty = true;
        renderProfileSummary();
        setSlot($('ob-save-status'), "Couldn't save: " + e.message + ' Your changes still apply to this visit.', true);
        return false;
      }
      if (data === STALE) return true;
      state.profileDirty = false;
      if (!putTimer) {
        adoptProfile(data);
        renderConfirm();
      }
      setSlot($('ob-save-status'), putTimer ? 'Saving...' : 'Saved');
      return true;
    })();
    putInFlight = run;
    return run;
  }

  async function finishConfirm() {
    var hadPending = Boolean(putTimer);
    if (putTimer) {
      clearTimeout(putTimer);
      putTimer = null;
    }
    var saved = true;
    if (hadPending) saved = await putProfile();
    else if (putInFlight) saved = await putInFlight;
    putInFlight = null;
    // A failed save stays on screen so the error is read. Pressing again carries on.
    if (!saved) return;
    closeScreen();
  }

  async function submitRegistration(path, opts, timeout, busyText) {
    show($('ob-error'), false);
    setSlot($('ob-status'), busyText);
    $('ob-submit').disabled = true;
    var data;
    try {
      data = await latest(profileChannel, path, opts, timeout);
      if (data !== STALE && !isProfile(data)) throw new Error('the server response was incomplete.');
    } catch (e) {
      $('ob-submit').disabled = false;
      setSlot($('ob-status'), '');
      $('ob-error-text').textContent = "Couldn't save your profile: " + e.message;
      show($('ob-error'), true);
      return;
    }
    if (data === STALE) return;
    $('ob-submit').disabled = false;
    setSlot($('ob-status'), '');
    storeSet(data.profile_id);
    show($('profile-error'), false);
    state.profileDirty = false;
    adoptProfile(data);
    openConfirm(data.transcript || data.raw_text, true);
  }

  function requireName() {
    var name = $('ob-name').value.trim();
    if (name) return name;
    setSlot($('ob-status'), 'Add your name first.', true);
    $('ob-name').focus();
    return null;
  }

  function bindProfile() {
    $('ob-ask').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = requireName();
      if (!name) return;
      var text = $('ob-text').value.trim();
      if (!text) {
        setSlot($('ob-status'), 'Tell us what you are allergic to, or press Speak.', true);
        $('ob-text').focus();
        return;
      }
      submitRegistration('/api/profile', jsonPost({ name: name, text: text }), ROUTE_TIMEOUT, 'Reading what you told us...');
    });
    makeMic({
      button: $('ob-mic'),
      label: $('ob-mic-label'),
      note: $('ob-mic-note'),
      canStart: function () { return Boolean(requireName()); },
      onAudio: function (blob, filename) {
        var form = new FormData();
        form.append('file', blob, filename);
        form.append('name', $('ob-name').value.trim());
        submitRegistration('/api/profile/voice', { method: 'POST', body: form }, VOICE_TIMEOUT, 'Listening back to what you said...');
      }
    });
    $('ob-manual').addEventListener('click', function () {
      state.profile = null;
      closeScreen();
    });
    $('ob-asthma').addEventListener('change', function (e) {
      state.profile.asthma = e.target.checked;
      state.asthma = e.target.checked;
      schedulePut();
    });
    $('ob-done').addEventListener('click', finishConfirm);
    $('ob-restart').addEventListener('click', function () {
      clearTimeout(putTimer);
      putTimer = null;
      cancel(profileChannel);
      storeClear();
      state.profile = null;
      state.profileDirty = false;
      state.groups = null;
      state.asthma = false;
      $('asthma').checked = false;
      syncChips();
      $('ob-name').value = '';
      $('ob-text').value = '';
      clearWalk();
      syncMode();
      openRegister();
    });
    $('profile-edit').addEventListener('click', function () {
      if (state.profile) openConfirm(null, false);
      else openRegister();
    });
  }

  // ---- symptoms ----

  function bindSymptoms() {
    $('symptom-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('symptom-input').value.trim();
      if (!text) {
        setStatus($('symptom-status'), 'Describe your symptoms first.', true);
        return;
      }
      runSymptoms(text);
    });
  }

  async function runSymptoms(text) {
    setStatus($('symptom-status'), 'Searching...');
    $('symptom-submit').disabled = true;
    var data;
    try {
      data = await latest(symptomChannel, '/api/symptoms', jsonPost({ text: text }), ROUTE_TIMEOUT);
    } catch (e) {
      $('symptom-submit').disabled = false;
      clearChildren($('symptom-results'));
      show($('symptom-note'), false);
      setStatus($('symptom-status'), 'Symptom search failed: ' + e.message, true);
      return;
    }
    if (data === STALE) return;
    $('symptom-submit').disabled = false;
    setStatus($('symptom-status'), '');
    state.symptomResults = data;
    renderSymptoms();
  }

  // One row per tree group the routes can avoid, with a button that adds it to the profile.
  function renderSymptoms() {
    var data = state.symptomResults;
    if (!data) return;
    var list = $('symptom-results');
    clearChildren(list);
    var known = ((state.meta && state.meta.groups) || []).map(function (g) { return g.id; });
    var seen = {};
    var rows = (Array.isArray(data.suggestions) ? data.suggestions : []).filter(function (s) {
      if (known.indexOf(s.group) < 0 || seen[s.group]) return false;
      seen[s.group] = true;
      return true;
    });
    if (!rows.length) setStatus($('symptom-status'), 'No matching trees found for that description.');
    var picked = (state.profile && state.profile.groups) || [];
    rows.forEach(function (s) {
      var added = picked.indexOf(s.group) >= 0;
      var li = el('li', { className: 'suggestion' });
      var head = el('div', { className: 'suggestion-head' });
      head.appendChild(el('span', { className: 'suggestion-name', text: s.common || s.species || 'Unknown tree' }));
      var add = el('button', { className: 'btn btn-small', text: added ? 'Added' : 'Add' });
      add.type = 'button';
      add.setAttribute('aria-pressed', added ? 'true' : 'false');
      add.addEventListener('click', function () { toggleProfileGroup(s.group); });
      head.appendChild(add);
      li.appendChild(head);
      if (s.why) li.appendChild(el('p', { className: 'suggestion-why', text: s.why }));
      list.appendChild(li);
    });
    var note = $('symptom-note');
    note.textContent = data.note || 'A suggestion, not a diagnosis.';
    show(note, true);
  }

  // ---- air, meta, badges ----

  async function loadAir() {
    var chip = $('air');
    try {
      var air = await api('/api/air');
      var parts = [];
      if (isNum(air.pm2_5)) parts.push('PM2.5 ' + fmt(air.pm2_5, 1));
      if (isNum(air.us_aqi)) parts.push('AQI ' + fmt(air.us_aqi));
      if (!parts.length) { show(chip, false); return; }
      $('air-values').textContent = parts.join('  ');
      $('air-source').textContent = air.source || 'Open-Meteo';
      show(chip, true);
    } catch (_) {
      show(chip, false); // the one quiet failure, by design: the chip is a bonus
    }
  }

  function renderBadges() {
    var box = $('badges');
    clearChildren(box);
    var modes = (state.meta && state.meta.modes) || {};
    var labels = [];
    if (modes.elastic === false) labels.push('Elastic off');
    if (modes.mistral === false) labels.push('Mistral off');
    if (localExposure) labels.push('Exposure source: local');
    labels.forEach(function (label) {
      box.appendChild(el('span', { className: 'badge', text: label }));
    });
  }

  async function loadMeta() {
    show($('meta-error'), false);
    try {
      var meta = await api('/api/meta');
      state.meta = meta;
      renderChips();
      renderPresets();
      renderBadges();
      syncMonth();
      renderProfileSummary();
      renderStatsFoot();
      if (!$('ob-confirm').hidden) renderConfirm();
      if (Array.isArray(meta.bounds) && isPoint(meta.bounds[0]) && isPoint(meta.bounds[1])) {
        homeBounds = meta.bounds;
        if (!state.route) fitHome();
      }
    } catch (e) {
      $('meta-error-text').textContent = "Couldn't load allergen data: " + e.message;
      show($('meta-error'), true);
    }
  }

  // ---- start ----

  function boot() {
    if (!window.maplibregl) {
      $('meta-error-text').textContent = "The map library didn't load. Check the network connection and reload.";
      $('meta-retry').hidden = true;
      show($('meta-error'), true);
      return;
    }
    initSidebar();
    initMap();
    renderLegendSteps();
    renderChips();
    syncMonth();
    bindControls();
    bindAsk();
    bindProfile();
    bindSymptoms();
    updateHint();
    metaLoaded = loadMeta();
    loadAir();
    setInterval(loadAir, 600000);
    loadTraffic();
    setInterval(loadTraffic, TRAFFIC_REFRESH);

    var savedId = storeGet();
    if (savedId) {
      loadProfile(savedId);
      requestLocation();
    } else {
      syncMode();
      openRegister();
    }
  }

  boot();
})();
