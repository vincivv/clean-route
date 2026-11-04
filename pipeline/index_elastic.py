"""Create the Elastic indices and load trees, the allergen table and the pollution zone."""
import json
import os
import statistics
import sys

from elasticsearch import NotFoundError, helpers

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import ALLERGENS_INDEX, ALLERGENS_JSON, APEZ_JSON, INFERENCE_ID, TREES_INDEX, TREES_JSON, ZONE_INDEX, es_client


def load_table():
    """Mistral's table plus reviewed corrections."""
    table = json.loads(ALLERGENS_JSON.read_text())["species"]
    overrides = json.loads((ALLERGENS_JSON.parent / "allergen_overrides.json").read_text())
    for sci, fix in overrides.items():
        if sci in table:
            table[sci].update(fix)
    return table


def recreate(es, name, mappings):
    es.options(ignore_status=404).indices.delete(index=name)
    es.indices.create(index=name, mappings=mappings)


def bulk(es, actions, label):
    ok, errors = helpers.bulk(es, actions, chunk_size=2000, max_retries=4, raise_on_error=False, request_timeout=180)
    print(label, "indexed", ok, "errors", len(errors), errors[:1] if errors else "")


def trees(es, table):
    recreate(es, TREES_INDEX, {"properties": {
        "tree_id": {"type": "keyword"},
        "scientific": {"type": "keyword"},
        "common": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
        "allergen_group": {"type": "keyword"},
        "level": {"type": "byte"},
        "dbh_inches": {"type": "float"},
        "weight": {"type": "float"},
        "location": {"type": "geo_point"},
    }})
    rows = json.loads(TREES_JSON.read_text())
    dbhs = [float(r["mapdbh"]) for r in rows if str(r.get("mapdbh", "")).replace(".", "").isdigit() and 0 < float(r["mapdbh"]) <= 80]
    median = statistics.median(dbhs)
    print("median dbh", median, "from", len(dbhs), "of", len(rows))

    def docs():
        for r in rows:
            try:
                lat, lon = float(r["latitude"]), float(r["longitude"])
            except (KeyError, ValueError):
                continue
            sci, _, com = (r.get("species") or "").partition("::")
            sci = sci.strip()
            a = table.get(sci)
            level = a["allergy_level"] if a else 0
            try:
                dbh = float(r.get("mapdbh", 0))
            except ValueError:
                dbh = 0
            if not 0 < dbh <= 80:
                dbh = median
            yield {"_index": TREES_INDEX, "_id": r["treeid"], "_source": {
                "tree_id": r["treeid"], "scientific": sci or "Unknown", "common": (a or {}).get("common_name") or com.strip() or "Unknown",
                "allergen_group": a["allergen_group"] if a else "unrated", "level": level, "dbh_inches": dbh,
                "weight": round(level * level * dbh, 2), "location": {"lat": lat, "lon": lon}}}

    bulk(es, docs(), "trees")


def allergens(es, table):
    es.options(ignore_status=404).inference.delete(inference_id=INFERENCE_ID, force=True)
    es.inference.put(task_type="text_embedding", inference_id=INFERENCE_ID, inference_config={
        "service": "mistral", "service_settings": {"api_key": os.environ["MISTRAL_API_KEY"], "model": "mistral-embed", "rate_limit": {"requests_per_minute": 120}}})
    recreate(es, ALLERGENS_INDEX, {"properties": {
        "scientific": {"type": "keyword"},
        "common": {"type": "text"},
        "allergen_group": {"type": "keyword"},
        "level": {"type": "byte"},
        "bloom_months": {"type": "byte"},
        "symptoms_text": {"type": "text"},
        "profile": {"type": "semantic_text", "inference_id": INFERENCE_ID},
        "rationale": {"type": "text"},
        "trees": {"type": "integer"},
    }})
    month = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    def docs():
        for sci, a in table.items():
            if a["allergy_level"] < 1:
                continue
            months = ", ".join(month[m] for m in a["bloom_months"])
            yield {"_index": ALLERGENS_INDEX, "_id": sci, "_source": {
                "scientific": sci, "common": a["common_name"], "allergen_group": a["allergen_group"], "level": a["allergy_level"],
                "bloom_months": a["bloom_months"], "symptoms_text": a["symptoms"], "rationale": a["rationale"], "trees": a["trees"],
                "profile": f"{a['common_name']} ({sci}). Pollen season: {months}. {a['symptoms']} {a['rationale']}"}}

    ok, errors = helpers.bulk(es, docs(), chunk_size=25, max_retries=4, raise_on_error=False, request_timeout=300)
    print("allergens indexed", ok, "errors", len(errors), str(errors[:1])[:300] if errors else "")


def zone(es):
    recreate(es, ZONE_INDEX, {"properties": {"name": {"type": "keyword"}, "geometry": {"type": "geo_shape"}}})
    es.index(index=ZONE_INDEX, id="apez", document={"name": "Air Pollutant Exposure Zone", "geometry": json.loads(APEZ_JSON.read_text())}, refresh=True)
    print("zone indexed")


if __name__ == "__main__":
    es = es_client()
    table = load_table()
    which = sys.argv[1:] or ["trees", "allergens", "zone"]
    if "zone" in which:
        zone(es)
    if "trees" in which:
        trees(es, table)
    if "allergens" in which:
        allergens(es, table)
    for i in (TREES_INDEX, ALLERGENS_INDEX, ZONE_INDEX):
        try:
            es.indices.refresh(index=i)
            print(i, es.count(index=i)["count"])
        except NotFoundError:
            print(i, "missing")
