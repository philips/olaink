#!/usr/bin/env bash
# Build olainkplugin.snplg: RN bundle + committed PluginConfig.json + icon,
# zipped. Output: build/outputs/olainkplugin.snplg
#
# Unlike the upstream template script, this one never rewrites the committed
# PluginConfig.json — the pluginID stays stable (reinstall = upgrade).
# Consumed by scripts/snplg-deploy.sh packages/plugin
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$*"; }

NAME="$(python3 -c "import json;print(json.load(open('package.json'))['name'])")"
ROOT_DIR="$(pwd)"
# Android variants supply isolated paths so assembleDebug and assembleRelease
# can stage matching plugin bundles in the same Gradle invocation.
GEN="${OLAINK_PLUGIN_GENERATED_DIR:-$ROOT_DIR/build/generated}"
OUT="${OLAINK_PLUGIN_OUTPUT_DIR:-$ROOT_DIR/build/outputs}"
COMPANION_SHARE_ACTION="${OLAINK_COMPANION_SHARE_ACTION:-com.olaink.OPEN_SHARE}"
readonly DEFAULT_COMPANION_SHARE_ACTION='com.olaink.OPEN_SHARE'
case "$COMPANION_SHARE_ACTION" in
  com.olaink.OPEN_SHARE|com.olaink.OPEN_SHARE.dev) ;;
  *) echo "invalid OLAINK_COMPANION_SHARE_ACTION: $COMPANION_SHARE_ACTION" >&2; exit 2 ;;
esac
rm -rf "$GEN" "$OUT"
mkdir -p "$GEN" "$OUT"

# Android supplies these for an embedded archive. A standalone build retains
# the committed development values from PluginConfig.json.
PLUGIN_VERSION_NAME="${OLAINK_PLUGIN_VERSION_NAME:-$(python3 -c "import json; print(json.load(open('PluginConfig.json'))['versionName'])")}"
PLUGIN_VERSION_CODE="${OLAINK_PLUGIN_VERSION_CODE:-$(python3 -c "import json; print(json.load(open('PluginConfig.json'))['versionCode'])")}"

GIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
if git -C "$ROOT_DIR" status --porcelain 2>/dev/null | grep -q .; then GIT="${GIT}-dirty"; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
step "bundling (metro, release)"
npx react-native bundle \
  --entry-file index.js \
  --bundle-output "$GEN/$NAME.bundle" \
  --platform android \
  --assets-dest "$GEN" \
  --dev false \
  --reset-cache

# Stamp the release artifact, not tracked source. The static TypeScript module
# remains valid for tests and development builds, while the packaged bundle
# records its exact Git revision and build time for device log diagnostics.
step "stamping bundle"
BUILD_GIT="$GIT" BUILD_TIME="$BUILT_AT" BUNDLE="$GEN/$NAME.bundle" \
PLUGIN_VERSION_NAME="$PLUGIN_VERSION_NAME" PLUGIN_VERSION_CODE="$PLUGIN_VERSION_CODE" \
COMPANION_SHARE_ACTION="$COMPANION_SHARE_ACTION" STAMP_DEFAULT_COMPANION_SHARE_ACTION="$DEFAULT_COMPANION_SHARE_ACTION" python3 - <<'PY'
import os
from pathlib import Path

bundle = Path(os.environ["BUNDLE"])
values = {
    "__OLAINK_BUILD_GIT__": os.environ["BUILD_GIT"],
    "__OLAINK_BUILD_TIME__": os.environ["BUILD_TIME"],
    "__OLAINK_PLUGIN_VERSION_NAME__": os.environ["PLUGIN_VERSION_NAME"],
    "__OLAINK_PLUGIN_VERSION_CODE__": os.environ["PLUGIN_VERSION_CODE"],
    os.environ["STAMP_DEFAULT_COMPANION_SHARE_ACTION"]: os.environ["COMPANION_SHARE_ACTION"],
}
source = bundle.read_text(encoding="utf-8")
for token, value in values.items():
    occurrences = source.count(token)
    if occurrences != 1:
        raise SystemExit(f"expected one {token} token in {bundle}, found {occurrences}")
    source = source.replace(token, value)
bundle.write_text(source, encoding="utf-8")
PY

step "staging config"
cp PluginConfig.json "$GEN/PluginConfig.json"
# Android supplies its variant's version when embedding this archive. Standalone
# plugin builds retain PluginConfig.json's development version.
PLUGIN_CONFIG="$GEN/PluginConfig.json" \
OLAINK_PLUGIN_VERSION_NAME="$PLUGIN_VERSION_NAME" \
OLAINK_PLUGIN_VERSION_CODE="$PLUGIN_VERSION_CODE" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["PLUGIN_CONFIG"])
config = json.loads(path.read_text(encoding="utf-8"))
version_name = os.environ["OLAINK_PLUGIN_VERSION_NAME"] or config["versionName"]
version_code = os.environ["OLAINK_PLUGIN_VERSION_CODE"] or config["versionCode"]
if not isinstance(version_name, str) or not version_name.strip():
    raise SystemExit("OLAINK_PLUGIN_VERSION_NAME must be a non-empty string")
if not isinstance(version_code, str) or not version_code.isdecimal() or int(version_code) < 1:
    raise SystemExit("OLAINK_PLUGIN_VERSION_CODE must be a positive integer")
config["versionName"] = version_name
config["versionCode"] = version_code
path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY
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
