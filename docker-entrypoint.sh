#!/bin/bash
set -euo pipefail

MITMPROXY_CERT="/mitmproxy-certs/mitmproxy-ca-cert.pem"
INSTALLED_CERT="/etc/pki/ca-trust/source/anchors/mitmproxy-ca.crt"

# Remove ready marker at start (in case of container restart)
rm -f "$READY_MARKER"

# Use ${VAR:-} to handle unset variables when using set -u
if [[ -n "${MITM_PROXY:-}" ]]; then
    if [[ -f "$MITMPROXY_CERT" ]]; then
        # Only install and update trust if the certificate has changed or is missing
        if ! cmp -s "$MITMPROXY_CERT" "$INSTALLED_CERT"; then
            echo "Installing mitmproxy CA certificate in system store..."
            sudo cp "$MITMPROXY_CERT" "$INSTALLED_CERT"
            sudo update-ca-trust extract
            # Symlinks in Dockerfile point to $SSL_CERT_FILE which is now updated
            echo "CA certificate installed successfully"
        fi
    else
        echo "ERROR: MITM_PROXY set but cert missing at $MITMPROXY_CERT" >&2
        exit 1
    fi
fi

mise trust --all --yes
mise install --yes

# Signal that initialization is complete
touch "$READY_MARKER"

exec "$@"
