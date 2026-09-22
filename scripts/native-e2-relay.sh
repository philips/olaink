#!/usr/bin/env bash
# Manage the disposable relay for the native single-.snplg experiment.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2_DIR="$REPO_ROOT/experiments/native-client-plugin/e2"

usage() {
  cat <<'EOF'
usage: scripts/native-e2-relay.sh start|stop|reset|status|pin|tailscale-cert

start          starts missing disposable relay processes, preserving its test database
stop           stops relay processes started by this harness
reset          stops, deletes all disposable relay/peer state, then starts fresh
status         reports process state and the current certificate pin
pin            prints the current relay leaf certificate SHA-256 pin
tailscale-cert replaces the disposable leaf with a WebPKI Tailscale certificate
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 2
  }
}

pid_is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null
}

start_process() {
  local name="$1" pid_file="$2" log_file="$3"
  shift 3
  if pid_is_running "$pid_file"; then
    echo "$name already running (pid $(<"$pid_file"))"
    return
  fi
  rm -f "$pid_file"
  "$@" >>"$log_file" 2>&1 &
  echo $! >"$pid_file"
  echo "started $name (pid $!)"
}

stop_process() {
  local name="$1" pid_file="$2"
  if ! [[ -f "$pid_file" ]]; then
    return
  fi
  local pid
  pid="$(<"$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    # Do not leave a child holding a listener if it takes a moment to exit.
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$pid_file"
}

print_pin() {
  [[ -f "$E2_DIR/tls-cert.pem" ]] || {
    echo 'relay certificate does not exist; run npm run native:e2:relay:start first' >&2
    exit 1
  }
  openssl x509 -in "$E2_DIR/tls-cert.pem" -outform DER | sha256sum | awk '{print $1}'
}

start() {
  require_command node
  require_command bun
  require_command openssl
  require_command sha256sum
  mkdir -p "$E2_DIR"
  if [[ ! -f "$E2_DIR/tls-cert.pem" || ! -f "$E2_DIR/tls-key.pem" ]]; then
    echo 'generating disposable self-signed relay certificate'
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
      -keyout "$E2_DIR/tls-key.pem" -out "$E2_DIR/tls-cert.pem" \
      -subj '/CN=olaink-e2-staging' >/dev/null 2>&1
  fi
  start_process 'AuthGravity stub' "$E2_DIR/stub.pid" "$E2_DIR/stub.log" \
    node "$E2_DIR/stub-authgravity.mjs"
  start_process 'Ola Ink relay' "$E2_DIR/server.pid" "$E2_DIR/server.log" \
    env AUTHGRAVITY_WHOAMI_URL=http://127.0.0.1:8011/v1/whoami \
      OLAINK_HOST=0.0.0.0 OLAINK_PORT=8010 \
      OLAINK_DATABASE="$E2_DIR/olaink-e2.sqlite" \
      bun "$REPO_ROOT/packages/server/src/main.ts"
  start_process 'TLS proxy' "$E2_DIR/tls.pid" "$E2_DIR/tls.log" \
    node "$E2_DIR/tls-proxy.mjs"
  echo "relay pin: $(print_pin)"
}

stop() {
  stop_process 'TLS proxy' "$E2_DIR/tls.pid"
  stop_process 'Ola Ink relay' "$E2_DIR/server.pid"
  stop_process 'AuthGravity stub' "$E2_DIR/stub.pid"
}

status() {
  local name pid_file
  for name in 'AuthGravity stub' 'Ola Ink relay' 'TLS proxy'; do
    case "$name" in
      'AuthGravity stub') pid_file="$E2_DIR/stub.pid" ;;
      'Ola Ink relay') pid_file="$E2_DIR/server.pid" ;;
      *) pid_file="$E2_DIR/tls.pid" ;;
    esac
    if pid_is_running "$pid_file"; then
      echo "$name: running (pid $(<"$pid_file"))"
    else
      echo "$name: stopped"
    fi
  done
  [[ -f "$E2_DIR/tls-cert.pem" ]] && echo "relay pin: $(print_pin)"
}

reset() {
  stop
  rm -f "$E2_DIR"/{tls-cert.pem,tls-key.pem,*.log,*.pid,*.sqlite,*.sqlite-shm,*.sqlite-wal,peer-state.json}
  start
}

tailscale_cert() {
  require_command tailscale
  local domain="${OLAINK_RELAY_HOST:-}"
  if [[ -z "$domain" ]]; then
    domain="$(tailscale status --json | node -e '
      let source = "";
      process.stdin.on("data", chunk => { source += chunk; });
      process.stdin.on("end", () => {
        const name = JSON.parse(source).Self?.DNSName;
        if (name) process.stdout.write(name.replace(/\.$/, ""));
      });
    ')"
  fi
  [[ "$domain" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]] || {
    echo 'OLAINK_RELAY_HOST must be this machine’s MagicDNS *.ts.net name' >&2
    exit 2
  }
  local certificate_tmp key_tmp
  certificate_tmp="$(mktemp "$E2_DIR/.tls-cert.XXXXXX")"
  key_tmp="$(mktemp "$E2_DIR/.tls-key.XXXXXX")"
  if ! tailscale cert --cert-file "$certificate_tmp" --key-file "$key_tmp" "$domain"; then
    rm -f "$certificate_tmp" "$key_tmp"
    echo 'existing relay certificate and TLS proxy were left unchanged' >&2
    return 1
  fi
  stop_process 'TLS proxy' "$E2_DIR/tls.pid"
  mv -f "$certificate_tmp" "$E2_DIR/tls-cert.pem"
  mv -f "$key_tmp" "$E2_DIR/tls-key.pem"
  start
  echo "React Native staging origin: https://${domain}:8443"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  status) status ;;
  pin) print_pin ;;
  tailscale-cert) tailscale_cert ;;
  *) usage >&2; exit 2 ;;
esac
