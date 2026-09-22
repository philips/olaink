#!/usr/bin/env bash
# Assert that a stable olainkplugin.snplg is exactly what Plugin Manager
# should install: fixed production relay, stable plugin ID, no native
# shared libraries, and the sidebar icon asset packaged for the bundle.
set -euo pipefail

EXPECT_VERSION_NAME=""
EXPECT_VERSION_CODE=""
ARCHIVE=""

usage() {
  echo "usage: $0 [--expect-version-name NAME] [--expect-version-code CODE] path/to/olainkplugin.snplg" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-version-name) EXPECT_VERSION_NAME="${2:?}"; shift 2 ;;
    --expect-version-code) EXPECT_VERSION_CODE="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) if [[ -n "$ARCHIVE" ]]; then usage; fi; ARCHIVE="$1"; shift ;;
  esac
done
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "archive not found: ${ARCHIVE:-<missing>}" >&2; usage; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$ARCHIVE" -d "$TMP"

ENTRIES="$(cd "$TMP" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
EXPECTED="$(printf '%s\n' \
  PluginConfig.json \
  app.npk \
  drawable-mdpi/assets_icon.png \
  icon.png \
  olainkplugin.bundle \
  relay.json \
  vectors/note-v1-vectors.json | LC_ALL=C sort)"
[[ "$ENTRIES" = "$EXPECTED" ]] || {
  echo 'archive entry set mismatch:' >&2
  diff <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$ENTRIES") >&2 || true
  exit 1
}

RELAY="$(cat "$TMP/relay.json")"
[[ "$RELAY" = '{"base":"https://app.olaink.com"}' ]] || {
  echo "relay.json must be the fixed production origin, got: $RELAY" >&2
  exit 1
}

PLUGIN_CONFIG="$TMP/PluginConfig.json" EXPECT_VERSION_NAME="$EXPECT_VERSION_NAME" \
EXPECT_VERSION_CODE="$EXPECT_VERSION_CODE" python3 - <<'PY'
import json, os, sys

config = json.load(open(os.environ['PLUGIN_CONFIG']))
errors = []

if config.get('pluginID') != 'olainksync00000001':
    errors.append(f"pluginID must stay stable (olainksync00000001), got {config.get('pluginID')!r}")
if config.get('pluginKey') != 'olaink':
    errors.append(f"pluginKey must be 'olaink', got {config.get('pluginKey')!r}")

permissions = sorted(config.get('uses-permissions', []))
if permissions != sorted(['plugin.permission.FILE:READ', 'plugin.permission.FILE:WRITE', 'plugin.permission.INTERNET']):
    errors.append(f"unexpected permissions: {permissions}")

expected_name = os.environ['EXPECT_VERSION_NAME']
expected_code = os.environ['EXPECT_VERSION_CODE']
if expected_name and config.get('versionName') != expected_name:
    errors.append(f"versionName {config.get('versionName')!r} != expected {expected_name!r}")
if expected_code:
    if str(config.get('versionCode')) != str(expected_code):
        errors.append(f"versionCode {config.get('versionCode')!r} != expected {expected_code!r}")
    else:
        try:
            if int(config['versionCode']) < 13:
                errors.append("release versionCode must exceed the first stable install (12)")
        except (KeyError, TypeError, ValueError):
            errors.append(f"versionCode must be numeric, got {config.get('versionCode')!r}")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    sys.exit(1)
PY

NPK_ENTRIES="$(unzip -Z1 "$TMP/app.npk")"
grep -q 'classes.dex' <<<"$NPK_ENTRIES" || {
  echo 'app.npk is missing classes.dex' >&2
  exit 1
}
if grep -qE '\.so$' <<<"$NPK_ENTRIES"; then
  echo 'app.npk must not contain native shared libraries' >&2
  exit 1
fi

if unzip -Z1 "$ARCHIVE" | grep -qE '\.(so|apk)$'; then
  echo 'archive must not contain shared libraries or APKs' >&2
  exit 1
fi

grep -qF 'registerAsset' "$TMP/olainkplugin.bundle" && \
  grep -qF 'httpServerLocation:"/assets' "$TMP/olainkplugin.bundle" || {
  echo 'bundle does not register the sidebar icon asset' >&2
  exit 1
}

echo "OK: $(basename "$ARCHIVE") is a stable olainkplugin.snplg (pluginID=olainksync00000001, relay=app.olaink.com, version ${EXPECT_VERSION_NAME:-<unspecified>}/${EXPECT_VERSION_CODE:-<unspecified>})"
