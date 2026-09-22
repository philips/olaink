#!/usr/bin/env bash
# Static guard for the hostile probe archive. Device evidence is the point.
set -euo pipefail

ARCHIVE="${1:?usage: verifyArchive.sh path/to/olainkhostile.snplg}"
[[ -f "$ARCHIVE" ]] || { echo "missing archive: $ARCHIVE" >&2; exit 2; }
for command in python3 strings unzip; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
unzip -qq "$ARCHIVE" -d "$TEMP/archive"

python3 - "$TEMP/archive" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected_members = {'PluginConfig.json', 'app.npk', 'icon.png', 'olainkhostile.bundle'}
actual_members = {
    path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file()
}
if actual_members != expected_members:
    raise SystemExit(
        f'archive members differ: missing={sorted(expected_members - actual_members)}, '
        f'unexpected={sorted(actual_members - expected_members)}'
    )

config = json.loads((root / 'PluginConfig.json').read_text(encoding='utf-8'))
expected_config = {
    'name': 'olainkhostile',
    'desc': 'Hostile-plugin isolation probe — attacks the Ola Ink E1 experiment only',
    'iconPath': '/icon.png',
    'versionName': '0.0.1',
    'versionCode': '1',
    'pluginID': 'olainkhostile001',
    'pluginKey': 'olainkhostile',
    'jsMainPath': 'index',
    'reactPackages': ['com.olaink.hostile.OlaInkHostilePackage'],
    'nativeCodePackage': '/app.npk',
}
if config != expected_config:
    raise SystemExit(f'unexpected PluginConfig.json: {config!r}')
# The hostile probe deliberately declares NO permissions: it tests whether an
# unprivileged sibling plugin can still reach same-UID state.
if config.get('uses-permissions'):
    raise SystemExit('hostile probe must not declare permissions')
if len(config['pluginID']) != 16 or not config['pluginID'].isalnum():
    raise SystemExit('hostile pluginID must be 16 alphanumeric characters')
PY

grep -a -q 'hostile-isolation-probe-v1' "$TEMP/archive/olainkhostile.bundle" || {
  echo 'bundle missing hostile revision marker' >&2
  exit 1
}

unzip -qq "$TEMP/archive/app.npk" -d "$TEMP/npk"
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -print -quit | grep -q . || {
  echo 'app.npk has no classes*.dex' >&2
  exit 1
}
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -exec strings {} + > "$TEMP/dex-strings"
for class_name in OlaInkHostilePackage OlaInkHostileProbeModule; do
  grep -q "$class_name" "$TEMP/dex-strings" || {
    echo "app.npk missing $class_name" >&2
    exit 1
  }
done
grep -q 'olainknativeexp1' "$TEMP/dex-strings" || {
  echo 'hostile module is not targeting the E1 experiment' >&2
  exit 1
}
if find "$TEMP/npk" -type f -name '*.so' -print -quit | grep -q .; then
  echo 'app.npk contains native shared libraries' >&2
  exit 1
fi
if find "$TEMP/archive" -type f \( -name '*.apk' -o -name '*.jks' -o -name '*.keystore' \) -print -quit | grep -q .; then
  echo 'archive contains forbidden APK or key output' >&2
  exit 1
fi

echo "archive check passed: $ARCHIVE"
