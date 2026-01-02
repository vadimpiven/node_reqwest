"""
Mitmproxy stub addon that proxies all traffic.
For details on mocking, see [Mitmproxy Mocking Plan](./mitmproxy-mocking.md).
"""

from mitmproxy import http, ctx

class ProxyAddon:
    def request(self, flow: http.HTTPFlow) -> None:
        """Log proxied requests."""
        ctx.log.debug(f"Proxying request: {flow.request.pretty_url}")

addons = [ProxyAddon()]
