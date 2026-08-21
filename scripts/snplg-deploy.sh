#!/usr/bin/env bash
# Build + install a .snplg onto the Supernote over adb (Wi-Fi), fully automated.
#
# Usage:
#   scripts/snplg-deploy.sh [experiment-dir] [--no-build]
#
# Defaults to experiments/stroke-live.
#
# Env:
#   SNPLG_DEVICE  device serial (default: 100.103.149.40:5555)
#
# How install works (no root needed):
#   1. adb push the .snplg to /storage/emulated/0/MyStyle/ (world-writable)
#   2. deep-link the Settings plugin page:
#        am start -n com.ratta.settings/.SettingsActivity \
#                 -a com.ratta.settings.application.PluginManagerFragment
#   3. tap: "Add Plugin" -> the .snplg file -> "Install"
#      (uiautomator dump + XML parsing finds coordinates each time)
#   4. wait for "PluginInstallManager: Install Success" in logcat
#
# Re-installing over an existing plugin with the same pluginID is an
# in-place upgrade (moveDirectory + DB insert) — no uninstall needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE="${SNPLG_DEVICE:-100.103.149.40:5555}"
MYSTYLE="/storage/emulated/0/MyStyle"

EXPERIMENT="experiments/stroke-live"
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) EXPERIMENT="$arg" ;;
  esac
done

[ -d "$REPO_ROOT/$EXPERIMENT" ] || { echo "no such experiment: $EXPERIMENT" >&2; exit 1; }
cd "$REPO_ROOT/$EXPERIMENT"

step() { printf '\n==> %s\n' "$*"; }
adb() { command adb -s "$DEVICE" "$@"; }

# --- preflight ---------------------------------------------------------
adb devices | awk -v d="$DEVICE" '$1==d && $2=="device"' || adb connect "$DEVICE" >/dev/null
adb get-state >/dev/null

# --- build -------------------------------------------------------------
if [ "$NO_BUILD" = 0 ]; then
  step "building $EXPERIMENT"
  npm run build:snplg >/dev/null
fi
SNPLG="$(ls -1 build/outputs/*.snplg 2>/dev/null | head -1)"
[ -n "$SNPLG" ] || { echo "no .snplg in build/outputs/ (run without --no-build?)" >&2; exit 1; }
NAME="$(basename "$SNPLG")"
step "installing $NAME (device $DEVICE)"

# --- UI helpers ----------------------------------------------------------
UIXML="/tmp/snplg-ui-$$.xml"
trap 'adb shell rm -f /sdcard/_ui.xml >/dev/null 2>&1 || true' EXIT

ui_dump() {
  local i
  for i in 1 2 3 4; do
    adb shell input keyevent 224 >/dev/null   # wake / keep awake
    sleep 0.7
    if adb shell uiautomator dump /sdcard/_ui.xml >/dev/null 2>&1 \
       && adb pull /sdcard/_ui.xml "$UIXML" >/dev/null 2>&1 \
       && [ -s "$UIXML" ]; then
      return 0
    fi
    sleep 1
  done
  echo "uiautomator dump failed (screen asleep or mid-transition?)" >&2
  return 1
}

# Tap the first node whose text equals $1; echo the tapped point.
ui_tap_text() {
  local text="$1" pt
  pt=$(python3 - "$UIXML" "$text" <<'EOF'
import re, sys
xml, target = open(sys.argv[1]).read(), sys.argv[2]
for node in re.findall(r'<node [^>]*?/?>', xml):
    m = re.search(r'text="([^"]*)"', node)
    if not m or m.group(1) != target:
        continue
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if b:
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        sys.exit(0)
sys.exit(1)
EOF
  ) || { echo "UI node not found: $text" >&2; return 1; }
  set -- $pt
  adb shell input tap "$1" "$2"
  sleep 2.5
}

# --- 1. push -------------------------------------------------------------
step "pushing to $MYSTYLE"
adb push "$SNPLG" "$MYSTYLE/$NAME" >/dev/null

# --- 2. open plugin manager ----------------------------------------------
step "opening Settings → Plugins"
adb logcat -c 2>/dev/null || true
adb shell am start -n com.ratta.settings/.SettingsActivity \
  -a com.ratta.settings.application.PluginManagerFragment >/dev/null
sleep 3

# --- 3. tap: Add Plugin -> file -> Install --------------------------------
step "tap: Add Plugin"
ui_dump
ui_tap_text "Add Plugin"

step "tap: $NAME"
ui_dump
ui_tap_text "$NAME"

step "tap: Install"
ui_dump
ui_tap_text "Install"

# --- 4. wait for result ----------------------------------------------------
step "waiting for install result"
for i in $(seq 1 30); do
  LOG="$(adb logcat -d 2>/dev/null | grep -E 'PluginInstallManager|startInstallTask' | tail -20)"
  if echo "$LOG" | grep -q "Install Success"; then
    adb shell input keyevent 3 >/dev/null   # HOME — leave settings
    step "INSTALL OK"
    echo "$LOG" | tail -5
    exit 0
  fi
  if echo "$LOG" | grep -qiE "fail|exception|error"; then
    echo "install FAILED:" >&2
    echo "$LOG" >&2
    exit 1
  fi
  sleep 1
done
echo "timed out waiting for install result; check: scripts/snplg-logs.sh --capture" >&2
exit 1
