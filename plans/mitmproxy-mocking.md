# Mitmproxy Mocking Plan

This plan describes how to implement the mock response system within the mitmproxy integration.

## Implementation Details

### Phase 1: Directory Structure

Extend the `packages/node/tests/mitmproxy/` directory:

```text
packages/node/tests/mitmproxy/
├── proxy_addon.py         # Main mitmproxy addon (updated with routing logic)
└── responses/             # Mock response definitions
    ├── __init__.py        # Package marker (for IDE support)
    └── server_lan.py      # Responses for https://server.lan/*
```

### Phase 2: Mitmproxy Addon Script (Mocking Logic)

Replace the stub `packages/node/tests/mitmproxy/proxy_addon.py` with the full implementation:

```python
"""
Mitmproxy addon for intercepting and mocking HTTP responses.

This addon:
1. Proxies all traffic to the internet by default
2. Intercepts specific URLs (e.g., https://server.lan/*) and returns mock responses
"""

from mitmproxy import http, ctx
import json
import importlib.util
import os
from pathlib import Path

# Import response handlers
RESPONSES_DIR = Path(__file__).parent / "responses"


class MockResponseAddon:
    """Addon that intercepts specific requests and returns mock responses."""

    def __init__(self):
        self.handlers = {}
        self._load_handlers()

    def _load_handlers(self):
        """Dynamically load all response handler modules."""
        if not RESPONSES_DIR.exists():
            ctx.log.warn(f"Responses directory not found: {RESPONSES_DIR}")
            return

        for py_file in RESPONSES_DIR.glob("*.py"):
            if py_file.name.startswith("_"):
                continue

            module_name = py_file.stem
            spec = importlib.util.spec_from_file_location(module_name, py_file)
            module = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(module)
                if hasattr(module, "ROUTES"):
                    for pattern, handler in module.ROUTES.items():
                        self.handlers[pattern] = handler
                        ctx.log.info(f"Registered mock handler: {pattern}")
            except Exception as e:
                ctx.log.error(f"Failed to load handler {py_file}: {e}")

    def request(self, flow: http.HTTPFlow) -> None:
        """Intercept requests and optionally return mock responses."""
        url = flow.request.pretty_url

        # Check if this URL matches any mock handler
        for pattern, handler in self.handlers.items():
            if self._matches_pattern(url, pattern):
                ctx.log.info(f"Mocking request: {url}")
                response = handler(flow.request)
                flow.response = http.Response.make(
                    status_code=response.get("status", 200),
                    content=response.get("body", b""),
                    headers=response.get("headers", {"Content-Type": "application/json"}),
                )
                return

        # Let the request pass through to the internet
        ctx.log.debug(f"Proxying request: {url}")

    def _matches_pattern(self, url: str, pattern: str) -> bool:
        """
        Simple pattern matching.
        Supports:
        - Exact match: "https://server.lan/api/test"
        - Prefix match with wildcard: "https://server.lan/*"
        - Host-only match: "server.lan"
        """
        if pattern.endswith("/*"):
            prefix = pattern[:-1]  # Remove the trailing *
            return url.startswith(prefix)
        elif "://" not in pattern:
            # Host-only pattern
            from urllib.parse import urlparse
            parsed = urlparse(url)
            return parsed.netloc == pattern or parsed.netloc.endswith(f".{pattern}")
        else:
            return url == pattern


addons = [MockResponseAddon()]
```

### Phase 3: Example Response Handler

Create `packages/node/tests/mitmproxy/responses/server_lan.py`:

```python
"""
Mock responses for https://server.lan/* endpoints.

Each handler receives a mitmproxy Request object and returns a dict with:
- status: HTTP status code (default: 200)
- body: Response body (bytes or str)
- headers: Dict of response headers
"""

import json
from mitmproxy.http import Request


def handle_api_test(request: Request) -> dict:
    """Handle GET https://server.lan/api/test"""
    return {
        "status": 200,
        "body": json.dumps({
            "message": "This is a mock response from mitmproxy",
            "path": request.path,
            "method": request.method,
        }),
        "headers": {
            "Content-Type": "application/json",
            "X-Mock-Response": "true",
        },
    }


def handle_api_data(request: Request) -> dict:
    """Handle requests to https://server.lan/api/data/*"""
    return {
        "status": 200,
        "body": json.dumps({
            "data": [1, 2, 3, 4, 5],
            "mocked": True,
        }),
        "headers": {"Content-Type": "application/json"},
    }


def handle_health(request: Request) -> dict:
    """Handle GET https://server.lan/health"""
    return {
        "status": 200,
        "body": "OK",
        "headers": {"Content-Type": "text/plain"},
    }


# Route patterns to handler functions
ROUTES = {
    "https://server.lan/api/test": handle_api_test,
    "https://server.lan/api/data/*": handle_api_data,
    "https://server.lan/health": handle_health,
}
```

### Phase 4: README for Mitmproxy Scripts

Create `packages/node/tests/mitmproxy/README.md` with full details from the main plan.
