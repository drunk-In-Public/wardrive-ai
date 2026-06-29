#!/usr/bin/env python3
"""
WardDrive AI - Local server
Serves the frontend and proxies WiGLE API calls (handles CORS)
"""

import http.server
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

PORT = int(os.environ.get("PORT", 7432))
BASE_DIR = Path(__file__).parent / "public"


class WardDriveHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, format, *args):
        # Quieter logs - only show non-200 or API calls
        if "/api/" in self.path or args[1] != "200":
            print(f"[{self.log_date_time_string()}] {format % args}")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # Health check endpoint (used by keep-alive ping)
        if parsed.path == "/health":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        # Proxy WiGLE API calls
        if parsed.path.startswith("/wigle-proxy/"):
            self._proxy_wigle(parsed)
            return

        # Proxy OSRM routing calls
        if parsed.path.startswith("/osrm-proxy/"):
            self._proxy_osrm(parsed)
            return

        # Serve static files
        super().do_GET()

    def _proxy_wigle(self, parsed):
        """Proxy requests to WiGLE API v2"""
        api_path = parsed.path.replace("/wigle-proxy", "")
        query = parsed.query

        # Get auth from query param (we strip it before forwarding)
        params = urllib.parse.parse_qs(query)
        auth_token = params.pop("_auth", [None])[0]

        # Rebuild query without _auth
        clean_query = urllib.parse.urlencode(
            {k: v[0] for k, v in params.items()}, safe=""
        )

        wigle_url = f"https://api.wigle.net{api_path}"
        if clean_query:
            wigle_url += f"?{clean_query}"

        print(f"[WiGLE] Proxying: {wigle_url}")

        req = urllib.request.Request(wigle_url)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "WardDriveAI/1.0")
        if auth_token:
            req.add_header("Authorization", f"Basic {auth_token}")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            try:
                body = e.read()
            except Exception:
                body = b'{}'
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.URLError as e:
            err = json.dumps({"error": f"Connection failed: {e.reason}"}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(err)
        except Exception as e:
            err = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(err)

    def _proxy_osrm(self, parsed):
        """Proxy requests to OSRM routing API"""
        api_path = parsed.path.replace("/osrm-proxy", "")
        query = parsed.query

        osrm_url = f"https://router.project-osrm.org{api_path}"
        if query:
            osrm_url += f"?{query}"

        print(f"[OSRM] Proxying: {osrm_url}")

        req = urllib.request.Request(osrm_url)
        req.add_header("User-Agent", "WardDriveAI/1.0")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            err = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(err)


def main():
    if not BASE_DIR.exists():
        print(f"ERROR: public/ directory not found at {BASE_DIR}")
        sys.exit(1)

    print("=" * 60)
    print("  WardDrive AI - Wardriving Route Planner")
    print("=" * 60)
    print(f"  Local:   http://localhost:{PORT}")
    print(f"  Network: http://0.0.0.0:{PORT}")
    print()
    print("  iPhone: Connect to same WiFi, open Safari,")
    print(f"          navigate to http://<your-ip>:{PORT}")
    print("          then tap Share → Add to Home Screen")
    print()
    print("  Press Ctrl+C to stop")
    print("=" * 60)

    server = http.server.HTTPServer(("0.0.0.0", PORT), WardDriveHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")


if __name__ == "__main__":
    main()
