# Clean Route

Walk San Francisco with less of the pollen that sets you off.

Tell it once what you're allergic to and whether you have asthma. It remembers, then finds a walking route that passes fewer of *your* trigger trees and fewer major roads. Built at the Elastic x Mistral "Make SF Better" hack night.

## Measured result

30 random walks in the area (all tree pollen, April, seeded, run through the live API):

| | Median |
|---|---|
| Less estimated exposure, trees within 25 m | **75.7%** (middle half: 60.1% to 80.3%) |
| Same comparison, trees within 100 m | **34.0%** |
| Extra walking time | **1.8 min** on a 31.6 min walk |

These are modelled exposure figures, not measured pollen or health outcomes. See `pipeline/evaluate.py` and `data/evaluation.json`.

## How it works

| Step | Tool | What happens |
|---|---|---|
| Allergen table | Mistral Large 4 | Rates 122 species (93% of identified trees in the area) for allergy level, bloom months and symptoms. The city's data has none of this. |
| Street scoring | Elastic | `geo_shape` + `terms` + `sum` aggregations in `_msearch` score all 31,973 street segments against 60,645 trees. |
| Registration | Voxtral, Mistral, Elastic | Speech or text becomes a saved profile, including cross-reactive groups ("sycamore" maps to plane). |
| Route search | Elastic, then Dijkstra | Each request loads street scores for its corridor from Elastic. Dijkstra then runs at 12 exposure prices, and we keep the shortest detour that gets 80% of the best saving, up to 30% longer. |
| Route proof | Elastic | A live aggregation sums distinct trees around each finished route. Elastic does the math, not the LLM. |
| Symptom search | Elastic + `mistral-embed` | Hybrid search (RRF over BM25 and `semantic_text`) suggests likely triggers, labelled as not a diagnosis. |

Edge cost: `length × (1 + road and pollution-zone penalty if asthma) + α × person's pollen score`, where tree weight is `level² × trunk diameter`, scaled by bloom month.

## Limits

- **Estimated exposure:** based on tree locations, not live pollen. Pollen also travels further than these distances.
- **Missing trees:** only city street-tree records, so parks and private trees look cleaner than they may be.
- **Allergen ratings:** from Mistral's own knowledge, spot-checked for the top 30 species with 3 corrections (`data/allergen_overrides.json`). Not validated against a published source.
- **Car pollution:** approximated by OSM road type and SF's Air Pollutant Exposure Zone. There's no live emissions data, and 85% of segments are inside the zone.
- **Coverage:** about 3 km around downtown.
- **Not medical advice:** no claim of fewer symptoms.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
```bash
cp .env.example .env
```
Add your keys to `.env`, then build the data once (about 5 minutes):
```bash
.venv/bin/python pipeline/download.py && .venv/bin/python pipeline/allergens.py && .venv/bin/python pipeline/index_elastic.py && .venv/bin/python pipeline/score_segments.py
```
```bash
.venv/bin/uvicorn backend.app:app --port 8000
```
Tests: `.venv/bin/python -m pytest -q tests`. API reference: `docs/API.md`.

## Data and credits

[SF Street Tree List](https://data.sf.gov/d/tkzw-k3nq) and [Air Pollutant Exposure Zone](https://data.sf.gov/d/t65d-x6p8) (DataSF). Street network © OpenStreetMap contributors (ODbL). Air readings from Open-Meteo. Concept inspired by [Project TreeRoute](https://github.com/NBeibarys/Project-TreeRoute); no code reused.
