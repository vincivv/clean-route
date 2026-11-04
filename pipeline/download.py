"""Download real data: SF street trees, the Air Pollutant Exposure Zone and the OSM walking graph."""
import json
import math
import sys

import osmnx as ox
import requests
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import APEZ_JSON, CENTER, GRAPH_JSON, RADIUS_M, RAW, TREES_JSON


def bbox():
    pad = RADIUS_M + 100
    dlat = pad / 111_320
    dlon = pad / (111_320 * math.cos(math.radians(CENTER[0])))
    return CENTER[0] - dlat, CENTER[1] - dlon, CENTER[0] + dlat, CENTER[1] + dlon


def trees():
    s, w, n, e = bbox()
    rows, offset = [], 0
    while True:
        r = requests.get(
            "https://data.sf.gov/resource/tkzw-k3nq.json",
            params={
                "$select": "treeid,species,dbh,latitude,longitude,qaddress,legalstatus".replace("dbh", "mapdbh").replace(",qaddress", ""),
                "$where": f"latitude between {s} and {n} and longitude between {w} and {e}",
                "$limit": 50000,
                "$offset": offset,
                "$order": "treeid",
            },
            timeout=90,
        )
        r.raise_for_status()
        page = r.json()
        rows += page
        offset += len(page)
        if len(page) < 50000:
            break
    TREES_JSON.write_text(json.dumps(rows))
    print("trees", len(rows))


def apez():
    r = requests.get("https://data.sf.gov/resource/t65d-x6p8.json", timeout=90)
    r.raise_for_status()
    geom = shape(r.json()[0]["the_geom"])
    print("apez valid", geom.is_valid, "area", round(geom.area, 5), "points", len(mapping(geom)["coordinates"]))
    geom = make_valid(geom).simplify(0.00005)
    if geom.geom_type == "GeometryCollection":
        from shapely.geometry import MultiPolygon

        geom = MultiPolygon([g for g in geom.geoms if g.geom_type in ("Polygon",)] + [p for g in geom.geoms if g.geom_type == "MultiPolygon" for p in g.geoms])
    APEZ_JSON.write_text(json.dumps(mapping(geom)))
    print("apez", geom.geom_type, "valid", geom.is_valid)


def graph():
    G = ox.graph_from_point(CENTER, dist=RADIUS_M, network_type="walk", simplify=True)
    G = ox.convert.to_undirected(G)
    nodes = {str(n): [d["y"], d["x"]] for n, d in G.nodes(data=True)}
    edges = []
    for u, v, k, d in G.edges(keys=True, data=True):
        geom = d.get("geometry")
        coords = [[y, x] for x, y in geom.coords] if geom is not None else [nodes[str(u)], nodes[str(v)]]
        hw = d.get("highway", "")
        hw = hw[0] if isinstance(hw, list) else hw
        name = d.get("name", "")
        name = name[0] if isinstance(name, list) else name
        edges.append({"id": f"{u}-{v}-{k}", "u": str(u), "v": str(v), "length": float(d["length"]), "highway": hw, "name": name, "coords": coords})
    GRAPH_JSON.write_text(json.dumps({"nodes": nodes, "edges": edges}))
    print("graph nodes", len(nodes), "edges", len(edges))


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    trees()
    apez()
    graph()
