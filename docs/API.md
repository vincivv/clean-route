# Clean Route API contract

Coordinates are always `[lat, lon]`. The FastAPI backend serves `frontend/` at `/` and the API under `/api`.

## GET /api/meta
```json
{
  "center": [37.7746, -122.4116],
  "bounds": [[37.747, -122.446], [37.802, -122.377]],
  "groups": [{"id": "plane", "label": "Plane tree", "trees": 9000, "level": 3, "bloom_months": [3, 4, 5]}],
  "presets": [{"name": "Venue to Dolores Park", "start": [37.7873, -122.4005], "end": [37.7596, -122.4269]}],
  "modes": {"elastic": true, "mistral": true},
  "data": {"trees": 40000, "segments": 20000, "species_covered_pct": 91.2}
}
```

## POST /api/route
Request:
```json
{"start": [37.78, -122.40], "end": [37.76, -122.42], "groups": ["plane", "olive"], "month": 3, "asthma": true, "max_detour": 1.3}
```
`groups: null` means every allergen group. `asthma: true` adds the road and pollution-zone penalties.

Response:
```json
{
  "shortest": "<Route>",
  "clean": "<Route>",
  "summary": {"extra_minutes": 2.4, "extra_meters": 190, "exposure_reduction_pct": 41.2},
  "explanation": "Short plain-English note from Mistral, or null",
  "elastic_query": {"size": 0, "query": {}, "aggs": {}}
}
```
`Route`:
```json
{
  "coords": [[37.78, -122.40]],
  "length_m": 2500,
  "minutes": 31.2,
  "exposure": 1234.5,
  "exposure_source": "elastic",
  "trees_near": 210,
  "allergenic_trees_near": 80,
  "by_group": [{"group": "plane", "label": "Plane tree", "weight": 800.0, "trees": 30}],
  "top_species": [{"species": "Platanus x hispanica", "common": "London plane", "trees": 30, "level": 3}],
  "major_road_share": 0.2,
  "pollution_zone_share": 0.6
}
```

## GET /api/segments?month=3&groups=plane,olive&asthma=false
Street-level exposure for the map layer. `e` is per metre, `max` is the 98th percentile for the colour scale.
```json
{"segments": [{"c": [[37.78, -122.40], [37.78, -122.41]], "e": 1.2}], "max": 5.0}
```

## POST /api/parse
Request `{"text": "I'm allergic to olive trees and have asthma, walk me from the Ferry Building to Dolores Park"}`.
```json
{
  "transcript": "same text",
  "groups": ["olive"],
  "asthma": true,
  "start_text": "Ferry Building",
  "end_text": "Dolores Park",
  "start": [37.7955, -122.3937],
  "end": [37.7596, -122.4269]
}
```
`groups`, `start` and `end` can be null. `start`/`end` are null when the place could not be found.

## POST /api/voice
Multipart form with field `file` (webm, wav or mp3). Same response as `/api/parse`.

## POST /api/symptoms
Request `{"text": "my eyes itch every March", "month": 3, "coords": [[37.78, -122.40]]}`. `coords` is optional.
```json
{
  "suggestions": [{"species": "Platanus x hispanica", "common": "London plane", "group": "plane", "level": 3, "why": "...", "trees_on_route": 30, "score": 0.03}],
  "note": "A suggestion, not a diagnosis.",
  "elastic_query": {}
}
```

## GET /api/air
```json
{"pm2_5": 9.1, "nitrogen_dioxide": 8.8, "us_aqi": 53, "wind_speed_10m": 12.0, "wind_direction_10m": 270, "time": "2026-11-03T18:00", "source": "Open-Meteo"}
```

## Errors
Non-2xx responses return `{"detail": "message"}`. A 503 means Elastic or Mistral isn't configured.

## Profiles (registration)
A person registers once. The server stores the profile in Elastic and `/api/route` applies it automatically.

### POST /api/profile
Request `{"name": "Sam", "text": "I'm allergic to olive and birch and I have mild asthma"}`. `text` can be replaced with `groups` and `asthma`.
```json
{
  "profile_id": "p_ab12cd",
  "name": "Sam",
  "groups": ["olive", "birch", "alder"],
  "asthma": true,
  "reasons": ["Birch pollen often cross-reacts with alder"],
  "not_covered": ["Grass isn't a street tree, so routes can't avoid it"],
  "raw_text": "..."
}
```

### POST /api/profile/voice
Multipart form with `file` and `name`. Same response, plus `transcript`.

### GET /api/profile/{profile_id}
Same shape. 404 if it doesn't exist.

### PUT /api/profile/{profile_id}
Request `{"groups": ["olive"], "asthma": false}`. Same response.

### Route with a profile
`POST /api/route` also accepts `"profile_id": "p_ab12cd"`. Explicit `groups` or `asthma` in the request override it for that route.
