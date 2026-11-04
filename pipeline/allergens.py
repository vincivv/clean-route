"""Mistral Large 4 builds the allergen table SF's tree data doesn't have."""
import collections
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from pydantic import BaseModel, Field

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import ALLERGENS_JSON, LARGE_MODEL, TREES_JSON, mistral_client

GROUPS = ["plane", "olive", "cypress", "pine", "oak", "elm", "ash", "maple", "birch", "alder", "mulberry", "privet",
          "acacia", "eucalyptus", "palm", "poplar", "walnut", "sweetgum", "other_wind", "low_allergen"]
BATCH = 20
TARGET_COVERAGE = 0.93
MAX_SPECIES = 160


class Species(BaseModel):
    species_key: str = Field(description="Copy the input scientific name exactly")
    common_name: str
    allergen_group: str = Field(description="One of the allowed groups")
    allergy_level: int = Field(ge=0, le=3, description="0 none, 1 low, 2 moderate, 3 high pollen allergenicity")
    wind_pollinated: bool
    bloom_months: list[int] = Field(description="Months 1-12 when it sheds pollen in coastal San Francisco")
    symptoms: str = Field(description="One sentence on the season and typical symptoms people with this pollen allergy report")
    rationale: str = Field(description="One sentence on why this level, naming any known cross-reactivity")
    confidence: str = Field(description="high, medium or low")


class Batch(BaseModel):
    species: list[Species]


SYSTEM = f"""You are an aerobiology and allergy reference. For each street tree species growing in San Francisco, return its pollen allergenicity.
Allowed allergen_group values: {', '.join(GROUPS)}. Use the botanical family or genus match. Use other_wind for wind-pollinated trees outside the list, and low_allergen for insect- or bird-pollinated trees with little airborne pollen.
Judge pollen only, not fruit or sap. Female-only cultivars and sterile hybrids should get low levels. If you are unsure, lower confidence rather than guess high. Return every species you are given."""


def load_species():
    counts = collections.Counter()
    for t in json.loads(TREES_JSON.read_text()):
        s = (t.get("species") or "").split("::")[0].strip()
        if s and s.lower() not in ("tree(s)", "tree", "tbd", "shrub"):
            counts[s] += 1
    total = sum(counts.values())
    picked, running = [], 0
    for s, n in counts.most_common(MAX_SPECIES):
        picked.append((s, n))
        running += n
        if running / total >= TARGET_COVERAGE:
            break
    print(f"{len(picked)} species cover {running / total:.1%} of {total} identified trees")
    return picked, total


def ask(batch):
    names = "\n".join(s for s, _ in batch)
    for attempt in range(4):
        try:
            r = mistral_client().chat.parse(
                model=LARGE_MODEL,
                messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": names}],
                response_format=Batch,
            )
            return r.choices[0].message.parsed.species
        except Exception as e:  # rate limits and rare schema errors: retry
            print("retry", attempt, type(e).__name__, str(e)[:150])
    return []


def main():
    picked, total = load_species()
    counts = dict(picked)
    batches = [picked[i:i + BATCH] for i in range(0, len(picked), BATCH)]
    table = {}
    with ThreadPoolExecutor(6) as pool:
        for result in pool.map(ask, batches):
            for s in result:
                if s.species_key in counts:
                    d = s.model_dump()
                    if d["allergen_group"] not in GROUPS:
                        d["allergen_group"] = "other_wind" if d["wind_pollinated"] else "low_allergen"
                    d["bloom_months"] = sorted({m for m in d["bloom_months"] if 1 <= m <= 12})
                    d["trees"] = counts[s.species_key]
                    table[s.species_key] = d
    missing = [s for s in counts if s not in table]
    covered = sum(d["trees"] for d in table.values())
    ALLERGENS_JSON.write_text(json.dumps({"model": LARGE_MODEL, "identified_trees": total, "covered_trees": covered, "species": table}, indent=1))
    print(f"table {len(table)} species, covers {covered / total:.1%}; missing {missing[:10]}")


if __name__ == "__main__":
    main()
