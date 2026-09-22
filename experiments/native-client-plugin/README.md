# Ola Ink native client E0/E1/E2 experiment

Disposable scaffold for E0/E1 of
[`plans/single-snplg-native-client-experiment.md`](../../plans/single-snplg-native-client-experiment.md).
E0 proves one `.snplg` loads a React Native bundle plus an `app.npk` that
registers `OlaInkNativeClient` and `OlaInkSvgDocument`. E1 adds pure-Java
protocol crypto, Android Keystore probes, the wrapped-software-key fallback,
and durable-state sentinels. E2 adds a pinned-HTTPS staging relay, throwaway
native pairing, whole-record fixture encryption/decryption, ciphertext inbox
storage, ACK-after-validation, and logout.

No phase parses a real `.note`, reads/writes a note, or creates a production
identity. E2 requests only `INTERNET` at user action. It uses fixture bytes
only; the eventual file permissions remain declared but unexercised.

The experiment uses throwaway plugin ID `olainknativeexp1`. Never replace it
with the stable Ola Ink ID and never pair this build to a production account.

## Build

From the repository root, after `npm ci`:

```sh
PIN=<lowercase-sha256-of-staging-leaf-certificate>
OLAINK_RELAY_BASE=https://<staging-ip>:8443 \\
OLAINK_RELAY_CERT_SHA256="$PIN" experiments/native-client-plugin/buildPlugin.sh
(cd experiments/native-client-plugin/android && ./gradlew :app:testDebugUnitTest)
node experiments/native-client-plugin/vectors/generate-vectors.mjs  # only to refresh vectors
```

Requirements: Node/Metro from the root install, JDK 17, Android SDK 35,
`python3`, `zip`, `unzip`, `strings`, and `sha256sum`. Output:

```text
experiments/native-client-plugin/build/outputs/olainknativeexp.snplg
```

`verifyArchive.sh` requires the pinned HTTPS `relay.json`, checks the
disposable ID/config/permissions/native classes, verifies the PR 119 commit
descriptor and committed interop vectors, and rejects browser/viewer
references, nested APKs, key/state files, and native shared libraries. PR 119
is not bundled yet. Its effective Apache-2.0 `LICENSE` comes from upstream
relicensing commit `27ea9bf7336df4929224b413132f4406144ae39d`, which is already
an ancestor of the pinned commit; its stale package manifest still says GPL,
so preserve the Apache LICENSE and this provenance when bundling.

## Nomad E3 procedure

Version 5 embeds the pinned PR 119 `SupernoteX`/`toSvg` bundle and a public
82,615-byte ruler-tool fixture. The native bridge allows only 16 KiB chunks and
a 1 MiB fixture cap. `converter/LICENSE` and `converter/PROVENANCE.md`
preserve upstream Apache-2.0 provenance.

**Do not rerun this probe on Nomad.** It established that the browser/image-js
bundle is not viable: Hermes needed missing-Intl/Encoding shims and a recorded
named-RegExp-capture patch just to begin; then conversion ran for more than
70 seconds and reached 312 MiB native PSS / 355 MiB native heap allocation for
this 82 KiB fixture. Force-stopping PluginHost recovered the host. No E4 code
may use this converter; see the E3 result in the plan.

## Nomad E2 procedure

Run only against the throwaway relay/peer under `e2/`; generated TLS keys,
peer state, SQLite, PIDs, and logs are ignored. First request **INTERNET** and
select **Allow This Time Only**, then explicitly tap **OK** in PluginHost's
permission dialog. Pair with a one-use code from the independent Node peer,
send the 4 KiB fixture, poll the peer's fixture, and logout. Capture only
redacted evidence:

```sh
adb logcat -d -s OlaInkNativeExp:V ReactNativeJS:V
```

Expected evidence: Java/Node decrypt each other’s fixture, a second poll is
empty after ACK, a tampered AES-GCM record remains unacknowledged, an offline
relay fails recoverably, and logout clears the native profile. This is
functional staging evidence, not a production-security result; E1 established
that another native plugin can access the shared Android Keystore.

## Nomad E1 procedure

Open the experiment (see E0 below), then use the probe buttons and capture:

```sh
adb logcat -d -s OlaInkNativeExp:V ReactNativeJS:V
```

- **Run protocol self-test** — must log `passed=4 failed=0` including
  `deterministic-encrypt:byte-identical`.
- **Probe Android Keystore ECDH** — documents whether keystore-native ECDH
  exists (it does not on Android 11: the wrapped-software-key fallback is
  mandatory).
- **Wrapped-key self-test** — wraps a throwaway software identity with an
  AndroidKeyStore AES-GCM key; must log `roundTrip=true` and persists the blob
  under `olaink-e1-olainknativeexp1/`.
- **Write/Read/Clear state sentinels** — durable-state evidence across close,
  force-stop (`adb shell am force-stop com.ratta.supernote.pluginhost`),
  reboot, same-ID upgrade, logout, and uninstall; see the plan document for
  the recorded results and the still-pending device items.

Never log or resolve a consumed `WritableArray`; PluginHost closes the entire
plugin view on a native-module exception.

## Nomad E0 procedure

```sh
adb connect 100.103.149.40:5555
scripts/snplg-deploy.sh experiments/native-client-plugin --no-build
```

Open it from Plugin Manager and from the NOTE sidebar entry **Ola Ink native
client experiment**. Expected UI/log evidence:

- the hardcoded native Canvas line replays and Pause/Replay work;
- the status begins `OK E0: com.ratta.supernote.pluginhost` and reports native revision 2;
- the converter pin reports `matches`;
- logcat contains `OlaInkNativeExp: native module constructed phase=E0` and
  `OlaInkNativeExp: describe invoked phase=E0`; and
- no permission prompt, file/network operation, identity, or state is created.

Capture logs with:

```sh
adb logcat -d -s ReactNativeJS:V OlaInkNativeExp:V PluginApp:V \
  PluginHost:V PluginManager:V PluginInstallManager:V
```

E0 was installed first as version 1 and then rebuilt as committed version 2.
Installing version 2 over the same ID must report `isUpgrade=true`; the reopened
UI must show native revision 2 and the v2 scene. Future checks must continue to
increment both config and Gradle versions without changing the plugin ID.

Uninstall `olainknativeexp1` after the experiment. No production Ola Ink
installation or identity should be changed.
