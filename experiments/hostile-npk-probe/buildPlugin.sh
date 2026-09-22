#!/usr/bin/env bash
# Build the disposable hostile-plugin isolation probe for E1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="$ROOT_DIR/build/generated"
OUTPUT="$ROOT_DIR/build/outputs"
NPK="$ROOT_DIR/android/app/build/outputs/npk/app.npk"
ARCHIVE="$OUTPUT/olainkhostile.snplg"

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

rm -rf "$GENERATED" "$OUTPUT"
mkdir -p "$GENERATED" "$OUTPUT"

echo '==> Bundling React Native hostile probe'
(
  cd "$ROOT_DIR"
  npx --no-install metro build index.js \
    --out "$GENERATED/olainkhostile.bundle" \
    --platform android --dev false --minify true --reset-cache \
    --config metro.config.cjs
)
if [[ -f "$GENERATED/olainkhostile.bundle.js" ]]; then
  mv "$GENERATED/olainkhostile.bundle.js" "$GENERATED/olainkhostile.bundle"
fi
[[ -f "$GENERATED/olainkhostile.bundle" ]] || {
  echo 'Metro did not produce the configured bundle' >&2
  exit 1
}
cp "$ROOT_DIR/PluginConfig.json" "$GENERATED/PluginConfig.json"
cp "$ROOT_DIR/assets/icon.png" "$GENERATED/icon.png"

echo '==> Building PluginHost app.npk'
(
  cd "$ROOT_DIR/android"
  JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}" \
  ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" \
    ./gradlew :app:buildPluginNpk
)
cp "$NPK" "$GENERATED/app.npk"

echo '==> Packaging olainkhostile.snplg'
(
  cd "$GENERATED"
  zip -X -q "$ARCHIVE" olainkhostile.bundle PluginConfig.json icon.png app.npk
)
"$ROOT_DIR/verifyArchive.sh" "$ARCHIVE"
echo "SHA256 $(sha256sum "$ARCHIVE" | awk '{print $1}')  $ARCHIVE"
echo "OK: $ARCHIVE"
