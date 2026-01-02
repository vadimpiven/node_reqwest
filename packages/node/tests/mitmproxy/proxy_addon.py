"""
Mitmproxy stub addon that proxies all traffic.
"""

import json
from urllib.parse import urlparse

from mitmproxy import ctx, http


def handle_test(request: http.Request) -> http.Response:
    """Handle GET https://server.lan/test"""
    return http.Response.make(
        status_code=200,
        headers={
            "Content-Type": "application/json",
            "X-Mock-Response": "true",
        },
        content=json.dumps(
            {
                "message": "This is a mock response from mitmproxy",
                "path": request.path,
                "method": request.method,
            }
        ),
    )


# Route patterns to handler functions
ROUTES = {
    "https://server.lan/test": handle_test,
}


class ProxyAddon:
    """Addon that intercepts specific requests and returns mock responses."""

    def request(self, flow: http.HTTPFlow) -> None:
        """Intercept requests and optionally return mock responses."""
        url = flow.request.pretty_url

        # Check if this URL matches any mock handler
        for pattern, handler in ROUTES.items():
            if self._matches_pattern(url, pattern):
                ctx.log.info(f"Mocking request: {url}")
                flow.response = handler(flow.request)
                return

        # Let the request pass through to the internet
        ctx.log.debug(f"Proxying request: {url}")

    def _matches_pattern(self, url: str, pattern: str) -> bool:
        """
        Simple pattern matching.
        Supports:
        - Exact match: "https://server.lan/test"
        - Prefix match with wildcard: "https://server.lan/*"
        - Host-only match: "server.lan"
        """
        if pattern.endswith("/*"):
            prefix = pattern[:-1]  # Remove the trailing *
            return url.startswith(prefix)
        elif "://" not in pattern:
            # Host-only pattern
            parsed = urlparse(url)
            return parsed.netloc == pattern or parsed.netloc.endswith(f".{pattern}")
        else:
            return url == pattern


addons = [ProxyAddon()]
