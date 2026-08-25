#!/usr/bin/env bash
# Hot-reload the Ola Ink plugin's JS bundle on a connected device without a
# full reinstall. Uses the plugin host's debug broadcast receiver, which
# swaps the bundle in place and re-runs index.js in the note-app context.
#
# Prereq: a built bundle at packages/plugin/build/generated/olainkplugin.bundle
#         (run `npm run build:plugin` first, or pass --build).
set -euo pipefail
DEVICE="${SNPLG_DEVICE:-100.103.149.40:5555}"
PLUGIN_ID="olainksync00000001"
BUNDLE="packages/plugin/build/generated/olainkplugin.bundle"
DEST="/storage/emulated/0/MyStyle/olainkplugin.bundle"

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--build" ]]; then
  npm run build:plugin
fi

[[ -f "$BUNDLE" ]] || { echo "missing $BUNDLE — run: npm run build:plugin" >&2; exit 1; }

echo "==> pushing bundle to $DEST"
adb -s "$DEVICE" push "$BUNDLE" "$DEST" >/dev/null

echo "==> hot-reloading (debug receiver) pluginID=$PLUGIN_ID"
adb -s "$DEVICE" shell am broadcast \
  -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
  -a com.ratta.supernote.plugin.action.DEBUG -f 0x01000000 \
  --es bundle_path "$DEST" --es plugin_id "$PLUGIN_ID" >/dev/null

echo "OK: hot-reloaded. Tail logs with: npm run logs"
