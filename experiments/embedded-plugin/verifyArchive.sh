#!/usr/bin/env bash
# Static guard for the Phase 0.1 archive. It does not prove device loading.
set -euo pipefail

ARCHIVE="${1:?usage: verifyArchive.sh path/to/olainkprobe.snplg}"
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
    'pluginID': 'olainknativeprobe1',
    'pluginKey': 'olainkprobe',
    'jsMainPath': 'index',
    'nativeCodePackage': '/app.npk',
    'reactPackages': ['com.olaink.probe.OlaInkProbePackage'],
    'uses-permissions': [
        'plugin.permission.FILE:READ',
        'plugin.permission.FILE:WRITE',
        'plugin.permission.INTERNET',
    ],
}
for key, value in expected.items():
    if config.get(key) != value:
        raise SystemExit(f'PluginConfig {key!r}: expected {value!r}, got {config.get(key)!r}')
PY

for member in olainkprobe.bundle icon.png PluginConfig.json app.npk; do
  [[ -f "$TEMP/archive/$member" ]] || { echo "missing archive member: $member" >&2; exit 1; }
done

# A native package must have code, and its configured ReactPackage must have
# made it into dex. `strings` is sufficient as a cheap CI guard; device launch
# remains the source of truth.
unzip -qq "$TEMP/archive/app.npk" -d "$TEMP/npk"
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -print -quit | grep -q . || {
  echo 'app.npk has no classes*.dex' >&2
  exit 1
}
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -exec strings {} + > "$TEMP/dex-strings"
grep -q 'OlaInkProbePackage' "$TEMP/dex-strings" || {
  echo 'app.npk is missing OlaInkProbePackage' >&2
  exit 1
}

# The experimental NPK must never be accidentally distributed as another
# top-level APK; app.npk is the only native archive member.
if find "$TEMP/archive" -maxdepth 1 -type f -name '*.apk' -print -quit | grep -q .; then
  echo 'unexpected top-level APK in plugin archive' >&2
  exit 1
fi

echo "archive check passed: $ARCHIVE"
