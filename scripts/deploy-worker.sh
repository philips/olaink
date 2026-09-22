#!/usr/bin/env bash
# Deploys the Ola Ink service Worker: remote D1 migrations, then the Worker
# with the source commit baked in for GET /commit, then an optional smoke
# check. Used by .github/workflows/deploy.yml and for manual deploys.
#
#   scripts/deploy-worker.sh staging|production
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or `wrangler login`).
# SMOKE_URL (e.g. https://olaink-staging.<sub>.workers.dev) enables the smoke
# check: /healthz must answer and /commit must report the deployed commit.
set -euo pipefail

target="${1:-}"
case "$target" in
  staging) env_flag='--env=staging' ;;
  production) env_flag='--env=' ;;  # top-level wrangler.jsonc environment
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

commit="${GITHUB_SHA:-$(git rev-parse HEAD)}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "not a full commit SHA: $commit" >&2
  exit 1
fi
# A manual deploy must be reproducible from the commit it reports.
if [[ -z "${GITHUB_ACTIONS:-}" && -n "$(git status --porcelain)" && -z "${ALLOW_DIRTY:-}" ]]; then
  echo 'working tree is dirty; commit first (or set ALLOW_DIRTY=1 for a throwaway deploy)' >&2
  exit 1
fi

# The generated modules (onboard page, viewer, migrations) must match their
# sources, exactly as CI's check:generated enforces.
node scripts/embed-onboard-page.mjs --check

cd packages/server
echo "==> applying D1 migrations ($target)"
npx wrangler d1 migrations apply db --remote "$env_flag"
echo "==> deploying Worker ($target) at $commit"
npx wrangler deploy "$env_flag" --define "process.env.OLAINK_BUILD_COMMIT:\"$commit\""

if [[ -z "${SMOKE_URL:-}" ]]; then
  echo '==> SMOKE_URL not set; skipping smoke check'
  exit 0
fi
echo "==> smoke check $SMOKE_URL"
for attempt in $(seq 1 10); do
  deployed="$(curl -fsS "$SMOKE_URL/commit" 2>/dev/null || true)"
  if [[ "$deployed" == "$commit" ]] && [[ "$(curl -fsS "$SMOKE_URL/healthz")" == 'ok' ]]; then
    echo "==> $SMOKE_URL serves $commit"
    exit 0
  fi
  echo "    attempt $attempt: /commit=${deployed:-<no answer>}; retrying"
  sleep 6
done
echo "smoke check failed: $SMOKE_URL does not serve $commit" >&2
exit 1
