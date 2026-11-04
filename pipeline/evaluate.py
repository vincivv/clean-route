"""Measure the demo number: estimated exposure saved across random real walks, via the live API code and Elastic."""
import json
from pathlib import Path
import random
import statistics
import sys

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from fastapi.testclient import TestClient

from backend.app import NET, app

N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
MONTH = int(sys.argv[2]) if len(sys.argv) > 2 else 4
random.seed(7)
client = TestClient(app)
results = []
ids = NET.node_ids
while len(results) < N:
    a, b = random.sample(ids, 2)
    start, end = NET.nodes[a], NET.nodes[b]
    d = ((start[0] - end[0]) ** 2 + ((start[1] - end[1]) * 0.79) ** 2) ** 0.5 * 111_320
    if not 800 <= d <= 3500:
        continue
    r = client.post("/api/route", json={"start": start, "end": end, "groups": None, "month": MONTH, "asthma": False, "max_detour": 1.3})
    r.raise_for_status()
    j = r.json()
    results.append({"reduction": j["summary"]["exposure_reduction_pct"], "wide": j["summary"]["reduction_within_100m_pct"], "extra_min": j["summary"]["extra_minutes"], "short_min": j["shortest"]["minutes"]})
red = [x["reduction"] for x in results]
out = {
    "walks": N, "month": MONTH, "median_reduction_pct": round(statistics.median(red), 1), "p25": round(statistics.quantiles(red, n=4)[0], 1), "p75": round(statistics.quantiles(red, n=4)[2], 1),
    "median_reduction_within_100m_pct": round(statistics.median(x["wide"] for x in results), 1),
    "median_extra_min": round(statistics.median(x["extra_min"] for x in results), 1), "median_walk_min": round(statistics.median(x["short_min"] for x in results), 1),
    "share_changed": round(sum(1 for x in red if x > 0) / N, 2),
}
print(json.dumps(out, indent=1))
Path("data/evaluation.json").write_text(json.dumps(out, indent=1))
