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


def test_published_rating_wins_and_no_reports_is_not_zero():
    from pipeline.index_elastic import load_table

    table = load_table()
    plane = table["Platanus x hispanica"]
    assert plane["mistral_level"] == 3 and plane["allergy_level"] == 2 and plane["verified"]
    assert table["Pinus radiata"]["allergy_level"] == 1
    assert not table["Maytenus boaria"]["verified"]


def test_coords_are_continuous_even_when_geometry_is_stored_backwards():
    net = small_net()
    net.edges["ab"]["coords"] = list(reversed(net.edges["ab"]["coords"]))
    net.edges["bd"]["coords"] = [net.nodes["d"], [37.0002, -121.9985], net.nodes["b"]]
    coords = net.coords(["a", "b", "d"])
    assert coords[0] == net.nodes["a"] and coords[-1] == net.nodes["d"]
    assert coords[1] == net.nodes["b"]


def test_asthma_route_rejects_much_more_heavy_traffic():
    net = small_net(100.0)
    net.congestion = {"ac": 0.9, "cd": 0.9}
    assert net.clean("a", "d", {"olive": 1.0}, True, 1.3) == ["a", "b", "d"]
    assert net.clean("a", "d", {"olive": 1.0}, False, 1.3) == ["a", "c", "d"]


def test_sidewalk_beside_a_major_road_counts_as_major():
    net = small_net(0.0)
    net.beside = {"ab": "primary", "bd": "primary"}
    assert net.stats(["a", "b", "d"], {})["major_road_share"] == 1.0
    assert net.stats(["a", "c", "d"], {})["major_road_share"] == 0.0
    assert net.clean("a", "d", {}, True, 1.3) == ["a", "c", "d"]


def test_live_congestion_raises_traffic_pollution_score():
    net = small_net(0.0)
    net.beside = {"ab": "secondary", "bd": "secondary"}
    calm = net.stats(["a", "b", "d"], {})["air_exposure"]
    net.congestion = {"ab": 0.8}
    assert net.stats(["a", "b", "d"], {})["air_exposure"] > calm
