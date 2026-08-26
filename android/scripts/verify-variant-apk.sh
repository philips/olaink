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
    ;;
  release)
    PACKAGE='com.olaink'
    ACTION='com.olaink.OPEN_SHARE'
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
$AAPT dump xmltree "$APK" AndroidManifest.xml | grep -Fq "$ACTION" || {
  echo "expected manifest action $ACTION in $APK" >&2
  exit 1
}

PLUGIN_ARCHIVE="$(mktemp)"
PLUGIN_BUNDLE="$(mktemp)"
trap 'rm -f "$PLUGIN_ARCHIVE" "$PLUGIN_BUNDLE"' EXIT
unzip -p "$APK" assets/olainkplugin.snplg > "$PLUGIN_ARCHIVE"
unzip -p "$PLUGIN_ARCHIVE" olainkplugin.bundle > "$PLUGIN_BUNDLE"
[[ "$(grep -aoF "$ACTION" "$PLUGIN_BUNDLE" | wc -l)" -eq 1 ]] || {
  echo "expected exactly one $ACTION in the embedded plugin bundle" >&2
  exit 1
}

echo "OK: $VARIANT APK has $PACKAGE and $ACTION"
