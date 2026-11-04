"""Measure asthma routes on the running server's live traffic. Results change with the time of day."""
import json
import math
import random
import statistics
from datetime import datetime
from pathlib import Path

import requests

N = 100
nodes = json.loads(Path("data/raw/graph.json").read_text())["nodes"]
ids = sorted(nodes)
random.seed(11)
rows, times = [], []
while len(rows) < N:
    a, b = random.sample(ids, 2)
    s, e = nodes[a], nodes[b]
    if not 800 <= math.hypot((s[0] - e[0]) * 111_320, (s[1] - e[1]) * 88_000) <= 3500:
        continue
    r = requests.post("http://localhost:8000/api/route", json={"start": s, "end": e, "groups": ["plane", "olive"], "month": 4, "asthma": True}, timeout=30)
    if r.status_code != 200:
        continue
    times.append(r.elapsed.total_seconds())
    j = r.json()
    metres = lambda route, key: route["length_m"] * route[key]
    rows.append({"air": j["summary"]["air_reduction_pct"], "pollen": j["summary"]["exposure_reduction_pct"], "wide": j["summary"]["reduction_within_100m_pct"], "extra": j["summary"]["extra_minutes"],
                 "heavy_short": metres(j["shortest"], "congested_share"), "heavy_clean": metres(j["clean"], "congested_share"), "major_short": metres(j["shortest"], "major_road_share"), "major_clean": metres(j["clean"], "major_road_share"), "live": j["traffic_live"]})
med = lambda k: round(statistics.median(x[k] for x in rows), 1)
out = {"walks": N, "measured_at": datetime.now().isoformat(timespec="minutes"), "traffic_live": all(x["live"] for x in rows), "median_air_reduction_pct": med("air"), "median_pollen_reduction_pct": med("pollen"),
       "median_pollen_reduction_100m_pct": med("wide"), "median_extra_min": med("extra"), "median_heavy_traffic_m": [med("heavy_short"), med("heavy_clean")], "median_major_road_m": [med("major_short"), med("major_clean")],
       "walks_with_more_heavy_traffic": sum(x["heavy_clean"] > x["heavy_short"] + 1 for x in rows), "walks_with_more_major_road": sum(x["major_clean"] > x["major_short"] + 1 for x in rows),
       "median_route_seconds": round(statistics.median(times), 2)}
print(json.dumps(out, indent=1))
Path("data/evaluation_asthma.json").write_text(json.dumps(out, indent=1))
