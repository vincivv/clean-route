"""Exposure-aware routing over the OSM walking graph, using scores Elastic computed per street segment."""
import json
import math
from dataclasses import dataclass, field

import networkx as nx
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from pipeline.config import CENTER, GRAPH_JSON, SEGMENTS_JSON
from pipeline.score_segments import MAJOR, MEDIUM

WALK_M_PER_MIN = 80.0
LOW_ALLERGEN = "low_allergen"
MLON = math.cos(math.radians(CENTER[0]))
ALPHAS = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4]
KNEE_SHARE = 0.8  # Take the shortest detour that gets 80% of the best available saving.


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
    ix: dict = field(default_factory=dict)  # Shared across per-request copies.

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

    def _index(self):
        if not self.ix:
            names = list(self.graph.nodes)
            pos = {n: i for i, n in enumerate(names)}
            triples = [(pos[u], pos[v], d["id"]) for u, v, d in self.graph.edges(data=True)]
            self.ix.update(names=names, pos=pos, us=np.array([t[0] for t in triples]), vs=np.array([t[1] for t in triples]),
                           ids=[t[2] for t in triples], lengths=np.array([self.edges[t[2]]["length"] for t in triples]),
                           road=np.array([road_penalty(self.edges[t[2]]["highway"]) for t in triples]),
                           zone=np.array([0.3 if t[2] in self.zone else 0.0 for t in triples]))
        return self.ix

    def _solve(self, a, b, costs):
        ix = self._index()
        costs = np.maximum(costs, 1e-3)
        n = len(ix["names"])
        m = csr_matrix((np.r_[costs, costs], (np.r_[ix["us"], ix["vs"]], np.r_[ix["vs"], ix["us"]])), shape=(n, n))
        src, dst = ix["pos"][a], ix["pos"][b]
        _, pred = dijkstra(m, indices=src, return_predecessors=True)
        path, cur = [], dst
        while cur != src:
            path.append(ix["names"][cur])
            cur = pred[cur]
        path.append(ix["names"][src])
        return path[::-1]

    def shortest(self, a, b):
        return self._solve(a, b, self._index()["lengths"])

    def clean(self, a, b, weights, asthma, max_detour):
        """Sweep the exposure price, then take the shortest detour that gets most of the available saving."""
        ix = self._index()
        base_path = self.shortest(a, b)
        base = self.stats(base_path, weights)
        budget = base["length_m"] * max_detour
        exposure = np.array([self.exposure(i, weights) for i in ix["ids"]])
        factor = 1.0 + (ix["road"] + ix["zone"] if asthma else 0.0)

        def badness(st):
            return st["segment_exposure"] + (self._air_cost(st) if asthma else 0.0)

        options = [(base["length_m"], badness(base), base_path)]
        for alpha in ALPHAS:
            path = self._solve(a, b, ix["lengths"] * factor + alpha * exposure)
            st = self.stats(path, weights)
            if st["length_m"] > budget:
                break
            options.append((st["length_m"], badness(st), path))
        worst, best = options[0][1], min(o[1] for o in options)
        target = worst - KNEE_SHARE * (worst - best)
        return min((o for o in options if o[1] <= target), key=lambda o: o[0])[2]

    @staticmethod
    def _air_cost(s):
        return s["length_m"] * (s["major_road_share"] * 0.6 + s["pollution_zone_share"] * 0.3)
