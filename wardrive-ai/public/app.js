/**
 * WardDrive AI - Main Application
 * Wardriving route planner powered by WiGLE API
 */

// ============================================================
// KML Parser (inlined — guard prevents duplicate if kml-parser.js
// was accidentally left on the server)
// ============================================================
if (typeof window.KMLParser === "undefined") {
class KMLParser {
  /**
   * Parse a KML string into tracks and points.
   * Uses localName-based element search so it works regardless of
   * namespace prefix (gx:Track, Track, LineString all found the same way).
   * Handles: LineString, gx:Track / Track, gx:MultiTrack, and point collections.
   */
  parse(kmlText) {
    const parser = new DOMParser();
    let doc = parser.parseFromString(kmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      // Try HTML parser as fallback
      doc = parser.parseFromString(kmlText, "text/html");
    }

    // Get ALL elements — we'll filter by localName (ignores namespace prefix)
    const all = Array.from(doc.getElementsByTagName("*"));
    const byLocal = (name) => all.filter(el => el.localName === name);

    const tracks = [];
    const seen = new WeakSet();

    // ── 1. LineString ─────────────────────────────────────────
    for (const ls of byLocal("LineString")) {
      if (seen.has(ls)) continue; seen.add(ls);
      const coords = this._parseKmlCoords(ls);
      if (coords.length >= 2)
        tracks.push({ name: this._nearestName(ls, doc), coords });
    }

    // ── 2. gx:Track / Track ───────────────────────────────────
    //    Group coords from sibling <gx:coord> / <coord> children.
    //    Skip any Track that is a child of MultiTrack (handled below).
    for (const gt of byLocal("Track")) {
      if (seen.has(gt)) continue; seen.add(gt);
      // Skip if parent is a MultiTrack (we'll combine those below)
      if (gt.parentElement && gt.parentElement.localName === "MultiTrack") continue;
      const coords = this._parseGxCoords(gt);
      if (coords.length >= 2)
        tracks.push({ name: this._nearestName(gt, doc), coords });
    }

    // ── 3. gx:MultiTrack ─────────────────────────────────────
    //    Merge all child Tracks into ONE continuous polyline per MultiTrack.
    for (const mt of byLocal("MultiTrack")) {
      if (seen.has(mt)) continue; seen.add(mt);
      const allCoords = [];
      for (const gt of Array.from(mt.getElementsByTagName("*")).filter(e => e.localName === "Track")) {
        seen.add(gt);
        allCoords.push(...this._parseGxCoords(gt));
      }
      if (allCoords.length >= 2)
        tracks.push({ name: this._nearestName(mt, doc), coords: allCoords });
    }

    // ── 4. Points (Placemarks with Point geometry) ────────────
    //    Iterate by Placemark so we have full context for metadata extraction.
    const points = [];
    for (const pm of byLocal("Placemark")) {
      const ptEls = Array.from(pm.getElementsByTagName("*")).filter(e => e.localName === "Point");
      if (ptEls.length === 0) continue;
      const coords = this._parseKmlCoords(ptEls[0]);
      if (coords.length > 0) {
        const info = this._extractNetworkInfo(pm);
        points.push({ ...info, lat: coords[0][0], lon: coords[0][1] });
      }
    }
    // Log security type breakdown for debugging
    if (points.length > 0) {
      const tally = {};
      points.forEach(p => { tally[p.security] = (tally[p.security] || 0) + 1; });
      console.log(`[KMLParser] Security breakdown:`, tally);
    }

    // ── 5. Fallback: if no tracks but many points (WiGLE network export) ──
    //    Mark as a point collection so it draws as colored network dots.
    if (tracks.length === 0 && points.length >= 2) {
      console.log(`[KMLParser] No tracks — treating ${points.length} points as WiFi networks`);
      tracks.push({
        name: "WiFi Networks",
        coords: points.map(p => [p.lat, p.lon]),
        points: points,           // full metadata: ssid, security, lat, lon
        isPointCollection: true,  // draw as dots, not polyline
      });
    }

    console.log(`[KMLParser] Result: ${tracks.length} tracks, ${points.length} pts`);
    tracks.forEach((t, i) =>
      console.log(`  [${i+1}] "${t.name}" — ${t.coords.length} coords`)
    );

    const allTrackPoints = tracks.flatMap(t => t.coords);
    let bounds = null;
    if (allTrackPoints.length > 0) {
      const lats = allTrackPoints.map(c => c[0]);
      const lons = allTrackPoints.map(c => c[1]);
      bounds = {
        south: Math.min(...lats), north: Math.max(...lats),
        west:  Math.min(...lons), east:  Math.max(...lons),
      };
    }
    const estKm = tracks.reduce((total, t) => {
      if (t.isPointCollection) return total; // wifi scan dots aren't a driven route
      for (let i = 1; i < t.coords.length; i++)
        total += this._hav(t.coords[i-1][0], t.coords[i-1][1], t.coords[i][0], t.coords[i][1]);
      return total;
    }, 0);

    return { tracks, points, allTrackPoints, bounds, stats: { trackCount: tracks.length, estimatedKm: estKm } };
  }

  /** Extract [lat,lon] pairs from gx:coord children of a Track element */
  _parseGxCoords(trackEl) {
    const coords = [];
    for (const c of Array.from(trackEl.getElementsByTagName("*")).filter(e => e.localName === "coord")) {
      // gx:coord format: "lon lat [ele]"
      const p = c.textContent.trim().split(/\s+/);
      if (p.length >= 2) {
        const lon = parseFloat(p[0]), lat = parseFloat(p[1]);
        if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
      }
    }
    return coords;
  }

  /** Extract [lat,lon] pairs from <coordinates> child of el */
  _parseKmlCoords(el) {
    const coordEls = el.getElementsByTagName("coordinates");
    if (!coordEls.length) return [];
    const results = [];
    for (const token of coordEls[0].textContent.trim().split(/[\s\n\r]+/)) {
      if (!token) continue;
      const parts = token.split(",");
      if (parts.length < 2) continue;
      const lon = parseFloat(parts[0]), lat = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lon)) results.push([lat, lon]);
    }
    return results;
  }

  /** Walk up the tree to find the nearest ancestor's <name> text */
  _nearestName(el, doc) {
    let node = el.parentElement;
    while (node && node !== doc.documentElement) {
      for (const child of Array.from(node.childNodes)) {
        if (child.localName === "name") return child.textContent.trim() || "Track";
      }
      node = node.parentElement;
    }
    return "Track";
  }

  /**
   * Extract SSID name and security type from a Placemark element.
   * Handles WiGLE KML which stores info in <description>, <ExtendedData>,
   * or <SimpleData> (SchemaData) elements.
   */
  _extractNetworkInfo(placemarkEl) {
    const allEls = Array.from(placemarkEl.getElementsByTagName("*"));

    // SSID from direct <name> child
    const nameEl = Array.from(placemarkEl.childNodes).find(n => n.localName === "name");
    const ssid = nameEl ? nameEl.textContent.trim() : "Unknown";

    // ── Try <SimpleData name="..."> (SchemaData format) ──────────
    for (const sd of allEls.filter(e => e.localName === "SimpleData")) {
      const attrName = (sd.getAttribute("name") || "").toLowerCase();
      if (attrName === "capabilities" || attrName === "encryption" || attrName === "security" || attrName === "type") {
        const sec = this._classifySecurity(sd.textContent);
        if (sec !== "Unknown") return { ssid, security: sec };
      }
    }

    // ── Try <Data name="..."><value>...</value> ──────────────────
    for (const d of allEls.filter(e => e.localName === "Data")) {
      const attrName = (d.getAttribute("name") || "").toLowerCase();
      if (attrName === "capabilities" || attrName === "encryption" || attrName === "security") {
        const valEl = allEls.find(e => e.localName === "value" && d.contains(e));
        if (valEl) {
          const sec = this._classifySecurity(valEl.textContent);
          if (sec !== "Unknown") return { ssid, security: sec };
        }
      }
    }

    // ── Scan ALL SimpleData / Data values for security keywords ──
    // (WiGLE may use different field names — try any field)
    for (const el of allEls.filter(e => e.localName === "SimpleData" || e.localName === "value")) {
      const sec = this._classifySecurity(el.textContent);
      if (sec !== "Unknown") return { ssid, security: sec };
    }

    // ── Fall back to <description> text ─────────────────────────
    const descEl = Array.from(placemarkEl.childNodes).find(n => n.localName === "description");
    const desc = descEl ? descEl.textContent : "";

    return { ssid, security: this._classifySecurity(desc) };
  }

  /** Map a capabilities/encryption string to a canonical security label */
  _classifySecurity(text) {
    const t = text.toUpperCase();
    if (t.includes("WPA3"))   return "WPA3";
    if (t.includes("WPA2"))   return "WPA2";
    if (t.includes("WPA"))    return "WPA";
    if (t.includes("WEP"))    return "WEP";
    // "Open" networks: no encryption keyword, or explicitly named
    if (t.includes("OPEN") || t.includes("NONE") || t.includes("ESS]") || t.includes("NOENCRYP")) return "Open";
    return "Unknown";
  }

  getCoveredCells(allTrackPoints, gridData, bufferDeg = 0.0006) {
    const { gridSize, bounds } = gridData;
    const { south, north, west, east } = bounds;
    const latStep = (north - south) / gridSize;
    const lonStep = (east  - west)  / gridSize;
    const covered = new Set();
    for (const [lat, lon] of allTrackPoints) {
      const rowMin = Math.floor((lat - bufferDeg - south) / latStep);
      const rowMax = Math.floor((lat + bufferDeg - south) / latStep);
      const colMin = Math.floor((lon - bufferDeg - west)  / lonStep);
      const colMax = Math.floor((lon + bufferDeg - west)  / lonStep);
      for (let r = Math.max(0, rowMin); r <= Math.min(gridSize-1, rowMax); r++)
        for (let c = Math.max(0, colMin); c <= Math.min(gridSize-1, colMax); c++)
          covered.add(`${r},${c}`);
    }
    return covered;
  }

  _hav(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
}
window.KMLParser = KMLParser;
} // end guard

// ============================================================
// App State
// ============================================================
const state = {
  map: null,
  wigle: null,
  analyzer: null,
  planner: null,

  // Layers
  gridLayer: null,
  routeLayer: null,
  waypointLayer: null,
  wigleTileLayer: null,
  kmlLayer: null,

  // Data
  currentNetworks: [],
  currentGrid: null,
  currentRoute: null,
  currentWaypoints: [],
  kmlTracks: [],        // loaded KML track data
  kmlCoveredCells: null, // Set of "row,col" strings covered by KML

  // UI
  phase: "idle",
  settings: {
    gridSize: 8,
    numWaypoints: 12,
    maxNetworks: 500,
    networkType: "",
    showWigleTiles: false,
    showGrid: true,
  },
};

// ============================================================
// Keep-alive heartbeat — pings /health every 4 min so
// Render's free tier never sleeps during a session
// ============================================================
function startKeepAlive() {
  const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
  setInterval(async () => {
    try {
      await fetch("/health");
      console.log("[keepalive] ping OK");
    } catch (e) {
      console.warn("[keepalive] ping failed:", e.message);
    }
  }, INTERVAL_MS);
}

// ============================================================
// Startup error display — always visible even if onerror misses it
// ============================================================
function fatalError(msg) {
  const box = document.getElementById("jsErrorBox") || document.createElement("div");
  box.id = "jsErrorBox";
  box.style.cssText = "position:fixed;inset:0;background:#1a0000;color:#ff6666;padding:24px;font-size:15px;z-index:99999;font-family:monospace;white-space:pre-wrap;overflow:auto;display:flex;flex-direction:column;gap:12px";
  box.innerHTML = `<b style="font-size:18px;color:#ff4444">❌ WardDrive AI failed to start</b>\n\n${msg}\n\n<span style="color:#aaa;font-size:12px">Fix the error above and reload the page.\nIf this keeps happening, clear your browser cache (Settings → Privacy → Clear browsing data).</span>`;
  document.body.appendChild(box);
}

// ============================================================
// Initialization
// ============================================================
function init() {
  // Check Leaflet loaded
  if (typeof L === "undefined") {
    fatalError("Leaflet map library failed to load.\n\nCheck your internet connection and reload.\n(unpkg.com CDN may be temporarily unavailable)");
    return;
  }

  // Check all classes available
  const missing = [];
  if (typeof WigleAPI    === "undefined") missing.push("wigle-api.js");
  if (typeof DensityAnalyzer === "undefined") missing.push("density-analyzer.js");
  if (typeof RoutePlanner === "undefined") missing.push("route-planner.js");
  if (typeof KMLParser   === "undefined") missing.push("KMLParser (not in app.js — GitHub app.js may be outdated)");
  if (missing.length > 0) {
    fatalError("Missing required scripts:\n• " + missing.join("\n• ") + "\n\nMake sure all files are uploaded to GitHub correctly.");
    return;
  }

  try {
    state.wigle   = new WigleAPI();
    state.analyzer = new DensityAnalyzer();
    state.planner  = new RoutePlanner();
    state.kmlParser = new KMLParser();
  } catch (e) {
    fatalError("Failed to initialize classes:\n" + e.message + "\n\n" + (e.stack || ""));
    return;
  }

  try {
    initMap();
  } catch (e) {
    fatalError("Map failed to initialize:\n" + e.message + "\n\n" + (e.stack || ""));
    return;
  }

  loadSettings();

  if (state.wigle.loadSavedCredentials()) {
    showStatus("Credentials loaded. Ready to scan.", "success");
    updateAuthUI(true);
  } else {
    openSettings();
  }

  setupEventListeners();
  startKeepAlive();
  updateCacheStats();
}

// ============================================================
// Map Setup
// ============================================================
function initMap() {
  state.map = L.map("map", {
    center: [37.7749, -122.4194],
    zoom: 13,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(state.map);

  updateWigleTileLayer();

  // Named layer groups so we can clear each independently
  state.kmlLayer      = L.layerGroup().addTo(state.map); // KML under everything
  state.gridLayer     = L.layerGroup().addTo(state.map);
  state.routeLayer    = L.layerGroup().addTo(state.map);
  state.waypointLayer = L.layerGroup().addTo(state.map);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => state.map.setView([pos.coords.latitude, pos.coords.longitude], 13),
      () => {}
    );
  }
}

function updateWigleTileLayer() {
  if (state.wigleTileLayer) {
    state.map.removeLayer(state.wigleTileLayer);
    state.wigleTileLayer = null;
  }
  if (state.settings.showWigleTiles) {
    state.wigleTileLayer = L.tileLayer(
      "https://tiles.wigle.net/tile/{z}/{x}/{y}.png",
      { maxZoom: 18, opacity: 0.45, attribution: "WiGLE.net" }
    ).addTo(state.map);
  }
}

// ============================================================
// Settings
// ============================================================
function loadSettings() {
  try {
    const saved = localStorage.getItem("wardrive_settings");
    if (saved) Object.assign(state.settings, JSON.parse(saved));
  } catch {}
  applySettingsToUI();
}

function saveSettings() {
  localStorage.setItem("wardrive_settings", JSON.stringify(state.settings));
}

function applySettingsToUI() {
  document.getElementById("gridSize").value = state.settings.gridSize;
  document.getElementById("numWaypoints").value = state.settings.numWaypoints;
  document.getElementById("maxNetworks").value = state.settings.maxNetworks;
  document.getElementById("networkType").value = state.settings.networkType;
  document.getElementById("showWigleTiles").checked = state.settings.showWigleTiles;
  document.getElementById("showGrid").checked = state.settings.showGrid;
  const apiName = localStorage.getItem("wigle_api_name") || "";
  document.getElementById("apiName").value = apiName;
}

function openSettings() {
  document.getElementById("settingsPanel").classList.add("open");
}

function closeSettings() {
  document.getElementById("settingsPanel").classList.remove("open");
}

function saveAndCloseSettings() {
  const apiName = document.getElementById("apiName").value.trim();
  const apiToken = document.getElementById("apiToken").value.trim();

  if (apiName && apiToken) {
    state.wigle.setCredentials(apiName, apiToken);
    document.getElementById("apiToken").value = "";
    updateAuthUI(true);
    showStatus("API credentials saved.", "success");
  } else if (!state.wigle.isAuthenticated()) {
    showStatus("Please enter your WiGLE API Name and Token.", "warn");
    return;
  }

  state.settings.gridSize     = parseInt(document.getElementById("gridSize").value) || 8;
  state.settings.numWaypoints = parseInt(document.getElementById("numWaypoints").value) || 12;
  state.settings.maxNetworks  = parseInt(document.getElementById("maxNetworks").value) || 500;
  state.settings.networkType  = document.getElementById("networkType").value;
  state.settings.showWigleTiles = document.getElementById("showWigleTiles").checked;
  state.settings.showGrid     = document.getElementById("showGrid").checked;

  saveSettings();
  updateWigleTileLayer();

  if (!state.settings.showGrid) state.gridLayer.clearLayers();

  closeSettings();
}

function updateAuthUI(authenticated) {
  document.getElementById("authIndicator").className =
    `auth-dot ${authenticated ? "auth-ok" : "auth-error"}`;
  document.getElementById("authLabel").textContent =
    authenticated ? "WiGLE Connected" : "Not Connected";
}

// ============================================================
// Main Scan + Analyze Flow
// ============================================================
async function startScan() {
  if (!state.wigle.isAuthenticated()) {
    openSettings();
    showStatus("Enter WiGLE credentials first.", "warn");
    return;
  }

  const bounds = state.map.getBounds();
  const mapBounds = {
    south: bounds.getSouth(),
    north: bounds.getNorth(),
    west:  bounds.getWest(),
    east:  bounds.getEast(),
  };

  const latSpan = mapBounds.north - mapBounds.south;
  const lonSpan = mapBounds.east  - mapBounds.west;
  if (latSpan > 0.5 || lonSpan > 0.5) {
    showStatus("Area too large — zoom in more for better results.", "warn");
    return;
  }

  setPhase("scanning");
  clearLayers();
  state.currentNetworks  = [];
  state.currentGrid      = null;
  state.currentRoute     = null;
  state.currentWaypoints = [];
  document.getElementById("statsPanel").classList.remove("visible");

  try {
    // 1 — Verify auth
    showProgress("Verifying WiGLE credentials…", 2);
    await state.wigle.testAuth();

    // 2 — Fetch networks (uses cache if available)
    showProgress("Checking cache / fetching networks from WiGLE…", 5);
    let fromCache = false;
    const networks = await state.wigle.fetchAllNetworksInBounds(
      mapBounds,
      (fetched, total, cached) => {
        fromCache = cached;
        const label = cached ? `Using cached data — ${fetched} networks` : `Fetched ${fetched} / ${total} networks…`;
        const pct   = Math.min(78, Math.round((fetched / total) * 70) + 5);
        showProgress(label, pct);
      },
      {
        maxResults:    state.settings.maxNetworks,
        type:          state.settings.networkType,
        forceRefresh:  state.settings.forceRefresh,
      }
    );
    state.settings.forceRefresh = false; // reset after one use

    if (networks.length === 0) {
      showStatus("No networks found in this area — try a different location.", "warn");
      setPhase("idle");
      return;
    }

    state.currentNetworks = networks;
    showProgress(`Analyzing ${networks.length} networks…`, 80);

    // 3 — Build density grid
    const gridData = state.analyzer.buildDensityGrid(
      networks, mapBounds, state.settings.gridSize
    );
    state.currentGrid = gridData;

    // 4 — Score cells (pass KML coverage so already-driven cells are penalised)
    if (state.kmlTracks.length > 0 && state.currentGrid) {
      // Recompute covered cells for the new grid
      const allPts = state.kmlTracks.flatMap((t) => t.coords);
      state.kmlCoveredCells = state.kmlParser.getCoveredCells(allPts, gridData, 0.0006);
      console.log(`[KML] ${state.kmlCoveredCells.size} cells marked as already-driven`);
    }
    const scoredCells = state.analyzer.scoreCells(gridData, state.kmlCoveredCells);

    // 5 — Draw grid overlay
    if (state.settings.showGrid) {
      showProgress("Drawing density grid…", 83);
      drawDensityGrid(gridData, scoredCells);
    }

    // 6 — Select & order waypoints
    showProgress("Selecting optimal waypoints…", 87);
    const rawWaypoints = state.analyzer.selectWaypoints(
      scoredCells, state.settings.numWaypoints, 0.003
    );

    let startPoint = null;
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000 })
      );
      startPoint = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch {}

    const orderedWaypoints = state.analyzer.orderWaypointsNearestNeighbor(
      rawWaypoints, startPoint
    );
    state.currentWaypoints = orderedWaypoints;

    // 7 — Generate road route
    showProgress("Generating road route via OSRM…", 92);
    setPhase("routing");

    let route;
    let routeWarning = null;
    try {
      route = await state.planner.generateRoute(orderedWaypoints);
    } catch (osrmErr) {
      console.warn("[Route] OSRM failed, using straight-line fallback:", osrmErr.message);
      route = state.planner.generateFallbackRoute(orderedWaypoints);
      routeWarning = "⚠️ Road routing unavailable — showing straight lines. Export GPX and open in a nav app for road directions.";
    }
    state.currentRoute = route;

    // 8 — Draw everything
    showProgress("Drawing route…", 97);
    drawRoute(route);
    drawWaypoints(orderedWaypoints);

    setPhase("done");
    updateStats(networks, scoredCells, route);

    if (routeWarning) {
      showStatus(routeWarning, "warn");
    } else {
      const cacheNote = fromCache ? " (cached data)" : "";
      showStatus(
        `✓ Road route ready — ${orderedWaypoints.length} cold spots, ${route.totalDistanceKm.toFixed(1)} km${cacheNote}`,
        "success"
      );
    }

  } catch (err) {
    console.error("Scan error:", err);
    showStatus(`Error: ${err.message}`, "error");
    setPhase("idle");
  }
}

// ============================================================
// Map Drawing
// ============================================================
function clearLayers() {
  state.gridLayer.clearLayers();
  state.routeLayer.clearLayers();
  state.waypointLayer.clearLayers();
  // Note: KML layer is NOT cleared here — persists across scans intentionally
}

function clearKmlLayer() {
  state.kmlLayer.clearLayers();
  state.kmlTracks = [];
  state.kmlCoveredCells = null;
  document.getElementById("kmlBadge").style.display = "none";
  document.getElementById("kmlToggleBtn").style.display = "none";
  // Remove security legend if present
  const leg = document.getElementById("securityLegend");
  if (leg) leg.parentElement.removeChild(leg);
  showStatus("KML tracks cleared.", "info");
}

// ============================================================
// KML Upload & Rendering
// ============================================================

function handleKmlUpload(files) {
  if (!files || files.length === 0) return;

  let totalTracks = 0;
  let totalKm = 0;
  let loadedCount = 0;

  // Support multiple KML files at once
  Array.from(files).forEach((file) => {
    if (!file.name.toLowerCase().endsWith(".kml")) {
      showStatus(`Skipped ${file.name} — not a .kml file`, "warn");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = state.kmlParser.parse(e.target.result);
        state.kmlTracks.push(...parsed.tracks);
        totalTracks += parsed.stats.trackCount;
        totalKm     += parsed.stats.estimatedKm;
        loadedCount++;

        drawKmlTracks(parsed.tracks, file.name);

        // Fit map to KML bounds if we have them
        if (parsed.bounds && loadedCount === 1) {
          state.map.fitBounds([
            [parsed.bounds.south, parsed.bounds.west],
            [parsed.bounds.north, parsed.bounds.east],
          ], { padding: [30, 30] });
        }

        updateKmlBadge(totalTracks, totalKm, parsed);
        const isNetworkExport = parsed.tracks.some(t => t.isPointCollection);
        const pointCount = parsed.tracks.filter(t => t.isPointCollection).reduce((s, t) => s + t.coords.length, 0);
        showStatus(
          isNetworkExport
            ? `✓ Loaded ${file.name} — ${pointCount.toLocaleString()} WiFi networks`
            : `✓ Loaded ${file.name} — ${parsed.stats.trackCount} track(s), ~${totalKm.toFixed(1)} km driven`,
          "success"
        );
      } catch (err) {
        showStatus(`Failed to parse ${file.name}: ${err.message}`, "error");
      }
    };
    reader.readAsText(file);
  });
}

// Security type → color mapping for WiFi network dots
const SECURITY_COLORS = {
  Open:    "#ff4444",  // red    — no encryption
  WEP:     "#ff8800",  // orange — weak/legacy
  WPA:     "#ffcc00",  // yellow — moderate
  WPA2:    "#44dd88",  // green  — good
  WPA3:    "#00d4ff",  // cyan   — best
  Unknown: "#aaaaaa",  // gray
};

function getSecurityColor(security) {
  return SECURITY_COLORS[security] || SECURITY_COLORS.Unknown;
}

/**
 * Thin a coordinate array to at most maxPts points while keeping endpoints.
 * Used to avoid drawing thousands of overlapping segments.
 */
function thinCoords(coords, maxPts = 1500) {
  if (coords.length <= maxPts) return coords;
  const step = Math.ceil(coords.length / maxPts);
  const result = coords.filter((_, i) => i % step === 0);
  // Always include last point
  if (result[result.length - 1] !== coords[coords.length - 1])
    result.push(coords[coords.length - 1]);
  return result;
}

function drawKmlTracks(tracks, filename) {
  const colors = ["#b44fff", "#ff44cc", "#ff44aa", "#aa44ff"];
  const colorIdx = state.kmlLayer.getLayers().length % colors.length;
  const color = colors[colorIdx];

  // Use canvas renderer for efficiency with many features
  const canvasRenderer = L.canvas({ padding: 0.5 });

  tracks.forEach((track) => {
    if (track.coords.length < 1) return;

    // ── Point collection (WiGLE network export) ────────────────
    // Draw each WiFi network as a colored dot by security type.
    if (track.isPointCollection) {
      const MAX_INTERACTIVE = 3000;  // interactive popups up to this count
      const hasMetadata = track.points && track.points.length > 0;
      const totalPts = track.coords.length;
      const step = Math.ceil(totalPts / MAX_INTERACTIVE);
      const svgRenderer = L.svg({ padding: 0.5 });  // SVG allows click events

      // Count by security type for the console summary
      const secCounts = {};

      let drawn = 0;
      for (let i = 0; i < totalPts; i += step) {
        let lat, lon, secColor, ssid, security;

        if (hasMetadata) {
          const pt = track.points[i];
          lat      = pt.lat;
          lon      = pt.lon;
          ssid     = pt.ssid || "Unknown";
          security = pt.security || "Unknown";
          secColor = getSecurityColor(security);
          secCounts[security] = (secCounts[security] || 0) + 1;
        } else {
          [lat, lon] = track.coords[i];
          secColor   = color;
          ssid       = "Network";
          security   = "Unknown";
        }

        const dot = L.circleMarker([lat, lon], {
          radius:      5,
          renderer:    svgRenderer,
          color:       secColor,
          fillColor:   secColor,
          fillOpacity: 0.75,
          weight:      1,
          interactive: true,
        });

        // Popup with network name and security info
        dot.bindPopup(
          `<div style="font-family:monospace;font-size:12px;line-height:1.5">
            <b style="font-size:13px">${ssid}</b><br>
            <span style="color:${secColor};font-weight:700">⬤ ${security}</span><br>
            <span style="color:#888">${lat.toFixed(6)}, ${lon.toFixed(6)}</span>
          </div>`,
          { maxWidth: 220 }
        );

        state.kmlLayer.addLayer(dot);
        drawn++;
      }

      if (hasMetadata) {
        const summary = Object.entries(secCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([sec, n]) => `${sec}:${n}`)
          .join(" ");
        console.log(`[KML] Drew ${drawn} network dots (${summary}) from ${totalPts} total`);
      } else {
        console.log(`[KML] Drew ${drawn} scan dots from ${totalPts} points`);
      }

      // Add a legend if we have metadata
      if (hasMetadata && drawn > 0) {
        addSecurityLegend();
      }
      return;
    }

    // ── GPS track (LineString / gx:Track) ──────────────────────
    // Thin if very dense, then draw as a clean polyline.
    const thinned = thinCoords(track.coords, 1500);
    const latLngs = thinned.map(([lat, lon]) => [lat, lon]);

    const line = L.polyline(latLngs, {
      color,
      weight:      3,
      opacity:     0.82,
      smoothFactor: 2,   // Leaflet's built-in simplification at render time
    });

    line.bindTooltip(
      `<b>📍 Previous Drive</b><br>${track.name || filename}<br>${track.coords.length} GPS points`,
      { sticky: true }
    );

    state.kmlLayer.addLayer(line);
  });

  // Show toggle button
  document.getElementById("kmlToggleBtn").style.display = "flex";
}

/** Show a color legend for WiFi security types in the bottom-left corner */
function addSecurityLegend() {
  // Only add once
  if (document.getElementById("securityLegend")) return;

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "security-legend");
    div.id = "securityLegend";
    div.innerHTML = `
      <div style="
        background:rgba(0,0,0,0.82);border-radius:8px;padding:8px 12px;
        font-family:monospace;font-size:11px;color:#fff;line-height:1.7;
        border:1px solid rgba(255,255,255,0.15);backdrop-filter:blur(4px)
      ">
        <div style="font-weight:700;margin-bottom:4px;color:#ccc">WiFi Security</div>
        ${Object.entries(SECURITY_COLORS).map(([sec, col]) =>
          `<div><span style="color:${col};font-size:14px">⬤</span> ${sec}</div>`
        ).join("")}
      </div>`;
    return div;
  };
  legend.addTo(state.map);
}

function updateKmlBadge(trackCount, km, parsed) {
  const badge = document.getElementById("kmlBadge");
  const isNetworkExport = parsed && parsed.tracks.some(t => t.isPointCollection);
  const ptCount = parsed && parsed.tracks.filter(t => t.isPointCollection).reduce((s, t) => s + t.coords.length, 0);
  badge.textContent = isNetworkExport
    ? `📡 ${ptCount.toLocaleString()} networks`
    : `📍 ${trackCount} track${trackCount !== 1 ? "s" : ""} · ${km.toFixed(1)} km`;
  badge.style.display = "inline-flex";
  document.getElementById("kmlToggleBtn").style.display = "inline-flex";
  document.getElementById("kmlClearBtn").style.display  = "inline-flex";
}

function drawDensityGrid(gridData, scoredCells) {
  const { grid, gridSize } = gridData;

  // Build a flat array of all counts to find the max
  const allCounts = grid.flat().map((c) => c.count);
  const maxCount  = Math.max(...allCounts, 1);

  // Build score lookup for tooltips
  const scoreMap = {};
  scoredCells.forEach((c) => { scoreMap[`${c.row},${c.col}`] = c; });

  let drawn = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const cell  = grid[row][col];
      const scored = scoreMap[`${row},${col}`] || {};
      const color  = state.analyzer.getHeatColor(cell.count, maxCount);

      const rect = L.rectangle(
        [[cell.south, cell.west], [cell.north, cell.east]],
        {
          color:       "rgba(255,255,255,0.15)",
          weight:      0.8,
          fillColor:   color,
          fillOpacity: 0.45,
          interactive: true,
        }
      );

      rect.bindTooltip(
        `<b>Cell [${row},${col}]</b><br>
         Networks: <b>${cell.count}</b><br>
         WiFi: ${cell.wifiCount} &nbsp;|&nbsp; BT: ${cell.btCount}<br>
         AI Score: ${scored.score !== undefined ? (scored.score * 100).toFixed(0) + "%" : "—"}`,
        { sticky: true, opacity: 0.95 }
      );

      state.gridLayer.addLayer(rect);
      drawn++;
    }
  }
  console.log(`[Grid] Drew ${drawn} cells (${gridSize}×${gridSize})`);
}

function drawRoute(route) {
  if (!route?.geometry?.coordinates?.length) return;

  const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  console.log(`[Route] Drawing ${coords.length} points, road=${route.isRoadRoute}`);

  const polyline = L.polyline(coords, {
    color:     route.isRoadRoute ? "#00d4ff" : "#ff9900",
    weight:    route.isRoadRoute ? 4 : 3,
    opacity:   0.88,
    lineJoin:  "round",
    lineCap:   "round",
    dashArray: route.isRoadRoute ? null : "10, 6", // dashed = fallback
  });

  polyline.bindTooltip(
    route.isRoadRoute
      ? `🛣️ Road route: ${route.totalDistanceKm.toFixed(1)} km / ${Math.round(route.totalDurationMin)} min`
      : `⚠️ Straight-line estimate: ${route.totalDistanceKm.toFixed(1)} km (no road routing)`,
    { sticky: true }
  );

  state.routeLayer.addLayer(polyline);

  // Direction arrow at midpoint
  if (coords.length > 4) {
    const mid = coords[Math.floor(coords.length / 2)];
    state.routeLayer.addLayer(
      L.circleMarker(mid, {
        radius: 5, color: "#fff", fillColor: route.isRoadRoute ? "#00d4ff" : "#ff9900",
        fillOpacity: 1, weight: 2,
      })
    );
  }
}

function drawWaypoints(waypoints) {
  waypoints.forEach((wp, i) => {
    const color  = state.analyzer.getScoreColor(wp.score);
    const isStart = i === 0;

    // Outer circle marker (clickable, shows popup)
    const marker = L.circleMarker([wp.centerLat, wp.centerLon], {
      radius:      isStart ? 13 : 10,
      color:       isStart ? "#ffffff" : color,
      fillColor:   color,
      fillOpacity: 0.88,
      weight:      isStart ? 3 : 2,
    });

    marker.bindPopup(
      `<div class="popup-content">
        <h3>${isStart ? "▶ START" : "#" + i} — Cold Spot</h3>
        <table>
          <tr><td>AI Score</td><td><b>${(wp.score * 100).toFixed(0)}%</b></td></tr>
          <tr><td>Existing scans</td><td>${wp.count}</td></tr>
          <tr><td>WiFi APs</td><td>${wp.wifiCount}</td></tr>
          <tr><td>Bluetooth</td><td>${wp.btCount}</td></tr>
          <tr><td>Grid cell</td><td>[${wp.row}, ${wp.col}]</td></tr>
          <tr><td>Coords</td><td>${wp.centerLat.toFixed(5)}, ${wp.centerLon.toFixed(5)}</td></tr>
        </table>
      </div>`
    );

    // Number label icon on top
    const icon = L.divIcon({
      className: "waypoint-label",
      html: `<span style="
        background:${color};color:#000;border-radius:50%;
        width:22px;height:22px;display:flex;align-items:center;
        justify-content:center;font-weight:700;font-size:11px;
        border:2px solid rgba(255,255,255,0.8);box-shadow:0 1px 4px rgba(0,0,0,0.5)
      ">${isStart ? "S" : i}</span>`,
      iconSize:   [22, 22],
      iconAnchor: [11, 11],
    });

    state.waypointLayer.addLayer(marker);
    state.waypointLayer.addLayer(
      L.marker([wp.centerLat, wp.centerLon], { icon, interactive: false })
    );
  });
}

// ============================================================
// Stats Panel
// ============================================================
function updateStats(networks, scoredCells, route) {
  document.getElementById("statNetworks").textContent  = networks.length;
  document.getElementById("statWifi").textContent      =
    networks.filter((n) => n.type !== "BT" && n.type !== "BLE").length;
  document.getElementById("statBt").textContent        =
    networks.filter((n) => n.type === "BT" || n.type === "BLE").length;
  document.getElementById("statWaypoints").textContent = state.currentWaypoints.length;
  document.getElementById("statDistance").textContent  =
    route.totalDistanceKm.toFixed(1) + " km";
  document.getElementById("statDuration").textContent  =
    route.totalDurationMin ? Math.round(route.totalDurationMin) + " min" : "—";
  document.getElementById("statColdSpots").textContent =
    scoredCells.filter((c) => c.isZeroScan).length;

  document.getElementById("statsPanel").classList.add("visible");
}

// ============================================================
// GPX Export
// ============================================================
function exportGPX() {
  if (!state.currentRoute || !state.currentWaypoints.length) {
    showStatus("Generate a route first.", "warn");
    return;
  }
  const gpx  = state.planner.exportGPX(state.currentRoute, "WardDrive AI Route");
  const blob  = new Blob([gpx], { type: "application/gpx+xml" });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement("a");
  a.href      = url;
  a.download  = `wardrive_route_${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
  showStatus("GPX downloaded!", "success");
}

// ============================================================
// UI Helpers
// ============================================================
function setPhase(phase) {
  state.phase = phase;
  const btn = document.getElementById("scanBtn");
  const progressBar = document.getElementById("progressContainer");

  switch (phase) {
    case "idle":
      btn.disabled = false;
      btn.textContent = "📡 Scan & Plan Route";
      progressBar.style.display = "none";
      break;
    case "done":
      btn.disabled = false;
      btn.textContent = "📡 Scan Again";
      progressBar.style.display = "none";
      break;
    case "scanning":
      btn.disabled = true;
      btn.textContent = "Scanning…";
      progressBar.style.display = "block";
      break;
    case "routing":
      btn.disabled = true;
      btn.textContent = "Routing…";
      break;
  }
}

function showProgress(message, percent) {
  document.getElementById("progressMsg").textContent       = message;
  document.getElementById("progressBar").style.width       = `${percent}%`;
  document.getElementById("progressPct").textContent       = `${percent}%`;
}

function showStatus(message, type = "info") {
  const el = document.getElementById("statusMsg");
  el.textContent  = message;
  el.className    = `status-msg status-${type}`;
  el.style.display = "block";
  if (type === "success") {
    setTimeout(() => { el.style.display = "none"; }, 6000);
  }
}

// ============================================================
// Event Listeners
// ============================================================
function setupEventListeners() {
  document.getElementById("scanBtn").addEventListener("click", startScan);
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettingsBtn").addEventListener("click", saveAndCloseSettings);
  document.getElementById("exportGpxBtn").addEventListener("click", exportGPX);

  document.getElementById("clearBtn").addEventListener("click", () => {
    clearLayers();
    document.getElementById("statsPanel").classList.remove("visible");
    document.getElementById("statusMsg").style.display = "none";
    setPhase("idle");
  });

  document.getElementById("settingsPanel").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) saveAndCloseSettings();
  });

  document.getElementById("testAuthBtn").addEventListener("click", async () => {
    const apiName  = document.getElementById("apiName").value.trim();
    const apiToken = document.getElementById("apiToken").value.trim();
    if (!apiName || !apiToken) {
      showStatus("Enter API Name and Token first.", "warn");
      return;
    }
    state.wigle.setCredentials(apiName, apiToken);
    document.getElementById("testAuthBtn").textContent = "Testing…";
    try {
      const profile = await state.wigle.testAuth();
      document.getElementById("testAuthBtn").textContent = "Test Connection";
      updateAuthUI(true);
      showStatus(`✓ Connected as ${profile.user || apiName}`, "success");
      document.getElementById("apiToken").value = "";
    } catch (e) {
      document.getElementById("testAuthBtn").textContent = "Test Connection";
      updateAuthUI(false);
      showStatus(`Auth failed: ${e.message}`, "error");
    }
  });

  document.getElementById("showWigleTiles").addEventListener("change", (e) => {
    state.settings.showWigleTiles = e.target.checked;
    updateWigleTileLayer();
  });

  // KML upload
  const kmlInput = document.getElementById("kmlFileInput");
  document.getElementById("kmlUploadBtn").addEventListener("click", () => kmlInput.click());
  kmlInput.addEventListener("change", (e) => {
    handleKmlUpload(e.target.files);
    kmlInput.value = ""; // allow re-uploading same file
  });

  // KML drag-and-drop on map
  const mapEl = document.getElementById("map");
  mapEl.addEventListener("dragover", (e) => { e.preventDefault(); mapEl.classList.add("drag-over"); });
  mapEl.addEventListener("dragleave", () => mapEl.classList.remove("drag-over"));
  mapEl.addEventListener("drop", (e) => {
    e.preventDefault();
    mapEl.classList.remove("drag-over");
    const kmlFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".kml")
    );
    if (kmlFiles.length > 0) handleKmlUpload(kmlFiles);
    else showStatus("Drop .kml files onto the map to load them.", "warn");
  });

  // KML visibility toggle
  let kmlVisible = true;
  document.getElementById("kmlToggleBtn").addEventListener("click", () => {
    kmlVisible = !kmlVisible;
    if (kmlVisible) {
      state.map.addLayer(state.kmlLayer);
      document.getElementById("kmlToggleBtn").textContent = "👁️ Hide Tracks";
    } else {
      state.map.removeLayer(state.kmlLayer);
      document.getElementById("kmlToggleBtn").textContent = "👁️ Show Tracks";
    }
  });

  // KML clear
  document.getElementById("kmlClearBtn").addEventListener("click", clearKmlLayer);

  document.getElementById("forceRefreshBtn").addEventListener("click", () => {
    state.settings.forceRefresh = true;
    showStatus("Next scan will fetch fresh data from WiGLE (ignoring cache).", "info");
    document.getElementById("forceRefreshBtn").textContent = "✓ Will refresh on next scan";
  });

  document.getElementById("clearCacheBtn").addEventListener("click", () => {
    state.wigle.clearCache();
    showStatus("Cache cleared. Next scan will fetch fresh data from WiGLE.", "success");
    updateCacheStats();
  });

  document.getElementById("locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { showStatus("Geolocation not available.", "warn"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { state.map.setView([pos.coords.latitude, pos.coords.longitude], 14); },
      ()    => showStatus("Could not get location.", "warn")
    );
  });
}

// ============================================================
// Cache Stats UI
// ============================================================
function updateCacheStats() {
  const el = document.getElementById("cacheStats");
  if (!el || !state.wigle) return;
  const { count, oldestMs } = state.wigle.getCacheStats();
  if (count === 0) {
    el.textContent = "No cached areas yet.";
  } else {
    const hrs = Math.round(oldestMs / 1000 / 60 / 60);
    el.textContent = `${count} area${count > 1 ? "s" : ""} cached · oldest ${hrs}h ago · expires in ${24 - hrs}h`;
  }
}

// ============================================================
// Boot
// ============================================================
document.addEventListener("DOMContentLoaded", init);
