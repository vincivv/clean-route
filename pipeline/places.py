"""Index SF places in Elastic from OpenStreetMap, for typo-tolerant search and autocomplete."""
import json
import math
import re
import sys

import requests
from elasticsearch import helpers

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import CENTER, GRAPH_JSON, RADIUS_M, RAW, es_client

PLACES_INDEX = "cr_places"
PLACES_JSON = RAW / "places.json"
SHORT = [(r"\bStreet\b", "St"), (r"\bAvenue\b", "Ave"), (r"\bBoulevard\b", "Blvd"), (r"\bDrive\b", "Dr"), (r"\bRoad\b", "Rd"), (r"\bPlace\b", "Pl"), (r"\bSaint\b", "St"), (r"\bSquare\b", "Sq")]
LANDMARK = {"attraction", "museum", "park", "stadium", "theatre", "library", "townhall", "station", "university", "college", "hospital", "garden", "viewpoint", "plaza", "ferry_terminal"}


def download():
    pad = RADIUS_M + 300
    dlat, dlon = pad / 111_320, pad / (111_320 * math.cos(math.radians(CENTER[0])))
    box = f"{CENTER[0] - dlat},{CENTER[1] - dlon},{CENTER[0] + dlat},{CENTER[1] + dlon}"
    tags = ["amenity", "shop", "tourism", "leisure", "office", "historic", "public_transport", "railway", "building", "place", "landuse", "man_made"]
    parts = "".join(f'nwr["name"]["{t}"]({box});' for t in tags) + f'nwr["addr:housenumber"]["addr:street"]({box});'
    query = f"[out:json][timeout:150];({parts});out center tags;"
    for host in ("https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://lz4.overpass-api.de/api/interpreter"):
        try:
            r = requests.post(host, data={"data": query}, timeout=200, headers={"User-Agent": "clean-route-hackathon"})
            r.raise_for_status()
            json.loads(r.text)
            PLACES_JSON.write_text(r.text)
            print("downloaded from", host)
            return
        except (requests.RequestException, ValueError) as e:
            print("failed", host, type(e).__name__)
    raise RuntimeError("No Overpass server answered")


def shorten(name):
    for pattern, short in SHORT:
        name = re.sub(pattern, short, name)
    return name


def docs():
    seen = set()
    for e in json.loads(PLACES_JSON.read_text())["elements"]:
        t = e.get("tags", {})
        lat, lon = e.get("lat") or e.get("center", {}).get("lat"), e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        address = f"{t['addr:housenumber']} {t['addr:street']}" if "addr:housenumber" in t and "addr:street" in t else None
        name = t.get("name") or address
        category = next((t[k] for k in ("tourism", "amenity", "leisure", "shop", "public_transport", "railway", "historic", "office", "place", "man_made") if k in t), "address" if not t.get("name") else "building")
        key = (name.lower(), round(lat, 3), round(lon, 3))
        if not name or key in seen:
            continue
        seen.add(key)
        yield {"name": name, "alt": " ".join(x for x in (shorten(name), address, shorten(address) if address else None, t.get("alt_name"), t.get("short_name")) if x),
               "category": category.replace("_", " "), "landmark": category in LANDMARK, "detail": address if t.get("name") and address else category.replace("_", " "), "location": {"lat": lat, "lon": lon}}
    # Streets from the walking network, placed at their middle segment.
    streets = {}
    for e in json.loads(GRAPH_JSON.read_text())["edges"]:
        if e["name"]:
            streets.setdefault(e["name"], []).append(e["coords"][len(e["coords"]) // 2])
    for name, points in streets.items():
        mid = sorted(points)[len(points) // 2]
        yield {"name": name, "alt": shorten(name), "category": "street", "landmark": False, "detail": "street", "location": {"lat": mid[0], "lon": mid[1]}}


def index():
    es = es_client()
    es.options(ignore_status=404).indices.delete(index=PLACES_INDEX)
    es.indices.create(index=PLACES_INDEX, mappings={"properties": {
        "name": {"type": "search_as_you_type"}, "name_exact": {"type": "keyword"}, "alt": {"type": "search_as_you_type"}, "category": {"type": "text"},
        "detail": {"type": "keyword", "index": False}, "landmark": {"type": "boolean"}, "location": {"type": "geo_point"}}})
    ok, errors = helpers.bulk(es, ({"_index": PLACES_INDEX, "_source": d | {"name_exact": d["name"].lower()}} for d in docs()), chunk_size=3000, raise_on_error=False)
    es.indices.refresh(index=PLACES_INDEX)
    print("places indexed", ok, "errors", len(errors), str(errors[:1])[:200] if errors else "")


if __name__ == "__main__":
    if not PLACES_JSON.exists():
        download()
    index()
