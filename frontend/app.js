(function () {
  'use strict';

  var FALLBACK_CENTER = [37.7746, -122.4116];
  var FALLBACK_BOUNDS = [[37.747, -122.446], [37.802, -122.377]];
  var MAX_DETOUR = 1.3;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // One-hue-family sequential scale, light to dark. Green is reserved for the clean route.
  var HEAT_COLORS = ['#f7d9a8', '#f5c282', '#f2a65a', '#ec8a3c', '#de6a26', '#c44e1c', '#9c3614', '#6f230c'];
  var HEAT_WEIGHTS = [1, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
  var ROUTE_TIMEOUT = 30000;
  var VOICE_TIMEOUT = 60000;
  var RECORD_LIMIT = 30000;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    meta: null,
    groups: null, // null means every group
    month: 3,
    asthma: false,
    heatOn: true,
    start: null,
    end: null,
    placeNames: null,
    route: null,
    lastSymptomText: null,
    profile: null,
    profileDirty: false // true when local edits couldn't be saved to the server
  };

  var map, startMarker, endMarker, heatLines = [], heatGroup, routeLayers;
  var routeTimer, heatTimer, hintTimer;
  var fitOnNextRoute = false;
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
  var profileChannel = newChannel();

  // ---- map ----

  function initMap() {
    map = L.map('map', { center: FALLBACK_CENTER, zoom: 13, zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    fitHome();
    addTiles();

    map.createPane('heat');
    map.getPane('heat').style.zIndex = 350;
    map.getPane('heat').style.pointerEvents = 'none';

    // One canvas, one path per colour step: a stroke per bucket rather than per street,
    // and no hit testing, so 20,000 segments stay smooth to pan and zoom.
    var renderer = L.canvas({ pane: 'heat', padding: 0.25 });
    heatGroup = L.layerGroup();
    HEAT_COLORS.forEach(function (color, i) {
      var line = L.polyline([], {
        renderer: renderer,
        pane: 'heat',
        color: color,
        weight: HEAT_WEIGHTS[i],
        opacity: 0.95,
        interactive: false,
        smoothFactor: 1
      });
      heatLines.push(line);
      heatGroup.addLayer(line);
    });
    heatGroup.addTo(map);

    routeLayers = L.layerGroup().addTo(map);

    map.on('click', onMapClick);
    $('map').classList.add('picking');

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        map.invalidateSize();
        if (homePending) fitHome();
      }).observe($('map'));
    }
  }

  // A hidden tab or pane has no size, and fitting to that zooms out to the whole world.
  // Wait for a real size before fitting.
  function fitHome() {
    var size = map.getSize();
    homePending = !(size.x > 0 && size.y > 0);
    if (!homePending) map.fitBounds(homeBounds);
  }

  function addTiles() {
    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    var errors = 0;
    var loaded = 0;
    tiles.on('tileload', function () {
      loaded += 1;
      setStatus($('tile-status'), '');
    });
    tiles.on('tileerror', function () {
      errors += 1;
      if (errors >= 6 && loaded === 0) {
        setStatus($('tile-status'), "Map background didn't load. Check the network.", true);
      }
    });
  }

  function pinIcon(letter) {
    return L.divIcon({
      className: '',
      html: '<div class="marker-pin">' + letter + '</div>', // static letter, never server text
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
  }

  function placeMarker(which, point) {
    var marker = which === 'start' ? startMarker : endMarker;
    if (!point) {
      if (marker) map.removeLayer(marker);
      if (which === 'start') startMarker = null; else endMarker = null;
      return;
    }
    if (marker) {
      marker.setLatLng(point);
      return;
    }
    marker = L.marker(point, {
      icon: pinIcon(which === 'start' ? 'A' : 'B'),
      draggable: true,
      autoPan: true,
      title: which === 'start' ? 'Start. Drag to move.' : 'End. Drag to move.',
      alt: which === 'start' ? 'Start' : 'End',
      zIndexOffset: 1000
    }).addTo(map);
    marker.on('dragend', function () {
      var ll = marker.getLatLng();
      state[which] = [ll.lat, ll.lng];
      forgetPlaceNames();
      runRoute();
    });
    if (which === 'start') startMarker = marker; else endMarker = marker;
  }

  function setPoint(which, point) {
    state[which] = point;
    placeMarker(which, point);
  }

  function forgetPlaceNames() {
    state.placeNames = null;
    $('preset').value = '';
  }

  function onMapClick(e) {
    if (!$('onboarding').hidden) return;
    var point = [e.latlng.lat, e.latlng.lng];
    if (!state.start) {
      setPoint('start', point);
      forgetPlaceNames();
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
    $('map').classList.toggle('picking', !(state.start && state.end));
    show($('clear-route'), Boolean(state.start || state.end));
    if (!state.start) {
      hint.textContent = 'Click the map to set your start';
      show(hint, true);
    } else if (!state.end) {
      hint.textContent = 'Now click to set your end';
      show(hint, true);
    } else {
      show(hint, false);
    }
    show($('result-empty'), !state.route && !(state.start && state.end));
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

  function syncBloomNote() {
    var note = $('bloom-note');
    var groups = (state.meta && state.meta.groups) || [];
    if (!groups.length) { note.textContent = ''; return; }
    var month = MONTHS[state.month - 1];
    var mine = state.groups
      ? groups.filter(function (g) { return state.groups.indexOf(g.id) >= 0; })
      : groups;
    var inBloom = mine.filter(function (g) {
      return Array.isArray(g.bloom_months) && g.bloom_months.indexOf(state.month) >= 0;
    }).map(function (g) { return g.label; });
    if (inBloom.length) {
      note.textContent = (state.groups ? 'Your trees in bloom in ' : 'In bloom in ') + month + ': ' + inBloom.join(', ');
    } else {
      note.textContent = state.groups
        ? 'None of your trees are listed in bloom in ' + month + '.'
        : 'Nothing listed in bloom in ' + month + '.';
    }
  }

  function syncMonth() {
    var slider = $('month');
    slider.value = String(state.month);
    var name = MONTHS[state.month - 1];
    $('month-value').textContent = name;
    slider.setAttribute('aria-valuetext', name);
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
    $('month').addEventListener('input', function (e) {
      state.month = Number(e.target.value);
      syncMonth();
      controlsChanged();
    });
    $('asthma').addEventListener('change', function (e) {
      state.asthma = e.target.checked;
      controlsChanged();
    });
    $('heat-toggle').addEventListener('change', function (e) {
      state.heatOn = e.target.checked;
      if (state.heatOn) {
        heatGroup.addTo(map);
        show($('legend-heat'), true);
        scheduleHeat(0);
      } else {
        clearTimeout(heatTimer);
        cancel(heatChannel);
        map.removeLayer(heatGroup);
        show($('legend-heat'), false);
        setStatus($('heat-status'), '');
        show($('heat-retry'), false);
      }
    });
    $('preset').addEventListener('change', function (e) {
      if (e.target.value === '') return;
      var presets = (state.meta && state.meta.presets) || [];
      var preset = presets[Number(e.target.value)];
      if (!preset || !isPoint(preset.start) || !isPoint(preset.end)) return;
      setPoint('start', preset.start);
      setPoint('end', preset.end);
      state.placeNames = preset.name;
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
    setPoint('start', null);
    setPoint('end', null);
    forgetPlaceNames();
    clearRouteResult();
    updateHint();
  }

  // Remove every trace of the current route, including anything still on its way.
  function clearRouteResult() {
    clearTimeout(routeTimer);
    cancel(routeChannel);
    state.route = null;
    routeLayers.clearLayers();
    show($('hero'), false);
    show($('details'), false);
    show($('route-error'), false);
    setStatus($('route-status'), '');
    localExposure = false;
    renderBadges();
    updateHint();
  }

  async function runRoute() {
    clearTimeout(routeTimer);
    if (!(state.start && state.end)) return;

    var request = routeRequest();
    var context = describeRequest();

    show($('route-error'), false);
    show($('result-empty'), false);
    setStatus($('route-status'), 'Finding routes...');
    $('hero').classList.add('is-stale');
    $('result').setAttribute('aria-busy', 'true');

    var data;
    try {
      data = await latest(routeChannel, '/api/route', jsonPost(request), ROUTE_TIMEOUT);
    } catch (e) {
      // Never leave old numbers on screen for settings they don't describe.
      clearRouteResult();
      show($('result-empty'), false);
      $('route-error-text').textContent = 'Route failed: ' + e.message;
      show($('route-error'), true);
      $('result').removeAttribute('aria-busy');
      return;
    }
    if (data === STALE) return;

    $('result').removeAttribute('aria-busy');
    setStatus($('route-status'), '');
    $('hero').classList.remove('is-stale');

    if (!data || !data.shortest || !data.clean || !Array.isArray(data.clean.coords)) {
      clearRouteResult();
      show($('result-empty'), false);
      $('route-error-text').textContent = 'Route failed: the server response was incomplete.';
      show($('route-error'), true);
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
      month: state.month,
      max_detour: MAX_DETOUR
    };
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
    parts.push(MONTHS[state.month - 1]);
    parts.push(groupsLabel());
    if (state.asthma) parts.push('Asthma on');
    return parts.join('. ') + '.';
  }

  function drawRoutes(data) {
    routeLayers.clearLayers();
    var shortest = data.shortest.coords || [];
    var clean = data.clean.coords || [];
    [
      { coords: shortest, color: '#ffffff', weight: 8, opacity: 0.9 },
      { coords: shortest, color: '#5b636d', weight: 5, opacity: 1 },
      { coords: clean, color: '#ffffff', weight: 10, opacity: 0.95 },
      { coords: clean, color: '#0b7a3b', weight: 7, opacity: 1 }
    ].forEach(function (s) {
      if (s.coords.length < 2) return;
      routeLayers.addLayer(L.polyline(s.coords, {
        color: s.color,
        weight: s.weight,
        opacity: s.opacity,
        interactive: false,
        lineCap: 'round',
        lineJoin: 'round'
      }));
    });
    if (fitOnNextRoute) {
      fitOnNextRoute = false;
      var pts = shortest.concat(clean);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
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
    }
    $('hero-context').textContent = context;

    renderCompare(data.shortest, data.clean);
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

  function renderCompare(shortest, clean) {
    var rows = [
      ['Minutes', fmt(shortest.minutes, 1), fmt(clean.minutes, 1)],
      ['Exposure', fmt(shortest.exposure), fmt(clean.exposure)],
      ['Allergenic trees near', fmt(shortest.allergenic_trees_near), fmt(clean.allergenic_trees_near)],
      ['Major road share', fmtShare(shortest.major_road_share), fmtShare(clean.major_road_share)],
      ['Pollution zone share', fmtShare(shortest.pollution_zone_share), fmtShare(clean.pollution_zone_share)]
    ];
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
    params.set('month', String(state.month));
    if (state.groups) params.set('groups', state.groups.join(','));
    params.set('asthma', state.asthma ? 'true' : 'false');

    show($('heat-retry'), false);
    setStatus($('heat-status'), 'Updating street layer...');

    var data;
    try {
      data = await latest(heatChannel, '/api/segments?' + params.toString(), {}, ROUTE_TIMEOUT);
    } catch (e) {
      // Drop old colours: they describe different settings.
      heatLines.forEach(function (line) { line.setLatLngs([]); });
      setStatus($('heat-status'), 'Street layer failed: ' + e.message, true);
      show($('heat-retry'), true);
      return;
    }
    if (data === STALE) return;

    var segments = Array.isArray(data.segments) ? data.segments : [];
    var hottest = drawHeat(segments, data.max);
    if (!segments.length) {
      setStatus($('heat-status'), 'No street data for these settings.');
    } else if (hottest <= 0) {
      setStatus($('heat-status'), 'No estimated exposure on any street for these settings.');
    } else {
      setStatus($('heat-status'), '');
    }
  }

  function drawHeat(segments, max) {
    var steps = HEAT_COLORS.length;
    var buckets = HEAT_COLORS.map(function () { return []; });
    var scale = isNum(max) && max > 0 ? max : 0;
    var hottest = 0;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || !Array.isArray(seg.c) || seg.c.length < 2) continue;
      var e = isNum(seg.e) ? seg.e : 0;
      if (e > hottest) hottest = e;
      var ratio = scale ? Math.min(e / scale, 1) : 0;
      var step = Math.min(Math.floor(ratio * steps), steps - 1);
      buckets[Math.max(step, 0)].push(seg.c);
    }
    heatLines.forEach(function (line, n) { line.setLatLngs(buckets[n]); });
    return hottest;
  }

  function renderLegendSteps() {
    var box = $('legend-steps');
    HEAT_COLORS.forEach(function (color) {
      var step = el('span');
      step.style.background = color;
      box.appendChild(step);
    });
  }

  // ---- voice and text ----

  function setAskBusy(text) {
    setStatus($('ask-status'), text);
    $('ask-submit').disabled = Boolean(text);
  }

  async function sendAsk(path, opts, timeout, busyText) {
    setAskBusy(busyText);
    var data;
    try {
      data = await latest(askChannel, path, opts, timeout);
    } catch (e) {
      $('ask-submit').disabled = false;
      setStatus($('ask-status'), "Couldn't read that: " + e.message + ' The controls and map still work.', true);
      return;
    }
    if (data === STALE) return;
    $('ask-submit').disabled = false;
    applyParsed(data);
  }

  function defaultStart() {
    var presets = (state.meta && state.meta.presets) || [];
    return presets[0] && isPoint(presets[0].start) ? presets[0].start : null;
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

    // Asked for a destination only, so walk from the default point. Pin A shows where that is.
    if (isPoint(data.end) && !state.start && !data.start_text && defaultStart()) {
      setPoint('start', defaultStart());
      notes.push('Starting from pin A. Drag it to change.');
    }

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
        problems.push(state.start ? 'Click the map to set the end.' : "We didn't catch a place. Try again, or click the map.");
      }
    }

    setAskBusy('');
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
      sendAsk('/api/parse', jsonPost({ text: text }), ROUTE_TIMEOUT, 'Finding that place...');
    });
    makeMic({
      button: $('mic'),
      label: $('mic-label'),
      note: $('mic-note'),
      onAudio: function (blob, filename) {
        var form = new FormData();
        form.append('file', blob, filename);
        sendAsk('/api/voice', { method: 'POST', body: form }, VOICE_TIMEOUT, 'Listening back to what you said...');
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
    map.invalidateSize();
    syncMode();
    scheduleHeat(0);
    scheduleRoute(0);
    $('ask-input').focus();
  }

  function openRegister(message) {
    show($('ob-ask'), true);
    show($('ob-confirm'), false);
    show($('ob-error'), false);
    setStatus($('ob-status'), message || '', Boolean(message));
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
    setStatus($('ob-save-status'), state.profileDirty ? "These changes aren't saved yet." : '', state.profileDirty);
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
    setStatus($('ob-save-status'), 'Saving...');
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
        setStatus($('ob-save-status'), "Couldn't save: " + e.message + ' Your changes still apply to this visit.', true);
        return false;
      }
      if (data === STALE) return true;
      state.profileDirty = false;
      if (!putTimer) {
        adoptProfile(data);
        renderConfirm();
      }
      setStatus($('ob-save-status'), putTimer ? 'Saving...' : 'Saved');
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
    setStatus($('ob-status'), busyText);
    $('ob-submit').disabled = true;
    var data;
    try {
      data = await latest(profileChannel, path, opts, timeout);
      if (data !== STALE && !isProfile(data)) throw new Error('the server response was incomplete.');
    } catch (e) {
      $('ob-submit').disabled = false;
      setStatus($('ob-status'), '');
      $('ob-error-text').textContent = "Couldn't save your profile: " + e.message;
      show($('ob-error'), true);
      return;
    }
    if (data === STALE) return;
    $('ob-submit').disabled = false;
    setStatus($('ob-status'), '');
    storeSet(data.profile_id);
    show($('profile-error'), false);
    state.profileDirty = false;
    adoptProfile(data);
    openConfirm(data.transcript || data.raw_text, true);
  }

  function requireName() {
    var name = $('ob-name').value.trim();
    if (name) return name;
    setStatus($('ob-status'), 'Add your name first.', true);
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
        setStatus($('ob-status'), 'Tell us what you are allergic to, or press Speak.', true);
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
    var payload = { text: text, month: state.month };
    var cleanCoords = state.route && state.route.clean && state.route.clean.coords;
    if (cleanCoords && cleanCoords.length) payload.coords = cleanCoords;

    setStatus($('symptom-status'), 'Searching tree records...');
    var data;
    try {
      data = await latest(symptomChannel, '/api/symptoms', jsonPost(payload), ROUTE_TIMEOUT);
    } catch (e) {
      clearChildren($('symptom-results'));
      show($('symptom-note'), false);
      setStatus($('symptom-status'), 'Symptom search failed: ' + e.message, true);
      return;
    }
    if (data === STALE) return;
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
      if (Array.isArray(meta.bounds) && isPoint(meta.bounds[0]) && isPoint(meta.bounds[1]) && !state.route) {
        homeBounds = meta.bounds;
        fitHome();
      }
    } catch (e) {
      $('meta-error-text').textContent = "Couldn't load allergen data: " + e.message;
      show($('meta-error'), true);
    }
  }

  // ---- start ----

  function boot() {
    if (!window.L) {
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
    loadMeta();
    loadAir();
    setInterval(loadAir, 600000);

    var savedId = storeGet();
    if (savedId) {
      loadProfile(savedId);
    } else {
      syncMode();
      openRegister();
    }
  }

  boot();
})();
