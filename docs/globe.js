// =============================================================
// Atolls of the World — globe + interactions
// Built on Globe.gl (Three.js) + d3-scale + d3-scale-chromatic
// =============================================================

const fmtKm2  = d3.format(",.0f");
const fmtSmall = d3.format(",.2f");

const REGION_ORDER = [
  "Pacific Ocean", "France/Pacific Ocean", "Asia", "Indian Ocean",
  "France/Indian Ocean", "Australia", "Caribbean", "Red Sea", "Kiribati",
];

const REGION_COLORS = {
  "Pacific Ocean":         "#ff7964",
  "France/Pacific Ocean":  "#f4ad6b",
  "Asia":                  "#6be0d0",
  "Indian Ocean":          "#9fb9ff",
  "France/Indian Ocean":   "#c195ff",
  "Australia":             "#ffd07b",
  "Caribbean":             "#ff9fd3",
  "Red Sea":               "#ff5a3c",
  "Kiribati":              "#7be0a8",
};

const ORIGIN_COLORS = {
  oceanic: "#6be0d0",
  continental: "#ff7964",
  "main land": "#d7a85b",
  unknown: "#7d7864",
};

// Globe surface palette (parchment land on indigo ocean)
const COUNTRY_FILL   = "rgba(243,232,207,0.20)";
const COUNTRY_STROKE = "rgba(243,232,207,0.55)";
const OCEAN_COLOR    = "#173959";
const OCEAN_EMISSIVE = "#0a1f33";
const ATMO_COLOR     = "#7ed3ff";

// ---- State ---------------------------------------------------
const state = {
  raw: [],
  filtered: [],
  activeRegions: new Set(),
  minArea: 0,
  search: "",
  colorMode: "region",
  pinned: null,
};

// ---- Utilities -----------------------------------------------
function dominantOrigin(atoll) {
  const counts = {};
  for (const c of Object.values(atoll.l5 || {})) {
    counts[c.l1] = (counts[c.l1] || 0) + (c.km2 || 0);
  }
  let best = "unknown", bestV = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestV) { best = k; bestV = v; }
  }
  return best;
}

function colorFor(atoll, mode) {
  if (mode === "region")   return REGION_COLORS[atoll.region] || "#fff";
  if (mode === "origin")   return ORIGIN_COLORS[atoll.origin] || ORIGIN_COLORS.unknown;
  if (mode === "richness") {
    const t = Math.min(1, (atoll.l5_classes_n || 0) / 18);
    return d3.interpolateMagma(0.20 + 0.70 * t);
  }
  return "#fff";
}

// Pin marker size grows softly with atoll area
function pinScaleFor(atoll) {
  const a = atoll.area_km2 || 0.1;
  return 0.85 + 0.18 * Math.log10(1 + a);   // 0.85–~1.6×
}

// SVG teardrop pin — sized ~30px tall at scale=1; margin offset
// anchors the *tip* of the pin at the atoll coordinate (Globe.gl
// positions the element's top-left at that point).
function pinSvg(atoll, color) {
  const s = pinScaleFor(atoll);
  const w = 22 * s, h = 30 * s;
  return `
    <div class="atoll-pin" data-atoll="${atoll.name.replace(/"/g, "&quot;")}"
         style="color:${color};width:${w}px;height:${h}px;
                margin-left:${-w/2}px;margin-top:${-h}px;">
      <svg viewBox="0 0 22 30" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <path class="atoll-pin__core"
              d="M11 0 C5 0, 1 4.2, 1 10.3 C1 18, 11 30, 11 30 C11 30, 21 18, 21 10.3 C21 4.2, 17 0, 11 0 Z"
              fill="${color}" fill-opacity="0.92"/>
        <circle class="atoll-pin__dot" cx="11" cy="10.4" r="2.6"/>
      </svg>
    </div>`;
}

// ---- Tooltip -------------------------------------------------
const tt = document.getElementById("tooltip");
function placeTip(x, y) {
  const tw = 280, th = 200;
  const px = Math.min(window.innerWidth  - tw - 12, x + 14);
  const py = Math.min(window.innerHeight - th - 12, y + 14);
  tt.style.left = Math.max(8, px) + "px";
  tt.style.top  = Math.max(8, py) + "px";
}
function showTip(atoll, x, y) {
  tt.innerHTML = `
    <p class="tooltip__name">${atoll.name}</p>
    <p class="tooltip__where">${atoll.region || ""} · ${atoll.archipelago || ""}</p>
    <dl class="tooltip__stats">
      <dt>Area</dt><dd>${fmtKm2(atoll.area_km2 || 0)} km²</dd>
      <dt>Richness</dt><dd>${atoll.l5_classes_n} L5 classes</dd>
      <dt>Origin</dt><dd>${atoll.origin}</dd>
      <dt>Latitude</dt><dd>${atoll.lat?.toFixed(2)}°</dd>
      <dt>Longitude</dt><dd>${atoll.lon?.toFixed(2)}°</dd>
    </dl>`;
  placeTip(x, y);
  tt.classList.add("is-open");
}
function hideTip() { tt.classList.remove("is-open"); }

// ---- Detail panel --------------------------------------------
const detail = document.getElementById("detail");
function renderDetail(atoll) {
  if (!atoll) {
    detail.innerHTML = `<p class="detail__empty">Hover the globe to inspect an atoll.<br>
      Click to pin its full geomorphological profile here.</p>`;
    return;
  }
  const bars = Object.entries(atoll.l4 || {})
    .sort(([, a], [, b]) => b - a);
  const maxV = bars.length ? bars[0][1] : 1;
  const barHtml = bars.map(([k, v]) => {
    const pct = (v / maxV) * 100;
    return `
      <div class="bar">
        <span class="bar__label">${k}</span>
        <span class="bar__value">${fmtSmall(v)} km²</span>
        <span class="bar__track"><span class="bar__fill" style="width:${pct}%"></span></span>
      </div>`;
  }).join("");

  detail.innerHTML = `
    <h2 class="detail__name">${atoll.name}</h2>
    <p class="detail__where">${atoll.region || ""} · ${atoll.archipelago || ""}</p>
    <dl>
      <div class="detail__row"><dt>Total area</dt><dd>${fmtKm2(atoll.area_km2 || 0)} km²</dd></div>
      <div class="detail__row"><dt>Geomorph. richness</dt><dd>${atoll.l5_classes_n} L5 classes</dd></div>
      <div class="detail__row"><dt>Origin</dt><dd>${atoll.origin}</dd></div>
      <div class="detail__row"><dt>Coordinates</dt><dd>${atoll.lat?.toFixed(3)}°, ${atoll.lon?.toFixed(3)}°</dd></div>
    </dl>
    <section class="detail__chart">
      <h3>Composition by L4 class</h3>
      <div class="bars">${barHtml || '<p class="detail__empty">No L4 breakdown.</p>'}</div>
    </section>`;
}

// ---- Filters → derived list ----------------------------------
function applyFilters() {
  const q = state.search.trim().toLowerCase();
  state.filtered = state.raw.filter(a => {
    if (!a.lat || !a.lon) return false;
    if (state.activeRegions.size && !state.activeRegions.has(a.region)) return false;
    if ((a.area_km2 || 0) < state.minArea) return false;
    if (q && !a.name.toLowerCase().includes(q)) return false;
    return true;
  });
  refreshGlobe();
  refreshHud();
}

function refreshHud() {
  document.getElementById("hud-count").textContent =
    state.filtered.length.toLocaleString();
  const sum = state.filtered.reduce((s, a) => s + (a.area_km2 || 0), 0);
  document.getElementById("hud-area").textContent = fmtKm2(sum);
}

// ---- Globe ---------------------------------------------------
let world;
function initGlobe() {
  const el = document.getElementById("globe");
  world = Globe()(el)
    .backgroundColor("rgba(0,0,0,0)")
    .showAtmosphere(true)
    .atmosphereColor(ATMO_COLOR)
    .atmosphereAltitude(0.20)
    .htmlElementsData([])
    .htmlLat("lat")
    .htmlLng("lon")              // *** our JSON uses `lon`, Globe.gl's default is `lng` ***
    .htmlAltitude(0.01)
    .htmlElement(d => {
      const wrap = document.createElement("div");
      wrap.innerHTML = pinSvg(d, colorFor(d, state.colorMode));
      const pin = wrap.firstElementChild;
      pin.addEventListener("pointerenter", e => {
        pin.classList.add("is-active");
        showTip(d, e.clientX, e.clientY);
      });
      pin.addEventListener("pointermove", e => {
        if (tt.classList.contains("is-open")) placeTip(e.clientX, e.clientY);
      });
      pin.addEventListener("pointerleave", () => {
        pin.classList.remove("is-active");
        hideTip();
      });
      pin.addEventListener("click", e => {
        e.stopPropagation();
        handleClick(d);
      });
      return pin;
    });

  // Globe sphere — lifted enough off black to actually read as a globe
  const gm = world.globeMaterial();
  gm.color             = new THREE.Color(OCEAN_COLOR);
  gm.emissive          = new THREE.Color(OCEAN_EMISSIVE);
  gm.emissiveIntensity = 0.30;
  gm.shininess         = 1.2;

  const ctl = world.controls();
  ctl.autoRotate      = true;
  ctl.autoRotateSpeed = 0.45;
  ctl.enableDamping   = true;
  ctl.dampingFactor   = 0.08;

  // Country outlines (cheap — small dataset, low extrusion)
  fetch("https://cdn.jsdelivr.net/npm/three-globe/example/country-polygons/ne_110m_admin_0_countries.geojson")
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(geo => {
      world.polygonsData(geo.features)
           .polygonCapColor(()    => COUNTRY_FILL)
           .polygonSideColor(()   => "rgba(243,232,207,0.04)")
           .polygonStrokeColor(() => COUNTRY_STROKE)
           .polygonAltitude(0.005)
           .polygonLabel(() => "");
      console.log(`[globe] countries loaded: ${geo.features.length}`);
    })
    .catch(err => console.warn("[globe] country outlines failed:", err));

  // Atoll reef-rim outlines via the LIGHTWEIGHT pathsData layer.
  // Each path is a tube along the rim — far cheaper than extruded
  // polygons. Source file is ~100 KB and limited to atolls ≥50 km².
  fetch("data/atoll-paths.json")
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(data => {
      world.pathsData(data.paths)
           .pathPoints("coords")
           .pathPointLat(p => p[0])
           .pathPointLng(p => p[1])
           .pathPointAlt(0.006)
           .pathColor(p =>
             [REGION_COLORS[p.region] || "#ff7964",
              "rgba(255,212,160,0.0)"])     // fade tail for a halo feel
           .pathStroke(1.4)
           .pathDashLength(1)
           .pathDashGap(0)
           .pathTransitionDuration(0);
      console.log(`[globe] atoll paths loaded: ${data.paths.length}`);
    })
    .catch(err => console.warn("[globe] atoll paths failed:", err));

  let resumeTimer;
  ctl.addEventListener("start", () => { clearTimeout(resumeTimer); ctl.autoRotate = false; });
  ctl.addEventListener("end",   () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (!state.pinned) ctl.autoRotate = true;
    }, 4000);
  });

  // Keep canvas sized to its stage
  const stage = document.querySelector(".globe-stage");
  const sync = () => world.width(stage.clientWidth).height(stage.clientHeight);
  sync();
  new ResizeObserver(sync).observe(stage);
  window.addEventListener("orientationchange", () => setTimeout(sync, 250));

  // Start framed on the Indo-Pacific atoll belt (Maldives → Marshall Islands)
  world.pointOfView({ lat: 5, lng: 105, altitude: 2.0 }, 0);
  console.log(`[globe] ready, ${state.filtered.length} points to draw`);
}

function refreshGlobe() {
  if (!world) return;
  // Pass FRESH OBJECT REFERENCES so Globe.gl's html-layer can't
  // shortcut on identity. Without this, filtering reduces the array
  // but Globe.gl keeps the original DOM nodes for unchanged refs —
  // the UI changes don't propagate to the globe.
  const fresh = state.filtered.map(a => ({ ...a }));
  world.htmlElementsData(fresh);
  requestAnimationFrame(() => {
    const n = document.querySelectorAll(".atoll-pin").length;
    console.log(`[globe] requested ${fresh.length} pins; ${n} in DOM`);
  });
}

function handleClick(point) {
  if (!point || !world) return;
  state.pinned = point;
  world.controls().autoRotate = false;
  world.pointOfView({ lat: point.lat, lng: point.lon, altitude: 1.2 }, 1400);
  renderDetail(point);
  document.body.classList.add("has-pinned");
  // On mobile, open the detail tray automatically
  if (window.matchMedia("(max-width: 800px)").matches) {
    openTray("rail-right");
  }
}

// ---- Filters UI ----------------------------------------------
function buildChips() {
  const wrap = document.getElementById("region-chips");
  const regions = REGION_ORDER.filter(r =>
    state.raw.some(a => a.region === r)
  );
  wrap.innerHTML = regions.map(r => `
    <button class="chip" data-region="${r}" aria-pressed="false">
      <span class="chip__swatch" style="background:${REGION_COLORS[r]}"></span>${r}
    </button>`).join("");
  wrap.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = btn.dataset.region;
      const on = !state.activeRegions.has(r);
      if (on) state.activeRegions.add(r); else state.activeRegions.delete(r);
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
      applyFilters();
    });
  });
  buildLegend();
}

function bindControls() {
  document.getElementById("search").addEventListener("input", e => {
    state.search = e.target.value;
    applyFilters();
  });

  const slider = document.getElementById("area-min");
  const sliderOut = document.getElementById("area-min-out");
  slider.addEventListener("input", e => {
    state.minArea = +e.target.value;
    sliderOut.textContent = state.minArea ? `≥ ${state.minArea}` : "0";
    applyFilters();
  });

  document.querySelectorAll("#color-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#color-mode button").forEach(b => {
        b.classList.remove("is-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");
      state.colorMode = btn.dataset.mode;
      refreshGlobe();
      buildLegend();
    });
  });

  // Mobile tray toggles + scrim + close buttons
  const scrim = document.getElementById("scrim");

  document.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.toggle;
      const target = document.getElementById(id);
      const willOpen = !target.classList.contains("is-open");
      // Close any other open tray first
      document.querySelectorAll(".rail.is-open").forEach(r => {
        if (r !== target) r.classList.remove("is-open");
      });
      document.querySelectorAll(".tray-toggle.is-active").forEach(t => {
        if (t !== btn) t.classList.remove("is-active");
      });
      target.classList.toggle("is-open", willOpen);
      btn.classList.toggle("is-active", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
      scrim.classList.toggle("is-open", willOpen);
    });
  });

  // Explicit close buttons inside each rail
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      closeAllTrays();
    });
  });

  // Tap on scrim closes any open tray
  scrim.addEventListener("click", closeAllTrays);

  // ESC closes any open tray
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeAllTrays();
  });
}

function openTray(id) {
  const target = document.getElementById(id);
  const btn = document.querySelector(`[data-toggle="${id}"]`);
  target?.classList.add("is-open");
  btn?.classList.add("is-active");
  btn?.setAttribute("aria-expanded", "true");
  document.getElementById("scrim")?.classList.add("is-open");
}

function closeAllTrays() {
  document.querySelectorAll(".rail.is-open")
          .forEach(r => r.classList.remove("is-open"));
  document.querySelectorAll(".tray-toggle.is-active")
          .forEach(t => {
            t.classList.remove("is-active");
            t.setAttribute("aria-expanded", "false");
          });
  document.getElementById("scrim")?.classList.remove("is-open");
}

function buildLegend() {
  const legend = document.getElementById("legend-list");
  if (state.colorMode === "region") {
    const regions = REGION_ORDER.filter(r => state.raw.some(a => a.region === r));
    legend.innerHTML = regions.map(r => {
      const n = state.raw.filter(a => a.region === r).length;
      return `<li>
        <span class="legend__swatch" style="background:${REGION_COLORS[r]}"></span>
        ${r} <span style="margin-left:auto;color:var(--text-quiet)">${n}</span>
      </li>`;
    }).join("");
    return;
  }
  if (state.colorMode === "origin") {
    legend.innerHTML = Object.entries(ORIGIN_COLORS).map(([k, c]) => {
      const n = state.raw.filter(a => a.origin === k).length;
      return `<li>
        <span class="legend__swatch" style="background:${c}"></span>
        ${k} <span style="margin-left:auto;color:var(--text-quiet)">${n}</span>
      </li>`;
    }).join("");
    return;
  }
  if (state.colorMode === "richness") {
    legend.innerHTML = [2, 6, 10, 14, 18].map(n => {
      const t = Math.min(1, n / 18);
      const c = d3.interpolateMagma(0.20 + 0.70 * t);
      return `<li>
        <span class="legend__swatch" style="background:${c}"></span>
        ${n} L5 classes
      </li>`;
    }).join("");
  }
}

// ---- WebGL probe ---------------------------------------------
function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl") ||
              c.getContext("experimental-webgl"));
  } catch { return false; }
}

function showWebGLFallback() {
  const stage = document.getElementById("globe");
  stage.innerHTML = `
    <div class="webgl-fallback">
      <p class="webgl-fallback__title">The globe needs WebGL to spin.</p>
      <p class="webgl-fallback__sub">
        This browser hasn’t exposed a WebGL context.<br>
        Try a desktop Chrome, Firefox, or Safari — or a recent mobile browser.
      </p>
    </div>`;
}

// ---- Bootstrap -----------------------------------------------
async function main() {
  const res = await fetch("data/atolls.json");
  const payload = await res.json();
  state.raw = payload.atolls.map(a => ({
    ...a,
    origin: dominantOrigin(a),
  }));
  state.filtered = state.raw.filter(a => a.lat && a.lon);

  buildChips();
  bindControls();
  refreshHud();

  if (!hasWebGL()) {
    showWebGLFallback();
    return;
  }

  try {
    initGlobe();
    refreshGlobe();
    const stage = document.querySelector(".globe-stage");
    stage.animate(
      [ { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0)" } ],
      { duration: 900, easing: "ease-out", fill: "both" }
    );
  } catch (err) {
    console.error("globe init failed:", err);
    showWebGLFallback();
  }
}

main().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend",
    `<pre style="color:var(--coral);padding:20px;font-family:var(--f-mono);font-size:11px">${err.stack}</pre>`);
});
