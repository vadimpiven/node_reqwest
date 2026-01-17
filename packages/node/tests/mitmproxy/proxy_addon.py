"""
Mitmproxy addon that proxies all traffic except for the requests to the test server.

Note: Mitmproxy automatically reloads scripts when they are modified.
Any changes to this file will be picked up immediately by the running proxy.
"""

from mitmproxy import ctx
from mitmproxy import http


class ProxyAddon:
    """Addon that intercepts specific requests and returns mock responses."""

    def request(self, flow: http.HTTPFlow) -> None:
        """Intercept requests and optionally return mock responses."""
        url = flow.request.pretty_url

        # Check if the requested host is echo.lan
        if flow.request.pretty_host == "echo.lan":
            ctx.log.info(f"Echoing request: {flow.request.pretty_url}")
            flow.response = http.Response.make(
                200,
                flow.request.content or b"",
                dict(flow.request.headers),
            )
            return

        # Let the request pass through to the internet
        ctx.log.debug(f"Proxying request: {url}")


addons = [ProxyAddon()]
