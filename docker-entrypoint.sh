#!/bin/bash
set -euo pipefail

MITMPROXY_CERT="/mitmproxy-certs/mitmproxy-ca-cert.pem"
INSTALLED_CERT="/etc/pki/ca-trust/source/anchors/mitmproxy-ca.crt"

# Use ${VAR:-} to handle unset variables when using set -u
if [[ -n "${MITM_PROXY:-}" ]]; then
    if [[ -f "$MITMPROXY_CERT" ]]; then
        # Only install and update trust if the certificate has changed or is missing
        if ! cmp -s "$MITMPROXY_CERT" "$INSTALLED_CERT"; then
            echo "Installing mitmproxy CA certificate in system store..."
            sudo cp "$MITMPROXY_CERT" "$INSTALLED_CERT"
            sudo update-ca-trust extract
            sudo ln -sf /etc/pki/tls/certs/ca-bundle.crt /opt/_internal/certs.pem
            echo "CA certificate installed successfully"
        fi
    else
        echo "ERROR: MITM_PROXY set but cert missing at $MITMPROXY_CERT" >&2
        exit 1
    fi
fi

# Install dependencies (uses cache, fast on subsequent runs)
echo "Running pnpm install..."
CI=true HUSKY=1 pnpm install

# Execute the command (e.g., sleep infinity)
exec "$@"
