#!/usr/bin/env bash
# Assert that an APK's Android routing and embedded Supernote plugin agree.
# Usage: android/scripts/verify-variant-apk.sh debug|release path/to/app.apk
set -euo pipefail

VARIANT="${1:?usage: $0 debug|release path/to/app.apk}"
APK="${2:?usage: $0 debug|release path/to/app.apk}"
case "$VARIANT" in
  debug)
    PACKAGE='com.olaink.dev'
    ACTION='com.olaink.OPEN_SHARE.dev'
    APP_LABEL='Ola Ink Dev'
    ;;
  release)
    PACKAGE='com.olaink'
    ACTION='com.olaink.OPEN_SHARE'
    APP_LABEL='Ola Ink'
    ;;
  *) echo "unknown variant: $VARIANT" >&2; exit 2 ;;
esac

AAPT="${ANDROID_HOME:-$HOME/android-sdk}/build-tools/35.0.0/aapt"
if [[ ! -x "$AAPT" ]]; then
  AAPT="$(command -v aapt)"
fi
[[ -f "$APK" ]] || { echo "APK not found: $APK" >&2; exit 1; }

BADGING="$($AAPT dump badging "$APK")"
grep -Fq "package: name='$PACKAGE'" <<<"$BADGING" || {
  echo "expected package $PACKAGE in $APK" >&2
  exit 1
}
grep -Fq "application-label:'$APP_LABEL'" <<<"$BADGING" || {
  echo "expected application label $APP_LABEL in $APK" >&2
  exit 1
}
$AAPT dump xmltree "$APK" AndroidManifest.xml | grep -Fq "$ACTION" || {
  echo "expected manifest action $ACTION in $APK" >&2
  exit 1
}

APK_VERSION_CODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
APK_VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
[[ -n "$APK_VERSION_CODE" && -n "$APK_VERSION_NAME" ]] || {
  echo "could not read APK version from $APK" >&2
  exit 1
}

PLUGIN_ARCHIVE="$(mktemp)"
PLUGIN_BUNDLE="$(mktemp)"
PLUGIN_CONFIG="$(mktemp)"
trap 'rm -f "$PLUGIN_ARCHIVE" "$PLUGIN_BUNDLE" "$PLUGIN_CONFIG"' EXIT
unzip -p "$APK" assets/olainkplugin.snplg > "$PLUGIN_ARCHIVE"
unzip -p "$PLUGIN_ARCHIVE" PluginConfig.json > "$PLUGIN_CONFIG"
PLUGIN_VERSION_CODE="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["versionCode"])' "$PLUGIN_CONFIG")"
PLUGIN_VERSION_NAME="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["versionName"])' "$PLUGIN_CONFIG")"
[[ "$PLUGIN_VERSION_CODE" = "$APK_VERSION_CODE" && "$PLUGIN_VERSION_NAME" = "$APK_VERSION_NAME" ]] || {
  echo "embedded plugin version $PLUGIN_VERSION_NAME ($PLUGIN_VERSION_CODE) does not match APK version $APK_VERSION_NAME ($APK_VERSION_CODE)" >&2
  exit 1
}
unzip -p "$PLUGIN_ARCHIVE" olainkplugin.bundle > "$PLUGIN_BUNDLE"
[[ "$(grep -aoF "$ACTION" "$PLUGIN_BUNDLE" | wc -l)" -eq 1 ]] || {
  echo "expected exactly one $ACTION in the embedded plugin bundle" >&2
  exit 1
}

echo "OK: $VARIANT APK has $PACKAGE ($APP_LABEL), $ACTION, and plugin version $APK_VERSION_NAME ($APK_VERSION_CODE)"
