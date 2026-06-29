/**
 * WiGLE API v2 Client
 * Communicates via local proxy server to avoid CORS issues.
 * Results are cached in localStorage (24 hr TTL) to preserve daily API quota.
 */

class WigleAPI {
  constructor() {
    this.baseUrl = "/wigle-proxy/api/v2";
    this.authToken = null;
    this.CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    this.CACHE_PREFIX = "wigle_cache_";
  }

  // ── Credentials ──────────────────────────────────────────

  setCredentials(apiName, apiToken) {
    this.authToken = btoa(`${apiName}:${apiToken}`);
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

  // ── Cache helpers ─────────────────────────────────────────

  _cacheKey(bounds, type) {
    // Round to 2 decimal places (~1 km) so nearby areas share cache
    const r = (n) => Math.round(n * 100) / 100;
    return (
      this.CACHE_PREFIX +
      `${r(bounds.south)},${r(bounds.north)},${r(bounds.west)},${r(bounds.east)},${type || "all"}`
    );
  }

  _readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > this.CACHE_TTL_MS) {
        localStorage.removeItem(key);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  _writeCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // localStorage full — clear old cache entries and try once more
      this._pruneCache();
      try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
    }
  }

  _pruneCache() {
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.CACHE_PREFIX)) toDelete.push(k);
    }
    toDelete.forEach((k) => localStorage.removeItem(k));
    console.log(`[WiGLE cache] Pruned ${toDelete.length} entries`);
  }

  clearCache() {
    this._pruneCache();
  }

  getCacheStats() {
    let count = 0;
    let oldest = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(this.CACHE_PREFIX)) continue;
      count++;
      try {
        const { ts } = JSON.parse(localStorage.getItem(k));
        if (ts < oldest) oldest = ts;
      } catch {}
    }
    return { count, oldestMs: count > 0 ? Date.now() - oldest : 0 };
  }

  // ── Core fetch ────────────────────────────────────────────

  async _fetch(path, params = {}) {
    if (!this.authToken) {
      throw new Error("Not authenticated. Please enter your WiGLE API credentials.");
    }

    const queryParams = new URLSearchParams({ ...params, _auth: this.authToken });
    const url = `${this.baseUrl}${path}?${queryParams}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      let msg = `WiGLE API error ${resp.status}`;
      try { msg = JSON.parse(text).message || msg; } catch {}

      // Friendly message for the daily quota error
      if (resp.status === 429 || text.toLowerCase().includes("too many")) {
        throw new Error(
          "WiGLE daily query limit reached. " +
          "Limits reset at midnight UTC — try again tomorrow, or use cached results by scanning the same area again."
        );
      }
      if (resp.status === 401) {
        throw new Error("WiGLE authentication failed. Check your API Name and Token in Settings.");
      }
      throw new Error(msg);
    }

    const json = await resp.json();

    // WiGLE sometimes returns 200 with success:false and a quota message
    if (json.success === false) {
      const m = (json.message || "").toLowerCase();
      if (m.includes("too many") || m.includes("exceeded") || m.includes("quota")) {
        throw new Error(
          "WiGLE daily query limit reached. " +
          "Limits reset at midnight UTC — cached results will be used for areas you've already scanned today."
        );
      }
      throw new Error(json.message || "WiGLE request failed");
    }

    return json;
  }

  // ── Public API ────────────────────────────────────────────

  async testAuth() {
    return this._fetch("/profile/user");
  }

  async searchNetworks(lat1, lat2, lon1, lon2, opts = {}) {
    const params = {
      latrange1:      Math.min(lat1, lat2).toFixed(6),
      latrange2:      Math.max(lat1, lat2).toFixed(6),
      longrange1:     Math.min(lon1, lon2).toFixed(6),
      longrange2:     Math.max(lon1, lon2).toFixed(6),
      resultsPerPage: opts.resultsPerPage || 100,
      pagestart:      opts.pagestart || 0,
      type:           opts.type || "",
      onlymine:       false,
      freenet:        false,
      paynet:         false,
    };
    return this._fetch("/network/search", params);
  }

  /**
   * Fetch all networks in bounds, with localStorage caching.
   * @param {object}   bounds      - {south, north, west, east}
   * @param {function} onProgress  - (fetched, total, fromCache) callback
   * @param {object}   opts        - {maxResults, type, forceRefresh}
   */
  async fetchAllNetworksInBounds(bounds, onProgress, opts = {}) {
    const cacheKey = this._cacheKey(bounds, opts.type);

    // Return cached data if available and not forcing a refresh
    if (!opts.forceRefresh) {
      const cached = this._readCache(cacheKey);
      if (cached) {
        console.log(`[WiGLE cache] HIT — ${cached.length} networks from cache`);
        if (onProgress) onProgress(cached.length, cached.length, true);
        return cached;
      }
    }

    // No cache — fetch from API
    const maxResults     = opts.maxResults || 500;
    const resultsPerPage = 100;
    const allNetworks    = [];
    let pagestart        = 0;
    let totalMatching    = null;

    while (true) {
      const result = await this.searchNetworks(
        bounds.south, bounds.north, bounds.west, bounds.east,
        { resultsPerPage, pagestart, type: opts.type || "" }
      );

      const networks = result.results || [];
      allNetworks.push(...networks);

      if (totalMatching === null) {
        totalMatching = result.totalResults || networks.length;
      }

      if (onProgress) onProgress(allNetworks.length, Math.min(totalMatching, maxResults), false);

      if (networks.length < resultsPerPage)           break;
      if (allNetworks.length >= maxResults)            break;
      if (pagestart + resultsPerPage >= totalMatching) break;

      pagestart += resultsPerPage;
      await new Promise((r) => setTimeout(r, 350)); // rate limit buffer
    }

    // Cache the results
    this._writeCache(cacheKey, allNetworks);
    console.log(`[WiGLE cache] Stored ${allNetworks.length} networks`);

    return allNetworks;
  }
}

window.WigleAPI = WigleAPI;
