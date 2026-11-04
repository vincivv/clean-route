(function () {
  'use strict';
  var COLORS = ['#f4d83e', '#ffb224', '#ff7a1a', '#ff4a1c', '#ff1f1f'];
  var MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var LAT = 37.7746, LON = -122.4116, SCALE = 300 / 3250, M_PER_DEG = 111320, COS = 0.7906;
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function x(lon) { return 300 + (lon - LON) * M_PER_DEG * COS * SCALE; }
  function y(lat) { return 300 - (lat - LAT) * M_PER_DEG * SCALE; }
  function svg(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    parent.appendChild(n);
    return n;
  }
  function pct(v) { return Math.round(v) + '%'; }
  function get(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function line(coords, attrs, parent) {
    var d = coords.map(function (c, i) { return (i ? 'L' : 'M') + x(c[1]).toFixed(1) + ' ' + y(c[0]).toFixed(1); }).join('');
    return svg('path', Object.assign({ d: d, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, attrs), parent);
  }

  // Tooltip
  var tip = $('tip');
  function tipped(node, text) {
    node.addEventListener('mousemove', function (e) {
      tip.textContent = text;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 270) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    node.addEventListener('mouseleave', function () { tip.hidden = true; });
    return node;
  }

  function row(name, value, share, cls, hover) {
    var r = el('div', 'bar-row');
    r.appendChild(el('span', 'bar-name', name));
    var track = el('span', 'bar-track');
    var fill = el('span', 'bar-fill' + (cls ? ' ' + cls : ''));
    fill.style.width = Math.max(share * 100, 0.5) + '%';
    track.appendChild(fill);
    r.appendChild(track);
    r.appendChild(el('span', 'bar-value', value));
    if (hover) tipped(r, hover);
    return r;
  }

  function renderResults(s) {
    var e = s.evaluation, a = s.asthma;
    var box = $('chart-reductions');
    box.appendChild(el('div', 'bar-row is-head', 'Pollen profile (' + e.walks + ' walks)'));
    box.appendChild(row('Pollen, trees within 25 m', pct(e.median_reduction_pct), e.median_reduction_pct / 100, '', 'Middle half of walks: ' + pct(e.p25) + ' to ' + pct(e.p75)));
    box.appendChild(row('Pollen, trees within 100 m', pct(e.median_reduction_within_100m_pct), e.median_reduction_within_100m_pct / 100));
    box.appendChild(el('div', 'bar-row is-head', 'Pollen plus asthma (' + a.walks + ' walks)'));
    box.appendChild(row('Traffic pollution', pct(a.median_air_reduction_pct), a.median_air_reduction_pct / 100, '', 'Our own estimated score, not measured emissions'));
    box.appendChild(row('Pollen, trees within 25 m', pct(a.median_pollen_reduction_pct), a.median_pollen_reduction_pct / 100));
    box.appendChild(row('Pollen, trees within 100 m', pct(a.median_pollen_reduction_100m_pct), a.median_pollen_reduction_100m_pct / 100));
    $('note-reductions').textContent = 'Costs about ' + e.median_extra_min.toFixed(1) + ' extra minutes on a ' + e.median_walk_min.toFixed(1) + '-minute walk (' + a.median_extra_min.toFixed(1) + ' with asthma on).';

    var air = $('chart-air');
    var top = Math.max(a.median_heavy_traffic_m[0], a.median_major_road_m[0]);
    [['Heavy traffic', a.median_heavy_traffic_m], ['Major road', a.median_major_road_m]].forEach(function (p) {
      air.appendChild(el('div', 'bar-row is-head', p[0]));
      air.appendChild(row('Shortest', Math.round(p[1][0]) + ' m', p[1][0] / top, 'short'));
      air.appendChild(row('Clean Route', Math.round(p[1][1]) + ' m', p[1][1] / top));
    });
    $('note-air').textContent = 'Live TomTom traffic, measured at 6:54 PM on Nov 3. ' + a.walks_with_more_heavy_traffic + ' of ' + a.walks + ' walks did get more heavy traffic, and ' + a.walks_with_more_major_road + ' more major road.';

    if (s.groups && s.groups.length) {
      if (s.trees) $('stat-trees').textContent = s.trees.toLocaleString('en-US');
      var g = $('chart-groups');
      var most = s.groups[0].load_share;
      var four = s.groups.slice(0, 4).reduce(function (t, d) { return [t[0] + d.tree_share, t[1] + d.load_share]; }, [0, 0]);
      $('note-groups').textContent = 'The top 4 groups are ' + Math.round(four[0] * 100) + '% of trees but ' + Math.round(four[1] * 100) + '% of total pollen load, live from Elastic. Load is allergy level squared times trunk diameter.';
      s.groups.slice(0, 8).forEach(function (d) {
        g.appendChild(row(d.label, Math.round(d.load_share * 100) + '%', d.load_share / most, '', d.trees.toLocaleString('en-US') + ' trees, ' + (d.tree_share * 100).toFixed(1) + '% of all trees'));
      });
    }
    if (s.months && s.months.length) {
      var box2 = $('chart-months');
      s.months.forEach(function (v, i) {
        var col = el('div', 'col' + (i + 1 === s.today_month ? ' is-now' : ''));
        var bar = el('i');
        bar.style.height = 'calc(' + (v * 100) + '% - 26px)';
        col.appendChild(bar);
        col.appendChild(el('span', '', MONTHS[i]));
        tipped(col, MONTH_NAMES[i] + ': ' + Math.round(v * 100) + '% of peak' + (i + 1 === s.today_month ? ' (now)' : ''));
        box2.appendChild(col);
      });
    }
  }

  function renderHero() {
    var map = $('hero-map');
    var trees = svg('g', {}, map), traffic = svg('g', {}, map), route = svg('g', {}, map);
    get('/api/hotspots?month=4').then(function (d) {
      d.cells.forEach(function (c) {
        svg('circle', {
          cx: x(c.point[1]).toFixed(1), cy: y(c.point[0]).toFixed(1), r: ((25 + 85 * c.level) * SCALE).toFixed(1),
          fill: COLORS[Math.min(Math.floor(c.level * 5), 4)], opacity: 0.72
        }, trees);
      });
    }).catch(function () {});
    get('/api/traffic').then(function (d) {
      (d.segments || []).forEach(function (s) {
        if (s.level < 0.4) return;
        line(s.c, { stroke: COLORS[Math.min(Math.floor((s.level - 0.4) / 0.6 * 5), 4)], 'stroke-width': 1.3 }, traffic);
      });
    }).catch(function () {});
    get('/api/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: [37.7873, -122.4005], end: [37.7596, -122.4269], groups: ['plane', 'olive'], month: 4, asthma: true })
    }).then(function (d) {
      line(d.shortest.coords, { stroke: '#101214', 'stroke-width': 6 }, route);
      line(d.shortest.coords, { stroke: '#c9ced6', 'stroke-width': 3 }, route);
      line(d.clean.coords, { stroke: '#101214', 'stroke-width': 7 }, route);
      line(d.clean.coords, { stroke: '#2ee6a6', 'stroke-width': 4 }, route);
      var s = d.summary;
      $('hero-caption').textContent = '33 New Montgomery to Dolores Park, planning for April: ' + pct(s.exposure_reduction_pct) + ' less pollen, ' + pct(s.air_reduction_pct) + ' less traffic pollution, +' + s.extra_minutes.toFixed(1) + ' min. Live right now.';
    }).catch(function () {});
  }

  renderHero();
  get('/api/stats').then(renderResults).catch(function () {
    $('note-reductions').textContent = "Couldn't load the results.";
  });
})();
