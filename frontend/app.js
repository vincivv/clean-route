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
  // Cool ramp so congestion can't be mistaken for pollen exposure.
  var TRAFFIC_COLORS = ['#b4bdf2', '#7f86e8', '#5546d6', '#3a1fb0', '#25107a'];
  var TRAFFIC_REFRESH = 120000;
  var TRAFFIC_MAX_AGE = 600000;
  var MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
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
    heatOn: true,
    start: null,
    startIsYou: false,
    here: null,
    locating: false,
    locationFailed: false,
    end: null,
    placeNames: null,
    route: null,
    lastSymptomText: null,
    profile: null,
    profileDirty: false // true when local edits couldn't be saved to the server
  };

  var map = null;
  var mapStyleReady = false;
  var startMarker = null;
  var endMarker = null;
  var mapData = { heat: emptyLines(), traffic: emptyLines(), routes: emptyLines() };
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: OSM_CREDIT }), 'bottom-right');

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

  // Runs on every style load, because changing style drops custom layers.
  function addDataLayers() {
    mapStyleReady = true;
    var labels = map.getStyle().layers.find(function (l) { return l.type === 'symbol'; });
    var below = labels ? labels.id : undefined;

    ['heat', 'traffic', 'routes'].forEach(function (id) {
      if (map.getSource(id)) return;
      map.addSource(id, { type: 'geojson', data: mapData[id], tolerance: 0.5, buffer: 32, maxzoom: 15 });
    });

    // Under the labels: exposure first, then congestion beside it.
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
    map.addLayer({
      id: 'traffic',
      type: 'line',
      source: 'traffic',
      layout: { 'line-cap': 'round', visibility: trafficVisible() ? 'visible' : 'none' },
      paint: {
        'line-color': rampExpression(['get', 'level'], 0, TRAFFIC_COLORS),
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 13, 2, 15, 3.5, 18, 7],
        'line-offset': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 15, 3, 18, 7],
        'line-opacity': 0.95
      }
    }, below);

    // Over everything: the routes are the point of the page.
    [
      ['route-short-casing', 'shortest', '#ffffff', 8],
      ['route-short', 'shortest', '#5b636d', 5],
      ['route-clean-casing', 'clean', '#ffffff', 10],
      ['route-clean', 'clean', '#0b7a3b', 7]
    ].forEach(function (r) {
      map.addLayer({
        id: r[0],
        type: 'line',
        source: 'routes',
        filter: ['==', ['get', 'role'], r[1]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': r[2], 'line-width': r[3] }
      });
    });
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
  function fitHome() {
    if (!map) return;
    var box = map.getContainer();
    homePending = !(box.clientWidth > 0 && box.clientHeight > 0);
    if (!homePending) map.fitBounds(toLngLatBounds(homeBounds), { padding: 24, animate: false });
  }

  function fitPoints(points) {
    if (!map || !points.length) return;
    var bounds = new maplibregl.LngLatBounds();
    points.forEach(function (p) { bounds.extend(toLngLat(p)); });
    map.fitBounds(bounds, { padding: { top: 70, bottom: 50, left: 60, right: 60 }, maxZoom: 16, duration: 500 });
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
    var hint = $('map-hint');
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
    hint.textContent = text;
    show(hint, Boolean(text));
    show($('result-empty'), !state.route && $('route-error').hidden);
  }

  function flashHint(text) {
    var hint = $('map-hint');
    hint.textContent = text;
    show(hint, true);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { show(hint, false); }, 3500);
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
      show($('legend-heat'), state.heatOn);
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
    $('traffic-toggle').addEventListener('change', function (e) {
      trafficTouched = true;
      trafficOn = e.target.checked;
      syncTraffic();
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
    show($('hero'), false);
    $('hero').classList.remove('is-stale');
    show($('details'), false);
    show($('route-error'), false);
    localExposure = false;
    renderBadges();
    updateHint();
  }

  function showRouteError(message) {
    clearRouteResult();
    $('route-error-text').textContent = message;
    show($('route-error'), true);
    show($('result-empty'), false);
  }

  async function runRoute() {
    clearTimeout(routeTimer);
    if (!(state.start && state.end)) return;

    var request = routeRequest();
    var context = describeRequest();

    show($('route-error'), false);
    setBusy('route', true);
    $('hero').classList.add('is-stale');
    $('result').setAttribute('aria-busy', 'true');

    var data;
    try {
      data = await latest(routeChannel, '/api/route', jsonPost(request), ROUTE_TIMEOUT);
    } catch (e) {
      // Never leave old numbers on screen for settings they don't describe.
      $('result').removeAttribute('aria-busy');
      showRouteError(e.status === 400 ? e.message : 'Route failed: ' + e.message);
      return;
    }
    if (data === STALE) return;

    $('result').removeAttribute('aria-busy');
    setBusy('route', false);
    $('hero').classList.remove('is-stale');

    if (!data || !data.shortest || !data.clean || !Array.isArray(data.clean.coords)) {
      showRouteError('Route failed: the server response was incomplete.');
      return;
    }

    state.route = data;
    drawRoutes(data);
    renderResult(data, context);
    updateHint();
    if (state.lastSymptomText) runSymptoms(state.lastSymptomText);
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
    parts.push(groupsLabel());
    if (state.asthma) parts.push('Asthma on');
    return parts.join('. ') + '.';
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
    var airOnly = !same && pct <= 0;

    show($('hero'), true);
    show($('hero-gain'), !same);
    show($('hero-same'), same);
    if (same) {
      $('hero-same-detail').textContent = isNum(data.shortest.minutes)
        ? 'For these settings, ' + fmt(data.shortest.minutes, 1) + ' min with no cleaner option within the detour limit.'
        : 'For these settings, no cleaner option within the detour limit.';
    } else {
      $('hero-pct-value').textContent = airOnly ? 'Less traffic' : pct + '%';
      $('hero-pct-label').textContent = airOnly
        ? 'none of your trees on either route, so this one avoids major roads'
        : 'less estimated exposure from trees within 25 m';
      $('hero-time').textContent = extraTimeText(summary.extra_minutes);
      var wide = summary.reduction_within_100m_pct;
      $('hero-wide').textContent = !airOnly && isNum(wide) ? Math.round(wide) + '% if we count trees within 100 m' : '';

      // Out of season the percentage is a share of almost nothing, so it can't be the headline.
      var offSeason = !airOnly && Array.isArray(summary.in_season) && summary.in_season.length === 0;
      show($('hero-pct-value').parentNode, !offSeason);
      show($('hero-pct-label'), !offSeason);
      show($('hero-wide'), !offSeason);
      show($('hero-off-title'), offSeason);
      show($('hero-off-detail'), offSeason);
      if (offSeason) {
        $('hero-off-title').textContent = 'None of your trees are in season '
          + (state.monthOverride ? 'in ' + MONTHS[activeMonth() - 1] : 'this month');
        $('hero-off-detail').textContent = 'When they are, this route has ' + pct + '% less exposure';
      }
    }
    $('hero-context').textContent = context;

    renderCompare(data.shortest, data.clean, data.traffic_live === true);
    renderSpecies($('species-short'), data.shortest.top_species);
    renderSpecies($('species-clean'), data.clean.top_species);

    var hasExplanation = typeof data.explanation === 'string' && data.explanation.trim() !== '';
    $('explanation').textContent = hasExplanation ? data.explanation : '';
    show($('explanation-block'), hasExplanation);

    $('elastic-query').textContent = data.elastic_query
      ? JSON.stringify(data.elastic_query, null, 2)
      : 'No Elastic query for this route. The server did not return one.';

    show($('details'), true);

    localExposure = data.shortest.exposure_source === 'local' || data.clean.exposure_source === 'local';
    renderBadges();
  }

  function extraTimeText(minutes) {
    if (!isNum(minutes)) return 'Extra time unknown';
    var rounded = Math.round(minutes * 10) / 10;
    if (rounded > 0) return fmt(rounded, 1) + ' min longer';
    if (rounded < 0) return fmt(-rounded, 1) + ' min shorter';
    return 'No extra time';
  }

  function renderCompare(shortest, clean, trafficLive) {
    var rows = [
      ['Minutes', fmt(shortest.minutes, 1), fmt(clean.minutes, 1)],
      ['Exposure', fmt(shortest.exposure), fmt(clean.exposure)],
      ['Allergenic trees near', fmt(shortest.allergenic_trees_near), fmt(clean.allergenic_trees_near)],
      ['Major road share', fmtShare(shortest.major_road_share), fmtShare(clean.major_road_share)],
      ['Pollution zone share', fmtShare(shortest.pollution_zone_share), fmtShare(clean.pollution_zone_share)]
    ];
    if (trafficLive) {
      rows.push(['Time in heavy traffic', fmtShare(shortest.congested_share), fmtShare(clean.congested_share)]);
    }
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

  // ---- traffic layer ----

  var trafficLive = false;
  var trafficOn = false;
  var trafficTouched = false;
  var trafficFetchedAt = 0;

  function trafficVisible() { return trafficLive && trafficOn; }

  // Off the page entirely unless the feed is live. On by default for people with asthma.
  function syncTraffic() {
    if (!trafficTouched) trafficOn = state.asthma;
    $('traffic-toggle').checked = trafficOn;
    show($('traffic-switch'), trafficLive);
    show($('legend-traffic'), trafficVisible());
    show($('traffic-status'), trafficLive);
    setLayerVisible('traffic', trafficVisible());
  }

  function trafficClock(iso) {
    var when = new Date(iso);
    if (!iso || isNaN(when.getTime())) return '';
    return when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  }

  function endTraffic() {
    trafficLive = false;
    setMapData('traffic', emptyLines());
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
    var traffic = emptyLines();
    (Array.isArray(data.segments) ? data.segments : []).forEach(function (seg) {
      if (!seg || !Array.isArray(seg.c) || seg.c.length < 2 || !isNum(seg.level)) return;
      traffic.features.push(lineFeature(seg.c, { level: Math.max(0, Math.min(seg.level, 1)) }));
    });
    setMapData('traffic', traffic);
    var clock = trafficClock(data.updated);
    $('traffic-status').textContent = (clock ? 'Traffic updated ' + clock : 'Traffic') + (data.source ? ' \u00b7 ' + data.source : '');
    syncTraffic();
  }

  function renderLegendSteps() {
    [[$('legend-steps'), HEAT_COLORS], [$('traffic-steps'), TRAFFIC_COLORS]].forEach(function (pair) {
      pair[1].forEach(function (color) {
        var step = el('span');
        step.style.background = color;
        pair[0].appendChild(step);
      });
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
    }, locationFailed, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
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

  async function sendDestination(text) {
    setAskBusy(true);
    show($('transcript'), false);
    var data;
    try {
      data = await latest(askChannel, '/api/geocode', jsonPost({ text: text }), ROUTE_TIMEOUT);
      if (data !== STALE && !isPoint(data.point)) throw new Error('the server response was incomplete.');
    } catch (e) {
      // A sentence such as "from X to Y" isn't a place name, so it gets a second reading.
      if (e.status === 404 && text.split(/\s+/).length >= 4) {
        tryAsSentence(text, e.message);
        return;
      }
      setAskBusy(false);
      setStatus($('ask-status'), e.status === 404 ? e.message : "Couldn't look that up: " + e.message, true);
      return;
    }
    if (data === STALE) return;
    setAskBusy(false);

    setPoint('end', data.point);
    state.placeNames = 'To ' + (data.name || text);
    $('preset').value = '';
    updateHint();
    if (!state.start) {
      setStatus($('ask-status'), noStartMessage(), !state.locating);
      return;
    }
    fitOnNextRoute = true;
    runRoute();
  }

  async function tryAsSentence(text, notFound) {
    var data = null;
    try {
      data = await latest(askChannel, '/api/parse', jsonPost({ text: text }), ROUTE_TIMEOUT);
    } catch (_) {
      data = null;
    }
    if (data === STALE) return;
    setAskBusy(false);
    if (data && (isPoint(data.start) || isPoint(data.end))) applyParsed(data);
    else setStatus($('ask-status'), notFound, true);
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
      sendDestination(text);
    });
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
      scheduleRoute(0);
      return;
    }
    if (data === STALE) return;
    adoptProfile(data);
    state.profileDirty = false;
    renderProfileSummary();
    scheduleHeat(0);
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
      state.lastSymptomText = text;
      runSymptoms(text);
    });
  }

  async function runSymptoms(text) {
    var payload = { text: text };
    if (state.monthOverride) payload.month = state.monthOverride;
    var cleanCoords = state.route && state.route.clean && state.route.clean.coords;
    if (cleanCoords && cleanCoords.length) payload.coords = cleanCoords;

    setStatus($('symptom-status'), '');
    $('symptom-submit').disabled = true;
    var data;
    try {
      data = await latest(symptomChannel, '/api/symptoms', jsonPost(payload), ROUTE_TIMEOUT);
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
    renderSymptoms(data, Boolean(payload.coords));
  }

  function renderSymptoms(data, hasRoute) {
    var list = $('symptom-results');
    clearChildren(list);
    var suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!suggestions.length) {
      setStatus($('symptom-status'), 'No matching trees found for that description.');
    }
    suggestions.forEach(function (s) {
      var li = el('li', { className: 'suggestion' });
      var head = el('div', { className: 'suggestion-head' });
      head.appendChild(el('span', { className: 'suggestion-name', text: s.common || s.species || 'Unknown tree' }));
      if (hasRoute && isNum(s.trees_on_route)) {
        head.appendChild(el('span', {
          className: 'suggestion-count',
          text: plural(s.trees_on_route, 'tree') + ' on route'
        }));
      }
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
