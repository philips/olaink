#!/usr/bin/env bash
# Tail the Supernote plugin host + plugin JS runtime from the dev machine.
#
# Usage:
#   scripts/snplg-logs.sh              # live tail (ctrl-c to stop)
#   scripts/snplg-logs.sh --capture    # dump recent buffer, then exit
#   scripts/snplg-logs.sh --quiet      # hide the SDK's verifyParams noise
#
# Env:
#   SNPLG_DEVICE  device serial (default: 100.103.149.40:5555)
#
# What you'll see:
#   ReactNativeJS        - JS console output of the plugin (and SDK param checks)
#   PluginApp            - view show/hide, closePluginView, stopPlugin
#   PluginManager        - client binder routing (note vs settings)
#   PluginContainerService - host lifecycle
#   PluginInstallManager - install/upgrade progress + "Install Success"
set -euo pipefail

DEVICE="${SNPLG_DEVICE:-100.103.149.40:5555}"
CAPTURE=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --capture) CAPTURE=1 ;;
    --quiet)   QUIET=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# NOTE: tag filters require -s (silently ignored otherwise on Android 11).
TAGS="-s ReactNativeJS:V PluginApp:V PluginManager:V PluginContainerService:V PluginInstallManager:V PluginSettings:V"

if ! adb devices | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; then
  echo "no adb device attached; trying to connect to $DEVICE" >&2
  adb connect "$DEVICE" >/dev/null
fi

if [ "$CAPTURE" = 1 ]; then
  OUT=$(adb -s "$DEVICE" logcat -v time -d $TAGS 2>/dev/null | grep -vE "PluginContainerService: \[Finger\]|PluginStateTaskQueue" | tail -300)
  if [ "$QUIET" = 1 ]; then
    echo "$OUT" | grep -v "verifyParams" || true
  else
    echo "$OUT"
  fi
else
  echo "tailing plugin logs from $DEVICE (ctrl-c to stop)" >&2
  if [ "$QUIET" = 1 ]; then
    adb -s "$DEVICE" logcat -v time -T 1 $TAGS | grep -vE "verifyParams|PluginContainerService: \[Finger\]|PluginStateTaskQueue"
  else
    adb -s "$DEVICE" logcat -v time -T 1 $TAGS | grep -vE "PluginContainerService: \[Finger\]|PluginStateTaskQueue"
  fi
fi
