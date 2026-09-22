#!/usr/bin/env bash
# Static E0 archive guard. Device loading remains the source of truth.
set -euo pipefail

ARCHIVE="${1:?usage: verifyArchive.sh path/to/olainknativeexp.snplg}"
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
expected_members = {
    'PluginConfig.json',
    'app.npk',
    'icon.png',
    'olainknativeexp.bundle',
    'relay.json',
    'vectors/note-v1-vectors.json',
}
actual_members = {
    path.relative_to(root).as_posix()
    for path in root.rglob('*')
    if path.is_file()
}
if actual_members != expected_members:
    raise SystemExit(
        f'archive members differ: missing={sorted(expected_members - actual_members)}, '
        f'unexpected={sorted(actual_members - expected_members)}'
    )

config = json.loads((root / 'PluginConfig.json').read_text(encoding='utf-8'))
expected_config = {
    'name': 'olainknativeexp',
    'desc': 'Disposable Ola Ink single-snplg native client experiment — no production keys',
    'iconPath': '/icon.png',
    'versionName': '0.0.11-file-exchange',
    'versionCode': '11',
    'pluginID': 'olainknativeexp1',
    'pluginKey': 'olainknativeexp',
    'jsMainPath': 'index',
    'uses-permissions': [
        'plugin.permission.FILE:READ',
        'plugin.permission.FILE:WRITE',
        'plugin.permission.INTERNET',
    ],
    'reactPackages': ['com.olaink.nativeexp.OlaInkPackage'],
    'nativeCodePackage': '/app.npk',
}
if config != expected_config:
    raise SystemExit(f'unexpected PluginConfig.json: {config!r}')
if len(config['pluginID']) != 16 or not config['pluginID'].isalnum():
    raise SystemExit('experimental pluginID must be 16 alphanumeric characters')

import pathlib
vectors_path = root / 'vectors' / 'note-v1-vectors.json'
vectors = json.loads(vectors_path.read_text(encoding='utf-8'))
if vectors.get('schema') != 1 or 'throwaway keys' not in vectors.get('description', ''):
    raise SystemExit('unexpected interop vectors file')
for section in ('deterministic', 'randomWebCrypto'):
    if section not in vectors:
        raise SystemExit(f'vectors missing {section} case')
record = json.loads(vectors['deterministic']['expectedRecordJson'])
if record.get('version') != 1 or not record.get('keySlots'):
    raise SystemExit('deterministic vector record is malformed')

import re
relay = json.loads((root / 'relay.json').read_text(encoding='utf-8'))
base = relay.get('base', '')
pin = relay.get('certSha256')
if not re.match(r'^https://[0-9A-Za-z.:-]+$', base):
    raise SystemExit(f'relay.json base must be a fixed HTTPS scheme+host: {relay!r}')
if not re.match(r'^[0-9a-f]{64}$', pin or ''):
    raise SystemExit('relay requires a pinned leaf sha-256 certificate')
if 'app.olaink.com' in base:
    raise SystemExit('the experiment must not point at the production relay')
PY

BUNDLE="$TEMP/archive/olainknativeexp.bundle"
grep -a -q 'file-exchange-native-v11' "$BUNDLE" || {
  echo 'bundle missing file-exchange revision marker' >&2
  exit 1
}
if grep -a -E -q 'supernote-viewer|android\.webkit\.WebView|react-native-webview' "$BUNDLE"; then
  echo 'bundle contains a forbidden browser/viewer dependency' >&2
  exit 1
fi

unzip -qq "$TEMP/archive/app.npk" -d "$TEMP/npk"
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -print -quit | grep -q . || {
  echo 'app.npk has no classes*.dex' >&2
  exit 1
}
find "$TEMP/npk" -maxdepth 1 -name 'classes*.dex' -type f -exec strings {} + > "$TEMP/dex-strings"
for class_name in OlaInkPackage OlaInkNativeClientModule NoteV1 E2Profile E2Controller; do
  grep -q "$class_name" "$TEMP/dex-strings" || {
    echo "app.npk missing $class_name" >&2
    exit 1
  }
done
# React Android's transitive AndroidX LinkifyCompat references the static
# WebView.findAddress helper, so the generic platform class string is expected
# in dependency dex. Reject an Ola Ink WebView class or an actual browser/viewer
# package instead; E0's own registered classes are enumerated above.
if grep -E -q 'Lcom/olaink/[^;]*WebView|supernote-viewer|react-native-webview' "$TEMP/dex-strings"; then
  echo 'app.npk contains a forbidden Ola Ink browser/viewer dependency' >&2
  exit 1
fi
if find "$TEMP/npk" -type f -name '*.so' -print -quit | grep -q .; then
  echo 'app.npk contains duplicate native shared libraries' >&2
  exit 1
fi
if find "$TEMP/archive" -type f \( -name '*.apk' -o -name '*.jks' -o -name '*.keystore' \
    -o -name '*.pem' -o -name '*.pk8' -o -name '*.sqlite' \) -print -quit | grep -q .; then
  echo 'archive contains forbidden APK, key, or state output' >&2
  exit 1
fi

echo "archive check passed: $ARCHIVE"
