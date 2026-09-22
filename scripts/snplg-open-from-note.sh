#!/usr/bin/env bash
# Open a Supernote plugin's full-screen view from the NOTE app sidebar.
#
# Usage: scripts/snplg-open-from-note.sh [plugin-label]
#   plugin-label defaults to "Ola Ink native client experiment".
#
# Env: SNPLG_DEVICE (default 100.103.149.40:5555)
set -euo pipefail

DEVICE="${SNPLG_DEVICE:-100.103.149.40:5555}"
LABEL="${1:-Ola Ink native client experiment}"
adb() { command adb -s "$DEVICE" "$@"; }

UIXML="/tmp/snplg-open-$$.xml"
trap 'rm -f "$UIXML"' EXIT

dump() {
  local i
  for i in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/_open.xml >/dev/null 2>&1 || true
    adb pull /sdcard/_open.xml "$UIXML" >/dev/null 2>&1 || true
    if [ -s "$UIXML" ]; then return 0; fi
    sleep 1
  done
  echo "uiautomator dump failed" >&2
  return 1
}

center() { # attr value -> "x y" or nothing
  python3 - "$UIXML" "$1" "$2" <<'PY'
import re, sys
xml, attr, target = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3]
for node in re.findall(r'<node [^>]*?/?>', xml):
    m = re.search(attr + r'="([^"]*)"', node)
    if m and m.group(1) == target:
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if b:
            x1, y1, x2, y2 = map(int, b.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
PY
}

# Home, then the note app, then the sidebar, then its Plugins menu.
adb shell input keyevent 3; sleep 1
adb shell am start -n com.ratta.supernote.note/.view.NoteInsidePagesActivity >/dev/null 2>&1 || true
sleep 3
adb shell input swipe 1880 100 1880 1000 500; sleep 2
dump
PLUGINS=$(center content-desc plugins) || true
[ -n "${PLUGINS:-}" ] || { echo 'plugins sidebar entry not found' >&2; exit 1; }
adb shell input tap $PLUGINS; sleep 3
dump
ENTRY=$(center text "$LABEL") || true
[ -n "${ENTRY:-}" ] || { echo "plugin entry not found: $LABEL" >&2; exit 1; }
adb shell input tap $ENTRY
sleep 7
if adb shell dumpsys window | grep -q 'u0 com.ratta.supernote.pluginhost'; then
  echo "opened: $LABEL"
  exit 0
fi
echo "plugin view did not come up" >&2
exit 1
