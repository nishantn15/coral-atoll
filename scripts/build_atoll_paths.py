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
import math
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import shapefile


# ---------------------------------------------------------------
# Pure-Python inverse Transverse Mercator (Snyder, USGS 1987).
# A handful of MCRMP shapefiles are stored in projected UTM (e.g.
# Indonesia, French Polynesia archipelagos) rather than geographic
# WGS84 — pyproj won't install on Termux so we reproject by hand.
# ---------------------------------------------------------------

WGS84_A  = 6378137.0
WGS84_F  = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)              # eccentricity squared

PRJ_NUM_RE = re.compile(r'PARAMETER\["([^"]+)",([-0-9.eE]+)\]')


def parse_prj(prj_text: str) -> dict | None:
    """Return a dict of {is_projected, central_meridian_deg, false_easting,
    false_northing, scale_factor, projection}. Returns None for GEOGCS-only
    files (already WGS84 lon/lat — no transform needed)."""
    if not prj_text.startswith("PROJCS"):
        return None
    proj_match = re.search(r'PROJECTION\["([^"]+)"\]', prj_text)
    if not proj_match or "Transverse_Mercator" not in proj_match.group(1):
        return {"unsupported": True, "projection": proj_match.group(1) if proj_match else "?"}
    params = {k: float(v) for k, v in PRJ_NUM_RE.findall(prj_text)}
    return {
        "projection": "Transverse_Mercator",
        "lat_0": math.radians(params.get("latitude_of_origin", 0.0)),
        "lon_0": math.radians(params.get("central_meridian", 0.0)),
        "k_0":   params.get("scale_factor", 1.0),
        "fe":    params.get("false_easting", 0.0),
        "fn":    params.get("false_northing", 0.0),
    }


def inverse_tm(x: float, y: float, p: dict) -> tuple[float, float]:
    """Snyder eqs 8-1 to 8-3 + 7-1: inverse Transverse Mercator on WGS84.
    Returns (lon_deg, lat_deg)."""
    a, e2 = WGS84_A, WGS84_E2
    M = (y - p["fn"]) / p["k_0"]
    mu = M / (a * (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu
            + (3*e1/2 - 27*e1**3/32) * math.sin(2*mu)
            + (21*e1**2/16 - 55*e1**4/32) * math.sin(4*mu)
            + (151*e1**3/96) * math.sin(6*mu)
            + (1097*e1**4/512) * math.sin(8*mu))
    eprime2 = e2 / (1 - e2)
    sinp, cosp, tanp = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    C1 = eprime2 * cosp**2
    T1 = tanp**2
    N1 = a / math.sqrt(1 - e2*sinp**2)
    R1 = a*(1 - e2) / (1 - e2*sinp**2)**1.5
    D  = (x - p["fe"]) / (N1 * p["k_0"])

    lat = phi1 - (N1*tanp/R1) * (
        D**2/2
        - (5 + 3*T1 + 10*C1 - 4*C1**2 - 9*eprime2) * D**4/24
        + (61 + 90*T1 + 298*C1 + 45*T1**2 - 252*eprime2 - 3*C1**2) * D**6/720)
    lon = p["lon_0"] + (
        D
        - (1 + 2*T1 + C1) * D**3/6
        + (5 - 2*C1 + 28*T1 - 3*C1**2 + 8*eprime2 + 24*T1**2) * D**5/120) / cosp
    return math.degrees(lon), math.degrees(lat)


def valid_lonlat(x: float, y: float) -> bool:
    return -180.0 <= x <= 180.0 and -90.0 <= y <= 90.0

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
    polygon in this shapefile, reprojected to WGS84 lon/lat if the
    accompanying .prj file specifies a Transverse Mercator UTM zone."""
    try:
        sf = shapefile.Reader(str(shp_path.with_suffix("")))
    except Exception:
        return None
    # Inspect the .prj
    prj_path = shp_path.with_suffix(".prj")
    proj_info = None
    if prj_path.exists():
        try:
            proj_info = parse_prj(prj_path.read_text())
        except Exception:
            proj_info = None
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
    if not best:
        return None
    # Reproject if needed
    if proj_info and proj_info.get("projection") == "Transverse_Mercator":
        best = [inverse_tm(x, y, proj_info) for x, y in best]
    elif proj_info and proj_info.get("unsupported"):
        # Unknown projection (rare in this dataset) — bail; caller will skip
        return None
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
                    if not all(valid_lonlat(x, y) for x, y in ring):
                        # Safety net: a vertex is still outside [-180,180]/[-90,90]
                        # — drop the whole path rather than corrupt the globe.
                        print(f"    [drop] {shp.stem}: out-of-range coord "
                              f"e.g. {ring[0]}")
                        continue
                    if ring[0] != ring[-1]:
                        ring = ring + [ring[0]]
                    paths.append({
                        "name": atoll["name"],
                        "region": atoll.get("region"),
                        "area_km2": atoll.get("area_km2"),
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
