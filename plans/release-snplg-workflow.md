# Release pipeline: ship the `.snplg`, retire the APK

## Goal

Rework `.github/workflows/build-android-apk.yml` so the release pipeline
builds and publishes the single stable `olainkplugin.snplg` (plus the relay
server binaries), and stops building, signing, or verifying the retired
companion APK.

## Context

- PR #29 replaced the companion flow: the plugin is now a self-contained
  `.snplg` (React bundle + `app.npk` + fixed `relay.json`).
- The install flow documented on olaink.com/install is: GitHub release →
  `olainkplugin.snplg` → `MyStyle` → Plugin Manager.
- The current workflow still publishes a signed `app-release.apk` and gates
  on `ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_*` secrets, and the
  `ANDROID_RELEASE_CERT_SHA256` variable. The last tag run failed on the
  retired APK verification (`caution: filename not matched: assets/olainkplugin.snplg`
  because the archive was staged differently).
- PR #31 (merged) already gave `packages/plugin/buildPlugin.sh` what the new
  pipeline needs:
  - `OLAINK_PLUGIN_VERSION_NAME` / `OLAINK_PLUGIN_VERSION_CODE` env overrides
    stamped into the archive's `PluginConfig.json`;
  - `OLAINK_PLUGIN_OUTPUT_DIR` / `OLAINK_PLUGIN_GENERATED_DIR` env overrides;
  - React Native image assets packaged (NOTE sidebar icon).

## Prerequisites

- PR #31 merged (done, 2026-09-22).
- A first tag published under the new pipeline must upgrade the currently
  deployed plugin (device versionCode 12), so release versionCode must stay
  monotonically increasing: use `git rev-list --count HEAD` (currently 100+).

## Design

Replace `build-android-apk.yml` with `.github/workflows/release.yml`.

### Job 1: `build` — runs on push to `main` and on tags

- `actions/checkout@v5`, `actions/setup-node@v5` (node 24, npm cache),
  `actions/setup-java@v5` (temurin 17, gradle cache).
- Repo gates: `npm ci`, `npm run check:generated`, `npm run typecheck`,
  `npm test`.
- Native gate:
  `cd packages/plugin/android && ./gradlew :app:testDebugUnitTest`
  (pure-JVM NoteV1 interop vectors; uses the runner's preinstalled
  `ANDROID_HOME` platform 35, same as the old APK build).
- Build the stable plugin: `npm run build:plugin` (default output dir;
  committed PluginConfig version, fine for QA artifacts).
- Verify with a new archive verifier (below):
  `packages/plugin/verifySnplg.sh packages/plugin/build/outputs/olainkplugin.snplg`.
- Server builds (unchanged): `oven-sh/setup-bun@v2`, `npm run build:server`,
  `npm run build:server:arm64`, name as `ola-ink-server-linux-x64` /
  `ola-ink-server-linux-arm64`.
- Non-tag pushes only: `actions/upload-artifact@v4` for
  `ola-ink-plugin-dev.snplg` + both server binaries (retention 14 days).

### Job 2: `release` — tags only, `environment: release`, `needs: build`

No keystore, no signing secrets, no certificate check.

1. Set version:
   - `VERSION_NAME="$GITHUB_REF_NAME"` (tag, e.g. `v0.3.0`)
   - `VERSION_CODE="$(git rev-list --count HEAD)"` — monotonic, exceeds 109.
2. Build the release plugin:
   ```
   OLAINK_PLUGIN_VERSION_NAME="$VERSION_NAME" \
   OLAINK_PLUGIN_VERSION_CODE="$VERSION_CODE" \
   npm run build:plugin
   ```
3. Verify: `packages/plugin/verifySnplg.sh --expect-version-name "$VERSION_NAME" --expect-version-code "$VERSION_CODE" ...`
4. Build + name server binaries (same as job 1).
5. Collect assets:
   - `olainkplugin-<tag>.snplg`
   - `ola-ink-server-linux-x64`, `ola-ink-server-linux-arm64`
6. `gh release create "$GITHUB_REF_NAME" release-assets/*` with notes listing
   the plugin versionCode/Name. (`permissions: contents: write` stays.)

### New verifier: `packages/plugin/verifySnplg.sh`

Bash + python3, mirrors the existing `verifyArchive.sh` experiment style:

- Archive entry set matches exactly:
  `olainkplugin.bundle`, `PluginConfig.json`, `icon.png`, `app.npk`,
  `relay.json`, `vectors/note-v1-vectors.json`, `drawable-mdpi/assets_icon.png`.
- `PluginConfig.json`:
  - `pluginID == "olainksync00000001"` (stable ID),
  - `pluginKey == "olaink"`,
  - required permissions = `FILE:READ`, `FILE:WRITE`, `INTERNET`,
  - `versionCode` (optional `--expect-version-code` / `--expect-version-name`).
- `relay.json` is exactly `{"base":"https://app.olaink.com"}`.
- `app.npk` contains `classes.dex` and no `*.so` (no duplicate RN/Hermes ABI).
- Whole archive: no `*.apk`, no `*.so`, no key/state material, no `lib/` dir.
- Bundle sanity: registers at least one asset (`registerAsset` with
  `httpServerLocation` under `/assets`) so the sidebar icon survives bundling.

Add npm target: `"verify:plugin": "packages/plugin/verifySnplg.sh packages/plugin/build/outputs/olainkplugin.snplg"`.

### File-level changes

1. Delete `.github/workflows/build-android-apk.yml`.
2. Add `.github/workflows/release.yml` (trigger paths updated:
   `packages/plugin/**`, `packages/server/**`, `package.json`,
   `package-lock.json`, `packages/plugin/verifySnplg.sh`,
   `.github/workflows/release.yml`; drop dead paths
   `packages/protocol/**`, `packages/sn-stub/**`,
   `scripts/embed-onboard-page.mjs` is still run by `check:generated` but is
   not a build input — drop it from triggers too).
3. Add `packages/plugin/verifySnplg.sh`, npm `verify:plugin` target.
4. `package.json`: keep `build:android` / `deploy:android` for local
   companion use until the retirement follow-up.

## Explicitly out of scope (follow-up PR after the first tag is published)

- Delete the `android/` companion source tree, `android/scripts/verify-variant-apk.sh`,
  and the `build:android` / `deploy:android` npm targets.
- Remove Actions secrets `ANDROID_RELEASE_KEYSTORE_BASE64`,
  `ANDROID_RELEASE_STORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS`,
  `ANDROID_RELEASE_KEY_PASSWORD` and variable `ANDROID_RELEASE_CERT_SHA256`.
- Sweep remaining APK-install copy in `docs/`, `DEVELOPER.md`, `android/README.md`.

## Rollout

1. Land this workflow change on `main` (push-build smoke test; dev `.snplg`
   artifact available in Actions).
2. Cut a tag (e.g. `v0.3.0`). Confirm the release contains
   `olainkplugin-v0.3.0.snplg` + server binaries and notes show the version.
3. Install the tagged `.snplg` on the Nomad via `scripts/snplg-deploy.sh`
   (or manual Plugin Manager), confirm `PluginInstallManager: Install
   Success` with upgrade, sidebar icon, pairing, and a send/receive round
   trip to `app.olaink.com`.
4. Land the companion retirement follow-up.

## Risk notes

- Plugin upgrade requires `versionCode` strictly greater than the installed
  one; the git-count scheme guarantees this while the old device (12) and
  old APK releases (109) are still out there.
- `buildPlugin.sh` wipes its generated/output dirs; the release job must
  point them at a fresh dir (defaults are fine — they live under
  `packages/plugin/build/`).
- NPK build is an `assembleDebug` container build; debug signing is
  irrelevant to PluginHost, so no release keystore is involved.
- GitHub runner image already ships Android SDK platform 35 / build-tools
  35.0.0 (the old workflow relied on it), so no `setup-android` step needed.
