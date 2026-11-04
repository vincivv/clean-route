"""Live street congestion from TomTom vector flow tiles, matched onto the walking network."""
import hashlib
import math
import os
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import mapbox_vector_tile
import numpy as np
import requests
from dotenv import load_dotenv
from elasticsearch import helpers
from shapely import STRtree
from shapely.geometry import LineString, Point

from pipeline.config import CENTER, RADIUS_M, ROOT, es_client, has_elastic

ZOOM = 14
REFRESH_S = 300
MATCH_M = 18
SHOW_FROM = 0.25  # Free-flowing streets stay off the map so real congestion stands out.
TRAFFIC_INDEX = "cr_traffic"
LAYER = "Traffic flow"
TZ = ZoneInfo("America/Los_Angeles")
MLAT = 111_320
MLON = 111_320 * math.cos(math.radians(CENTER[0]))
URL = "https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf"


def to_tile(lat, lon, z=ZOOM):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y)


def covering_tiles():
    dlat, dlon = RADIUS_M / MLAT, RADIUS_M / MLON
    x0, y0 = to_tile(CENTER[0] + dlat, CENTER[1] - dlon)
    x1, y1 = to_tile(CENTER[0] - dlat, CENTER[1] + dlon)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def tile_point(x, y, px, py, extent):
    n = 2 ** ZOOM
    lon = (x + px / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1 - py / extent) / n))))
    return [round(lat, 6), round(lon, 6)]


def decode_tile(data, x, y):
    """Return [(coords, congestion)], where congestion is 0 when free-flowing and 1 at a standstill."""
    layers = mapbox_vector_tile.decode(data)
    layer = layers.get(LAYER) or next(iter(layers.values()), None)
    if not layer:
        return []
    extent = layer.get("extent", 4096)
    out = []
    for f in layer["features"]:
        ratio = f["properties"].get("traffic_level")
        if ratio is None or f["properties"].get("road_closure"):
            continue  # A closed road has no cars on it, so it adds no congestion.
        g = f["geometry"]
        parts = {"LineString": [g["coordinates"]], "MultiLineString": g["coordinates"]}.get(g["type"], [])
        for part in parts:
            if len(part) >= 2:
                out.append(([tile_point(x, y, p[0], p[1], extent) for p in part], round(1 - min(max(float(ratio), 0.0), 1.0), 2)))
    return out


class Traffic:
    def __init__(self, net):
        self.net = net
        self.lines = []
        self.by_edge = {}
        self.updated = None
        self.error = "No TOMTOM_API_KEY set"
        ids = list(net.edges)
        self.edge_ids = ids
        self.edge_points = np.array([self._xy(net.edges[i]["coords"][len(net.edges[i]["coords"]) // 2]) for i in ids])

    @staticmethod
    def _xy(p):
        return ((p[1] - CENTER[1]) * MLON, (p[0] - CENTER[0]) * MLAT)

    @property
    def live(self):
        return self.updated is not None and time.time() - self.updated.timestamp() < 3 * REFRESH_S

    def status(self):
        if self.live:
            return {"live": True, "updated": self.updated.isoformat(), "source": "TomTom", "segments": [{"c": c, "level": lv} for c, lv in self.lines if lv >= SHOW_FROM]}
        return {"live": False, "source": None, "segments": [], "reason": self.error}

    def fetch(self, key):
        lines = []
        tiles = covering_tiles()
        failures = 0
        for x, y in tiles:
            r = requests.get(URL.format(z=ZOOM, x=x, y=y), params={"key": key}, timeout=15)
            if r.status_code == 200:
                lines += decode_tile(r.content, x, y)
            elif r.status_code != 204:
                failures += 1
                self.error = f"TomTom returned {r.status_code}"
        if failures == len(tiles):
            raise RuntimeError(self.error)
        return lines

    def match(self, lines):
        """Give each walking edge the worst congestion on any road line within MATCH_M metres."""
        if not lines:
            return {}
        geoms = [LineString([self._xy(p) for p in c]) for c, _ in lines]
        levels = np.array([lv for _, lv in lines])
        tree = STRtree(geoms)
        pts = [Point(*p) for p in self.edge_points]
        pi, gi = tree.query(pts, predicate="dwithin", distance=MATCH_M)
        worst = np.zeros(len(pts))
        np.maximum.at(worst, pi, levels[gi])
        return {self.edge_ids[i]: float(worst[i]) for i in np.nonzero(worst)[0]}

    def store(self, lines, stamp):
        if not has_elastic():
            return
        es = es_client()
        mapping = es.options(ignore_status=404).indices.get_mapping(index=TRAFFIC_INDEX)
        if "point" not in mapping.get(TRAFFIC_INDEX, {}).get("mappings", {}).get("properties", {}):
            es.options(ignore_status=404).indices.delete(index=TRAFFIC_INDEX)
            es.indices.create(index=TRAFFIC_INDEX, mappings={"properties": {"line": {"type": "geo_shape"}, "point": {"type": "geo_point"}, "congestion": {"type": "float"}, "updated": {"type": "date"}, "source": {"type": "keyword"}}})
        docs = ({"_index": TRAFFIC_INDEX, "_id": hashlib.md5(str(c).encode()).hexdigest(), "_source": {
            "line": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in c]}, "point": {"lat": c[len(c) // 2][0], "lon": c[len(c) // 2][1]},
            "congestion": lv, "updated": stamp.isoformat(), "source": "TomTom"}} for c, lv in lines)
        ok, errors = helpers.bulk(es, docs, chunk_size=2000, raise_on_error=False)
        print(f"traffic: stored {ok} lines in Elastic, {len(errors)} errors", str(errors[:1])[:300] if errors else "", flush=True)

    def refresh(self, key):
        lines = self.fetch(key)
        self.by_edge = self.match(lines)
        self.lines = lines
        self.updated = datetime.now(TZ)
        self.net.congestion = self.by_edge
        print(f"traffic: {len(lines)} lines, {len(self.by_edge)} walking edges matched", flush=True)
        try:
            self.store(lines, self.updated)
        except Exception as e:  # Routing still works if the Elastic copy fails.
            print("traffic: Elastic store failed", type(e).__name__, str(e)[:200], flush=True)

    def loop(self):
        while True:
            load_dotenv(ROOT / ".env", override=True)
            key = os.getenv("TOMTOM_API_KEY", "").strip()
            if not key:
                time.sleep(15)
                continue
            try:
                self.refresh(key)
                time.sleep(REFRESH_S)
            except Exception as e:
                self.error = f"Traffic refresh failed: {type(e).__name__}"
                print(self.error, str(e)[:200].replace(key, "***"), flush=True)
                time.sleep(60)

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()
