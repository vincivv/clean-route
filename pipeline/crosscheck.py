"""Compare Mistral's allergen table with Pollen Library (pollen.com), one published reference. Stores only each rating and its URL."""
import json
import re
import sys
import time
import html
from concurrent.futures import ThreadPoolExecutor

import requests

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from pipeline.config import ALLERGENS_JSON, DATA

OUT = DATA / "allergen_crosscheck.json"
LEVELS = {"severe": 3, "moderate": 2, "mild": 1, "low": 1}
# Same tree under the reference's name.
SYNONYMS = {"Platanus x hispanica": "Platanus acerifolia", "patanus racemosa": "Platanus racemosa", "Syagrus romanzoffianum": "Syagrus romanzoffiana"}
# No entry for the species, so use a close relative in the same genus. Marked as "relative" in the output.
RELATIVES = {"Acacia": "Acacia baileyana", "Eucalyptus": "Eucalyptus globulus", "Juniperus": "Juniperus virginiana", "Fraxinus": "Fraxinus americana",
             "Pinus": "Pinus ponderosa", "Platanus": "Platanus occidentalis"}


def binomial(name):
    name = name.split("'")[0].strip()
    parts = name.split()
    if len(parts) >= 3 and parts[1] == "x":
        return " ".join(parts[:3])
    return " ".join(parts[:2])


def lookup(base):
    url = "https://www.pollenlibrary.com/Specie/" + base.replace(" ", "+") + "/"
    time.sleep(0.4)
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "clean-route-hackathon"})
    except requests.RequestException as e:
        return {"status": type(e).__name__, "url": url}
    text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style).*?</\1>", " ", r.text)))
    text = re.sub(r"\s+", " ", text)
    if r.status_code != 200 or "Allergenicity" not in text:
        return {"status": "not found", "url": url}
    level = re.search(r"Allergenicity\s*:.*? is an? (\w+) allergen", text)
    none = re.search(r"Allergenicity\s*:\s*No allergy has been reported", text)
    season = re.search(r"latitude and elevation:\s*([A-Za-z ,]+?)\.", text)
    word = "no allergy reported" if none else (level.group(1).lower() if level else "unstated")
    return {"status": "ok", "url": url, "word": word, "season": season.group(1) if season else None}


def fetch(name):
    base = binomial(name)
    found = lookup(SYNONYMS.get(base, base))
    match = "species"
    if found["status"] != "ok" and base.split()[0] in RELATIVES:
        found = lookup(RELATIVES[base.split()[0]])
        match = "relative"
    found["match"] = match if found["status"] == "ok" else None
    return name, found


def main():
    table = json.loads(ALLERGENS_JSON.read_text())["species"]
    with ThreadPoolExecutor(3) as pool:
        out = dict(pool.map(fetch, table))
    OUT.write_text(json.dumps(out, indent=1))
    print({k: sum(1 for v in out.values() if v["status"].startswith(k)) for k in ("ok", "not")})


if __name__ == "__main__":
    main()
