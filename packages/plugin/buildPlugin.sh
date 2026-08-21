#!/usr/bin/env bash
# Build wrtnplugin.snplg: RN bundle + committed PluginConfig.json + icon,
# zipped. Output: build/outputs/wrtnplugin.snplg
#
# Unlike the upstream template script, this one never rewrites the committed
# PluginConfig.json — the pluginID stays stable (reinstall = upgrade).
# Consumed by scripts/snplg-deploy.sh packages/plugin
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$*"; }

NAME="$(python3 -c "import json;print(json.load(open('package.json'))['name'])")"
ROOT_DIR="$(pwd)"
GEN="$ROOT_DIR/build/generated"
OUT="$ROOT_DIR/build/outputs"
rm -rf "$GEN" "$OUT"
mkdir -p "$GEN" "$OUT"

step "bundling (metro, release)"
npx react-native bundle \
  --entry-file index.js \
  --bundle-output "$GEN/$NAME.bundle" \
  --platform android \
  --assets-dest "$GEN" \
  --dev false \
  --reset-cache

step "staging config"
cp PluginConfig.json "$GEN/PluginConfig.json"
cp assets/icon.png "$GEN/icon.png"

step "packaging $NAME.snplg"
if command -v zip >/dev/null 2>&1; then
  (cd "$GEN" && zip -qr "$OUT/$NAME.zip" .)
else
  python3 - "$GEN" "$OUT/$NAME.zip" <<'EOF'
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src))
EOF
fi
mv "$OUT/$NAME.zip" "$OUT/$NAME.snplg"
echo "OK: $OUT/$NAME.snplg"
