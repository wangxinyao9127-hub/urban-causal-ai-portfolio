"""Generate the public portfolio dataset entirely from synthetic rules."""

from __future__ import annotations

import gzip
import json
import random
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEED = 240731
RNG = random.Random(SEED)

GROUPS = {
    "transport": ["pavement damage", "pothole", "road surface damage", "faded road marking", "damaged bollard", "road barrier", "street sign", "roadworks"],
    "drainage": ["blocked drain", "damaged drain", "water leak", "surface flooding", "sewer overflow"],
    "lighting": ["streetlight fault", "traffic signal fault", "public camera fault"],
    "utilities": ["utility cover", "utility cabinet", "street furniture", "public bin", "fence", "gate"],
    "other": ["waste accumulation", "overgrown vegetation", "abandoned item", "graffiti"],
}
GROUP_COUNTS = {"transport": 2700, "drainage": 1300, "lighting": 900, "utilities": 1100, "other": 2000}
VERBS = ["obstructs", "damages", "endangers", "disrupts", "causes", "reduces"]
TARGETS = ["pedestrian_access", "vehicle_movement", "drainage_function", "people_safety", "public_realm", "lighting_function", "traffic_control_function", "utility_service", "visibility", "environmental_quality"]
STATES = ["obstructed", "unsafe", "disrupted", "damaged", "flooded", "reduced", "degraded", "delayed"]
MONTHS = [f"2025-{month:02d}" for month in range(1, 13)]
ZONES = ["North Quarter", "Canal District", "East Junction", "West Park", "Central Core", "Riverside", "Market Ward", "University Zone", "South Basin", "Harbour Edge", "Garden District", "Industrial Quarter"]

RELATIONS = {
    "transport": [("endangers", "people_safety", "unsafe", 5), ("obstructs", "pedestrian_access", "obstructed", 4), ("disrupts", "vehicle_movement", "delayed", 3), ("damages", "public_realm", "damaged", 2), ("reduces", "visibility", "reduced", 1)],
    "drainage": [("obstructs", "drainage_function", "obstructed", 6), ("causes", "public_realm", "flooded", 5), ("endangers", "people_safety", "unsafe", 3), ("disrupts", "vehicle_movement", "delayed", 2), ("obstructs", "pedestrian_access", "obstructed", 2)],
    "lighting": [("disrupts", "lighting_function", "disrupted", 6), ("reduces", "visibility", "reduced", 5), ("endangers", "people_safety", "unsafe", 3), ("disrupts", "traffic_control_function", "disrupted", 2)],
    "utilities": [("disrupts", "utility_service", "disrupted", 5), ("obstructs", "pedestrian_access", "obstructed", 4), ("damages", "public_realm", "damaged", 3), ("endangers", "people_safety", "unsafe", 2)],
    "other": [("obstructs", "public_realm", "obstructed", 5), ("obstructs", "pedestrian_access", "obstructed", 4), ("reduces", "environmental_quality", "degraded", 4), ("endangers", "people_safety", "unsafe", 2)],
}
ZONE_WEIGHTS = {
    "transport": [3, 2, 6, 2, 7, 3, 5, 4, 2, 2, 3, 5],
    "drainage": [1, 6, 2, 1, 2, 8, 2, 1, 8, 7, 2, 4],
    "lighting": [6, 2, 4, 5, 6, 2, 4, 5, 2, 2, 4, 3],
    "utilities": [2, 3, 4, 2, 5, 3, 4, 3, 3, 4, 2, 6],
    "other": [3, 2, 3, 5, 6, 3, 7, 4, 3, 2, 6, 4],
}
MONTH_WEIGHTS = {
    "transport": [4, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 4],
    "drainage": [8, 7, 5, 4, 3, 3, 3, 3, 4, 7, 9, 9],
    "lighting": [9, 8, 6, 4, 3, 2, 2, 3, 5, 7, 9, 10],
    "utilities": [5] * 12,
    "other": [5, 5, 6, 7, 8, 8, 7, 7, 6, 5, 5, 5],
}


def weighted_relation(group):
    options = RELATIONS[group]
    return RNG.choices([row[:3] for row in options], weights=[row[3] for row in options], k=1)[0]


def make_geometry():
    result = []
    for index, name in enumerate(ZONES):
        col, row = index % 4, index // 4
        x0, y0 = col * 1070, row * 920
        ring = [[x0, y0], [x0 + 1000, y0], [x0 + 1000, y0 + 850], [x0, y0 + 850], [x0, y0]]
        result.append({"name": name, "shortLabel": name.replace(" District", "").replace(" Quarter", ""), "key": f"zone-{index + 1:02d}", "rings": [ring], "centroid": [x0 + 500, y0 + 425]})
    return result


def main():
    subjects = [subject for group in GROUPS.values() for subject in group]
    indexes = [{value: index for index, value in enumerate(values)} for values in (subjects, VERBS, TARGETS, STATES)]
    records = []
    for group, count in GROUP_COUNTS.items():
        for _ in range(count):
            subject = RNG.choice(GROUPS[group])
            verb, target, state = weighted_relation(group)
            zone_i = RNG.choices(range(len(ZONES)), weights=ZONE_WEIGHTS[group], k=1)[0]
            month_i = RNG.choices(range(len(MONTHS)), weights=MONTH_WEIGHTS[group], k=1)[0]
            col, row = zone_i % 4, zone_i // 4
            x = int(col * 1070 + 80 + RNG.random() * 840)
            y = int(row * 920 + 70 + RNG.random() * 710)
            records.append([indexes[0][subject], indexes[1][verb], indexes[2][target], indexes[3][state], x, y, zone_i, month_i])
    RNG.shuffle(records)
    chains = [list(key) + [count] for key, count in Counter(tuple(row[:4]) for row in records).most_common()]

    definitions = {
        "street_clutter": ("public_realm", "obstructed", "Street-space obstruction"),
        "pedestrian_obstruction": ("pedestrian_access", "obstructed", "Pedestrian obstruction"),
        "safety_unsafe": ("people_safety", "unsafe", "People-safety risk"),
        "drainage_obstruction": ("drainage_function", "obstructed", "Drainage obstruction"),
    }
    outcomes, outcome_sources = [], []
    for key, (target, state, label) in definitions.items():
        rows = [row for row in records if TARGETS[row[2]] == target and STATES[row[3]] == state]
        counts = Counter(subjects[row[0]] for row in rows)
        total = len(rows)
        shares = [n / total for n in counts.values()] if total else []
        effective = 1 / sum(share * share for share in shares) if shares else 0
        top_subject, top_n = counts.most_common(1)[0] if counts else ("none", 0)
        outcomes.append({"outcome_key": key, "label": label, "n": total, "share_explicit": total / len(records), "unique_subjects": len(counts), "effective_subjects": round(effective, 3), "top_subject": top_subject, "top_subject_share": top_n / total if total else 0})
        outcome_sources.extend({"outcome_key": key, "outcome_cn": label, "subject": subject, "n": n, "share_within_outcome": n / total if total else 0} for subject, n in counts.most_common())

    payload = {
        "version": 1,
        "meta": {"data_classification": "synthetic_demo_only", "generator_seed": SEED, "all_predictions": 9600, "explicit_analysis": len(records), "spatial_records": len(records), "unique_chains": len(chains), "record_schema": ["subject_index", "verb_index", "target_index", "state_index", "x_coordinate", "y_coordinate", "zone_index", "month_index"], "records_file": "explorer_records.json.gz", "records_are_external": True},
        "dictionaries": {"subjects": subjects, "verbs": VERBS, "targets": TARGETS, "states": STATES, "boroughs": ZONES, "months": MONTHS},
        "chains": chains,
        "borough_geometry": make_geometry(),
        "outcomes": outcomes,
        "outcome_sources": outcome_sources,
    }
    for output in (ROOT / "data" / "explorer_data.json", ROOT / "docs" / "data" / "explorer_data.json"):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    record_bytes = json.dumps({"version": 1, "data_classification": "synthetic_demo_only", "records": records}, separators=(",", ":")).encode()
    with (ROOT / "docs" / "data" / "explorer_records.json.gz").open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(record_bytes)
    print(json.dumps({"synthetic_records": len(records), "synthetic_chains": len(chains), "seed": SEED}, indent=2))


if __name__ == "__main__":
    main()
