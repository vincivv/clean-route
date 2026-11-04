import numpy as np
import mapbox_vector_tile

from backend.traffic import LAYER, Traffic, decode_tile, tile_point, to_tile


def encoded_tile(traffic_level):
    return mapbox_vector_tile.encode([{"name": LAYER, "features": [
        {"geometry": "LINESTRING (0 0, 4096 4096)", "properties": {"traffic_level": traffic_level}}]}])


def test_tile_corners_surround_the_point_they_came_from():
    lat, lon = 37.7873, -122.4005
    x, y = to_tile(lat, lon)
    south_west = tile_point(x, y, 0, 0, 4096)
    north_east = tile_point(x, y, 4096, 4096, 4096)
    assert south_west[0] <= lat <= north_east[0]
    assert south_west[1] <= lon <= north_east[1]


def test_slow_traffic_decodes_as_high_congestion():
    x, y = to_tile(37.7873, -122.4005)
    [(coords, congestion)] = decode_tile(encoded_tile(0.2), x, y)
    assert congestion == 0.8
    assert coords[0][0] < coords[-1][0]


class FakeNet:
    edges = {
        "near": {"coords": [[37.78, -122.40], [37.78, -122.40]]},
        "far": {"coords": [[37.79, -122.40], [37.79, -122.40]]},
    }


def test_only_nearby_walking_edges_get_congestion():
    t = Traffic(FakeNet())
    assert t.edge_points.shape == (2, 2) and isinstance(t.edge_points, np.ndarray)
    road = [[37.7801, -122.4005], [37.7801, -122.3995]]
    assert t.match([(road, 0.7)]) == {"near": 0.7}
