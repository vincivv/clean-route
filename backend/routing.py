"""Exposure-aware routing over the OSM walking graph, using scores Elastic computed per street segment."""
import json
import math
from dataclasses import dataclass, field

import networkx as nx
from scipy.spatial import cKDTree

from pipeline.config import CENTER, GRAPH_JSON, SEGMENTS_JSON
from pipeline.score_segments import MAJOR, MEDIUM

WALK_M_PER_MIN = 80.0
LOW_ALLERGEN = "low_allergen"
MLON = math.cos(math.radians(CENTER[0]))
ALPHAS = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2]


def road_penalty(highway: str) -> float:
    if highway in MAJOR:
        return 0.6
    if highway in MEDIUM:
        return 0.25
    return 0.0


@dataclass
class Network:
    graph: nx.Graph = field(default_factory=nx.Graph)
    edges: dict = field(default_factory=dict)
    scores: dict = field(default_factory=dict)
    zone: set = field(default_factory=set)
    node_ids: list = field(default_factory=list)
    nodes: dict = field(default_factory=dict)
    tree: cKDTree | None = None

    @classmethod
    def load(cls):
        data = json.loads(GRAPH_JSON.read_text())
        seg = json.loads(SEGMENTS_JSON.read_text()) if SEGMENTS_JSON.exists() else {"scores": {}, "zone": []}
        net = cls(scores=seg["scores"], zone=set(seg["zone"]), nodes=data["nodes"])
        for e in data["edges"]:
            if e["u"] == e["v"]:
                continue
            net.edges[e["id"]] = e
            existing = net.graph.get_edge_data(e["u"], e["v"])
            if existing is None or e["length"] < net.edges[existing["id"]]["length"]:
                net.graph.add_edge(e["u"], e["v"], id=e["id"])
        # Keep the largest connected component so every snap is routable.
        keep = max(nx.connected_components(net.graph), key=len)
        net.graph = net.graph.subgraph(keep).copy()
        net.node_ids = list(keep)
        net.tree = cKDTree([(net.nodes[n][0], net.nodes[n][1] * MLON) for n in net.node_ids])
        return net

    def nearest(self, latlon) -> str:
        _, i = self.tree.query((latlon[0], latlon[1] * MLON))
        return self.node_ids[i]

    def exposure(self, edge_id: str, weights: dict) -> float:
        s = self.scores.get(edge_id, {})
        return sum(v * weights.get(g, 0.0) for g, v in s.items())

    def path_edges(self, path):
        return [self.graph[a][b]["id"] for a, b in zip(path, path[1:])]

    def coords(self, path):
        out = []
        for a, b in zip(path, path[1:]):
            e = self.edges[self.graph[a][b]["id"]]
            pts = e["coords"] if e["u"] == a else list(reversed(e["coords"]))
            out += pts if not out else pts[1:]
        return out

    def stats(self, path, weights):
        ids = self.path_edges(path)
        length = sum(self.edges[i]["length"] for i in ids) or 1.0
        return {
            "length_m": round(length, 1),
            "minutes": round(length / WALK_M_PER_MIN, 1),
            "segment_exposure": round(sum(self.exposure(i, weights) for i in ids), 1),
            "major_road_share": round(sum(self.edges[i]["length"] for i in ids if road_penalty(self.edges[i]["highway"]) >= 0.6) / length, 3),
            "pollution_zone_share": round(sum(self.edges[i]["length"] for i in ids if i in self.zone) / length, 3),
        }

    def _path(self, a, b, weights, alpha, asthma):
        def cost(_u, _v, d):
            e = self.edges[d["id"]]
            factor = 1.0
            if asthma:
                factor += road_penalty(e["highway"]) + (0.3 if d["id"] in self.zone else 0.0)
            return e["length"] * factor + alpha * self.exposure(d["id"], weights)
        return nx.shortest_path(self.graph, a, b, weight=cost)

    def shortest(self, a, b):
        return nx.shortest_path(self.graph, a, b, weight=lambda _u, _v, d: self.edges[d["id"]]["length"])

    def clean(self, a, b, weights, asthma, max_detour):
        """Sweep the exposure price and keep the cleanest route within the detour budget."""
        base = self.stats(self.shortest(a, b), weights)
        budget = base["length_m"] * max_detour
        best, best_score = None, None
        for alpha in ALPHAS:
            path = self._path(a, b, weights, alpha, asthma)
            s = self.stats(path, weights)
            if s["length_m"] > budget:
                break
            # Asthma counts major-road and zone metres as well as pollen.
            score = s["segment_exposure"] + (self._air_cost(s) if asthma else 0.0)
            if best_score is None or score < best_score:
                best, best_score = path, score
        return best if best is not None else self.shortest(a, b)

    @staticmethod
    def _air_cost(s):
        return s["length_m"] * (s["major_road_share"] * 0.6 + s["pollution_zone_share"] * 0.3)
