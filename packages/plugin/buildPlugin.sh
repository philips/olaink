#!/usr/bin/env bash
# Build the stable native Ola Ink .snplg. The relay origin is intentionally
# fixed: production builds never accept a staging endpoint override.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="${OLAINK_PLUGIN_GENERATED_DIR:-$ROOT_DIR/build/generated}"
OUTPUT="${OLAINK_PLUGIN_OUTPUT_DIR:-$ROOT_DIR/build/outputs}"
PLUGIN_VERSION_NAME="${OLAINK_PLUGIN_VERSION_NAME:-}"
PLUGIN_VERSION_CODE="${OLAINK_PLUGIN_VERSION_CODE:-}"
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
  # React Native's bundler copies require()d image assets only when an
  # assets destination is supplied. The NOTE-sidebar button receives that URI.
  npx --no-install react-native bundle --entry-file index.js \
    --bundle-output "$GENERATED/olainkplugin.bundle" --assets-dest "$GENERATED" \
    --platform android --dev false --reset-cache --config metro.config.cjs
)
[[ -f "$GENERATED/olainkplugin.bundle" ]] || { echo 'React Native bundle missing' >&2; exit 1; }
cp "$ROOT_DIR/PluginConfig.json" "$GENERATED/PluginConfig.json"
PLUGIN_CONFIG="$GENERATED/PluginConfig.json" PLUGIN_VERSION_NAME="$PLUGIN_VERSION_NAME" \
PLUGIN_VERSION_CODE="$PLUGIN_VERSION_CODE" python3 - <<'PY'
import json, os
path = os.environ['PLUGIN_CONFIG']
config = json.load(open(path))
if os.environ['PLUGIN_VERSION_NAME']:
    config['versionName'] = os.environ['PLUGIN_VERSION_NAME']
if os.environ['PLUGIN_VERSION_CODE']:
    if not os.environ['PLUGIN_VERSION_CODE'].isdecimal():
        raise SystemExit('OLAINK_PLUGIN_VERSION_CODE must be numeric')
    config['versionCode'] = os.environ['PLUGIN_VERSION_CODE']
with open(path, 'w') as output:
    json.dump(config, output, indent=2)
    output.write('\n')
PY
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
  zip -X -q -r "$ARCHIVE" .
)
echo "OK: $ARCHIVE"
