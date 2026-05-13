// =============================================================
// Atolls of the World — globe + interactions
// Built on Globe.gl (Three.js) + d3-scale + d3-scale-chromatic
// =============================================================

const fmtKm2 = d3.format(",.0f");
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
  if (mode === "region") return REGION_COLORS[atoll.region] || "#999";
  if (mode === "origin") return ORIGIN_COLORS[atoll.origin] || ORIGIN_COLORS.unknown;
  if (mode === "richness") {
    const n = atoll.l5_classes_n || 0;
    const t = Math.min(1, n / 18);
    return d3.interpolateMagma(0.15 + 0.7 * t);
  }
  return "#fff";
}

function sizeFor(atoll) {
  const a = atoll.area_km2 || 0.1;
  // log scale for radius — gives small atolls a visible footprint without
  // letting Great Chagos blot out half the planet
  return 0.18 + 0.45 * Math.log10(1 + a);
}

function altFor(atoll) {
  const a = atoll.area_km2 || 0.1;
  return 0.005 + 0.012 * Math.log10(1 + a);
}

// ---- Tooltip -------------------------------------------------
const tt = document.getElementById("tooltip");
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
  tt.style.left = x + "px";
  tt.style.top  = y + "px";
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
  // Sort L4 breakdown by area desc
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
  world = Globe()
    (document.getElementById("globe"))
    .backgroundColor("rgba(0,0,0,0)")
    .globeImageUrl(null)             // we draw our own globe
    .showAtmosphere(true)
    .atmosphereColor("#2d6584")
    .atmosphereAltitude(0.16)
    .pointAltitude(d => altFor(d))
    .pointRadius(d => sizeFor(d))
    .pointColor(d => colorFor(d, state.colorMode))
    .pointResolution(8)
    .pointLabel(() => "")             // we render our own tooltip
    .onPointHover(handleHover)
    .onPointClick(handleClick);

  // Custom material for the globe sphere — deep ocean tone
  const globeMaterial = world.globeMaterial();
  globeMaterial.color = new THREE.Color("#0b2237");
  globeMaterial.emissive = new THREE.Color("#06182b");
  globeMaterial.emissiveIntensity = 0.18;
  globeMaterial.shininess = 0.5;

  // Slow auto-rotation
  world.controls().autoRotate = true;
  world.controls().autoRotateSpeed = 0.35;
  world.controls().enableDamping = true;
  world.controls().dampingFactor = 0.08;

  // World countries outline overlay (so users have a frame of reference)
  fetch("https://cdn.jsdelivr.net/npm/three-globe@2.32.6/example/datasets/ne_110m_admin_0_countries.geojson")
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(geo => {
      world
        .polygonsData(geo.features)
        .polygonCapColor(() => "rgba(243,232,207,0.10)")
        .polygonSideColor(() => "rgba(243,232,207,0.02)")
        .polygonStrokeColor(() => "rgba(243,232,207,0.35)")
        .polygonAltitude(0.003);
    })
    .catch(err => console.warn("country outlines failed:", err));

  // Pause autorotate on user interaction
  const ctl = world.controls();
  let userActive = false;
  ctl.addEventListener("start", () => { userActive = true; ctl.autoRotate = false; });
  ctl.addEventListener("end",   () => { setTimeout(() => {
    if (!state.pinned) ctl.autoRotate = true;
  }, 4000); });

  // Resize handle
  const stage = document.querySelector(".globe-stage");
  const ro = new ResizeObserver(() => {
    world.width(stage.clientWidth).height(stage.clientHeight);
  });
  ro.observe(stage);
}

function refreshGlobe() {
  world.pointsData(state.filtered)
       .pointColor(d => colorFor(d, state.colorMode))
       .pointAltitude(d => altFor(d))
       .pointRadius(d => sizeFor(d));
}

function handleHover(point) {
  if (point) {
    document.body.style.cursor = "pointer";
    const e = window.event;
    showTip(point, (e?.clientX ?? 100), (e?.clientY ?? 100));
  } else {
    document.body.style.cursor = "default";
    hideTip();
  }
}

// Better hover position tracking — Globe.gl hands us the datum but not the
// fresh pointer coords, so attach a mousemove on the canvas.
document.addEventListener("mousemove", e => {
  if (tt.classList.contains("is-open")) {
    tt.style.left = e.clientX + "px";
    tt.style.top  = e.clientY + "px";
  }
});

function handleClick(point) {
  if (!point) return;
  state.pinned = point;
  world.controls().autoRotate = false;
  // Fly to atoll
  world.pointOfView({ lat: point.lat, lng: point.lon, altitude: 1.6 }, 1500);
  renderDetail(point);
}

// ---- Filters UI ----------------------------------------------
function buildChips() {
  const wrap = document.getElementById("region-chips");
  const regions = REGION_ORDER.filter(r =>
    state.raw.some(a => a.region === r)
  );
  wrap.innerHTML = regions.map(r => `
    <button class="chip" data-region="${r}">
      <span class="chip__swatch" style="background:${REGION_COLORS[r]}"></span>${r}
    </button>`).join("");
  wrap.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = btn.dataset.region;
      if (state.activeRegions.has(r)) state.activeRegions.delete(r);
      else state.activeRegions.add(r);
      btn.classList.toggle("is-on");
      applyFilters();
    });
  });

  // Legend mirror
  const legend = document.getElementById("legend-list");
  legend.innerHTML = regions.map(r => {
    const n = state.raw.filter(a => a.region === r).length;
    return `<li>
      <span class="legend__swatch" style="background:${REGION_COLORS[r]}"></span>
      ${r} <span style="margin-left:auto;color:var(--text-quiet)">${n}</span>
    </li>`;
  }).join("");
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
      document.querySelectorAll("#color-mode button").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.colorMode = btn.dataset.mode;
      refreshGlobe();
      buildLegend();
    });
  });
}

function buildLegend() {
  const legend = document.getElementById("legend-list");
  if (state.colorMode === "region") {
    buildChips();   // already populates legend
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
      const c = d3.interpolateMagma(0.15 + 0.7 * t);
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
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

function showWebGLFallback() {
  const stage = document.getElementById("globe");
  stage.innerHTML = `
    <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:40px;">
      <div style="max-width:42ch;">
        <p style="font-family:var(--f-display);font-style:italic;font-size:24px;
                  color:var(--bone);line-height:1.3;margin:0 0 14px;">
          The globe needs WebGL to spin.
        </p>
        <p style="font-family:var(--f-mono);font-size:11px;letter-spacing:.12em;
                  text-transform:uppercase;color:var(--text-quiet);line-height:1.7;">
          This browser hasn’t exposed a WebGL context.<br>
          Try a desktop Chrome, Firefox, or Safari — or a recent mobile browser.
        </p>
      </div>
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

  // UI first so rails/chips/legend render even if WebGL is unavailable
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
