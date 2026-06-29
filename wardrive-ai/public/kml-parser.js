/**
 * KML Parser
 * Parses .kml files (from WiGLE, Kismet, GPS loggers, etc.) into
 * GeoJSON-compatible track arrays for map display and coverage analysis.
 */

class KMLParser {
  /**
   * Parse a KML string and return all tracks + points found.
   * @param {string} kmlText - Raw KML file contents
   * @returns {object} { tracks, points, name, stats }
   */
  parse(kmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlText, "application/xml");

    // Check for parse errors
    const parseErr = doc.querySelector("parsererror");
    if (parseErr) {
      throw new Error("Invalid KML file: " + parseErr.textContent.slice(0, 100));
    }

    const docName = this._getText(doc, "Document > name") ||
                    this._getText(doc, "name") ||
                    "KML Track";

    const tracks  = [];
    const points  = [];

    // Extract all Placemarks
    const placemarks = doc.querySelectorAll("Placemark");
    placemarks.forEach((pm) => {
      const name = this._getText(pm, "name") || "Track";

      // LineString tracks (typical wardrive log)
      const lineStrings = pm.querySelectorAll("LineString");
      lineStrings.forEach((ls) => {
        const coords = this._parseCoordinates(ls);
        if (coords.length >= 2) {
          tracks.push({ name, coords, type: "LineString" });
        }
      });

      // MultiGeometry → multiple LineStrings
      const multiLines = pm.querySelectorAll("MultiGeometry LineString");
      if (multiLines.length > 0 && lineStrings.length === 0) {
        multiLines.forEach((ls) => {
          const coords = this._parseCoordinates(ls);
          if (coords.length >= 2) {
            tracks.push({ name, coords, type: "LineString" });
          }
        });
      }

      // Polygon (area coverage)
      const polygons = pm.querySelectorAll("Polygon outerBoundaryIs LinearRing");
      polygons.forEach((ring) => {
        const coords = this._parseCoordinates(ring);
        if (coords.length >= 3) {
          tracks.push({ name, coords, type: "Polygon" });
        }
      });

      // Points (scan positions)
      const pointEls = pm.querySelectorAll("Point");
      pointEls.forEach((pt) => {
        const coords = this._parseCoordinates(pt);
        if (coords.length > 0) {
          points.push({ name, lat: coords[0][0], lon: coords[0][1] });
        }
      });

      // gx:Track (Google Earth extended format — used by some GPS tools)
      const gxTracks = pm.querySelectorAll("Track, gx\\:Track");
      gxTracks.forEach((gt) => {
        const coordEls = gt.querySelectorAll("coord, gx\\:coord");
        const coords = [];
        coordEls.forEach((c) => {
          const parts = c.textContent.trim().split(/\s+/);
          if (parts.length >= 2) {
            const lon = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
          }
        });
        if (coords.length >= 2) {
          tracks.push({ name, coords, type: "gxTrack" });
        }
      });
    });

    // Flatten all track coordinates into a single point array for coverage analysis
    const allTrackPoints = tracks.flatMap((t) => t.coords);

    // Compute bounding box of loaded tracks
    let bounds = null;
    if (allTrackPoints.length > 0) {
      bounds = {
        south: Math.min(...allTrackPoints.map((c) => c[0])),
        north: Math.max(...allTrackPoints.map((c) => c[0])),
        west:  Math.min(...allTrackPoints.map((c) => c[1])),
        east:  Math.max(...allTrackPoints.map((c) => c[1])),
      };
    }

    const totalPoints = allTrackPoints.length + points.length;
    const estKm = this._estimateTrackKm(tracks);

    return {
      name: docName,
      tracks,
      points,
      allTrackPoints,
      bounds,
      stats: {
        trackCount:  tracks.length,
        pointCount:  points.length,
        totalCoords: totalPoints,
        estimatedKm: estKm,
      },
    };
  }

  /**
   * Check which grid cells are covered by KML tracks.
   * Returns a Set of "row,col" strings for covered cells.
   *
   * @param {Array}  allTrackPoints - [[lat,lon], ...] from parse()
   * @param {object} gridData       - from DensityAnalyzer.buildDensityGrid()
   * @param {number} bufferDeg      - coverage buffer in degrees (~0.0005 = ~55m)
   */
  getCoveredCells(allTrackPoints, gridData, bufferDeg = 0.0005) {
    const { grid, gridSize, bounds } = gridData;
    const { south, north, west, east } = bounds;
    const latStep = (north - south) / gridSize;
    const lonStep = (east  - west)  / gridSize;
    const covered = new Set();

    for (const [lat, lon] of allTrackPoints) {
      // Find all cells within buffer distance of this track point
      const rowMin = Math.floor((lat - bufferDeg - south) / latStep);
      const rowMax = Math.floor((lat + bufferDeg - south) / latStep);
      const colMin = Math.floor((lon - bufferDeg - west)  / lonStep);
      const colMax = Math.floor((lon + bufferDeg - west)  / lonStep);

      for (let r = Math.max(0, rowMin); r <= Math.min(gridSize - 1, rowMax); r++) {
        for (let c = Math.max(0, colMin); c <= Math.min(gridSize - 1, colMax); c++) {
          covered.add(`${r},${c}`);
        }
      }
    }

    return covered;
  }

  // ── Private helpers ───────────────────────────────────────

  _getText(el, selector) {
    const found = el.querySelector(selector);
    return found ? found.textContent.trim() : null;
  }

  _parseCoordinates(el) {
    const coordEl = el.querySelector("coordinates");
    if (!coordEl) return [];

    return coordEl.textContent
      .trim()
      .split(/[\s,]+/)
      .reduce((acc, val, i, arr) => {
        // Coordinates in KML are "lon,lat,alt" space-separated tuples
        // We process them in groups of 2-3
        if (i % 1 === 0) return acc; // processed below
        return acc;
      }, [])
      // Better: split by whitespace first, then split each token by comma
      && coordEl.textContent
        .trim()
        .split(/\s+/)
        .map((token) => {
          const parts = token.split(",");
          if (parts.length < 2) return null;
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          return (!isNaN(lat) && !isNaN(lon)) ? [lat, lon] : null;
        })
        .filter(Boolean);
  }

  _estimateTrackKm(tracks) {
    let total = 0;
    for (const track of tracks) {
      for (let i = 1; i < track.coords.length; i++) {
        total += this._haversine(
          track.coords[i - 1][0], track.coords[i - 1][1],
          track.coords[i][0],     track.coords[i][1]
        );
      }
    }
    return total;
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a    =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

window.KMLParser = KMLParser;
