#!/usr/bin/env bash
# Build the disposable non-WebView animated SVG-scene probe.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
GENERATED="$ROOT_DIR/build/generated"
OUTPUT="$ROOT_DIR/build/outputs"
NPK="$ROOT_DIR/android/app/build/outputs/npk/app.npk"
SUPPLIED_SVG="$REPO_ROOT/fixtures/rtr-n5-20230015-recognition.note.0.svg"

for command in npx python3 unzip zip; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 2; }
done
[[ -d "$REPO_ROOT/node_modules/react-native" ]] || { echo 'run npm ci at repository root first' >&2; exit 2; }
[[ -d "$REPO_ROOT/node_modules/sn-plugin-lib" ]] || { echo 'run npm ci at repository root first' >&2; exit 2; }
[[ -f "$SUPPLIED_SVG" ]] || { echo "missing supplied SVG: $SUPPLIED_SVG" >&2; exit 2; }

rm -rf "$GENERATED" "$OUTPUT"
mkdir -p "$GENERATED" "$OUTPUT"

echo '==> Bundling React Native SVG-scene probe'
(
  cd "$ROOT_DIR"
  npx --no-install metro build index.js --out "$GENERATED/olainksvgprobe.bundle" \
    --platform android --dev false --minify true --reset-cache --config metro.config.cjs
)
# Metro 0.82 normalizes a JavaScript output to a .js suffix; PluginHost's
# archive convention uses the configured bare .bundle member.
mv "$GENERATED/olainksvgprobe.bundle.js" "$GENERATED/olainksvgprobe.bundle"
cp "$ROOT_DIR/PluginConfig.json" "$ROOT_DIR/assets/icon.png" "$ROOT_DIR/animated-scene.svg" "$GENERATED/"
mkdir -p "$GENERATED/examples" "$GENERATED/fixtures"
cp "$ROOT_DIR"/examples/*.svg "$GENERATED/examples/"
cp "$ROOT_DIR/fixtures/documents.json" "$GENERATED/fixtures/"
cp "$REPO_ROOT"/fixtures/*-embed-scene.svg "$GENERATED/fixtures/"

# The supplied supernote-typescript SVG contains a PNG data URI, not vector
# paths. Preserve the original and extract that exact raster for the honest
# top-to-bottom wipe experiment; never pretend this is stroke replay data.
cp "$SUPPLIED_SVG" "$GENERATED/supplied-note.svg"
SUPPLIED_SVG="$SUPPLIED_SVG" OUTPUT_PNG="$GENERATED/supplied-note-background.png" python3 - <<'PY'
import base64
import os
from pathlib import Path
import xml.etree.ElementTree as ET

root = ET.parse(os.environ['SUPPLIED_SVG']).getroot()
href = next((element.get('{http://www.w3.org/1999/xlink}href') or element.get('href')
             for element in root.iter() if element.tag.rsplit('}', 1)[-1] == 'image'), None)
if not href or not href.startswith('data:image/png;base64,'):
    raise SystemExit('supplied SVG does not contain one PNG data URI')
png = base64.b64decode(href.split(',', 1)[1], validate=True)
if not png.startswith(b'\x89PNG\r\n\x1a\n'):
    raise SystemExit('supplied SVG image is not a PNG')
Path(os.environ['OUTPUT_PNG']).write_bytes(png)
PY

echo '==> Building PluginHost native package'
(
  cd "$ROOT_DIR/android"
  JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}" ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}" \
    ./gradlew :app:buildPluginNpk
)
cp "$NPK" "$GENERATED/app.npk"

echo '==> Packaging olainksvgprobe.snplg'
(
  cd "$GENERATED"
  zip -X -q -r "$OUTPUT/olainksvgprobe.snplg" .
)
"$ROOT_DIR/verifyArchive.sh" "$OUTPUT/olainksvgprobe.snplg"
echo "OK: $OUTPUT/olainksvgprobe.snplg"
