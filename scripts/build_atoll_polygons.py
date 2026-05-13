"""Build docs/data/atoll-polygons.json — one GeoJSON FeatureCollection
holding the geomorphic polygons of every atoll in the MCRMP archive.

Each regional zip in references/gis_raw/ contains per-country sub-zips,
each of which contains one shapefile per atoll (multiple POLYGON features
keyed by L1-L5 attributes). We collapse each atoll's polygons into a
single MultiPolygon feature, tagged with `name`, `region`, `archipelago`,
and `area_km2` so the same join keys match docs/data/atolls.json.

Coordinates are rounded to 5 decimal places (~1 m at the equator) and
polygons with fewer than 5 points after rounding are dropped to keep
the payload web-friendly.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import shapefile  # pyshp

ROOT = Path("/storage/emulated/0/Download/coral-atoll")
GIS_RAW = ROOT / "references/gis_raw"
ATOLLS_JSON = ROOT / "docs/data/atolls.json"
OUT = ROOT / "docs/data/atoll-polygons.json"
COORD_DECIMALS = 4         # ~11 m at the equator (Landsat is 30 m, so plenty)
MIN_RING_POINTS = 6        # drop near-zero-area rings
KEEP_L3 = {"Atoll rim", "Pass", "Patch reefs"}  # the visible reef structure
MAX_RING_POINTS = 28       # decimate rings longer than this (web-friendly)


def load_atoll_lookup() -> dict[str, dict]:
    """name -> { region, archipelago, area_km2 } from the canonical join."""
    payload = json.loads(ATOLLS_JSON.read_text())
    lut: dict[str, dict] = {}
    for a in payload["atolls"]:
        lut[a["name"].lower().strip()] = {
            "name": a["name"],
            "region": a["region"],
            "archipelago": a["archipelago"],
            "area_km2": a["area_km2"],
        }
    return lut


def atoll_name_from_filename(stem: str) -> str:
    """`chagos_blenheimreef_2020` → `blenheimreef`
    Strip leading country prefix and trailing `_YYYY`; collapse underscores.
    """
    s = stem
    s = re.sub(r"_20\d{2}$", "", s)        # trailing year
    s = re.sub(r"^[A-Za-z]+_", "", s, count=1)  # country prefix
    s = s.replace("_", " ").strip()
    return s.lower()


def round_ring(ring):
    return [(round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)) for x, y in ring]


def decimate(ring, target=MAX_RING_POINTS):
    """If a ring has too many vertices, keep evenly-spaced samples + the first/last."""
    if len(ring) <= target:
        return ring
    step = len(ring) / target
    keep = [ring[int(i * step)] for i in range(target)]
    if keep[0] != ring[-1]:
        keep.append(ring[-1])
    # drop consecutive duplicates after rounding
    out = [keep[0]]
    for p in keep[1:]:
        if p != out[-1]:
            out.append(p)
    return out


def shape_to_polygons(shp) -> list[list[list[tuple]]]:
    """Convert a pyshp POLYGON shape (potentially with multiple parts) into
    a list of polygons-as-list-of-rings. Each part is treated as its own
    polygon (no hole detection — fine for atoll fragments at our zoom)."""
    pts = shp.points
    parts = list(shp.parts) + [len(pts)]
    polys = []
    for i in range(len(parts) - 1):
        ring = pts[parts[i]: parts[i + 1]]
        ring = round_ring(ring)
        # drop consecutive duplicates introduced by rounding
        dedup = [ring[0]] if ring else []
        for p in ring[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if len(dedup) < MIN_RING_POINTS:
            continue
        dedup = decimate(dedup)
        if dedup[0] != dedup[-1]:
            dedup = dedup + [dedup[0]]
        polys.append([dedup])
    return polys


MAX_POLYS_PER_ATOLL = 30   # cap rings per atoll; drop the smallest


def ring_extent(ring):
    """Rough bbox diagonal — used to rank ring 'visibility'."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


def collect_atoll(shp_path: Path) -> dict | None:
    """Read every polygon in one atoll's shapefile, KEEPING ONLY the
    visible reef structure (rim, passes, patch reefs). Cap to the
    MAX_POLYS_PER_ATOLL largest rings. Return one GeoJSON feature."""
    try:
        sf = shapefile.Reader(str(shp_path.with_suffix("")))
    except Exception as e:
        print(f"  [warn] cannot read {shp_path.name}: {e}")
        return None
    polys: list[list[list[tuple]]] = []
    records = sf.records()
    shapes = sf.shapes()
    for rec, shp in zip(records, shapes):
        rec_d = rec.as_dict()
        l3 = (rec_d.get("L3_ATTRIB_") or "").strip()
        if l3 not in KEEP_L3:
            continue
        polys.extend(shape_to_polygons(shp))
    sf.close()
    if not polys:
        return None
    if len(polys) > MAX_POLYS_PER_ATOLL:
        polys.sort(key=lambda p: -ring_extent(p[0]))
        polys = polys[:MAX_POLYS_PER_ATOLL]
    return {
        "type": "Feature",
        "geometry": {"type": "MultiPolygon", "coordinates": polys},
        "properties": {"file_stem": shp_path.stem},
    }


def walk_region(region_zip: Path, scratch: Path,
                lut: dict[str, dict]) -> list[dict]:
    """Unpack a regional zip then every nested per-country zip,
    yielding one feature per atoll shapefile."""
    features: list[dict] = []
    region_root = scratch / region_zip.stem
    region_root.mkdir(exist_ok=True)
    with zipfile.ZipFile(region_zip) as z:
        z.extractall(region_root)

    # Find inner per-country zips (1-2 levels deep)
    inner_zips = []
    for dirpath, _, files in os.walk(region_root):
        for fn in files:
            if fn.endswith(".zip"):
                inner_zips.append(Path(dirpath) / fn)

    matched = 0
    unmatched_names: list[str] = []
    for iz in inner_zips:
        ctry_dir = scratch / f"{region_zip.stem}__{iz.stem}"
        ctry_dir.mkdir(exist_ok=True)
        try:
            with zipfile.ZipFile(iz) as z:
                z.extractall(ctry_dir)
        except zipfile.BadZipFile:
            print(f"  [warn] bad zip {iz.name}, skipping")
            continue

        shp_files = []
        for dirpath, _, files in os.walk(ctry_dir):
            for fn in files:
                if fn.endswith(".shp"):
                    shp_files.append(Path(dirpath) / fn)

        for shp in shp_files:
            feat = collect_atoll(shp)
            if not feat:
                continue
            stem = shp.stem
            atoll_key = atoll_name_from_filename(stem)
            # Direct hit on the canonical join's lowercased names?
            meta = lut.get(atoll_key)
            if not meta:
                # try one common variant: hyphens vs spaces
                meta = lut.get(atoll_key.replace("-", " "))
            if not meta:
                # try collapsing all non-alnum
                key2 = re.sub(r"[^a-z0-9]", "", atoll_key)
                for k, v in lut.items():
                    if re.sub(r"[^a-z0-9]", "", k) == key2:
                        meta = v
                        break
            if meta:
                feat["properties"].update(meta)
                feat["properties"]["matched"] = True
                matched += 1
            else:
                feat["properties"]["matched"] = False
                feat["properties"]["name"] = stem
                feat["properties"]["region"] = region_zip.stem
                unmatched_names.append(stem)
            features.append(feat)

        shutil.rmtree(ctry_dir, ignore_errors=True)

    shutil.rmtree(region_root, ignore_errors=True)
    print(f"  {region_zip.stem}: {len(features)} polygons, "
          f"{matched} matched to atolls.json")
    if unmatched_names[:3]:
        print(f"  unmatched samples: {unmatched_names[:3]}")
    return features


def main() -> None:
    lut = load_atoll_lookup()
    print(f"Loaded {len(lut)} atolls from {ATOLLS_JSON.name}")

    scratch = Path(tempfile.mkdtemp(prefix="atoll_polys_"))
    try:
        all_features: list[dict] = []
        for region_zip in sorted(GIS_RAW.glob("*.zip")):
            print(f"Processing {region_zip.name} ({region_zip.stat().st_size/1024:.0f} KB) …")
            all_features.extend(walk_region(region_zip, scratch, lut))

        fc = {
            "type": "FeatureCollection",
            "license": "CC-BY-NC-SA 4.0",
            "source": "Andréfouët S., 2023, MCRMP, DataSuds",
            "features": all_features,
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        # Compact JSON to keep wire bytes down
        OUT.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
        print(f"\n[ok] wrote {len(all_features)} features → {OUT} "
              f"({OUT.stat().st_size/1024/1024:.2f} MB)")
        matched_count = sum(1 for f in all_features if f["properties"].get("matched"))
        print(f"[ok] {matched_count} features matched to atolls.json names")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
