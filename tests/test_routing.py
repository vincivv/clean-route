import networkx as nx
from scipy.spatial import cKDTree

from backend.routing import Network


def small_net(score_on_short=100.0):
    """A square: a-b-d is short and allergenic, a-c-d is longer and clean."""
    nodes = {"a": [37.0, -122.0], "b": [37.0, -121.999], "c": [37.001, -122.0], "d": [37.0, -121.998]}
    edges = {
        "ab": {"id": "ab", "u": "a", "v": "b", "length": 100.0, "highway": "footway", "coords": [nodes["a"], nodes["b"]]},
        "bd": {"id": "bd", "u": "b", "v": "d", "length": 100.0, "highway": "footway", "coords": [nodes["b"], nodes["d"]]},
        "ac": {"id": "ac", "u": "a", "v": "c", "length": 120.0, "highway": "footway", "coords": [nodes["a"], nodes["c"]]},
        "cd": {"id": "cd", "u": "c", "v": "d", "length": 120.0, "highway": "footway", "coords": [nodes["c"], nodes["d"]]},
    }
    g = nx.Graph()
    for e in edges.values():
        g.add_edge(e["u"], e["v"], id=e["id"])
    ids = list(nodes)
    return Network(graph=g, edges=edges, nodes=nodes, node_ids=ids, zone=set(), scores={"ab": {"olive": score_on_short}},
                   tree=cKDTree([nodes[n] for n in ids]))


def test_shortest_ignores_exposure():
    assert small_net().shortest("a", "d") == ["a", "b", "d"]


def test_clean_avoids_the_person_trigger():
    assert small_net().clean("a", "d", {"olive": 1.0}, False, 1.3) == ["a", "c", "d"]


def test_clean_ignores_groups_the_person_doesnt_react_to():
    assert small_net().clean("a", "d", {"birch": 1.0}, False, 1.3) == ["a", "b", "d"]


def test_detour_budget_is_respected():
    assert small_net().clean("a", "d", {"olive": 1.0}, False, 1.1) == ["a", "b", "d"]


def test_asthma_avoids_major_roads():
    net = small_net(0.0)
    net.edges["ab"]["highway"] = net.edges["bd"]["highway"] = "primary"
    assert net.clean("a", "d", {}, True, 1.3) == ["a", "c", "d"]
    assert net.stats(["a", "b", "d"], {})["major_road_share"] == 1.0


def test_coords_follow_direction_of_travel():
    assert small_net().coords(["d", "b", "a"])[0] == [37.0, -121.998]


def test_allergic_to_is_not_a_destination():
    from backend.app import trip_places

    assert trip_places("I'm allergic to London plane trees", None, None) == (None, None)
    assert trip_places("walk me from the Ferry Building to Dolores Park, I have asthma", None, None) == ("the Ferry Building", "Dolores Park")
    assert trip_places("take me to Dolores Park", None, None) == (None, "Dolores Park")
