"""Shared settings and clients for the Clean Route pipeline and backend."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=True)

DATA = ROOT / "data"
RAW = DATA / "raw"
CACHE = DATA / "cache"
ALLERGENS_JSON = DATA / "allergens.json"
SEGMENTS_JSON = CACHE / "segments.json"
TREES_JSON = RAW / "trees.json"
APEZ_JSON = RAW / "apez.json"
GRAPH_JSON = RAW / "graph.json"

CENTER = (37.7746, -122.4116)
RADIUS_M = 3000
BUFFER_M = 25
VENUE = (37.7873, -122.4005)

TREES_INDEX = "cr_trees"
SEGMENTS_INDEX = "cr_segments"
ALLERGENS_INDEX = "cr_allergens"
ZONE_INDEX = "cr_pollution_zone"
INFERENCE_ID = "cr-mistral-embed"

LARGE_MODEL = "mistral-large-4"
SMALL_MODEL = "ministral-14b-latest"
VOICE_MODEL = "voxtral-mini-latest"


def has_elastic() -> bool:
    return bool(os.getenv("ELASTIC_ENDPOINT", "").startswith("https://") and "your-project" not in os.getenv("ELASTIC_ENDPOINT", "") and os.getenv("ELASTIC_API_KEY"))


def has_mistral() -> bool:
    return bool(os.getenv("MISTRAL_API_KEY"))


def es_client():
    from elasticsearch import Elasticsearch

    return Elasticsearch(os.environ["ELASTIC_ENDPOINT"], api_key=os.environ["ELASTIC_API_KEY"], request_timeout=120, http_compress=True)


def mistral_client():
    from mistralai.client import Mistral

    return Mistral(api_key=os.environ["MISTRAL_API_KEY"])
