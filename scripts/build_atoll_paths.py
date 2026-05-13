"""Build docs/data/atoll-paths.json — a small payload of atoll-rim
outlines for Globe.gl's pathsData layer.

Strategy:
  - Only atolls with area_km2 >= MIN_AREA (defaults to 50 km²) — keeps
    the visual emphasis on the largest, most recognisable atolls.
  - For each atoll, pick the LARGEST L3="Atoll rim" polygon (its outer
    boundary) and use that single ring as the path.
  - Decimate the ring to MAX_POINTS evenly-spaced vertices.

Result: ~80-100 paths, well under 100 KB on the wire, lightweight
enough for mobile WebGL.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import shapefile

ROOT = Path("/storage/emulated/0/Download/coral-atoll")
GIS_RAW = ROOT / "references/gis_raw"
ATOLLS_JSON = ROOT / "docs/data/atolls.json"
OUT = ROOT / "docs/data/atoll-paths.json"

MIN_AREA_KM2 = 50          # atolls smaller than this become pins-only
MAX_POINTS = 20            # vertices per path (cheap to render)
COORD_DECIMALS = 4         # ~11 m


def load_atoll_lookup() -> dict[str, dict]:
    payload = json.loads(ATOLLS_JSON.read_text())
    return {a["name"].lower().strip(): a for a in payload["atolls"]}


def atoll_name_from_filename(stem: str) -> str:
    s = re.sub(r"_20\d{2}$", "", stem)
    s = re.sub(r"^[A-Za-z\-]+_", "", s, count=1)
    return s.replace("_", " ").strip().lower()


def match(stem: str, lut: dict[str, dict]) -> dict | None:
    key = atoll_name_from_filename(stem)
    if key in lut:
        return lut[key]
    key2 = key.replace("-", " ")
    if key2 in lut:
        return lut[key2]
    flat = re.sub(r"[^a-z0-9]", "", key)
    for k, v in lut.items():
        if re.sub(r"[^a-z0-9]", "", k) == flat:
            return v
    return None


def ring_extent(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


def decimate(pts, n):
    if len(pts) <= n:
        return pts
    step = len(pts) / n
    return [pts[int(i * step)] for i in range(n)]


def largest_rim_ring(shp_path: Path) -> list[tuple] | None:
    """Return the outer boundary ring of the largest L3='Atoll rim'
    polygon in this shapefile, or None if no rim found."""
    try:
        sf = shapefile.Reader(str(shp_path.with_suffix("")))
    except Exception:
        return None
    best = None
    best_extent = -1.0
    for rec, shp in zip(sf.records(), sf.shapes()):
        rec_d = rec.as_dict()
        if (rec_d.get("L3_ATTRIB_") or "").strip() != "Atoll rim":
            continue
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for i in range(len(parts) - 1):
            ring = pts[parts[i]: parts[i + 1]]
            if len(ring) < 6:
                continue
            ext = ring_extent(ring)
            if ext > best_extent:
                best_extent = ext
                best = ring
    sf.close()
    return best


def main() -> None:
    lut = load_atoll_lookup()
    print(f"Loaded {len(lut)} atolls from {ATOLLS_JSON.name}")

    scratch = Path(tempfile.mkdtemp(prefix="atoll_paths_"))
    paths: list[dict] = []
    try:
        for region_zip in sorted(GIS_RAW.glob("*.zip")):
            print(f"  {region_zip.name} …", end=" ")
            region_dir = scratch / region_zip.stem
            region_dir.mkdir(exist_ok=True)
            with zipfile.ZipFile(region_zip) as z:
                z.extractall(region_dir)
            inner_zips: list[Path] = []
            for dp, _, fs in os.walk(region_dir):
                inner_zips.extend(Path(dp) / f for f in fs if f.endswith(".zip"))
            n_kept = 0
            for iz in inner_zips:
                ctry = scratch / f"{region_zip.stem}__{iz.stem}"
                ctry.mkdir(exist_ok=True)
                try:
                    with zipfile.ZipFile(iz) as z:
                        z.extractall(ctry)
                except zipfile.BadZipFile:
                    continue
                shp_files = []
                for dp, _, fs in os.walk(ctry):
                    shp_files.extend(Path(dp) / f for f in fs if f.endswith(".shp"))
                for shp in shp_files:
                    atoll = match(shp.stem, lut)
                    if not atoll or (atoll.get("area_km2") or 0) < MIN_AREA_KM2:
                        continue
                    ring = largest_rim_ring(shp)
                    if not ring:
                        continue
                    ring = decimate(ring, MAX_POINTS)
                    ring = [(round(x, COORD_DECIMALS), round(y, COORD_DECIMALS))
                            for x, y in ring]
                    # close
                    if ring[0] != ring[-1]:
                        ring = ring + [ring[0]]
                    paths.append({
                        "name": atoll["name"],
                        "region": atoll.get("region"),
                        "area_km2": atoll.get("area_km2"),
                        # Globe.gl pathsData wants [lat, lng] tuples.
                        # Our shapefile coords are (lon, lat) — swap.
                        "coords": [[lat, lon] for lon, lat in ring],
                    })
                    n_kept += 1
                shutil.rmtree(ctry, ignore_errors=True)
            shutil.rmtree(region_dir, ignore_errors=True)
            print(f"{n_kept} paths kept")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    paths.sort(key=lambda p: -(p.get("area_km2") or 0))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "license": "CC-BY-NC-SA 4.0",
        "source": "Andréfouët S., 2023, MCRMP, DataSuds",
        "min_area_km2": MIN_AREA_KM2,
        "max_points": MAX_POINTS,
        "paths": paths,
    }, ensure_ascii=False, separators=(",", ":")))
    total_pts = sum(len(p["coords"]) for p in paths)
    print(f"\n[ok] {len(paths)} paths · {total_pts} total vertices → "
          f"{OUT} ({OUT.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
