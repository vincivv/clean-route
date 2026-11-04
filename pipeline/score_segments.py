"""Elastic does the math: score every walkable street segment with geo_shape + terms + sum aggregations."""
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from elasticsearch import helpers
from shapely.geometry import LineString, Polygon, mapping

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import BUFFER_M, GRAPH_JSON, SEGMENTS_INDEX, SEGMENTS_JSON, TREES_INDEX, ZONE_INDEX, CENTER, CACHE, es_client

MLAT = 111_320
MLON = 111_320 * math.cos(math.radians(CENTER[0]))
BATCH = 150
MAJOR = {"primary", "primary_link", "secondary", "secondary_link", "trunk", "trunk_link", "motorway_link"}
MEDIUM = {"tertiary", "tertiary_link"}


def buffer_polygon(coords_latlon, metres=BUFFER_M):
    """Buffer in local metres, then return a GeoJSON polygon in lon/lat."""
    line = LineString([((lon - CENTER[1]) * MLON, (lat - CENTER[0]) * MLAT) for lat, lon in coords_latlon])
    poly = line.buffer(metres, quad_segs=2).simplify(2)
    if poly.geom_type != "Polygon":
        poly = poly.convex_hull
    ring = [(x / MLON + CENTER[1], y / MLAT + CENTER[0]) for x, y in poly.exterior.coords]
    return {"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring]]}


def query_for(polygon):
    return {
        "size": 0,
        "track_total_hits": False,
        "query": {"bool": {"filter": [
            {"range": {"level": {"gte": 1}}},
            {"geo_shape": {"location": {"shape": polygon, "relation": "intersects"}}},
        ]}},
        "aggs": {"by_group": {"terms": {"field": "allergen_group", "size": 25}, "aggs": {"weight": {"sum": {"field": "weight"}}}}},
    }


def score_batch(es, batch):
    searches = []
    for e in batch:
        searches += [{"index": TREES_INDEX}, query_for(buffer_polygon(e["coords"]))]
    for attempt in range(4):
        try:
            responses = es.msearch(searches=searches, request_timeout=120)["responses"]
            break
        except Exception as ex:
            print("retry", attempt, type(ex).__name__, str(ex)[:150])
            time.sleep(2 * (attempt + 1))
    else:
        raise RuntimeError("msearch failed")
    out = []
    for e, r in zip(batch, responses):
        if "error" in r:
            raise RuntimeError(str(r["error"])[:400])
        groups = {b["key"]: {"w": round(b["weight"]["value"], 1), "n": b["doc_count"]} for b in r["aggregations"]["by_group"]["buckets"]}
        out.append((e["id"], groups))
    return out


def in_zone_ids(es):
    ids, after = set(), None
    while True:
        body = {
            "size": 5000, "_source": False, "sort": [{"segment_id": "asc"}],
            "query": {"geo_shape": {"line": {"indexed_shape": {"index": ZONE_INDEX, "id": "apez", "path": "geometry"}, "relation": "intersects"}}},
        }
        if after:
            body["search_after"] = after
        hits = es.search(index=SEGMENTS_INDEX, **body)["hits"]["hits"]
        if not hits:
            return ids
        ids.update(h["_id"] for h in hits)
        after = hits[-1]["sort"]


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    es = es_client()
    graph = json.loads(GRAPH_JSON.read_text())
    edges = graph["edges"][:limit] if limit else graph["edges"]
    batches = [edges[i:i + BATCH] for i in range(0, len(edges), BATCH)]
    t = time.time()
    scores = {}
    with ThreadPoolExecutor(6) as pool:
        for i, result in enumerate(pool.map(lambda b: score_batch(es, b), batches)):
            scores.update(result)
            if i % 10 == 0:
                print(f"{len(scores)}/{len(edges)} in {time.time() - t:.0f}s", flush=True)
    print(f"scored {len(scores)} segments in {time.time() - t:.0f}s via _msearch")

    es.options(ignore_status=404).indices.delete(index=SEGMENTS_INDEX)
    es.indices.create(index=SEGMENTS_INDEX, mappings={"properties": {
        "segment_id": {"type": "keyword"}, "name": {"type": "text"}, "highway": {"type": "keyword"},
        "length_m": {"type": "float"}, "line": {"type": "geo_shape"}, "total_weight": {"type": "float"},
        "scores": {"type": "object", "dynamic": True}}})
    def docs():
        for e in edges:
            g = scores.get(e["id"], {})
            yield {"_index": SEGMENTS_INDEX, "_id": e["id"], "_source": {
                "segment_id": e["id"], "name": e["name"], "highway": e["highway"], "length_m": e["length"],
                "line": {"type": "LineString", "coordinates": [[lon, lat] for lat, lon in e["coords"]]},
                "total_weight": sum(v["w"] for v in g.values()), "scores": {k: v["w"] for k, v in g.items()}}}
    ok, errs = helpers.bulk(es, docs(), chunk_size=2000, raise_on_error=False, request_timeout=180)
    print("segments indexed", ok, "errors", len(errs), str(errs[:1])[:300] if errs else "")
    es.indices.refresh(index=SEGMENTS_INDEX)

    zone = in_zone_ids(es)
    print("segments in pollution zone", len(zone))
    CACHE.mkdir(exist_ok=True, parents=True)
    SEGMENTS_JSON.write_text(json.dumps({"scores": {k: {g: v["w"] for g, v in s.items()} for k, s in scores.items()}, "zone": sorted(zone)}))
    print("cached", SEGMENTS_JSON)


if __name__ == "__main__":
    main()
