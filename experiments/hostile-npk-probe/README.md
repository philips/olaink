# Ola Ink hostile NPK isolation probe (E1)

Disposable second plugin for the E1 isolation gate of
[`plans/single-snplg-native-client-experiment.md`](../../plans/single-snplg-native-client-experiment.md).
It is deliberately hostile, but only toward the throwaway state of the E1
native-client experiment (`olainknativeexp1`):

- its candidate durable-state files under the PluginHost `filesDir`
  (`plugins/olainknativeexp1/olaink-e1/` and `olaink-e1-olainknativeexp1/`);
- its Android Keystore AES wrapping alias `olaink-e1-wrap` (detect, use to
  decrypt the wrapped identity, and optionally delete).

It declares **no** PluginHost permissions. If its reads or keystore use
succeed, per-plugin isolation inside the shared PluginHost UID does not exist
on this firmware and the single-plugin replacement is a no-go regardless of
any other result. It must never be given a real account, note, or key.

## Build

```sh
experiments/hostile-npk-probe/buildPlugin.sh
```

Output: `experiments/hostile-npk-probe/build/outputs/olainkhostile.snplg`

## Nomad procedure

1. With the E1 experiment installed and its wrapped-key self-test run (so the
   victim alias and wrapped identity exist), install this probe:

   ```sh
   scripts/snplg-deploy.sh experiments/hostile-npk-probe --no-build
   ```

2. Open **Ola Ink hostile probe** from the NOTE sidebar and run, in order:
   - **Try to read victim state files** — recorded result (2026-08-29): the
     plugin-tree sentinel is `exists=true readable=false
     error=AccessDeniedException`; custom sibling files are `readable=true`;
   - **Detect + try to use victim keystore alias** — recorded result:
     `aliasPresent=true usable=true` (the victim's wrapped PKCS#8 was
     decrypted with the victim's alias);
   - **Try to DELETE victim keystore alias** — recorded result:
     `wasPresent=true stillPresent=false`.

3. Capture `adb logcat -d -s OlaInkHostileProbe:V ReactNativeJS:V`.

4. Uninstall `olainkhostile001` immediately after evidence capture (done on
   2026-08-29; the staged archive was also removed from `MyStyle`, and the
   victim identity was regenerated).

Gate conclusion: per-plugin isolation exists only for `files/plugins/<id>/`
paths (`PluginCheck`). Custom sibling directories are world-readable inside
the PluginHost UID, and the Android Keystore has no per-plugin boundary at
all — any native plugin can use or delete another plugin's aliases. This is
recorded as a replacement no-go unless Supernote documents a stronger
boundary.
