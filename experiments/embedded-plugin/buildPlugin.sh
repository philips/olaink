#!/usr/bin/env bash
# Build the Phase 0.1 native-package probe as one .snplg archive.
# This experiment intentionally uses the repository's already-installed plugin
# dependencies. From the repository root, run `npm ci` before this command.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="$ROOT_DIR/build/generated"
OUTPUT="$ROOT_DIR/build/outputs"
NPK="$ROOT_DIR/android/app/build/outputs/npk/app.npk"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 2
  }
}
require npx
require python3
require unzip
require zip

[[ -d "$REPO_ROOT/node_modules/react-native" ]] || {
  echo "missing $REPO_ROOT/node_modules/react-native; run npm ci at the repository root" >&2
  exit 2
}
[[ -d "$REPO_ROOT/node_modules/sn-plugin-lib" ]] || {
  echo "missing $REPO_ROOT/node_modules/sn-plugin-lib; run npm ci at the repository root" >&2
  exit 2
}

rm -rf "$GENERATED" "$OUTPUT"
mkdir -p "$GENERATED" "$OUTPUT"

echo '==> Bundling React Native probe'
(
  cd "$ROOT_DIR"
  npx --no-install react-native bundle \
    --entry-file index.js \
    --bundle-output "$GENERATED/olainkprobe.bundle" \
    --platform android \
    --assets-dest "$GENERATED" \
    --dev false \
    --reset-cache
)

# The plugin icon is deliberately a plain archive member, not an Android
# resource. PluginConfig's absolute archive path points to it.
cp "$ROOT_DIR/PluginConfig.json" "$GENERATED/PluginConfig.json"
cp "$ROOT_DIR/assets/icon.png" "$GENERATED/icon.png"
mkdir -p "$GENERATED/webview"
cp "$ROOT_DIR"/webview/probe.html "$ROOT_DIR"/webview/probe-module.js \
  "$ROOT_DIR"/webview/probe-worker.js "$GENERATED/webview/"

echo '==> Building PluginHost native package'
(
  cd "$ROOT_DIR/android"
  JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}" \
  ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" \
  ./gradlew :app:buildPluginNpk
)
cp "$NPK" "$GENERATED/app.npk"

echo '==> Packaging olainkprobe.snplg'
(
  cd "$GENERATED"
  zip -X -q -r "$OUTPUT/olainkprobe.snplg" .
)
"$ROOT_DIR/verifyArchive.sh" "$OUTPUT/olainkprobe.snplg"
echo "OK: $OUTPUT/olainkprobe.snplg"
