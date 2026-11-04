"""Clean Route API."""
import json
import os
import re
import secrets
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests
from scipy.spatial import cKDTree
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi.middleware.gzip import GZipMiddleware

from backend.routing import LOW_ALLERGEN, Network, WALK_M_PER_MIN
from backend.traffic import TRAFFIC_INDEX, Traffic
from pipeline.config import (ALLERGENS_INDEX, CENTER, RADIUS_M, ROOT, SEGMENTS_INDEX, SMALL_MODEL, BUFFER_M, TREES_INDEX, VENUE, VOICE_MODEL, LARGE_MODEL,
                             es_client, has_elastic, has_mistral, mistral_client)
from pipeline.index_elastic import load_table
from pipeline.score_segments import buffer_polygon

PROFILES_INDEX = "cr_profiles"
PLACES_INDEX = "cr_places"
MONTH_RESIDUAL = 0.05
MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
LABELS = {"plane": "Plane tree", "olive": "Olive", "cypress": "Cypress and juniper", "pine": "Pine", "oak": "Oak", "elm": "Elm", "ash": "Ash",
          "maple": "Maple", "birch": "Birch", "alder": "Alder", "mulberry": "Mulberry", "privet": "Privet", "acacia": "Acacia", "eucalyptus": "Eucalyptus",
          "palm": "Palm", "poplar": "Poplar", "walnut": "Walnut", "sweetgum": "Sweetgum", "other_wind": "Other wind-pollinated"}
PLACES = {"33 new montgomery": (37.7873, -122.4005), "elastic office": (37.7873, -122.4005), "the venue": (37.7873, -122.4005),
          "ferry building": (37.7955, -122.3937), "dolores park": (37.7596, -122.4269), "civic center": (37.7793, -122.4193),
          "union square": (37.7880, -122.4075), "alamo square": (37.7764, -122.4346), "oracle park": (37.7786, -122.3893),
          "city hall": (37.7793, -122.4193), "chinatown": (37.7941, -122.4078), "mission dolores": (37.7643, -122.4269),
          "hayes valley": (37.7759, -122.4245), "powell station": (37.7844, -122.4079), "salesforce park": (37.7897, -122.3966),
          "16th street mission": (37.7650, -122.4194), "duboce park": (37.7690, -122.4332), "yerba buena gardens": (37.7848, -122.4023)}

TZ = ZoneInfo("America/Los_Angeles")
SYNC = {"at": None, "segments": 0}
app = FastAPI(title="Clean Route")
app.add_middleware(GZipMiddleware, minimum_size=2000)
NET = Network.load()
TRAFFIC = Traffic(NET)
POOL = ThreadPoolExecutor(6)


def current_month():
    return datetime.now(TZ).month
TABLE = load_table()
ALL_META = json.loads((ROOT / "data" / "allergens.json").read_text())


def bloom_by_group():
    """Tree-count-weighted set of months each group sheds pollen."""
    out = {}
    for a in TABLE.values():
        out.setdefault(a["allergen_group"], {"months": {}, "trees": 0, "level": 0})
        g = out[a["allergen_group"]]
        g["trees"] += a["trees"]
        g["level"] = max(g["level"], a["allergy_level"])
        for m in a["bloom_months"]:
            g["months"][m] = g["months"].get(m, 0) + a["trees"] * a["allergy_level"] ** 2
    return out


BLOOM = bloom_by_group()


def month_factor(group, month):
    g = BLOOM.get(group)
    if not g or not g["months"]:
        return MONTH_RESIDUAL
    peak = max(g["months"].values())
    share = g["months"].get(month, 0) / peak if peak else 0
    return max(share, MONTH_RESIDUAL)


def person_weights(groups, month):
    chosen = groups if groups else [g for g in BLOOM if g != LOW_ALLERGEN]
    return {g: month_factor(g, month) for g in chosen}


def require_elastic():
    if not has_elastic():
        raise HTTPException(503, "Elastic isn't configured")


def require_mistral():
    if not has_mistral():
        raise HTTPException(503, "Mistral isn't configured")


@lru_cache
def es():
    return es_client()


@lru_cache
def mistral():
    return mistral_client()


def fast_then_large(call):
    """Try the quick model with a short timeout, then fall back to Large, so a slow API can't hang the page."""
    try:
        return call(SMALL_MODEL, 8000)
    except Exception as e:
        print("small model failed:", type(e).__name__, str(e)[:120], flush=True)
    return call(LARGE_MODEL, 25000)


def text_of(message):
    """Mistral Large 4 can return thinking chunks, so keep only the text."""
    content = message.content
    if isinstance(content, str):
        return content.strip()
    return "".join(c.text for c in content if getattr(c, "type", "") == "text").strip()


# ---------- meta ----------
@app.get("/api/meta")
def meta():
    groups = [{"id": g, "label": LABELS.get(g, g), "trees": d["trees"], "level": d["level"], "bloom_months": sorted(d["months"])}
              for g, d in sorted(BLOOM.items(), key=lambda x: -x[1]["trees"]) if g != LOW_ALLERGEN]
    dlat = RADIUS_M / 111_320
    dlon = dlat / 0.79
    return {
        "center": CENTER,
        "bounds": [[CENTER[0] - dlat, CENTER[1] - dlon], [CENTER[0] + dlat, CENTER[1] + dlon]],
        "groups": groups,
        "presets": [
            {"name": "33 New Montgomery to Dolores Park", "start": list(VENUE), "end": list(PLACES["dolores park"])},
            {"name": "Ferry Building to Civic Center", "start": list(PLACES["ferry building"]), "end": list(PLACES["civic center"])},
            {"name": "Union Square to Alamo Square", "start": list(PLACES["union square"]), "end": list(PLACES["alamo square"])},
            {"name": "Oracle Park to Hayes Valley", "start": list(PLACES["oracle park"]), "end": list(PLACES["hayes valley"])},
        ],
        "today_month": current_month(),
        "traffic_live": TRAFFIC.live,
        "scores_synced": SYNC,
        "modes": {"elastic": has_elastic(), "mistral": has_mistral()},
        "data": {"trees": ALL_META["identified_trees"], "segments": len(NET.edges), "species_covered_pct": round(100 * ALL_META["covered_trees"] / ALL_META["identified_trees"], 1)},
    }


# ---------- routing ----------
class RouteRequest(BaseModel):
    start: list[float] = Field(min_length=2, max_length=2)
    end: list[float] = Field(min_length=2, max_length=2)
    groups: list[str] | None = None
    month: int | None = Field(default=None, ge=1, le=12)
    asthma: bool | None = None
    max_detour: float = Field(default=1.3, ge=1.0, le=2.0)
    profile_id: str | None = None


def route_query(coords, groups, metres=BUFFER_M):
    """The live query shown to judges: distinct trees around the whole route, summed inside Elastic."""
    step = max(1, len(coords) // 150)
    thin = coords[::step] + [coords[-1]]
    filters = [{"range": {"level": {"gte": 1}}},
               {"geo_shape": {"location": {"shape": buffer_polygon(thin, metres), "relation": "intersects"}}}]
    if groups:
        filters.append({"terms": {"allergen_group": groups}})
    else:
        filters.append({"bool": {"must_not": {"term": {"allergen_group": LOW_ALLERGEN}}}})
    return {
        "size": 0,
        "query": {"bool": {"filter": filters}},
        "aggs": {
            "by_group": {"terms": {"field": "allergen_group", "size": 25}, "aggs": {"weight": {"sum": {"field": "weight"}}}},
            "top_species": {"terms": {"field": "scientific", "size": 5, "order": {"weight": "desc"}}, "aggs": {"weight": {"sum": {"field": "weight"}}}},
        },
    }


def wide_exposure(coords, weights, groups, metres=100):
    """Sensitivity check: the same sum with trees up to 100 m from the route."""
    r = es().search(index=TREES_INDEX, **route_query(coords, groups, metres))
    return sum(b["weight"]["value"] * weights.get(b["key"], 0.0) for b in r["aggregations"]["by_group"]["buckets"])


def measure(coords, weights, groups):
    q = route_query(coords, groups)
    r = es().search(index=TREES_INDEX, **q)
    by = []
    exposure = 0.0
    for b in r["aggregations"]["by_group"]["buckets"]:
        factor = weights.get(b["key"], 0.0)
        w = b["weight"]["value"] * factor
        exposure += w
        by.append({"group": b["key"], "label": LABELS.get(b["key"], b["key"]), "weight": round(w, 1), "trees": b["doc_count"]})
    by.sort(key=lambda x: -x["weight"])
    top = []
    for b in r["aggregations"]["top_species"]["buckets"]:
        a = TABLE.get(b["key"], {})
        top.append({"species": b["key"], "common": a.get("common_name", b["key"]), "trees": b["doc_count"], "level": a.get("allergy_level", 0)})
    return {"exposure": round(exposure, 1), "exposure_source": "elastic", "allergenic_trees_near": r["hits"]["total"]["value"],
            "trees_near": r["hits"]["total"]["value"], "by_group": by, "top_species": top}, q


def sync_scores_from_elastic():
    """Load every street score from Elastic in one tiled _msearch. Routes read this snapshot, so search stays under a second."""
    dlat, dlon = (RADIUS_M + 200) / 111_320, (RADIUS_M + 200) / (111_320 * 0.79)
    north, south, west, east = CENTER[0] + dlat, CENTER[0] - dlat, CENTER[1] - dlon, CENTER[1] + dlon
    n = 5
    searches = []
    for i in range(n):
        for j in range(n):
            box = {"top_left": {"lat": north - (north - south) * i / n, "lon": west + (east - west) * j / n},
                   "bottom_right": {"lat": north - (north - south) * (i + 1) / n, "lon": west + (east - west) * (j + 1) / n}}
            searches += [{"index": SEGMENTS_INDEX}, {"size": 10000, "_source": ["scores"], "query": {"bool": {"filter": [{"range": {"total_weight": {"gt": 0}}}, {"geo_bounding_box": {"line": box}}]}}}]
    scores = {}
    for r in es().msearch(searches=searches)["responses"]:
        if "error" in r:
            raise RuntimeError(str(r["error"])[:200])
        for h in r["hits"]["hits"]:
            scores[h["_id"]] = h["_source"].get("scores", {})
    NET.scores = scores
    SYNC["at"] = datetime.now(TZ).isoformat()
    SYNC["segments"] = len(scores)
    print(f"synced {len(scores)} street scores from Elastic", flush=True)


def explain(s, c, summary, names, month, asthma=False):
    """Plain sentences built straight from Elastic's numbers, with no LLM arithmetic in the route path."""
    who = ", ".join(names) if isinstance(names, list) else names
    if c is s:
        return f"For {who} in {MONTHS[month]}, the shortest route is already the cleanest one we found."
    main = s["top_species"][0]["common"] if s["top_species"] else None
    text = f"In {MONTHS[month]}, this route passes {c['allergenic_trees_near']} trees that matter for {who}, compared with {s['allergenic_trees_near']} on the direct route, for {summary['extra_minutes']} more minutes."
    text += f" The main source on the direct route is {main}." if main else ""
    if asthma:
        text += f" It also has {summary['air_reduction_pct']}% less estimated traffic pollution and {round(c['major_road_share'] * 100)}% of the walk next to major roads, compared with {round(s['major_road_share'] * 100)}%."
    return text


@app.post("/api/route")
def route(req: RouteRequest):
    require_elastic()
    groups, asthma = req.groups, req.asthma
    if req.profile_id:
        p = read_profile(req.profile_id)
        groups = groups if groups is not None else (p["groups"] or None)
        asthma = asthma if asthma is not None else p["asthma"]
    asthma = bool(asthma)
    month = req.month or current_month()
    for label, point in (("start", req.start), ("destination", req.end)):
        if not NET.covers(point):
            raise HTTPException(400, f"That {label} is outside the area we cover, about 3 km around downtown SF.")
    weights = person_weights(groups, month)
    a, b = NET.nearest(req.start), NET.nearest(req.end)
    if a == b:
        raise HTTPException(400, "Start and end are the same point")
    short_path = NET.shortest(a, b)
    clean_path = NET.clean(a, b, weights, asthma, req.max_detour)
    short = NET.stats(short_path, weights) | {"coords": NET.coords(short_path)}
    clean = NET.stats(clean_path, weights) | {"coords": NET.coords(clean_path)}
    (m_short, _), (m_clean, q), wide_short, wide_clean = [f.result() for f in (
        POOL.submit(measure, short["coords"], weights, groups), POOL.submit(measure, clean["coords"], weights, groups),
        POOL.submit(wide_exposure, short["coords"], weights, groups), POOL.submit(wide_exposure, clean["coords"], weights, groups))]
    short |= m_short
    clean |= m_clean
    # Elastic's distinct-tree totals can disagree with the per-segment sum. Keep the shortest route if the "clean" one isn't really better.
    air_better = asthma and clean["air_exposure"] < short["air_exposure"]
    if clean["exposure"] >= short["exposure"] and not air_better:
        clean = short
    same = clean is short
    reduction = round(100 * (1 - clean["exposure"] / short["exposure"]), 1) if short["exposure"] > 0 else 0.0
    summary = {"extra_minutes": round((clean["length_m"] - short["length_m"]) / WALK_M_PER_MIN, 1),
               "extra_meters": round(clean["length_m"] - short["length_m"]), "exposure_reduction_pct": reduction, "same_route": same,
               "air_reduction_pct": round(100 * (1 - clean["air_exposure"] / short["air_exposure"]), 1) if short["air_exposure"] > 0 else 0.0,
               "in_season": [LABELS.get(g, g) for g in weights if month in BLOOM.get(g, {}).get("months", {})]}
    summary["reduction_within_100m_pct"] = round(100 * (1 - wide_clean / wide_short), 1) if wide_short > 0 else 0.0
    names = [LABELS.get(g, g) for g in groups] if groups else "all tree pollen"
    return {"shortest": short, "clean": clean, "summary": summary, "explanation": explain(short, clean, summary, names, month, asthma), "elastic_query": q, "traffic_live": TRAFFIC.live and asthma,
            "applied": {"groups": groups, "asthma": asthma, "month": month}}


@app.get("/api/segments")
def segments(month: int | None = None, groups: str | None = None, asthma: bool = False):
    chosen = [g for g in groups.split(",") if g] if groups else None
    weights = person_weights(chosen, month or current_month())
    rows, values = [], []
    for eid, e in NET.edges.items():
        x = NET.exposure(eid, weights)
        if x <= 0:
            continue
        v = x / max(e["length"], 15)
        values.append(v)
        rows.append({"c": [[round(p[0], 5), round(p[1], 5)] for p in e["coords"]], "e": round(v, 2)})
    values.sort()
    return {"segments": rows, "max": values[int(len(values) * 0.98)] if values else 1.0}


# ---------- voice and parsing ----------
class Understood(BaseModel):
    allergens_said: list[str] = Field(description="Allergens or trees the person named, in their words")
    groups: list[str] = Field(description="Allowed tree allergen groups that apply, including well-known cross-reactive tree groups")
    asthma: bool | None = Field(description="True or false if they said so, otherwise null")
    reasons: list[str] = Field(description="Short notes on any added cross-reactive group")
    not_covered: list[str] = Field(description="Things they named that street trees can't explain, like grass, ragweed, dust or cats")
    start_text: str | None = Field(description="Only the starting place name, a few words, or null")
    end_text: str | None = Field(description="Only the destination place name, a few words, or null")


def trip_places(text, start, end):
    """Prefer the person's literal words, and reject model output that isn't a short place name."""
    stop = r"(?=[,.;!?]|\s+(?:and|but|please|because|i\s|i'm)\b|$)"
    m = re.search(rf"\bfrom\s+(.+?)\s+to\s+(.+?){stop}", text, re.I)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.search(rf"\b(?:walk|walking|go|going|head|heading|take|get|route|directions?)\b[^.]*?\bto\s+((?:the\s+)?[A-Z0-9].+?){stop}", text)
    if m:
        end = m.group(1).strip()
    clean = lambda p: p.strip(" *.") if p and len(p) <= 50 and "\n" not in p else None
    return (clean(start), clean(end)) if re.search(r"\b(walk|walking|go|going|head|heading|take|get|route|directions?|from|to)\b", text.replace("allergic to", ""), re.I) else (None, None)


def understand(text):
    require_mistral()
    allowed = [g for g in BLOOM if g != LOW_ALLERGEN]
    r = fast_then_large(lambda model, timeout: mistral().chat.parse(model=model, timeout_ms=timeout, response_format=Understood, messages=[
        {"role": "system", "content": f"Extract health-profile and trip details from what a San Francisco walker says. Allowed groups: {', '.join(allowed)}. Use only those ids. Birch relates to alder; cypress family includes juniper and cedar. Olive relates to ash and privet. Add a cross-reactive group only if it is well established, and note why. If they say only 'pollen' or 'trees', return an empty groups list. Do not invent places."},
        {"role": "user", "content": text}]))
    u = r.choices[0].message.parsed
    u.groups = [g for g in u.groups if g in allowed]
    u.start_text, u.end_text = trip_places(text, u.start_text, u.end_text)
    return u


STREET_WORDS = re.compile(r"\s+(street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr)\.?$", re.I)
QUERY_FIXES = [(r"\bbldg\b", "building"), (r"\bbart\b", "station"), (r"\bmuni\b", "station"), (r"\bsf\b", "san francisco")]
ALIASES = {"sfmoma": "San Francisco Museum of Modern Art", "moma": "San Francisco Museum of Modern Art", "the mission": "Mission Dolores Park", "mission district": "16th Street Mission"}


def shorten_street(q):
    """"mission st" should also match the street named "Mission Street"."""
    for short, full in (("st", "street"), ("ave", "avenue"), ("blvd", "boulevard"), ("rd", "road"), ("dr", "drive")):
        q = re.sub(rf"\b{short}\.?$", full, q, flags=re.I)
    return q


def street_key(name):
    return STREET_WORDS.sub("", name.strip().lower())


def street_index():
    """Street name -> known points, from road edges and OSM addresses. Many SF roads have few named edges, so addresses fill the gaps."""
    points = {}
    for e in NET.edges.values():
        if e.get("name"):
            points.setdefault(street_key(e["name"]), []).extend(e["coords"])
    path = ROOT / "data" / "raw" / "places.json"
    if path.exists():
        for el in json.loads(path.read_text())["elements"]:
            street = el.get("tags", {}).get("addr:street")
            lat, lon = el.get("lat") or el.get("center", {}).get("lat"), el.get("lon") or el.get("center", {}).get("lon")
            if street and lat is not None:
                points.setdefault(street_key(street), []).append([lat, lon])
    return {k: np.array(v) * [1, 0.79] for k, v in points.items()}


def intersection(text):
    """The closest pair of known points on two streets, if they really come within 90 m of each other."""
    m = re.match(r"^\s*(.+?)\s+(?:and|at|&|\+)\s+(.+?)\s*$", text, re.I)
    if not m:
        return None
    a, b = STREETS.get(street_key(m.group(1))), STREETS.get(street_key(m.group(2)))
    if a is None or b is None:
        return None
    dist, nearest = cKDTree(b).query(a)
    i = int(dist.argmin())
    if dist[i] * 111_320 > 90:
        return None
    mid = (a[i] + b[nearest[i]]) / 2 / [1, 0.79]
    return {"name": f"{m.group(1).strip().title()} & {m.group(2).strip().title()}", "detail": "intersection", "point": [round(float(mid[0]), 6), round(float(mid[1]), 6)]}


LEADING_WORDS = re.compile(r"^\s*(?:please\s+)?(?:(?:take|walk|get|bring)\s+me\s+to|(?:go|walk|head|route|directions?)\s+to|to)\s+", re.I)


def search_places(text, near=None, size=6):
    """Typo-tolerant autocomplete over OSM places in Elastic, favouring exact names, landmarks and nearby results."""
    q = LEADING_WORDS.sub("", text).strip()
    q = ALIASES.get(q.lower(), q)
    q = re.sub(r"^the\s+", "", q, flags=re.I)
    if len(q) < 2:
        return []
    corner = intersection(q)
    if corner:
        return [corner]
    for pattern, fix in QUERY_FIXES:
        q = re.sub(pattern, fix, q, flags=re.I)
    origin = {"lat": near[0], "lon": near[1]} if near else {"lat": CENTER[0], "lon": CENTER[1]}
    fields = ["name", "name._2gram", "name._3gram", "alt", "alt._2gram", "alt._3gram"]
    query = {"function_score": {
        "query": {"bool": {"should": [
            {"term": {"name_exact": {"value": q.lower(), "boost": 60}}},
            {"term": {"name_exact": {"value": shorten_street(q).lower(), "boost": 60}}},
            {"match_phrase": {"name": {"query": q, "boost": 12}}},
            {"multi_match": {"query": q, "type": "bool_prefix", "fields": fields, "operator": "and", "boost": 4}},
            {"match_phrase_prefix": {"name": {"query": q, "boost": 20}}},
            {"multi_match": {"query": q, "fields": ["name", "alt"], "fuzziness": "AUTO:5,8", "prefix_length": 1, "operator": "and", "boost": 0.5}},
            {"match": {"category": {"query": q, "boost": 1}}},
        ], "minimum_should_match": 1, "must_not": [] if q[0].isdigit() else [{"term": {"category.keyword": "address"}}]}},
        "functions": [{"filter": {"term": {"landmark": True}}, "weight": 3}, {"filter": {"term": {"category.keyword": "street"}}, "weight": 1.5}, {"gauss": {"location": {"origin": origin, "scale": "2km", "decay": 0.6}}}],
        "score_mode": "multiply", "boost_mode": "multiply"}}
    hits = es().search(index=PLACES_INDEX, query=query, size=size * 2, source=["name", "detail", "location"])["hits"]["hits"]
    out, seen = [], set()
    for h in hits:
        d = h["_source"]
        point = [d["location"]["lat"], d["location"]["lon"]]
        if d["name"].lower() in seen or not NET.covers(point):
            continue
        seen.add(d["name"].lower())
        out.append({"name": d["name"], "detail": d.get("detail"), "point": point})
    return out[:size]


@lru_cache(maxsize=256)
def nominatim(place):
    """Fallback for addresses OSM's local data doesn't list. Raises on network errors so failures aren't cached."""
    r = requests.get("https://nominatim.openstreetmap.org/search", timeout=6, headers={"User-Agent": "clean-route-hackathon-demo"},
                     params={"q": f"{place}, San Francisco, CA", "format": "jsonv2", "limit": 1})
    r.raise_for_status()
    hits = r.json()
    return [float(hits[0]["lat"]), float(hits[0]["lon"])] if hits else None


def geocode(place, near=None):
    if not place:
        return None
    key = re.sub(r"^the\s+", "", place.lower().strip())
    for name, ll in PLACES.items():
        if key == name or (len(key) > 4 and (name in key or key in name)):
            return list(ll)
    if has_elastic():
        try:
            hits = search_places(place, near, size=1)
            if hits:
                return hits[0]["point"]
        except Exception as e:
            print("place search failed:", type(e).__name__, str(e)[:150], flush=True)
    try:
        point = nominatim(place)
        return point if point and NET.covers(point) else None
    except Exception as e:
        print("nominatim failed:", type(e).__name__, flush=True)
        return None


def transcribe(file_bytes, filename):
    require_mistral()
    r = mistral().audio.transcriptions.complete(model=VOICE_MODEL, file={"content": file_bytes, "file_name": filename})
    return r.text


class GeocodeRequest(BaseModel):
    text: str = Field(max_length=120)


@app.get("/api/places")
def places(q: str, lat: float | None = None, lon: float | None = None):
    require_elastic()
    return {"results": search_places(q[:120], [lat, lon] if lat is not None and lon is not None else None)}


@app.post("/api/geocode")
def geocode_place(req: GeocodeRequest):
    point = geocode(req.text.strip())
    if not point:
        raise HTTPException(404, f"Couldn't find {req.text.strip()} in the area we cover.")
    return {"point": point, "name": req.text.strip()}


class ParseRequest(BaseModel):
    text: str = Field(max_length=1000)


def parse_response(text):
    u = understand(text)
    return {"transcript": text, "groups": u.groups or None, "asthma": u.asthma, "reasons": u.reasons, "not_covered": u.not_covered,
            "start_text": u.start_text, "end_text": u.end_text, "start": geocode(u.start_text), "end": geocode(u.end_text)}


@app.post("/api/parse")
def parse(req: ParseRequest):
    return parse_response(req.text)


@app.post("/api/voice")
async def voice(file: UploadFile = File(...)):
    return parse_response(transcribe(await file.read(), file.filename or "clip.webm"))


# ---------- profiles ----------
class ProfileRequest(BaseModel):
    name: str = Field(default="", max_length=60)
    text: str | None = Field(default=None, max_length=1000)
    groups: list[str] | None = None
    asthma: bool | None = None


def ensure_profiles():
    if not es().indices.exists(index=PROFILES_INDEX):
        es().indices.create(index=PROFILES_INDEX, mappings={"properties": {
            "name": {"type": "keyword"}, "groups": {"type": "keyword"}, "asthma": {"type": "boolean"}, "reasons": {"type": "text"},
            "not_covered": {"type": "text"}, "raw_text": {"type": "text"}, "created_at": {"type": "date", "format": "epoch_second"}}})


def read_profile(pid):
    require_elastic()
    r = es().options(ignore_status=404).get(index=PROFILES_INDEX, id=pid)
    if not r.get("found"):
        raise HTTPException(404, "Profile not found")
    return r["_source"] | {"profile_id": pid}


def save_profile(pid, doc):
    ensure_profiles()
    es().index(index=PROFILES_INDEX, id=pid, document=doc, refresh="wait_for")
    return doc | {"profile_id": pid}


def new_profile(name, text, groups=None, asthma=None, transcript=None):
    reasons, missed = [], []
    if text:
        u = understand(text)
        groups, asthma, reasons, missed = u.groups, u.asthma, u.reasons, u.not_covered
    doc = {"name": name, "groups": groups or [], "asthma": bool(asthma), "reasons": reasons, "not_covered": missed, "raw_text": text or "", "created_at": int(time.time())}
    out = save_profile("p_" + secrets.token_hex(4), doc)
    if transcript:
        out["transcript"] = transcript
    return out


@app.post("/api/profile")
def create_profile(req: ProfileRequest):
    require_elastic()
    return new_profile(req.name, req.text, req.groups, req.asthma)


@app.post("/api/profile/voice")
async def create_profile_voice(file: UploadFile = File(...), name: str = Form("")):
    require_elastic()
    text = transcribe(await file.read(), file.filename or "clip.webm")
    return new_profile(name, text, transcript=text)


@app.get("/api/profile/{pid}")
def get_profile(pid: str):
    return read_profile(pid)


@app.put("/api/profile/{pid}")
def update_profile(pid: str, req: ProfileRequest):
    p = read_profile(pid)
    p.pop("profile_id")
    allowed = set(BLOOM)
    if req.groups is not None:
        p["groups"] = [g for g in req.groups if g in allowed]
    if req.asthma is not None:
        p["asthma"] = req.asthma
    if req.name:
        p["name"] = req.name
    return save_profile(pid, p)


# ---------- symptom search ----------
class SymptomRequest(BaseModel):
    text: str = Field(max_length=500)
    month: int | None = Field(default=None, ge=1, le=12)
    coords: list[list[float]] | None = None


MONTH_WORDS = {w: i + 1 for i, w in enumerate("january february march april may june july august september october november december".split())}
MONTH_WORDS.update({"spring": 4, "summer": 7, "fall": 10, "autumn": 10, "winter": 1})


def month_in_text(text):
    """'My eyes itch every March' is about March, even when it's typed in November."""
    for word in re.findall(r"[a-z]+", text.lower()):
        if word in MONTH_WORDS and word != "may":
            return MONTH_WORDS[word]
    return None


@app.post("/api/symptoms")
def symptoms(req: SymptomRequest):
    require_elastic()
    month = req.month or month_in_text(req.text) or current_month()
    body = {
        "size": 12,
        "_source": ["scientific", "common", "allergen_group", "level", "symptoms_text", "bloom_months", "trees"],
        "retriever": {"rrf": {"rank_window_size": 30, "retrievers": [
            {"standard": {"query": {"bool": {"must": {"multi_match": {"query": req.text, "fields": ["symptoms_text", "common", "rationale"]}},
                                             "should": {"term": {"bloom_months": month}}}}}},
            {"standard": {"query": {"semantic": {"field": "profile", "query": req.text}}}},
        ]}},
    }
    hits = es().search(index=ALLERGENS_INDEX, **body)["hits"]["hits"]
    counts = {}
    if req.coords and len(req.coords) > 1:
        q = route_query(req.coords, None)
        q["aggs"] = {"species": {"terms": {"field": "scientific", "size": 200}}}
        r = es().search(index=TREES_INDEX, **q)
        counts = {b["key"]: b["doc_count"] for b in r["aggregations"]["species"]["buckets"]}
    out = [{"species": h["_source"]["scientific"], "common": h["_source"]["common"], "group": h["_source"]["allergen_group"], "level": h["_source"]["level"],
            "why": h["_source"]["symptoms_text"], "trees_on_route": counts.get(h["_source"]["scientific"], 0), "score": round(h["_score"], 4),
            "in_season": month in (h["_source"].get("bloom_months") or [])} for h in hits]
    out.sort(key=lambda x: (not x["in_season"], -x["level"], -x["score"]))
    return {"suggestions": out, "note": "A suggestion, not a diagnosis. An allergist can test for specific pollens.", "elastic_query": body}


HOTSPOT_PRECISION = 17  # Fixed tiles of about 240 m here, so a place keeps the same circle at every zoom.


def tree_hotspots(month, groups):
    """Elastic grid aggregation: how much of this person's pollen load each block holds, and how much is in season."""
    filters = [{"range": {"level": {"gte": 2}}}]
    filters.append({"terms": {"allergen_group": groups}} if groups else {"bool": {"must_not": {"term": {"allergen_group": LOW_ALLERGEN}}}})
    query = {"size": 0, "query": {"bool": {"filter": filters}}, "aggs": {"cells": {
        "geotile_grid": {"field": "location", "precision": HOTSPOT_PRECISION, "size": 4000},
        "aggs": {"center": {"geo_centroid": {"field": "location"}},
                 "by_group": {"terms": {"field": "allergen_group", "size": 25}, "aggs": {"weight": {"sum": {"field": "weight"}}}}}}}}
    weights = person_weights(groups, month)
    buckets = es().search(index=TREES_INDEX, **query)["aggregations"]["cells"]["buckets"]
    loads = [sum(g["weight"]["value"] for g in b["by_group"]["buckets"]) for b in buckets]
    scale = sorted(loads)[int(len(loads) * 0.97)] if loads else 1.0
    cells = []
    for b, load in zip(buckets, loads):
        now = sum(g["weight"]["value"] * weights.get(g["key"], 0.0) for g in b["by_group"]["buckets"])
        c = b["center"]["location"]
        cells.append({"point": [round(c["lat"], 5), round(c["lon"], 5)], "count": b["doc_count"],
                      "level": round(min((load / scale) ** 0.5, 1.0), 3) if scale else 0.0,
                      "season": round(now / load, 3) if load else 0.0})
    return cells, query


@app.get("/api/hotspots")
def hotspots(month: int | None = None, groups: str | None = None):
    require_elastic()
    cells, query = tree_hotspots(month or current_month(), [g for g in groups.split(",") if g] if groups else None)
    return {"cells": cells, "query": query}


@app.get("/api/stats")
def site_stats():
    """Numbers for the landing page: the saved evaluations, plus live Elastic aggregations when Elastic is up."""
    data = ROOT / "data"
    out = {"evaluation": json.loads((data / "evaluation.json").read_text()), "asthma": json.loads((data / "evaluation_asthma.json").read_text()),
           "today_month": current_month(), "trees": None, "groups": [], "months": []}
    if not has_elastic():
        return out
    r = es().search(index=TREES_INDEX, size=0, track_total_hits=True, aggs={"by_group": {"terms": {"field": "allergen_group", "size": 25}, "aggs": {"weight": {"sum": {"field": "weight"}}}}})
    buckets = r["aggregations"]["by_group"]["buckets"]
    trees = r["hits"]["total"]["value"]
    total = sum(b["weight"]["value"] for b in buckets) or 1.0
    rated = sorted((b for b in buckets if b["key"] != LOW_ALLERGEN and b["weight"]["value"] > 0), key=lambda b: -b["weight"]["value"])
    by_month = [sum(b["weight"]["value"] * month_factor(b["key"], m) for b in rated) for m in range(1, 13)]
    peak = max(by_month) or 1.0
    out.update(trees=trees, months=[round(v / peak, 3) for v in by_month],
               groups=[{"id": b["key"], "label": LABELS.get(b["key"], b["key"]), "trees": b["doc_count"], "tree_share": round(b["doc_count"] / trees, 4),
                        "load_share": round(b["weight"]["value"] / total, 4)} for b in rated])
    return out


@app.get("/api/traffic")
def traffic():
    return TRAFFIC.status()


# ---------- air ----------
@lru_cache
def _air(bucket):
    a = requests.get("https://air-quality-api.open-meteo.com/v1/air-quality", timeout=8, params={"latitude": CENTER[0], "longitude": CENTER[1], "current": "pm2_5,nitrogen_dioxide,us_aqi"}).json()["current"]
    w = requests.get("https://api.open-meteo.com/v1/forecast", timeout=8, params={"latitude": CENTER[0], "longitude": CENTER[1], "current": "wind_speed_10m,wind_direction_10m"}).json()["current"]
    return {"pm2_5": a["pm2_5"], "nitrogen_dioxide": a["nitrogen_dioxide"], "us_aqi": a["us_aqi"], "wind_speed_10m": w["wind_speed_10m"], "wind_direction_10m": w["wind_direction_10m"], "time": a["time"], "source": "Open-Meteo"}


@app.get("/api/air")
def air():
    try:
        return _air(int(time.time() // 900))
    except Exception as e:
        raise HTTPException(502, f"Open-Meteo unavailable: {type(e).__name__}")


@app.on_event("startup")
def start_background_work():
    """Keep street scores synced with Elastic, and start the live traffic feed."""
    import threading

    def keep_synced():
        while True:
            if has_elastic():
                try:
                    sync_scores_from_elastic()
                except Exception as e:
                    print("score sync failed, keeping the last snapshot:", type(e).__name__, flush=True)
            time.sleep(600)

    threading.Thread(target=keep_synced, daemon=True).start()
    TRAFFIC.start()


STREETS = street_index()
frontend = Path(ROOT / "frontend")
if (frontend / "index.html").exists():
    app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
