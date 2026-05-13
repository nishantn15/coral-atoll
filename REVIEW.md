# Coral Atoll Site Review

Date: 2026-05-13

Scope: reviewed the static site in `docs/`, the local data payload, existing Termux browser screenshots, and local serving behavior from `/storage/emulated/0/Download/coral-atoll`. No site source files were changed.

## Summary

The atlas has a strong editorial visual direction and the core static structure is clean: `docs/index.html`, `docs/style.css`, `docs/globe.js`, and `docs/data/atolls.json` serve correctly from a simple local HTTP server. The data file is valid JSON and contains 597 atoll records.

The biggest product risk is that the main experience is WebGL-dependent. On Termux/mobile screenshots where WebGL is unavailable, the site falls back gracefully enough to explain the issue, but the actual atlas becomes non-interactive.

## Checks Run

- Served `docs/` locally with `python3 -m http.server` on `127.0.0.1:8876`.
- Verified `GET /`, `GET /globe.js`, `GET /style.css`, and `GET /data/atolls.json` return successfully.
- Validated `docs/data/atolls.json` with `python3 -m json.tool`.
- Compiled `scripts/build_atolls_json.py` with `python3 -m py_compile`.
- Reviewed static text output with `w3m`.
- Reviewed existing screenshots under `screenshots/.termux-browser-cli/`.

## Findings

### High: WebGL fallback removes the core experience

`docs/globe.js:400` switches to `showWebGLFallback()` when no WebGL context is available. The existing Termux browser screenshots show this path on mobile and desktop. The fallback message is clear, but users cannot browse the atolls, search results, or inspect records in a meaningful non-WebGL view.

Recommendation: add a lightweight fallback list or 2D map/table driven by the same filtered data. Even a searchable list with region chips and detail rows would preserve the atlas value on constrained Android browsers.

### Medium: Favicon asset is not wired into the published site

`coral-atoll-favicon.png` exists at the repository root, but `docs/index.html` does not include a `rel="icon"` link. If GitHub Pages is publishing from `docs/`, a root-level favicon file will not be served as part of the published site.

Recommendation: place the final favicon under `docs/` or `docs/assets/` and add favicon links in `docs/index.html`.

### Medium: Runtime depends on external CDNs

The page loads fonts and all major JS dependencies from external hosts in `docs/index.html:9-124`, plus country polygons from jsDelivr in `docs/globe.js:198`. If those CDNs are blocked, slow, or offline, the page will degrade heavily.

Recommendation: vendor the critical JS assets or provide a documented offline build path. Consider Subresource Integrity for third-party scripts if continuing with CDN delivery.

### Medium: 597 total records, 589 geolocated records

The JSON contains 597 records, but 8 records have `null` coordinates and cannot be plotted. `docs/globe.js:394` filters them out of the active globe list. That is reasonable, but the UI copy mixes total catalog size with visible/plotted count.

Recommendation: distinguish "597 catalogued atolls" from "589 plotted atolls" in the HUD or add a small data-quality note.

### Medium: Interactive controls need stronger accessibility state

Region chips, color-mode buttons, and mobile tray toggles are clickable, but they do not expose state with attributes such as `aria-pressed` or `aria-expanded`. The WebGL globe also has no keyboard-accessible equivalent for selecting an atoll.

Relevant areas: `docs/index.html:93-100`, `docs/globe.js:270-318`.

Recommendation: add `aria-pressed` to filter/color buttons, `aria-expanded`/`aria-controls` to tray toggles, and a keyboard-accessible fallback list of filtered atolls.

### Low: Tooltip positioning relies on `window.event`

`docs/globe.js:242` reads `window.event` inside `handleHover()`. That global is not reliable across browsers and event models. If Globe.gl does not populate it, the tooltip falls back to fixed coordinates.

Recommendation: track pointer coordinates from `mousemove` and touch events, then use that stored pointer position in `handleHover()`.

## What Works Well

- The site has a coherent visual identity and the screenshots show strong desktop and mobile composition.
- The mobile tray pattern is clear and works visually in the existing screenshots.
- The WebGL fallback is better than a blank canvas.
- The data pipeline is documented in `README.md`, and the processed JSON validates cleanly.
- The published `docs/` folder is small enough for static hosting, excluding the larger research references.

## Suggested Next Pass

1. Add a non-WebGL searchable list/detail fallback.
2. Wire the favicon into `docs/index.html`.
3. Clarify total vs plotted atoll counts.
4. Add accessibility state to controls.
5. Decide whether CDN delivery is acceptable or whether critical scripts should be vendored.
