# Android APK signing and side-by-side development plan

## Problem

The former GitHub workflow published `assembleDebug` output. GitHub-hosted
runners create a fresh debug keystore when none is supplied, while a developer
machine uses its own `~/.android/debug.keystore`. Those prior APKs used the
same `com.olaink` package ID, so Android correctly refuses an in-place update
when their signing certificates differ:

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE
```

This also means two APKs produced by separate GitHub runs are not a reliable
upgrade path.

## Goals

- Every published stable APK upgrades every earlier stable APK without clearing
  the companion's WebView profile, encryption key, pairing, or inbox.
- A local development APK can coexist with the stable APK on one Nomad.
- The installed Supernote plugin opens the matching companion variant without
  an Android resolver prompt.
- The release signing private key never enters the repository or a normal
  development machine.
- Keep the committed Supernote plugin ID stable.

## Non-goals

- Recovering data from an APK signed by an old ephemeral GitHub debug key.
  Android will require one final uninstall for that migration.
- Using `adb install -r` or an Android setting to bypass signature validation.
- Sharing a production signing key with developers merely to make debug APKs
  replace the release APK.

## Target build matrix

| Build | Package ID | Share action | Label | Signing | Distribution |
|---|---|---|---|---|---|
| `debug` | `com.olaink.dev` | `com.olaink.OPEN_SHARE.dev` | Ola Ink Dev | local debug keystore | developer artifact only |
| `release` | `com.olaink` | `com.olaink.OPEN_SHARE` | Ola Ink | persistent release keystore | GitHub tag release |

The development and release variants must each embed a plugin bundle that
contains the corresponding action. The plugin ID remains the same, so
installing the development bundle intentionally upgrades the installed plugin
to route launches to the development companion; installing the release bundle
routes it back to the stable companion. This is preferable to letting both
apps handle the same implicit intent and showing a resolver every time.

## Creating and uploading CI signing secrets

GitHub does not generate a safe Android release signing key. Generate it once
on a trusted local machine, retain encrypted offline recovery copies, then
upload its values as GitHub Actions secrets. Anyone with the key can publish
APK updates under this app identity.

1. Create the keystore outside this repository. Choose strong, distinct store
   and key passwords when prompted; use a long validity because losing the
   signing key permanently prevents future in-place updates.

   ```sh
   keytool -genkeypair -v -keystore "$HOME/olaink-release.jks" \
     -alias olaink-release -keyalg RSA -keysize 4096 -validity 10000
   keytool -list -v -keystore "$HOME/olaink-release.jks" -alias olaink-release
   ```

   Record the displayed `SHA256` certificate fingerprint in the private
   release runbook. Do not put the keystore, passwords, or its base64 value in
   Git, an issue, a shell script, or a workflow log.

2. Install and authenticate the GitHub CLI with repository-administrator
   access (`gh auth login`). Set the keystore secret without creating a file
   containing the encoded value; GNU/Linux uses `base64 -w 0`, while the
   portable command below works on macOS too.

   ```sh
   cd /path/to/olaink
   base64 < "$HOME/olaink-release.jks" | tr -d '\n' | \
     gh secret set ANDROID_RELEASE_KEYSTORE_BASE64 --env release --repo philips/olaink
   read -rs -p 'Keystore password: ' ANDROID_RELEASE_STORE_PASSWORD; echo
   printf %s "$ANDROID_RELEASE_STORE_PASSWORD" | \
     gh secret set ANDROID_RELEASE_STORE_PASSWORD --env release --repo philips/olaink
   unset ANDROID_RELEASE_STORE_PASSWORD
   read -rs -p 'Key password: ' ANDROID_RELEASE_KEY_PASSWORD; echo
   printf %s "$ANDROID_RELEASE_KEY_PASSWORD" | \
     gh secret set ANDROID_RELEASE_KEY_PASSWORD --env release --repo philips/olaink
   unset ANDROID_RELEASE_KEY_PASSWORD
   printf %s 'olaink-release' | \
     gh secret set ANDROID_RELEASE_KEY_ALIAS --env release --repo philips/olaink
   ```

   Alternatively, use GitHub: **repository Settings → Environments → release
   → Add secret**, and create all four names above. Encode the `.jks` with `base64 < "$HOME/olaink-release.jks" | tr -d '\n'` and
   paste that one-line result only into `ANDROID_RELEASE_KEYSTORE_BASE64`.

3. Store the non-secret certificate fingerprint as an Actions variable so CI
   can verify the published APK:

   ```sh
   gh variable set ANDROID_RELEASE_CERT_SHA256 \
     --body 'AA:BB:...:FF' --env release --repo philips/olaink
   ```

   Limit repository secret access to release maintainers. Use a protected
   GitHub Environment such as `release` for tag publication, require reviewer
   approval there, and scope the signing secrets to that environment rather
   than exposing them to every branch workflow.

## Implementation steps

1. **Create and protect the release key.**
   - Generate a dedicated upload/release keystore on an offline trusted host;
     do not use the Android debug keystore.
   - Record its SHA-256 signing-certificate fingerprint in the private release
     runbook and keep encrypted offline recovery copies of the keystore and
     passwords.
   - Add protected `release`-environment secrets:
     `ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_STORE_PASSWORD`,
     `ANDROID_RELEASE_KEY_ALIAS`, and `ANDROID_RELEASE_KEY_PASSWORD`.
   - Add `*.jks`, `*.keystore`, `android/release.properties`, and any decoded
     CI keystore path to `.gitignore`.

2. **Make signing explicit in Gradle.**
   - In `android/app/build.gradle.kts`, add a `release` signing configuration
     populated only from Gradle properties/environment variables, never from
     literals in source control.
   - Make a release build fail before packaging if any signing input is absent;
     it must never silently fall back to debug or unsigned signing.
   - Configure `debug` with `applicationIdSuffix = ".dev"`, a `-dev` version
     name suffix, and an `Ola Ink Dev` application label. Keep release package
     ID and public label unchanged.
   - Supply manifest placeholders per build type for the companion share action
     and use that placeholder in `AndroidManifest.xml`. Give the dev deep-link
     scheme/host a distinct value too if it remains supported.
   - Allow `versionCode` and `versionName` to be supplied as Gradle properties.
     Tag CI must set a monotonically increasing release `versionCode` (for
     example the full-history commit count, with `actions/checkout` fetching
     enough history) and use the tag as `versionName`. A signed APK with a
     lower version code cannot upgrade an installed release.

3. **Build a variant-matched bundled plugin.**
   - Replace the single Android `buildOlainkPlugin`/asset staging task with
     variant-aware debug and release tasks/directories.
   - Make `packages/plugin/buildPlugin.sh` accept one explicit companion-action
     environment variable, defaulting to the current stable action for direct
     plugin builds. Stamp that value into the generated React Native bundle;
     keep the TypeScript source and its tests on the stable default.
   - Have the debug APK invoke the plugin build with
     `com.olaink.OPEN_SHARE.dev`, and the release APK invoke it with
     `com.olaink.OPEN_SHARE`.
   - Add source-set/variant asset wiring so `assembleDebug` and
     `assembleRelease` each package their own generated `.snplg`, including
     when both tasks run in one Gradle invocation.
   - Preserve `PluginConfig.json` and its committed plugin ID. Do not create a
     second production plugin ID.

4. **Separate CI artifacts from releases.**
   - Change ordinary branch builds to run `:app:assembleDebug` and upload a
     clearly named `ola-ink-companion-dev.apk` artifact. It must not be
     attached to a GitHub release.
   - On tag builds, decode the release keystore to a runner-local protected
     file, export only the needed Gradle properties, run
     `:app:assembleRelease`, and publish
     `app/build/outputs/apk/release/app-release.apk` as
     `ola-ink-<tag>.apk` (for example, `ola-ink-0.0.8.apk`).
   - Make the release-publish step depend on successful release signing rather
     than on any debug artifact. Ensure secret-bearing steps do not run for
     pull requests from forks.
   - Run `apksigner verify --verbose --print-certs` on the release output and
     compare its certificate fingerprint to a non-secret expected value stored
     in the workflow or repository. Include that fingerprint in release notes
     for independent verification.
   - Delete the decoded keystore in an `always()` cleanup step. GitHub runner
     teardown is not the only control.

5. **Update developer commands and documentation.**
   - Keep `npm run build:android` and `npm run deploy:android` as the safe
     development path, but update their output/package wording to Ola Ink Dev.
   - Add an explicit release-build command that requires the signing properties
     and is not the default local workflow.
   - Update `android/README.md`, `DEVELOPER.md`, and the release checklist with
     the two package IDs, artifact names, signing verification command, and
     action-routing behavior.
   - Document that a developer can launch either installed app explicitly:

     ```sh
     adb shell am start -n com.olaink.dev/com.olaink.MainActivity \
       -a com.olaink.OPEN_SHARE.dev
     adb shell am start -n com.olaink/.MainActivity \
       -a com.olaink.OPEN_SHARE
     ```

6. **Test before rollout.**
   - Add a Gradle/configuration test or CI assertion that debug and release
     manifests have their expected package IDs and intent actions.
   - Add plugin build tests that verify the default and overridden action are
     stamped once and that the matching bundle is included in each APK.
   - In CI, build both variants and inspect each APK with `aapt dump badging`
     and `apksigner verify`.
   - On the Nomad, install the stable release and development APK side by side;
     verify the launcher labels differ, both retain independent WebView data,
     and each explicit ADB action opens only its matching app.
   - Install each variant's bundled plugin in turn and verify a Supernote Share
     launch reaches the intended app with no chooser. Re-run the normal send,
     inbox, logout, and pairing smoke tests for both variants.

## Migration and rollout

1. Publish the first stable, release-signed APK with a version code greater
   than the old published value.
2. Announce that `com.olaink` is a new Android package. Users of the old
   `dev.olaink.player` must install it as a fresh app and pair again; Android
   cannot transfer the old WebView profile/key/inbox across package sandboxes.
   They may uninstall the old app after confirming the new pairing works.
3. From that release onward, retain the release keystore and monotonically
   increase version codes; stable APKs will update in place.
4. Developers install `com.olaink.dev` once and can thereafter update it with
   `adb install -r` without touching the stable app or its data.

## Acceptance criteria

- Two tag releases signed by CI install sequentially with `adb install -r`
  under `com.olaink`, preserving the stable app's local data.
- A local debug APK installs with `adb install -r` under `com.olaink.dev`
  while the stable release remains installed.
- No GitHub release publishes an `assembleDebug` APK.
- The release key and passwords are absent from Git history, build artifacts,
  logs, and local default configuration.
- The Supernote plugin routes to the selected build variant without an intent
  chooser.
