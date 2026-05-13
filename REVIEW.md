# Coral Atoll Site Review

Date: 2026-05-13

Scope: reviewed the current local folder at `/storage/emulated/0/Download/coral-atoll`, including commit `1744541`, the `docs/` static site, data payloads, scripts, existing Termux screenshots, and the Samsung Internet screenshot at `/storage/emulated/0/DCIM/Screenshots/Screenshot_20260513_152157_Samsung Internet.jpg`. No site source files were changed.

## Current Version

- `HEAD`: `1744541`
- Branch: `main`
- Remote tracking state: `origin/main` also points to `1744541`
- Commit title: `Fix mobile crash: replace extruded polygons with lightweight paths`

The latest commit does include the intended direction: it replaces the heavy atoll polygon payload with `docs/data/atoll-paths.json`, adds `scripts/build_atoll_paths.py`, keeps all 589 plotted pins, and wires favicon assets into `docs/index.html`.

## Checks Run

- Confirmed current commit with `git rev-parse --short HEAD`.
- Reviewed latest commit stats with `git show --stat HEAD`.
- Validated `docs/data/atolls.json` and `docs/data/atoll-paths.json` with `python3 -m json.tool`.
- Compiled `scripts/build_atoll_paths.py` and `scripts/build_atolls_json.py` with `python3 -m py_compile`.
- Inspected the Samsung Internet screenshot supplied by the user.
- Audited `docs/globe.js`, `docs/style.css`, `docs/index.html`, and `scripts/build_atoll_paths.py`.

## Summary

The site is no longer failing only at the "no WebGL" fallback stage. In the Samsung Internet screenshot, WebGL does render, pins appear, and the HUD is present. The page still does not load well: the globe surface is blown out cyan, the outline layer creates dense vertical streaks across the sphere, and bottom UI is partly covered by Samsung Internet browser chrome.

The main regression is in the new atoll path data. `docs/data/atoll-paths.json` contains projected shapefile coordinates mixed into a payload that `docs/globe.js` treats as latitude/longitude. That explains the visual streaking and likely keeps mobile GPU/main-thread cost higher than intended.

## Findings

### Critical: `atoll-paths.json` contains invalid latitude/longitude coordinates

`docs/globe.js:249-253` feeds each atoll path to Globe.gl as `coords` with `pathPointLat(p => p[0])` and `pathPointLng(p => p[1])`.

But the current `docs/data/atoll-paths.json` contains many coordinates outside valid lat/lon ranges:

- 237 total path features
- 4,977 total path vertices
- 43 path features contain invalid coordinates
- 903 vertices are outside `lat [-90, 90]` or `lon [-180, 180]`
- Example invalid path: `Takabonerate Islands` starts with `[9253679.5, 275862.0]`

This appears to come from `scripts/build_atoll_paths.py:146-148`, which assumes every shapefile point is `(lon, lat)` and swaps it to `[lat, lon]`. Some source shapefiles are already in projected coordinate systems, so their meter-like coordinates are being shipped directly to Globe.gl.

Recommendation: treat this as the top fix before visual tuning. Either reproject every shapefile to WGS84 using its `.prj`, or skip any rim whose sampled coordinates are outside valid lat/lon. Add a build-time assertion that fails if any output coordinate is outside valid geographic bounds.

### High: Samsung Internet screenshot confirms the path layer is visually corrupt

The screenshot shows a rendered globe with pins, but the globe is covered in dense vertical line artifacts and the ocean/land surface is washed out. This matches the invalid path-coordinate finding: Globe.gl is drawing tubes across impossible coordinates rather than around atoll rims.

Recommendation: for the next live test, disable `pathsData` entirely or publish only validated WGS84 paths. A pins-only baseline is more useful than a partially rendered outline layer that corrupts the globe.

### High: Mobile bottom controls are still too low for Samsung Internet

`docs/style.css:691-715` positions the tray buttons and HUD with `position: fixed` and `env(safe-area-inset-bottom)`. The screenshot shows Samsung Internet's bottom address/navigation chrome overlapping the HUD area. Android browser toolbars often are not represented by `safe-area-inset-bottom`, so CSS env values alone are not enough.

Recommendation: use `window.visualViewport` to maintain a CSS variable for the visible viewport bottom, or move the HUD/buttons higher on mobile. Test specifically in Samsung Internet with the bottom toolbar visible.

### Medium: 589 SVG HTML pins may still be expensive on mobile

The latest version uses `htmlElementsData` with SVG DOM pins for all plotted atolls (`docs/globe.js:190-214`, `docs/globe.js:286-298`). The screenshot shows large stacked pin clusters. Even without bad paths, 589 DOM nodes with SVG, filters, shadows, hover listeners, and transform updates can be costly on mobile while the globe rotates.

Recommendation: after fixing paths, profile pins separately. If Samsung Internet still stutters, reduce marker size/shadows, disable auto-rotation during initial load, cluster dense regions, or return to Globe.gl's native point layer for the default mobile mode.

### Medium: The outline layer loads immediately instead of progressively

The app loads pins, country polygons, and atoll paths during initial globe setup. The path payload is much smaller than before, but it is still an optional visual layer and should not block the stable baseline.

Recommendation: render pins first, then load outlines after the first frame or after a short idle delay. Add an emergency query flag such as `?outlines=0` so mobile testing can distinguish "globe broken" from "outline layer broken".

### Medium: External CDN dependency remains a reliability risk

The page still loads Three.js, Globe.gl, D3 packages, Google Fonts, and country polygons from external CDNs in `docs/index.html:16-136` and `docs/globe.js:230`. A CDN delay or blocked request can make mobile debugging harder.

Recommendation: for live/mobile testing, vendor critical JS dependencies or at least log a visible dependency-load status. Keep the country polygon fetch non-critical.

### Low: WebGL fallback remains non-interactive

The previous no-WebGL Termux screenshots still show a clear fallback message, but no searchable atoll list. This is less urgent than the current Samsung Internet render corruption because Samsung Internet is reaching WebGL now.

Recommendation: keep a non-WebGL list/detail fallback on the roadmap, but fix the invalid path data first.

## Fixed Since The Previous Review

- Favicon assets are now present under `docs/assets/` and linked from `docs/index.html`.
- The HUD now says `589 of 597 plotted`, which correctly separates plotted from catalogued records.
- Region chips and color-mode buttons now expose some ARIA state.
- Mobile drawers now have close buttons, a scrim, and `aria-expanded` updates.
- `htmlLng("lon")` is set, so pin coordinates use the actual JSON field.

## Recommended Next Live Test

1. Publish a pins-only build by disabling the `fetch("data/atoll-paths.json")` block in `docs/globe.js`.
2. Confirm Samsung Internet loads without the cyan/streak artifacts.
3. Re-enable outlines only after `docs/data/atoll-paths.json` validates every coordinate as WGS84 lat/lon.
4. Move HUD/buttons higher or drive their offset from `visualViewport`, then retest with Samsung Internet's bottom toolbar visible.
