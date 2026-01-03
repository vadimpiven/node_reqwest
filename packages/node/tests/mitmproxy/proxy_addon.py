"""
Mitmproxy addon that proxies all traffic except for the requests to the test server.

Note: Mitmproxy automatically reloads scripts when they are modified.
Any changes to this file will be picked up immediately by the running proxy.
"""

import json

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
        handler = ROUTES.get(url)
        if handler:
            ctx.log.info(f"Mocking request: {url}")
            flow.response = handler(flow.request)
            return

        # Let the request pass through to the internet
        ctx.log.debug(f"Proxying request: {url}")


addons = [ProxyAddon()]
