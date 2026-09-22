#!/usr/bin/env bash
# Build E0 of the disposable single-.snplg native client experiment.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="$ROOT_DIR/build/generated"
OUTPUT="$ROOT_DIR/build/outputs"
NPK="$ROOT_DIR/android/app/build/outputs/npk/app.npk"
ARCHIVE="$OUTPUT/olainknativeexp.snplg"

for command in npx python3 strings unzip zip sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command not found: $command" >&2
    exit 2
  }
done
[[ -d "$REPO_ROOT/node_modules/react-native" ]] || {
  echo 'run npm ci at the repository root first' >&2
  exit 2
}
[[ -d "$REPO_ROOT/node_modules/sn-plugin-lib" ]] || {
  echo 'run npm ci at the repository root first' >&2
  exit 2
}
# E2 requires one pinned HTTPS staging relay (scheme+host+port only). This is
# the only network wiring point; cleartext and unpinned relays are forbidden.
RELAY_BASE="${OLAINK_RELAY_BASE:-}"
if [[ ! "$RELAY_BASE" =~ ^https://[0-9A-Za-z.:-]+$ ]]; then
  echo "OLAINK_RELAY_BASE must be a fixed HTTPS staging relay, e.g. https://100.68.250.67:8443" >&2
  exit 2
fi
RELAY_PIN="${OLAINK_RELAY_CERT_SHA256:-}"
if [[ ! "$RELAY_PIN" =~ ^[0-9a-f]{64}$ ]]; then
  echo "OLAINK_RELAY_CERT_SHA256 must be the relay leaf SHA-256 (lowercase hex, 64 chars)" >&2
  exit 2
fi

rm -rf "$GENERATED" "$OUTPUT"
mkdir -p "$GENERATED" "$OUTPUT"

echo '==> Bundling React Native E0 shell'
(
  cd "$ROOT_DIR"
  npx --no-install metro build index.js \
    --out "$GENERATED/olainknativeexp.bundle" \
    --platform android --dev false --minify true --reset-cache \
    --config metro.config.cjs
)
if [[ -f "$GENERATED/olainknativeexp.bundle.js" ]]; then
  mv "$GENERATED/olainknativeexp.bundle.js" "$GENERATED/olainknativeexp.bundle"
fi
[[ -f "$GENERATED/olainknativeexp.bundle" ]] || {
  echo 'Metro did not produce the configured bundle' >&2
  exit 1
}
cp "$ROOT_DIR/PluginConfig.json" "$GENERATED/PluginConfig.json"
cp "$ROOT_DIR/assets/icon.png" "$GENERATED/icon.png"
printf '{"base":"%s"%s}\n' "$RELAY_BASE" "${RELAY_PIN:+,\"certSha256\":\"$RELAY_PIN\"}" > "$GENERATED/relay.json"
mkdir -p "$GENERATED/vectors"
cp "$ROOT_DIR/vectors/note-v1-vectors.json" "$GENERATED/vectors/"

echo '==> Building PluginHost app.npk'
(
  cd "$ROOT_DIR/android"
  JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}" \
  ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" \
    ./gradlew :app:buildPluginNpk
)
cp "$NPK" "$GENERATED/app.npk"

echo '==> Packaging olainknativeexp.snplg'
(
  cd "$GENERATED"
  zip -X -q "$ARCHIVE" \
    olainknativeexp.bundle PluginConfig.json icon.png app.npk \
    relay.json vectors/note-v1-vectors.json
)
"$ROOT_DIR/verifyArchive.sh" "$ARCHIVE"
echo "SHA256 $(sha256sum "$ARCHIVE" | awk '{print $1}')  $ARCHIVE"
echo "OK: $ARCHIVE"
