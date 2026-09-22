#!/usr/bin/env bash
# Build the disposable plugin against this machine's disposable E2 relay.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2_DIR="$REPO_ROOT/experiments/native-client-plugin/e2"

[[ -f "$E2_DIR/tls-cert.pem" ]] || {
  echo 'no disposable relay certificate; run npm run native:e2:relay:start first' >&2
  exit 2
}

# The Nomad must reach the host, so prefer its Tailscale IPv4 address. An
# explicit override is useful on a different network or with port forwarding.
RELAY_HOST="${OLAINK_RELAY_HOST:-}"
if [[ -z "$RELAY_HOST" ]] && command -v tailscale >/dev/null 2>&1; then
  RELAY_HOST="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi
[[ -n "$RELAY_HOST" ]] || {
  cat >&2 <<'EOF'
Cannot determine a device-reachable relay host.
Set OLAINK_RELAY_HOST to this machine's Tailscale IPv4 address, for example:
  OLAINK_RELAY_HOST=100.68.250.67 npm run native:e2:build
EOF
  exit 2
}
[[ "$RELAY_HOST" =~ ^[0-9A-Za-z.-]+$ ]] || {
  echo 'OLAINK_RELAY_HOST must be a hostname or IP address (set OLAINK_RELAY_PORT separately)' >&2
  exit 2
}

PIN="$(openssl x509 -in "$E2_DIR/tls-cert.pem" -outform DER | sha256sum | awk '{print $1}')"
RELAY_PORT="${OLAINK_RELAY_PORT:-8443}"
[[ "$RELAY_PORT" =~ ^[0-9]+$ ]] || { echo 'OLAINK_RELAY_PORT must be numeric' >&2; exit 2; }

echo "building experimental plugin for https://${RELAY_HOST}:${RELAY_PORT}"
OLAINK_RELAY_BASE="https://${RELAY_HOST}:${RELAY_PORT}" \
OLAINK_RELAY_CERT_SHA256="$PIN" \
  "$REPO_ROOT/experiments/native-client-plugin/buildPlugin.sh"
