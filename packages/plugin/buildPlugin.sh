#!/usr/bin/env bash
# Build the stable native Ola Ink .snplg. The relay origin is intentionally
# fixed: production builds never accept a staging endpoint override.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="$ROOT_DIR/build/generated"
OUTPUT="$ROOT_DIR/build/outputs"
NPK="$ROOT_DIR/android/app/build/outputs/npk/app.npk"
ARCHIVE="$OUTPUT/olainkplugin.snplg"

for command in npx python3 zip; do command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 2; }; done
[[ -d "$REPO_ROOT/node_modules/react-native" && -d "$REPO_ROOT/node_modules/sn-plugin-lib" ]] || {
  echo 'run npm ci at the repository root first' >&2; exit 2;
}
rm -rf "$GENERATED" "$OUTPUT"
mkdir -p "$GENERATED/vectors" "$OUTPUT"

(
  cd "$ROOT_DIR"
  npx --no-install metro build index.js --out "$GENERATED/olainkplugin.bundle" \
    --platform android --dev false --minify true --reset-cache --config metro.config.cjs
)
[[ -f "$GENERATED/olainkplugin.bundle" ]] || {
  [[ -f "$GENERATED/olainkplugin.bundle.js" ]] || { echo 'Metro bundle missing' >&2; exit 1; }
  mv "$GENERATED/olainkplugin.bundle.js" "$GENERATED/olainkplugin.bundle"
}
cp "$ROOT_DIR/PluginConfig.json" "$GENERATED/PluginConfig.json"
cp "$ROOT_DIR/assets/icon.png" "$GENERATED/icon.png"
printf '%s\n' '{"base":"https://app.olaink.com"}' > "$GENERATED/relay.json"
cp "$ROOT_DIR/vectors/note-v1-vectors.json" "$GENERATED/vectors/"
(
  cd "$ROOT_DIR/android"
  JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}" ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" \
    ./gradlew :app:buildPluginNpk
)
cp "$NPK" "$GENERATED/app.npk"
(
  cd "$GENERATED"
  zip -X -q "$ARCHIVE" olainkplugin.bundle PluginConfig.json icon.png app.npk relay.json vectors/note-v1-vectors.json
)
echo "OK: $ARCHIVE"
