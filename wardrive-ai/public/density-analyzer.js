/**
 * Grid Density Analyzer
 * Analyzes WiGLE network data to identify cold spots (low scan density areas)
 * that are good candidates for wardriving
 */

class DensityAnalyzer {
  /**
   * Build a density grid from a flat list of network results
   * @param {Array} networks - Array of WiGLE network objects
   * @param {object} bounds - {south, north, west, east}
   * @param {number} gridSize - Number of grid cells per side (e.g., 10 = 10x10 grid)
   * @returns {object} Grid data with counts per cell
   */
  buildDensityGrid(networks, bounds, gridSize = 10) {
    const { south, north, west, east } = bounds;
    const latSpan = north - south;
    const lonSpan = east - west;
    const latStep = latSpan / gridSize;
    const lonStep = lonSpan / gridSize;

    // Initialize grid
    const grid = [];
    for (let row = 0; row < gridSize; row++) {
      grid.push([]);
      for (let col = 0; col < gridSize; col++) {
        const cellSouth = south + row * latStep;
        const cellNorth = cellSouth + latStep;
        const cellWest = west + col * lonStep;
        const cellEast = cellWest + lonStep;
        grid[row].push({
          row,
          col,
          count: 0,
          wifiCount: 0,
          btCount: 0,
          centerLat: (cellSouth + cellNorth) / 2,
          centerLon: (cellWest + cellEast) / 2,
          south: cellSouth,
          north: cellNorth,
          west: cellWest,
          east: cellEast,
        });
      }
    }

    // Bin networks into grid cells
    for (const net of networks) {
      const lat = parseFloat(net.trilat);
      const lon = parseFloat(net.trilong);
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < south || lat > north || lon < west || lon > east) continue;

      const col = Math.min(Math.floor((lon - west) / lonStep), gridSize - 1);
      const row = Math.min(Math.floor((lat - south) / latStep), gridSize - 1);

      if (grid[row] && grid[row][col]) {
        grid[row][col].count++;
        if (net.type === "BT" || net.type === "BLE") {
          grid[row][col].btCount++;
        } else {
          grid[row][col].wifiCount++;
        }
      }
    }

    return { grid, gridSize, bounds, latStep, lonStep };
  }

  /**
   * Score grid cells for wardriving potential
   * High score = good candidate (low existing scans, likely has devices)
   * @param {object} gridData - Output from buildDensityGrid
   * @returns {Array} Sorted array of scored cells
   */
  scoreCells(gridData) {
    const { grid, gridSize } = gridData;
    const allCells = grid.flat();

    // Find max count for normalization
    const maxCount = Math.max(...allCells.map((c) => c.count), 1);
    const avgCount = allCells.reduce((s, c) => s + c.count, 0) / allCells.length;

    const scored = [];

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const cell = grid[row][col];

        // --- Scoring factors ---

        // 1. Scarcity score: lower scan count = higher score
        //    Cells with 0 scans get max scarcity, heavily penalize already-dense cells
        const scarcityScore = 1.0 - cell.count / (maxCount + 1);

        // 2. Neighbor activity: cells near high-density areas likely have undiscovered APs
        //    (people live/work near already-scanned areas)
        let neighborDensity = 0;
        let neighborCount = 0;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = row + dr;
            const nc = col + dc;
            if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
              neighborDensity += grid[nr][nc].count;
              neighborCount++;
            }
          }
        }
        const avgNeighborDensity = neighborCount > 0 ? neighborDensity / neighborCount : 0;
        // Cells with moderate neighbor density (not isolated wilderness) score higher
        const neighborScore = Math.min(avgNeighborDensity / (avgCount + 1), 1.0);

        // 3. Isolation penalty: cells completely surrounded by zero counts
        //    are likely unpopulated areas - penalize them
        let zeroNeighbors = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = row + dr;
            const nc = col + dc;
            if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) {
              zeroNeighbors++;
            } else if (grid[nr][nc].count === 0) {
              zeroNeighbors++;
            }
          }
        }
        const isolationPenalty = zeroNeighbors / 8; // 0 to 1, higher = more isolated

        // --- Combined score ---
        const score =
          scarcityScore * 0.55 + // Low existing scans is most important
          neighborScore * 0.35 - // Near populated areas is good
          isolationPenalty * 0.10; // Penalize isolation a bit

        scored.push({
          ...cell,
          score: Math.max(0, Math.min(1, score)),
          scarcityScore,
          neighborScore,
          isolationPenalty,
          isZeroScan: cell.count === 0,
        });
      }
    }

    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Select diverse waypoints for route planning
   * Ensures selected points cover different parts of the map
   * @param {Array} scoredCells - From scoreCells()
   * @param {number} numWaypoints - How many route waypoints to pick
   * @param {number} minSpreadDeg - Minimum degrees apart between waypoints
   * @returns {Array} Selected waypoint cells
   */
  selectWaypoints(scoredCells, numWaypoints = 15, minSpreadDeg = 0.005) {
    const waypoints = [];
    const candidates = [...scoredCells];

    // Always take the top-scoring cell first
    while (waypoints.length < numWaypoints && candidates.length > 0) {
      const best = candidates.shift();
      if (!best) break;

      // Check it's not too close to already-selected waypoints
      const tooClose = waypoints.some((wp) => {
        const dlat = Math.abs(wp.centerLat - best.centerLat);
        const dlon = Math.abs(wp.centerLon - best.centerLon);
        return dlat < minSpreadDeg && dlon < minSpreadDeg;
      });

      if (!tooClose) {
        waypoints.push(best);
      }
    }

    return waypoints;
  }

  /**
   * Order waypoints using nearest-neighbor TSP heuristic
   * Starts from a given point and greedily picks the closest unvisited waypoint
   * @param {Array} waypoints - Array of {centerLat, centerLon, ...}
   * @param {object} startPoint - {lat, lon} starting location (optional)
   * @returns {Array} Ordered waypoints
   */
  orderWaypointsNearestNeighbor(waypoints, startPoint = null) {
    if (waypoints.length === 0) return [];
    if (waypoints.length === 1) return waypoints;

    const remaining = [...waypoints];
    const ordered = [];

    // Find start: either closest to startPoint or highest-scored
    let current;
    if (startPoint) {
      let minDist = Infinity;
      let startIdx = 0;
      remaining.forEach((wp, i) => {
        const d = this._haversine(startPoint.lat, startPoint.lon, wp.centerLat, wp.centerLon);
        if (d < minDist) {
          minDist = d;
          startIdx = i;
        }
      });
      current = remaining.splice(startIdx, 1)[0];
    } else {
      current = remaining.shift();
    }

    ordered.push(current);

    while (remaining.length > 0) {
      let minDist = Infinity;
      let nearestIdx = 0;

      remaining.forEach((wp, i) => {
        const d = this._haversine(current.centerLat, current.centerLon, wp.centerLat, wp.centerLon);
        if (d < minDist) {
          minDist = d;
          nearestIdx = i;
        }
      });

      current = remaining.splice(nearestIdx, 1)[0];
      ordered.push(current);
    }

    return ordered;
  }

  /**
   * Get color for a density count (for map visualization)
   * Returns CSS color string
   */
  getHeatColor(count, maxCount) {
    if (count === 0) return "rgba(0, 200, 100, 0.35)"; // Green = unscanned
    const ratio = count / (maxCount + 1);
    if (ratio < 0.15) return "rgba(100, 220, 50, 0.3)"; // Light green = sparse
    if (ratio < 0.35) return "rgba(200, 220, 0, 0.3)"; // Yellow = moderate
    if (ratio < 0.65) return "rgba(255, 150, 0, 0.3)"; // Orange = busy
    return "rgba(255, 50, 50, 0.3)"; // Red = dense
  }

  /**
   * Get color for a score value
   */
  getScoreColor(score) {
    if (score > 0.75) return "#00ff88";
    if (score > 0.55) return "#88ff00";
    if (score > 0.35) return "#ffcc00";
    if (score > 0.15) return "#ff8800";
    return "#ff4444";
  }

  /**
   * Haversine distance in km
   */
  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

window.DensityAnalyzer = DensityAnalyzer;
