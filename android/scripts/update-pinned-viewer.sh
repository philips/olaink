#!/usr/bin/env bash
# Rebuild the checked-in WebView assets from the deliberately pinned upstream
# source. Updating either commit/checksum is an intentional reviewable change.
set -euo pipefail

readonly UPSTREAM_COMMIT='f2f604445b8c3e4086ad1ebae11eeb1e5a4b553d'
readonly VIEWER_SHA256='68ed212eab0e0252db9f7f4cc2e51bb06156708adae20d20c1299afd5efa6450'

source_dir=${1:?usage: $0 /path/to/supernote-obsidian-plugin-at-pinned-commit}
root_dir=$(cd "$(dirname "$0")/.." && pwd)

[[ $(git -C "$source_dir" rev-parse HEAD) == "$UPSTREAM_COMMIT" ]] || {
  echo "Expected upstream checkout at $UPSTREAM_COMMIT" >&2
  exit 1
}

# The upstream source deliberately keeps supernote-typescript as a submodule.
# Its compiled lib/ output is needed by the standalone element build.
(
  cd "$source_dir/supernote-typescript"
  npm ci
  npm run build
)
(
  cd "$source_dir"
  npm ci
  npm run build:webcomponent
  # The upstream animation is deliberately paint-capped at 30 FPS. The
  # Nomad fixture uses 10 FPS to avoid queuing E-Ink updates faster than the
  # panel can show them. Fail rather than silently patching a changed bundle.
  fps_constant_matches=$(grep -o 'q5=30,W5=3' dist/supernote-viewer.js | wc -l || true)
  [[ $fps_constant_matches -eq 1 ]] || {
    echo 'Could not find the pinned viewer animation-FPS constant' >&2
    exit 1
  }
  sed -i 's/q5=30,W5=3/q5=10,W5=3/' dist/supernote-viewer.js
)

cp "$source_dir/dist/supernote-viewer.js" "$root_dir/app/src/main/assets/supernote-viewer.js"
(
  cd "$root_dir/app/src/main/assets"
  printf '%s  %s\n' "$VIEWER_SHA256" supernote-viewer.js | sha256sum -c -
)
