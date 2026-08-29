#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:?usage: verifyArchive.sh path/to/olainksvgprobe.snplg}"
[[ -f "$ARCHIVE" ]] || { echo "missing archive: $ARCHIVE" >&2; exit 2; }
command -v unzip >/dev/null || { echo 'unzip is required' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 2; }

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
unzip -qq "$ARCHIVE" -d "$TEMP/archive"
python3 - "$TEMP/archive/PluginConfig.json" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding='utf-8'))
expected = {
    'pluginID': 'olainksvgprobe0001',
    'pluginKey': 'olainksvgprobe',
    'versionName': '0.0.18-tests-v1',
    'versionCode': '18',
    'jsMainPath': 'index',
    'nativeCodePackage': '/app.npk',
    'reactPackages': ['com.olaink.svgprobe.OlaInkSvgProbePackage'],
}
for key, value in expected.items():
    if config.get(key) != value:
        raise SystemExit(f'PluginConfig {key!r}: expected {value!r}, got {config.get(key)!r}')
if config.get('uses-permissions'):
    raise SystemExit('SVG-scene probe must not request PluginHost permissions')
PY

for member in olainksvgprobe.bundle icon.png PluginConfig.json animated-scene.svg \
  examples/centerline-reveal.svg examples/contour-swap.svg examples/contour-fade.svg \
  supplied-note.svg supplied-note-background.png app.npk; do
  [[ -f "$TEMP/archive/$member" ]] || { echo "missing archive member: $member" >&2; exit 1; }
done
unzip -qq "$TEMP/archive/app.npk" -d "$TEMP/npk"
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -exec strings {} + > "$TEMP/dex-strings"
grep -q 'OlaInkSvgProbePackage' "$TEMP/dex-strings" || { echo 'NPK missing probe ReactPackage' >&2; exit 1; }
grep -q 'AnimatedSvgSceneView' "$TEMP/dex-strings" || { echo 'NPK missing native SVG scene view' >&2; exit 1; }
grep -q 'AnimatedSvgDocumentView' "$TEMP/dex-strings" || { echo 'NPK missing fixture document view' >&2; exit 1; }
for member in fixtures/documents.json \
  fixtures/stroke-n5-20260016-20260809-page-1-embed-scene.svg \
  fixtures/blank-a6x-3.15.27-two-pages-page-2-embed-scene.svg \
  fixtures/demo-a5x-20230015-1to10-page-10-embed-scene.svg; do
  [[ -f "$TEMP/archive/$member" ]] || { echo "missing archive member: $member" >&2; exit 1; }
done
fixture_count=$(find "$TEMP/archive/fixtures" -name '*-embed-scene.svg' | wc -l)
[[ "$fixture_count" -eq 68 ]] || { echo "expected 68 fixture SVGs, found $fixture_count" >&2; exit 1; }
echo "archive check passed: $ARCHIVE"
