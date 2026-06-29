/**
 * WiGLE API v2 Client
 * Communicates via local proxy server to avoid CORS issues
 */

class WigleAPI {
  constructor() {
    this.baseUrl = "/wigle-proxy/api/v2";
    this.authToken = null;
  }

  setCredentials(apiName, apiToken) {
    // WiGLE uses HTTP Basic Auth with API name and token
    const raw = `${apiName}:${apiToken}`;
    this.authToken = btoa(raw);
    localStorage.setItem("wigle_auth", this.authToken);
    localStorage.setItem("wigle_api_name", apiName);
  }

  loadSavedCredentials() {
    this.authToken = localStorage.getItem("wigle_auth");
    return !!this.authToken;
  }

  clearCredentials() {
    this.authToken = null;
    localStorage.removeItem("wigle_auth");
    localStorage.removeItem("wigle_api_name");
  }

  isAuthenticated() {
    return !!this.authToken;
  }

  async _fetch(path, params = {}) {
    if (!this.authToken) {
      throw new Error("Not authenticated. Please enter your WiGLE API credentials.");
    }

    const queryParams = new URLSearchParams({
      ...params,
      _auth: this.authToken,
    });

    const url = `${this.baseUrl}${path}?${queryParams}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      const text = await resp.text();
      let msg = `WiGLE API error ${resp.status}`;
      try {
        const json = JSON.parse(text);
        msg = json.message || msg;
      } catch {}
      throw new Error(msg);
    }

    return resp.json();
  }

  /**
   * Verify credentials work
   */
  async testAuth() {
    return this._fetch("/profile/user");
  }

  /**
   * Search for networks in a bounding box
   * @param {number} lat1 - South latitude
   * @param {number} lat2 - North latitude
   * @param {number} lon1 - West longitude
   * @param {number} lon2 - East longitude
   * @param {object} opts - Additional options
   * @returns {Promise<object>} WiGLE search results
   */
  async searchNetworks(lat1, lat2, lon1, lon2, opts = {}) {
    const params = {
      latrange1: Math.min(lat1, lat2).toFixed(6),
      latrange2: Math.max(lat1, lat2).toFixed(6),
      longrange1: Math.min(lon1, lon2).toFixed(6),
      longrange2: Math.max(lon1, lon2).toFixed(6),
      resultsPerPage: opts.resultsPerPage || 100,
      pagestart: opts.pagestart || 0,
      lastupdt: opts.lastUpdated || "",
      netid: "",
      ssid: "",
      type: opts.type || "", // "WiFi", "BT", "BLE", ""
      onlymine: false,
      freenet: false,
      paynet: false,
      variance: opts.variance || 0.01,
    };

    return this._fetch("/network/search", params);
  }

  /**
   * Fetch multiple pages of results for an area
   * @param {object} bounds - {south, north, west, east}
   * @param {function} onProgress - Progress callback (fetched, total)
   * @param {object} opts - Options
   * @returns {Promise<Array>} All network results
   */
  async fetchAllNetworksInBounds(bounds, onProgress, opts = {}) {
    const { south, north, west, east } = bounds;
    const maxResults = opts.maxResults || 1000;
    const resultsPerPage = 100;

    const allNetworks = [];
    let pagestart = 0;
    let totalMatching = null;

    while (true) {
      const result = await this.searchNetworks(south, north, west, east, {
        resultsPerPage,
        pagestart,
        type: opts.type || "",
      });

      if (!result.success) {
        throw new Error(result.message || "Search failed");
      }

      const networks = result.results || [];
      allNetworks.push(...networks);

      if (totalMatching === null) {
        totalMatching = result.totalResults || networks.length;
      }

      if (onProgress) {
        onProgress(allNetworks.length, Math.min(totalMatching, maxResults));
      }

      // Stop conditions
      if (networks.length < resultsPerPage) break;
      if (allNetworks.length >= maxResults) break;
      if (pagestart + resultsPerPage >= totalMatching) break;

      pagestart += resultsPerPage;

      // Respect rate limits - small delay between pages
      await new Promise((r) => setTimeout(r, 300));
    }

    return allNetworks;
  }

  /**
   * Fetch network counts for a grid of cells (efficient batch approach)
   * Splits the bounds into a grid and fetches count per cell
   */
  async fetchGridCounts(bounds, gridSize, onProgress) {
    const { south, north, west, east } = bounds;
    const latStep = (north - south) / gridSize;
    const lonStep = (east - west) / gridSize;

    const grid = [];
    const totalCells = gridSize * gridSize;
    let completed = 0;

    for (let row = 0; row < gridSize; row++) {
      grid.push([]);
      for (let col = 0; col < gridSize; col++) {
        const cellSouth = south + row * latStep;
        const cellNorth = cellSouth + latStep;
        const cellWest = west + col * lonStep;
        const cellEast = cellWest + lonStep;

        try {
          const result = await this.searchNetworks(cellSouth, cellNorth, cellWest, cellEast, {
            resultsPerPage: 1, // We just need the count
          });

          grid[row].push({
            row,
            col,
            count: result.totalResults || 0,
            centerLat: (cellSouth + cellNorth) / 2,
            centerLon: (cellWest + cellEast) / 2,
            south: cellSouth,
            north: cellNorth,
            west: cellWest,
            east: cellEast,
          });
        } catch (e) {
          grid[row].push({
            row,
            col,
            count: -1, // Error
            centerLat: (cellSouth + cellNorth) / 2,
            centerLon: (cellWest + cellEast) / 2,
            south: cellSouth,
            north: cellNorth,
            west: cellWest,
            east: cellEast,
          });
        }

        completed++;
        if (onProgress) onProgress(completed, totalCells);

        // Respect WiGLE rate limits
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    return grid;
  }
}

window.WigleAPI = WigleAPI;
