(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CALM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var COLORS = ['#f4d83e', '#ffb224', '#ff7a1a', '#ff4a1c', '#ff1f1f'];
  var CIRCUMFERENCE = 326.7;
  var START = [37.7873, -122.4005], END = [37.7596, -122.4269];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function get(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, CALM ? 0 : ms); }); }

  function countTo(node, to, format, ms) {
    if (CALM) { node.textContent = format(to); return; }
    var began = performance.now();
    (function tick(now) {
      var t = Math.min((now - began) / (ms || 1400), 1);
      node.textContent = format(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    })(began);
  }
  var whole = function (v) { return Math.round(v).toLocaleString('en-US'); };
  var percent = function (v) { return Math.round(v) + '%'; };

  // ---- hero map ----
  function ramp(input, from) {
    var e = ['interpolate', ['linear'], input];
    COLORS.forEach(function (c, i) { e.push(from + (1 - from) * (i / (COLORS.length - 1)), c); });
    return e;
  }
  function metres() {
    var r = ['+', 25, ['*', 85, ['get', 'level']]];
    return ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', r, 1024 / 61880], 20, ['*', r, 1048576 / 61880]];
  }
  function lineString(coords) {
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map(function (c) { return [c[1], c[0]]; }) } };
  }
  function drawLine(map, source, coords, ms) {
    return new Promise(function (done) {
      if (CALM) { map.getSource(source).setData(lineString(coords)); done(); return; }
      var began = performance.now();
      (function tick(now) {
        var t = Math.min((now - began) / ms, 1);
        var eased = t * t * (3 - 2 * t);
        map.getSource(source).setData(lineString(coords.slice(0, Math.max(2, Math.ceil(coords.length * eased)))));
        if (t < 1) requestAnimationFrame(tick); else done();
      })(began);
    });
  }

  function startHero() {
    if (!window.maplibregl) return;
    var wide = window.innerWidth > 900;
    var map = new maplibregl.Map({
      container: 'hero-map', style: 'https://tiles.openfreemap.org/styles/dark',
      center: [-122.4116, 37.7746], zoom: wide ? 12.2 : 11.6, interactive: false, attributionControl: { compact: true }, fadeDuration: 0
    });
    map.once('style.load', function () {
      var layers = map.getStyle().layers;
      var lastShape = layers.reduce(function (at, l, i) {
        return l.id === 'building' || l.id.indexOf('highway_motorway') === 0 || l.id.indexOf('railway') === 0 ? i : at;
      }, -1);
      var labels = layers.find(function (l, i) { return i > lastShape && l.type === 'symbol'; });
      var below = labels ? labels.id : undefined;
      var empty = { type: 'FeatureCollection', features: [] };
      ['trees', 'traffic', 'short', 'clean'].forEach(function (id) { map.addSource(id, { type: 'geojson', data: empty }); });

      map.addLayer({ id: 'trees', type: 'circle', source: 'trees', paint: {
        'circle-radius': metres(), 'circle-color': ramp(['get', 'level'], 0), 'circle-opacity': 0, 'circle-opacity-transition': { duration: 1200 }
      } }, below);
      map.addLayer({ id: 'traffic', type: 'line', source: 'traffic', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ramp(['get', 'level'], 0.4), 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.4, 14, 3, 16, 5], 'line-opacity': 0, 'line-opacity-transition': { duration: 1200 }
      } }, below);
      function route(id, source, paint) {
        map.addLayer({ id: id, type: 'line', source: source, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: paint });
      }
      route('short-case', 'short', { 'line-color': '#0d0f12', 'line-width': 7 });
      route('short', 'short', { 'line-color': '#c9ced6', 'line-width': 3.5 });
      route('clean-glow', 'clean', { 'line-color': '#2ee6a6', 'line-width': 20, 'line-blur': 12, 'line-opacity': 0.55 });
      route('clean-case', 'clean', { 'line-color': '#07110d', 'line-width': 9 });
      route('clean', 'clean', { 'line-color': '#2ee6a6', 'line-width': 5.5 });

      var trees = get('/api/hotspots?month=4&groups=plane,olive,ash,privet');
      var traffic = get('/api/traffic');
      // Live traffic can leave a walk with no cleaner option, so try the next walk rather than show zeros.
      function firstCleaner(trips) {
        if (!trips.length) return Promise.reject(new Error('no cleaner walk right now'));
        return get('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: trips[0].start, end: trips[0].end, groups: ['plane', 'olive', 'ash', 'privet'], month: 4, asthma: true }) })
          .then(function (d) {
            if (d.summary.same_route || !(d.summary.exposure_reduction_pct > 0)) return firstCleaner(trips.slice(1));
            d.tripName = trips[0].name;
            return d;
          });
      }
      var walk = firstCleaner([
        { name: 'Venue to Dolores Park', start: START, end: END },
        { name: 'Oracle Park to Hayes Valley', start: [37.7786, -122.3893], end: [37.7760, -122.4240] },
        { name: 'Union Square to Alamo Square', start: [37.7879, -122.4074], end: [37.7764, -122.4346] },
        { name: 'Ferry Building to Civic Center', start: [37.7955, -122.3937], end: [37.7793, -122.4193] }
      ]);

      trees.then(function (d) {
        map.getSource('trees').setData({ type: 'FeatureCollection', features: d.cells.map(function (c) {
          return { type: 'Feature', properties: { level: c.level }, geometry: { type: 'Point', coordinates: [c.point[1], c.point[0]] } };
        }) });
        map.setPaintProperty('trees', 'circle-opacity', 0.62);
      }).catch(function () {});
      traffic.then(function (d) {
        map.getSource('traffic').setData({ type: 'FeatureCollection', features: (d.segments || []).filter(function (s) { return s.level >= 0.4; }).map(function (s) {
          return { type: 'Feature', properties: { level: s.level }, geometry: { type: 'LineString', coordinates: s.c.map(function (c) { return [c[1], c[0]]; }) } };
        }) });
        map.setPaintProperty('traffic', 'line-opacity', 0.9);
      }).catch(function () {});

      walk.then(function (d) {
        var all = d.clean.coords.concat(d.shortest.coords);
        var bounds = all.reduce(function (b, c) { return b.extend([c[1], c[0]]); }, new maplibregl.LngLatBounds([all[0][1], all[0][0]], [all[0][1], all[0][0]]));
        var pad = wide ? { top: 90, bottom: 90, left: Math.round(window.innerWidth * 0.52), right: 80 } : 40;
        map.fitBounds(bounds, { padding: pad, duration: CALM ? 0 : 2200, essential: true });
        return wait(1700).then(function () { return drawLine(map, 'short', d.shortest.coords, 1500); })
          .then(function () { return drawLine(map, 'clean', d.clean.coords, 2400); })
          .then(function () {
            var s = d.summary;
            $('hero-live').hidden = false;
            $('hero-note').textContent = d.tripName + ', planning for April, live traffic';
            $('hero-note').hidden = false;
            countTo($('live-pollen'), s.exposure_reduction_pct, percent);
            countTo($('live-air'), s.air_reduction_pct, percent);
            countTo($('live-min'), s.extra_minutes, function (v) { return '+' + v.toFixed(1); });
          });
      }).catch(function () {});
    });
  }

  // ---- charts, filled once and animated when their slide appears ----
  var stats = get('/api/stats');

  function runResults() {
    stats.then(function (s) {
      var e = s.evaluation, a = s.asthma;
      function gauge(key, share, text) {
        var g = document.querySelector('.gauge[data-key="' + key + '"]');
        g.querySelector('.arc').style.strokeDashoffset = CIRCUMFERENCE * (1 - share);
        countTo(g.querySelector('b'), text[0], text[1]);
      }
      gauge('pollen', e.median_reduction_pct / 100, [e.median_reduction_pct, percent]);
      gauge('air', a.median_air_reduction_pct / 100, [a.median_air_reduction_pct, percent]);
      gauge('time', e.median_extra_min / e.median_walk_min, [e.median_extra_min, function (v) { return '+' + v.toFixed(1); }]);
      $('pollen-100').textContent = 'trees within 25 m (' + percent(e.median_reduction_within_100m_pct) + ' within 100 m)';
      $('time-of').textContent = 'on a ' + e.median_walk_min.toFixed(1) + '-minute walk';
      $('results-fine').textContent = 'Medians: ' + e.walks + ' walks for pollen, ' + a.walks + ' for asthma, planning for April. Modelled exposure, not measured pollen or symptoms.';
      var box = $('versus');
      if (box.children.length) return;
      var top = Math.max(a.median_heavy_traffic_m[0], a.median_major_road_m[0]);
      [['Metres of heavy traffic', a.median_heavy_traffic_m], ['Metres of major road', a.median_major_road_m]].forEach(function (p) {
        var col = el('div');
        col.appendChild(el('div', 'vs-title', p[0]));
        [['Shortest', p[1][0], 'short'], ['Clean Route', p[1][1], '']].forEach(function (r) {
          var row = el('div', 'vs-row');
          row.appendChild(el('span', '', r[0]));
          var track = el('span');
          var fill = el('span', 'vs-fill ' + r[2]);
          track.appendChild(fill);
          row.appendChild(track);
          row.appendChild(el('b', '', whole(r[1])));
          col.appendChild(row);
          setTimeout(function () { fill.style.width = (r[1] / top * 100) + '%'; }, 60);
        });
        box.appendChild(col);
      });
    }).catch(function () {});
  }

  function waffle(box, share) {
    var on = Math.round(share * 100);
    if (!box.children.length) for (var n = 0; n < 100; n++) box.appendChild(el('i'));
    var cells = box.children;
    for (var i = 0; i < 100; i++) {
      (function (cell, lit, at) {
        if (lit) setTimeout(function () { cell.classList.add('on'); }, CALM ? 0 : at * 22);
      })(cells[99 - i], i < on, i);
    }
  }

  function runInsight() {
    stats.then(function (s) {
      if (!s.groups || !s.groups.length) return;
      var top = s.groups.slice(0, 4);
      var trees = top.reduce(function (t, d) { return t + d.tree_share; }, 0);
      var load = top.reduce(function (t, d) { return t + d.load_share; }, 0);
      $('insight-title').textContent = percent(trees * 100) + ' of trees. ' + percent(load * 100) + ' of the pollen.';
      $('waffle-trees-cap').replaceChildren(el('b', '', percent(trees * 100)), document.createTextNode('of all trees'));
      $('waffle-load-cap').replaceChildren(el('b', '', percent(load * 100)), document.createTextNode('of the pollen load'));
      waffle($('waffle-trees'), trees);
      waffle($('waffle-load'), load);
      var names = $('top-names');
      names.replaceChildren();
      top.forEach(function (d, i) {
        if (i) names.appendChild(document.createTextNode('  ·  '));
        names.appendChild(el('b', '', d.label));
      });
      var letters = 'JFMAMJJASOND';
      var months = $('months');
      if (!months.children.length) {
        s.months.forEach(function (v, i) {
          var col = el('div', 'col' + (i + 1 === s.today_month ? ' now' : ''));
          var bar = el('i');
          col.appendChild(bar);
          col.appendChild(el('span', '', letters[i]));
          months.appendChild(col);
          setTimeout(function () { bar.style.height = 'calc(' + (v * 100) + '% - 24px)'; }, CALM ? 0 : 200 + i * 70);
        });
      }
    }).catch(function () {});
  }

  // ---- Elastic diagram: a schematic of one street's geo_shape + sum ----
  var geoStarted = false;
  function runGeo() {
    if (geoStarted) return;
    geoStarted = true;
    var NS = 'http://www.w3.org/2000/svg', svg = $('geo');
    function add(tag, attrs, parent) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      (parent || svg).appendChild(n);
      return n;
    }
    [70, 160, 250].forEach(function (y) { add('line', { x1: 0, y1: y, x2: 560, y2: y, stroke: '#2d3035', 'stroke-width': 8 }); });
    [110, 250, 390, 500].forEach(function (x) { add('line', { x1: x, y1: 0, x2: x, y2: 320, stroke: '#2d3035', 'stroke-width': 8 }); });
    var buffer = add('rect', { x: 30, y: 120, width: 0, height: 80, rx: 40, fill: 'rgba(124,199,255,.16)', stroke: '#7cc7ff', 'stroke-width': 1.5 });
    add('line', { x1: 30, y1: 160, x2: 530, y2: 160, stroke: '#7cc7ff', 'stroke-width': 3, 'stroke-linecap': 'round' });
    var label = add('text', { x: 280, y: 34, 'text-anchor': 'middle', fill: '#f2f3f5', 'font-size': 20, 'font-weight': 700, 'font-family': 'ui-monospace, Menlo, monospace' });
    label.textContent = 'sum(weight)';
    label.style.opacity = 0;
    label.style.transition = 'opacity .3s';
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var dots = [];
    for (var i = 0; i < 90; i++) {
      var x = 20 + rnd() * 520, y = 54 + rnd() * 256;
      dots.push({ x: x, y: y, inside: Math.abs(y - 160) < 36 && x > 40 && x < 520, r: 4 + rnd() * 5, node: add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 4, fill: '#5a5f67' }) });
    }
    function frame(now) {
      var t = (now % 6500) / 4200;
      var p = Math.min(t, 1);
      buffer.setAttribute('width', (p * 500).toFixed(1));
      var edge = 30 + p * 500;
      label.style.opacity = t >= 1 ? 1 : 0;
      dots.forEach(function (d) {
        var lit = d.inside && d.x < edge;
        if (lit !== d.lit) {
          d.lit = lit;
          d.node.setAttribute('fill', lit ? '#ff7a1a' : '#5a5f67');
          d.node.setAttribute('r', lit ? d.r : 4);
        }
      });
      requestAnimationFrame(frame);
    }
    if (CALM) { buffer.setAttribute('width', 500); label.style.opacity = 1; dots.forEach(function (d) { if (d.inside) { d.node.setAttribute('fill', '#ff7a1a'); d.node.setAttribute('r', d.r); } }); return; }
    requestAnimationFrame(frame);
  }

  // ---- Mistral demo ----
  var SENTENCE = "I'm allergic to sycamore and olive, and I have asthma.";
  var RESULT = [['Plane tree', 'from "sycamore"'], ['Olive', ''], ['Ash', 'related to olive'], ['Privet', 'related to olive'], ['Asthma', 'avoids traffic too']];
  var demoRun = 0;
  async function runDemo() {
    var run = ++demoRun;
    while (run === demoRun) {
      var typed = $('typed'), parsed = $('parsed');
      typed.textContent = '';
      parsed.replaceChildren();
      if (CALM) typed.textContent = SENTENCE;
      else for (var i = 1; i <= SENTENCE.length && run === demoRun; i++) { typed.textContent = SENTENCE.slice(0, i); await wait(32); }
      await wait(350);
      for (var j = 0; j < RESULT.length && run === demoRun; j++) {
        var pill = el('div', 'pill', RESULT[j][0]);
        if (RESULT[j][1]) pill.appendChild(el('small', '', RESULT[j][1]));
        parsed.appendChild(pill);
        await wait(380);
      }
      if (CALM) return;
      await wait(4200);
    }
  }
  function runTrust() {
    Array.prototype.forEach.call($('trust').children, function (s) { s.style.width = s.dataset.w + '%'; });
  }

  // ---- slides ----
  var once = {
    how: function (s) { s.querySelectorAll('[data-count]').forEach(function (n) { countTo(n, +n.dataset.count, whole, 1700); }); },
    results: runResults,
    insight: runInsight,
    elastic: function (s) { runGeo(); s.querySelectorAll('[data-count]').forEach(function (n) { countTo(n, +n.dataset.count, whole); }); },
    mistral: function () { runDemo(); runTrust(); }
  };
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var dots = document.querySelector('.dots');
  slides.forEach(function (s) {
    var a = el('a');
    a.href = '#' + s.id;
    a.setAttribute('aria-label', s.id);
    dots.appendChild(a);
  });
  var current = 0;
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var s = e.target;
      current = slides.indexOf(s);
      Array.prototype.forEach.call(dots.children, function (d, i) { d.classList.toggle('on', i === current); });
      if (s.classList.contains('in')) return;
      s.classList.add('in');
      if (once[s.id]) once[s.id](s);
    });
  }, { threshold: 0.45 });
  slides.forEach(function (s) { seen.observe(s); });

  // Arrow keys, space and page keys step through slides when presenting.
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var step = { ArrowDown: 1, ArrowRight: 1, PageDown: 1, ' ': 1, ArrowUp: -1, ArrowLeft: -1, PageUp: -1 }[e.key];
    if (!step) return;
    var to = slides[Math.max(0, Math.min(slides.length - 1, current + step))];
    e.preventDefault();
    to.scrollIntoView({ behavior: CALM ? 'auto' : 'smooth' });
  });

  startHero();
})();
