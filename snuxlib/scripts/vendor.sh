#!/usr/bin/env bash
# Copy snuxlib into another plugin's source tree.
#
#   snuxlib/scripts/vendor.sh <dest-dir>      e.g. ../readwise-supernote-digest/plugin/src/snuxlib
#
# The copy is flat and self-contained (import it as './snuxlib'), has no
# dependencies beyond the plugin's own react / react-native, and carries a
# SNUXLIB_VERSION stamp. Never edit the copy: change snuxlib in olaink, then
# run this again. Re-running replaces the destination completely.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: vendor.sh <dest-dir>}"
case "$DEST" in
  */snuxlib|*/snuxlib/) ;;
  *) echo "refusing: destination must end in /snuxlib (it is deleted and recreated): $DEST" >&2; exit 2 ;;
esac

rm -rf "$DEST"
mkdir -p "$DEST/assets" "$DEST/demo" "$DEST/docs"
# Library sources, minus tests; icons moved next to the sources, so the
# `../assets/icons` require in icons.ts becomes `./assets/icons`.
for file in "$SRC"/src/*.ts "$SRC"/src/*.tsx; do
  case "$file" in *.test.ts|*.test.tsx) continue ;; esac
  cp "$file" "$DEST/"
done
cp -r "$SRC/assets/icons" "$DEST/assets/"
sed -i "s#'\.\./assets/icons/#'./assets/icons/#" "$DEST/icons.ts"
# Demo: it imports the library as '../src'; in the flat layout that is '..'.
cp "$SRC"/demo/*.tsx "$DEST/demo/"
sed -i "s#from '\.\./src'#from '..'#" "$DEST"/demo/*.tsx
cp "$SRC/README.md" "$DEST/README.md"
cp "$SRC"/docs/*.md "$DEST/docs/"
cp -r "$SRC/docs/screenshots" "$DEST/docs/"

COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
git -C "$SRC" diff --quiet -- . 2>/dev/null || DIRTY="+local-changes"
printf 'snuxlib %s from philips/olaink@%s%s on %s\nDo not edit this copy: change snuxlib/ in olaink and re-run snuxlib/scripts/vendor.sh.\n' \
  "$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$SRC/package.json")" "$COMMIT" "$DIRTY" "$(date -u +%Y-%m-%d)" > "$DEST/SNUXLIB_VERSION"
echo "vendored snuxlib into $DEST ($(cat "$DEST/SNUXLIB_VERSION" | head -1))"
