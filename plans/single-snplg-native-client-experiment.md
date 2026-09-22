# Experiment: replace the APK + `.snplg` pair with one native `.snplg`

Status: superseded for future work by `single-snplg-file-exchange.md`. E0/E1/E2 evidence remains valid; all in-plugin conversion, SVG, Canvas, and animation work is abandoned. Disposable experiment only; replacement remains security no-go.

This experiment asks whether Ola Ink can be rebuilt as one PluginHost client,
not whether the existing WebView client can be repackaged. The prior WebView
probe remains a decisive no-go: PluginHost runs as UID 1000 and Android refuses
to construct a `WebView` there. The replacement therefore uses React Native for
application UI, an `app.npk` for crypto/storage/networking and Android Canvas
rendering, and `supernote-typescript` only as a browser-free `.note` → SVG-scene
converter.

Do not change the stable plugin ID, production pairing, APK release, or current
architecture while running this experiment. A functional result is not enough
to ship: PluginHost key isolation and update provenance remain independent
security gates.

## Hypothesis

A single `.snplg` can perform the complete foreground workflow on the Nomad:

1. pair an experimental device;
2. save and read the active whole `.note` after scoped consent;
3. encrypt and send the complete bytes using native code in `app.npk`;
4. poll, decrypt, validate, list, and open inbox records in the plugin;
5. convert decrypted `.note` bytes to one embedded-scene SVG per page with
   [`supernote-typescript` PR 119](https://github.com/philips/supernote-typescript/pull/119);
6. display and replay those pages with the native Canvas player specified in
   [`native-svg-scene-renderer.md`](native-svg-scene-renderer.md); and
7. save a received whole `.note` atomically into the Supernote `Note` folder.

The relay must continue to receive only the existing opaque
`EncryptedNoteRecordV1`. There is no plaintext page/stroke network format and
no server-side `.note` conversion.

## Non-goals

- No WebView, `supernote-viewer`, HTML, DOM, WebCrypto, IndexedDB, SMIL, CSS
  animation, or second JavaScript engine.
- No background polling claim. Sync occurs when the plugin is open, on explicit
  refresh, after send, and when its foreground view resumes.
- No editing, appending pages, search, OCR UI, link overlays, thumbnails, or
  browser-like zoom/scroll parity in the first experiment.
- No migration of the APK's WebCrypto key, IndexedDB inbox, or paired identity.
- No production account, private key, recipient, or stable plugin ID.
- No deletion of the APK or existing plugin until all functional **and**
  security gates pass.

## Proposed architecture

```text
One experimental .snplg
├── React Native bundle
│   ├── pairing, inbox, send, player, settings UI
│   └── pinned supernote-typescript PR 119
│       SupernoteX(wholeNoteBytes)
│       toSvg(note, {
│         vectorInk: true,
│         embedScene: true,
│         documentId,
│       })
└── app.npk (loaded inside PluginHost)
    ├── OlaInkNativeModule
    │   ├── JCA crypto + Android Keystore wrapping
    │   ├── encrypted profile/inbox persistence
    │   ├── bounded current-note read + atomic inbox save
    │   └── allowlisted HTTPS relay client
    ├── in-memory SceneRegistry
    └── OlaInkSvgDocumentView
        strict v1 XML/JSON/path parser
        Android Canvas + PathMeasure
        postDelayed playback scheduler
```

`app.npk` is an APK-shaped native-code container, not a separately installed
application or process. Its Java code, React Native bundle, PluginHost, and
other native plugins share the PluginHost process/UID. Namespacing a file or
Keystore alias with the plugin ID prevents accidents; it does not create a
security boundary.

The generated `PluginConfig.json` declares only:

```json
{
  "uses-permissions": [
    "plugin.permission.FILE:READ",
    "plugin.permission.FILE:WRITE",
    "plugin.permission.INTERNET"
  ],
  "reactPackages": ["com.olaink.nativeexp.OlaInkPackage"],
  "nativeCodePackage": "/app.npk"
}
```

Request each capability at the action that needs it. Pair/poll/send require
`INTERNET`; sending or previewing the active note requires `FILE:READ`; saving
a received note requires `FILE:WRITE`. A denial must leave all unrelated
screens usable.

## Native endpoint boundary

Keep private keys, device-session tokens, ciphertext persistence, relay HTTP,
and encryption/decryption in the NPK. React Native receives only UI models and
one-shot document handles except for the deliberate plaintext conversion step
below.

A narrow native API is sufficient:

```text
profileStatus() -> unpaired | paired public metadata
ensureExperimentalIdentity() -> deviceId + public SPKI
claimPairing(code) -> public account metadata
logout()

listInbox() -> opaque ID, decrypted display metadata, read state
syncInbox() -> counts/status only
openInboxDocument(id) -> one-shot plaintext-note handle
markRead(id)
saveInboxDocument(id) -> destination filename

prepareCurrentNote(path) -> source handle + filename + bounded size
sendCurrentNote(sourceHandle, recipientUsername) -> accepted record ID
releaseDocument(handle)

readDocumentChunk(handle, offset, length) -> base64url bytes
createSceneDocument(documentId, pageCount) -> scene handle
putScenePage(sceneHandle, pageIndex, svg)
sealSceneDocument(sceneHandle) -> strict-parser result
releaseSceneDocument(sceneHandle)
```

Handles are random, process-local, single-purpose, and invalidated on release,
view close, profile reset, or process restart. Methods never return a private
key, session token, filesystem path, relay record, or unrestricted file API.
The current-note path enters native code only after
`PluginNoteAPI.saveCurrentNote()` and `PluginCommAPI.getCurrentFilePath()`; it
must be canonicalized under `/storage/emulated/0/Note`, end in `.note`, meet the
size cap, and never appear in logs or React state after preparation.

For the experiment, `readDocumentChunk` is the simplest way to feed the
TypeScript parser in Hermes without introducing JSI. Chunking avoids one giant
native bridge value, but `SupernoteX` still ultimately needs a complete
`Uint8Array`. Measure the native buffer, base64, Hermes array, generated SVG,
PNG, and native bitmap peaks. If representative notes exceed the memory budget
or block the UI, stop; do not hide the result by raising limits. A later JSI
buffer path is a separate optimization, not part of proving the architecture.

Plaintext `.note` bytes and SVG strings necessarily exist in the React Native
runtime during conversion. They remain local to the PluginHost process and
must not be logged, persisted by React state tools, sent to the relay, or
written to external storage. Java byte arrays should be cleared when practical;
JavaScript strings cannot be reliably zeroed, so do not claim perfect memory
erasure.

## Native crypto and profile storage

Implement the existing v1 format exactly, using Android/JCA rather than
WebCrypto:

- P-256 ECDH (`secp256r1`/`prime256v1`), SPKI DER public keys;
- a fresh ephemeral P-256 key for every recipient slot;
- HKDF-SHA-256 with empty salt and the existing content AAD as `info`;
- AES-256-GCM with 12-byte IVs and 16-byte tags;
- the existing content and slot AAD byte strings, including NUL separators;
- SHA-256 over the complete original `.note` bytes;
- canonical unpadded base64url and `SecureRandom` for IDs, keys, and IVs; and
- the existing whole-note JSON payload and `EncryptedNoteRecordV1` routing
  fields, including sender display metadata used by the current client.

Treat `packages/server/src/prototypeNoteCrypto.ts` and independent WebCrypto
vectors as the protocol oracle. Add checked-in, non-secret interoperability
vectors for Java encrypt → Node/WebCrypto decrypt and Node/WebCrypto encrypt →
Java decrypt. Include corrupted tags, AAD changes, wrong slots, malformed SPKI,
duplicate devices, non-canonical base64url, stale directories, and all size
limits.

### Android 11 key experiment

First test whether this firmware's Android Keystore can perform P-256 ECDH
with a non-exportable private key. Do not assume newer
`PURPOSE_AGREE_KEY` behavior exists on Android 11. If it is unsupported, the
functional fallback is:

1. generate the P-256 identity with the software JCA provider;
2. export its PKCS#8 once;
3. encrypt that PKCS#8 with a random AES-GCM key held by Android Keystore; and
4. persist only the wrapped key, IV, public SPKI, and versioned profile data.

That fallback tests functionality and at-rest wrapping, but it does not repair
the shared-UID threat: another native plugin may be able to invoke the same
Keystore alias. Never store raw PKCS#8, a session token, decrypted inbox bytes,
or plaintext message metadata on disk.

Persist durable inbox entries as ciphertext records plus minimal read/receipt
state. Decrypt records on demand to build the inbox model. Reopening an entry
regenerates its SVG scenes; SVG and decrypted `.note` caches are in memory only
and are discarded on close. Use atomic write + fsync + rename for profile and
ciphertext updates.

The experiment must discover and document a PluginHost-supported per-plugin
state directory. Test update, force-stop, reboot, uninstall/reinstall, and
logout semantics. Do not quietly use a PluginHost-global `SharedPreferences`
file. If there is no documented/preserved plugin-private location, replacement
is a no-go even if a directory happens to survive one firmware build.

## Inbox, send, and player UI

Build e-ink-oriented React Native screens rather than porting the HTML:

- **Unpaired:** pairing-code input, pair action, permission explanations.
- **Home/inbox:** explicit Refresh, unread count, sender/filename/date rows,
  offline/error state, and no decrypted metadata persisted between runs.
- **Send:** active-note filename/size, recipient address, Encrypt and send,
  cancel, and clear progress/error stages.
- **Player:** current page/page count, previous/next, replay, pause/resume, and
  `1/2/5/10×` speed.
- **Settings:** animation preference, logout, and an experiment/debug summary
  that contains timings and versions but no identifiers, paths, note names,
  key material, tokens, ciphertext, or plaintext.

Prove two entry paths: opening from an active NOTE goes directly to Send after
saving the note, while opening the installed plugin normally reaches Inbox.
If supported firmware has no discoverable non-note entry, record that as a
product blocker rather than assuming background inbox access.

### Send flow

1. Save the active note and obtain its current path through the plugin SDK.
2. Request `FILE:READ`, then have native code validate and open the exact file.
3. Reject locked/encrypted, changing, non-`.note`, out-of-root, symlinked, and
   oversized sources. Recheck size/identity while reading.
4. Request `INTERNET`; resolve the recipient directory with the paired-device
   capability.
5. Native code encrypts the complete note and uploads the opaque v1 record.
6. Release the source handle immediately after relay acceptance or failure.

No `.note` bytes need to cross into React Native merely to send. Previewing the
source is optional and uses the same conversion path as an inbox document.

### Inbox flow

1. Request `INTERNET` and poll with the device-scoped session held by native
   code.
2. Validate outer record shape and caps before cryptographic work.
3. Decrypt into a one-shot document handle; verify payload MIME, filename,
   hash, routing, and size.
4. In Hermes, construct `SupernoteX` from bounded chunks and export every page
   with PR 119.
5. Register each page in the native in-memory scene registry. The strict v1
   parser must accept all pages before the record is durable/acknowledged.
6. Persist ciphertext, acknowledge the relay record, and expose only decrypted
   list metadata to the current UI session.
7. On open, render the registered scenes; if they were evicted, decrypt and
   convert again.
8. On Save Note, request `FILE:WRITE` and atomically write the original whole
   `.note` under a sanitized, collision-safe name in `/storage/emulated/0/Note`.

This replaces the current “pinned viewer accepted the note before ACK” rule
with “`SupernoteX` converted every page and the strict native scene parser
accepted every page before ACK.” Conversion, parser, storage, or cancellation
failure leaves the relay delivery unacknowledged.

## `.note` → SVG-scene conversion

Pin PR 119 by exact commit (currently `71464862838eefad14da02da2c3694421578cd48`
while the PR is open), not by a moving branch or remote runtime asset. Record
its license and hash in the archive verification output. Upgrade only through a
reviewed dependency change.

For each document:

```ts
const note = new SupernoteX(noteBytes);
const pages = await toSvg(note, {
  vectorInk: true,
  embedScene: true,
  documentId,
});
```

Use the relay record ID for received documents and a random source-handle ID
for local previews. Never use Supernote `FILE_ID`, a canonical path, or a
filename as scene identity. PR 119 returns one standalone SVG per page and
embeds `oi:scene-version`, caller-owned document/page metadata, final contours,
real centerlines when available, erase-cover roles, optional timing, background
PNG, raster overlay, and OCR text as described in
[`ola-ink-svg-scene-v1.md`](ola-ink-svg-scene-v1.md).

The first converter milestone is a Hermes compatibility probe. Bundle only the
required parser/conversion/SVG path and narrowly reviewed polyfills (for
example `TextDecoder`/`atob` if absent). Do not bundle Node `fs`, the Atelier
`sql.js` path, PDF support, a DOM shim, or a general SVG package. Run real
fixtures on Nomad and compare output with the same pinned library under Node.
A converter that only works in Node/browser or requires another runtime fails
the experiment.

## Native SVG-scene player

Reuse the proven Canvas approach and production requirements from
[`native-svg-scene-renderer.md`](native-svg-scene-renderer.md), with one source
change: the experiment reads pages from the in-memory `SceneRegistry`, not from
PWA-exported files or archive fixtures.

Required behavior:

- strict, bounded parsing of the v1 XML/metadata/path subset;
- DTD and external entities disabled; no scripts, CSS, SMIL, URLs, or external
  resources;
- background PNG, raster overlay, supported static objects, final contours,
  centerlines, and erase covers;
- `writeOrder` playback and `zOrder` final compositing;
- centerline reveal with contour swap; fade for missing centerline;
- `View.postDelayed` monotonic scheduling because Nomad's animator scale is 0;
- current + next page maximum, worker-thread parse, generation-based
  cancellation, and bitmap recycling; and
- explicit PluginHost e-ink refresh at the measured cadence.

Do not pass SVG text as a React Native view prop every frame. Store it once in
the native scene registry, mount the view with an opaque handle, and pass only
small playback/page controls afterward. Release the registry entry on document
close, logout, view detach, memory pressure, and plugin shutdown.

## Experiment phases

Create `experiments/native-client-plugin/` with throwaway plugin ID
`olainknativeexp1`. Reuse small reviewed pieces from the two existing probes;
do not mutate either probe into the product and do not use
`olainksync00000001`.

### E0 — scaffold and archive discipline

- Build one `.snplg` containing one RN bundle, config, icon, and `app.npk`.
- Register one native module and the SVG document `ViewManager`.
- Add archive checks for exact members, config permissions, package classes,
  pinned converter revision, forbidden WebView/viewer assets, and no build or
  key output.
- Install/open/update/reboot/uninstall on Nomad and capture package lifecycle
  logs.

Exit: the disposable plugin opens from NOTE and Plugin Manager, and a same-ID
upgrade loads the expected new native and JS revisions without duplicate RN or
Hermes libraries.

### E0 implementation status — pass (2026-08-29)

`experiments/native-client-plugin/` contains the committed scaffold
(`olainknativeexp1`, version `0.0.2-e0-upgrade`, archive SHA-256
`880f4b51135457b240ca170de37837198e24c84ccfe8bb22ec879878e09d0720`).

- One archive with exactly five members: RN bundle, `PluginConfig.json`, icon,
  `converter-lock.json` (PR 119 commit pinned, not bundled), and `app.npk`.
  The NPK is pure Java: `lib/` is stripped entirely, so no duplicate RN/Hermes
  shared objects can ship. `verifyArchive.sh` enforces members, config,
  permissions, native classes, the pinned commit in both bundle and dex, and
  rejects Ola Ink browser/viewer references, nested APKs, key/state files, and
  any `.so`.
- The WebView guard needed one refinement: React Android's transitive
  AndroidX `LinkifyCompat` legitimately references the static platform
  `android.webkit.WebView.findAddress` helper in dependency dex, so the check
  rejects Ola Ink WebView classes/browser packages rather than the generic
  platform string.
- Version 1 installed on Nomad (`isUpgrade=false`), opened from the NOTE
  sidebar entry, and showed `OK E0: com.ratta.supernote.pluginhost; NPK
  revision 1; scene view OlaInkSvgDocument; converter pin matches.` with
  `FILE:READ=0 FILE:WRITE=0 INTERNET=0` displayed and never requested. The
  hardcoded Canvas geometry replayed under a `postDelayed` scheduler with the
  RN wrapper driving `invalidatePluginView()`; Pause stopped the refresh
  stream and Replay restarted it.
- Rebuilding every revision marker as version 2 and reinstalling over the same
  ID reported `isUpgrade=true`. PluginHost logged
  `resolveNativeLibsPath npkFileName:app_<timestamp>.npk,
  libsDirName:app_<timestamp>_libs` — it provisions a per-NPK libs directory
  even when the NPK ships no libraries, which E1 should account for when
  mapping the durable plugin state directory. The reopened UI showed only
  revision 2 (bundle, NPK, scene) with no `ClassNotFoundException`, duplicate
  class/library, or `UnsatisfiedLinkError` in logcat.
- Nothing else ran: no permission prompt, no identity, no profile/inbox state,
  no network, and no note read/write. The throwaway plugin is deliberately
  left installed so E1 can upgrade the same ID in place; remove it with
  Plugin Manager if the device is needed clean.

### E1 — crypto, state, and isolation gates

- Implement pure Java protocol code and run shared Node/WebCrypto/Java vectors.
- Probe native Android-Keystore ECDH; implement the wrapped-software-key
  fallback only if needed and label it clearly in the UI/log summary.
- Persist non-secret sentinels and a throwaway wrapped key through close,
  force-stop, reboot, and same-ID update; verify logout and uninstall deletion.
- Build a second hostile throwaway NPK that attempts to read the candidate
  state directory and use/delete its namespaced Keystore alias.
- Test downgrade and modified same-ID archive behavior and obtain/document the
  Supernote archive-authenticity rules.

Exit: functional crypto interop is mandatory. If another plugin can access the
key/profile, or update authenticity/persistence has no defensible contract,
mark the single-plugin **replacement** no-go. Later phases may continue only as
functional research with throwaway identities.

### E1 implementation status — functional crypto pass; isolation gate pending
device (2026-08-29)

Functional results on the Nomad (`olainknativeexp1` version `0.0.3-e1`, archive
SHA-256 `080477e6fc512b76fd730607e79b363cb353e8d8fe317d48e4921c44869e870d` and
later fixed rebuilds):

- **Protocol interop: pass.** `NoteV1.java` implements the full v1 record
  format in pure JCA (P-256 ECDH, HKDF-SHA-256 with empty salt and content AAD
  as info, AES-256-GCM, SHA-256, canonical unpadded base64url, strict minimal
  JSON, ordered payload/record serialization, full client-side validation).
  Host-JVM unit tests (`:app:testDebugUnitTest`, 9/9) and the on-device
  `protocolSelfTest` (4/4) agree with committed WebCrypto vectors in
  `vectors/note-v1-vectors.json`: Java's deterministic encrypt is **byte-
  identical** to the WebCrypto record, Java decrypts WebCrypto records for all
  recipients including a real-random-ephemeral case, and tamper/truncation/
  wrong-slot/non-canonical-base64 cases are rejected. Vectors are throwaway
  keys, regenerated by `vectors/generate-vectors.mjs` and shipped as an archive
  member for the on-device self-test.
- **Android Keystore ECDH: unavailable (expected on Android 11).** The probe
  reports `keystore ECDH unavailable; wrapped-software-key fallback required`
  — `PURPOSE_AGREE_KEY` generation and both AndroidKeyStore and software
  `KeyAgreement` with a keystore EC key all fail on this firmware. The fallback
  is therefore mandatory, exactly as the plan anticipated.
- **Wrapped-software-key fallback: functional.** AndroidKeyStore AES-256-GCM
  wrapping of a software P-256 PKCS#8 round-trips on-device, and the persisted
  blob remains decryptable after a PluginHost force-stop. Two required
  findings: the wrapping key must be generated with
  `setRandomizedEncryptionRequired(false)` (Android Keystore otherwise rejects
  caller-provided GCM IVs with `Caller-provided IV not permitted`), and a stale
  alias from a previous specification silently masks the new one, so the probe
  regenerates the alias per run.
- **Durable state: both candidate directories survive upgrade and process
death.** Sentinels under `plugins/olainknativeexp1/olaink-e1/` and the custom
  sibling `olaink-e1-olainknativeexp1/` kept the same marker through four
  same-ID reinstalls and a PluginHost force-stop. No PluginHost permission was
  required for these internal `filesDir` writes/reads.
- **Modified same-ID archive: accepted.** PluginHost repeatedly installed a
  rebuilt archive with the *same* pluginID and versionCode but different
  bundle/dex content as `isUpgrade=true` with no verification failure. There is
  no observed content-authenticity check at install time.
- **React Native bridge hazard (fixed, documented):** logging a `WritableArray`
  after handing it to the bridge throws `ObjectAlreadyConsumedException` on the
  native-modules thread, and PluginHost **closes the whole plugin view** on
  that exception. Bridge values must be stringified before `putArray`/
  `resolve`.

Pending device items were completed once the Nomad rejoined the network
(2026-08-29, post-reboot):

- **Reboot persistence: pass.** After a full device reboot, both state
  directories kept their marker and the wrapped identity remained decryptable
  (the Android Keystore AES key is TEE-backed and survived).
- **Hostile-plugin isolation gate: mixed — plugin tree isolated, everything
  else is not.** With the experiment's state present, the no-permission probe
  `olainkhostile001` (`experiments/hostile-npk-probe/`) found:
  - `plugins/olainknativeexp1/olaink-e1/e1-sentinel.json` — `exists=true`,
    `readable=false`, `error=AccessDeniedException`. The SDK's `PluginCheck`
    documents the mechanism: native code may only open paths under
    `files/plugins/<its-own-id>/`; foreign plugin paths are denied.
  - `olaink-e1-olainknativeexp1/*` (custom sibling) — **fully readable**,
    including the wrapped-identity ciphertext.
  - Android Keystore — **not plugin-isolated at all**: the hostile plugin saw
    the victim's `olaink-e1-wrap` alias, obtained the key, and **decrypted the
    victim's identity PKCS#8**; a follow-up call **deleted** the alias
    (`wasPresent=true stillPresent=false`). Any plugin can DoS (and, combined
    with a non-isolated blob, fully steal) another plugin's keystore-wrapped
    identity.
  The probe was uninstalled immediately after evidence capture, and the
  victim identity was regenerated.
- **Downgrade: rejected.** Installing a lower-versionCode archive
  (`2` over installed `3`) fails with `errorCode=103, errorMessage=Plugin
  Version is low` — PluginHost compares version codes.
- **Uninstall semantics: state survives uninstall.** After uninstalling and
  reinstalling the experiment, BOTH directories still contained the
  pre-uninstall marker (PluginHost's uninstall does not wipe
  `files/plugins/<id>/` beyond its own tracked files, and never touches custom
  siblings), the install DB row persists (reinstall reported `isUpgrade=true`),
  so downgrade protection spans uninstall/reinstall. Data-retention and
  logout-must-clean-up implications are mandatory design inputs.
- **Logout-style clear: pass.** `stateSentinelClear` removed both sentinels,
  the wrapped identity, and the keystore wrap alias (a `removed=0` in that
  log line was the same consumed-array artifact; the follow-up read showed
  `sentinel=false … wrapped=false` everywhere and the alias gone).

### E1 gate reading

Functional crypto interop (mandatory): **pass**. Isolation: **conditional** —
durable state is safe from other plugins only inside `files/plugins/<id>/`
(`PluginCheck`), and the Android Keystore offers no per-plugin boundary, so
keystore-wrapped keys are usable/deletable by any other native plugin in the
PluginHost UID. Update authenticity: downgrades are blocked, but same-ID
archives with equal-or-higher versionCode and arbitrary content install
without any content verification. Combined verdict per the decision rules:
the **replacement** remains no-go unless Supernote documents a stronger
boundary (keystore isolation or plugin signing); any future work continues
only as functional research with throwaway identities, and E2+ must keep all
durable state inside the plugin tree (not custom siblings), clean it on
logout, and treat identity theft by a hostile plugin as in-scope threat.

### E2 — native pairing and relay transport

**Core staging result (2026-09-21): pass, not a replacement gate.** The v4
archive accepts only a build-time fixed **HTTPS** IP/port and a pinned leaf
SHA-256 certificate. `RelayClient` uses 10-second connect/read timeouts,
no redirects, a 1 MiB response cap, no URL/token/body error logging, and the
companion Origin plus device-session capability only in native Java. All E2
state lives in `files/plugins/olainknativeexp1/olaink-profile/`.

Against a separately implemented Node WebCrypto peer and local staging relay:

- pairing produced `device_e2_ek1thlje` alongside the peer device;
- plugin → peer encrypted a fresh 4,096-byte fixture; the peer decrypted the
  complete payload and acknowledged it;
- peer → plugin encrypted an 8,192-byte fixture; the plugin decrypted,
  atomically stored ciphertext, and then acknowledged it;
- after force-stopping PluginHost and reopening from a NOTE, profile status
  still reported the same paired identity and two stored ciphertext records;
- a second clean poll returned zero records (ack idempotence);
- a deliberately AES-GCM-tampered record returned `polled=1, acked=0,
  failed=1` on two consecutive polls and logged only its record ID and
  `ProtocolException`, proving no ACK before successful validation;
- stopping the relay returned a redacted HTTP 502 while leaving the plugin
  usable; a syntactically valid nonexistent pairing code returned HTTP 400;
  and logout received server confirmation then left status unpaired with no
  local identity/inbox records; and
- a `strings` scan of the staging SQLite database found no E2 fixture plaintext
  marker. Throwaway TLS keys, peer state, relay DB, PIDs, and logs are ignored
  and rejected from the archive.

Still required before calling the whole E2 exit complete: deliberate timeout,
malformed-response, stale-directory, direct revoked-capability, cancellation,
and interrupted-atomic-write tests. E3 does not depend on them, but E4/E5
must close those cases.

Exit: each direction decrypts only at the intended peer; relay/database/logs
contain no plaintext note or private profile data.

### E3 — Hermes converter and bridge budget

**Provenance/license gate (2026-09-21): cleared.** The original author
retroactively relicensed the project in
`27ea9bf7336df4929224b413132f4406144ae39d` (`LICENSE: change the license
from upstream`). That commit is already an ancestor of the pinned PR 119
commit `71464862838eefad14da02da2c3694421578cd48`, so no rebase/cherry-pick is
needed: PR 119's `LICENSE` is Apache-2.0. `package.json` still says
`GPL-3.0-or-later`; record the discrepancy and the relicensing commit in
`converter-lock.json`, retain the upstream Apache LICENSE beside any bundled
source, and do not represent the stale manifest field as the effective grant.

**Initial bundle/host smoke (2026-09-21): pass; device measurement pending.**
A browser-targeted, minified CJS bundle exports only `SupernoteX` and `toSvg`.
It is 1.7 MiB (657,032 bytes gzip) and is SHA-256 pinned in the experiment
build. E3's checked-in, public 82,615-byte ruler-tool fixture crosses the
native→Hermes bridge as six capped 16 KiB base64url chunks. The independent
Node smoke constructs `SupernoteX` and produces three scene SVGs (28,961,
27,067, and 26,058 bytes); all three have v1 root metadata and two contain
replay stroke metadata. The archive carries the exact upstream Apache LICENSE
and provenance, not a plaintext generated SVG.

**Nomad Hermes result (2026-09-21): fail — stop this bundle path.** The first
load failed because Hermes lacks `Intl.ListFormat`/`Intl.Collator`; after a
minimal compatibility shim, it failed on absent `TextDecoder`; after adding
UTF-8/Latin-1 and `TextEncoder` shims, upstream named RegExp captures left
`match.groups` undefined. A recorded positional-capture patch fixed that
compatibility issue. The actual conversion then remained running beyond 70 s
and drove PluginHost to 312 MiB native PSS / 355 MiB native heap allocation for
an 82 KiB fixture. Force-stopping PluginHost recovered the view. This misses
all E3 latency/memory targets by orders of magnitude. Do not retry or conceal
it by increasing limits: image-js plus the all-in-one browser bundle is not a
viable PluginHost Hermes converter route. E4 must not consume this converter;
find a materially smaller converter/raster path or stop the native-client
experiment. The proposed recovery is
[`native-npk-note-to-scene.md`](native-npk-note-to-scene.md): parse/build/draw
inside the NPK and keep React Native to controls only.

- Pin PR 119 and bundle its minimal `.note` → SVG dependencies.
- Convert representative fixtures and all 27 documents/68 pages used by the
  existing renderer probe.
- Compare generated SVGs/profile metadata with Node goldens, then register and
  strict-parse every page natively in plugin.
- Measure bundle size, conversion latency, UI stalls, Java/Hermes/native heap,
  SVG size, PNG decode size, and cleanup after repeated open/close loops.

Initial targets: a 5 MiB note remains within PluginHost's memory envelope,
first page is visible within 3s for a representative note, subsequent page
parse stays hidden inside the page turn where possible, and ten open/close
cycles show no monotonic heap growth. Record actual device numbers even when
targets fail.

### E4 — native inbox/send/player shell

- Implement the five RN screens and foreground lifecycle.
- Integrate current-note save/read, native send, native poll/decrypt,
  conversion-before-ACK, scene playback, read state, and atomic Save Note.
- Port renderer regression and e-ink quality checks from the animated SVG
  probe. Keep at most one active decrypted document and current + next page.
- Cancel HTTP, conversion registration, and playback when the view closes;
  ensure stale callbacks cannot update a reopened view.

Exit: the plugin completes the two-device acceptance flow without the Ola Ink
APK installed or running.

### E5 — destructive and lifecycle acceptance

Using only backed-up fixtures and disposable accounts:

1. Install the one archive on a clean test state and deny every permission.
2. Pair after granting only Internet; refresh an empty inbox.
3. From an open note, save it, grant one-time read, send it to a Web/Node peer,
   and compare the decrypted SHA-256 byte-for-byte.
4. Send a note back; poll, convert all pages, acknowledge, display/replay, close,
   reopen/regenerate, and save it to `Note`; compare bytes again.
5. Repeat with multi-page, erase/highlighter/calligraphy, raster fallback,
   landscape, near-limit, corrupted, unsupported, locked, and changing files.
6. Force-stop PluginHost during read, encrypt, upload, decrypt, conversion,
   scene parse, save, and logout; verify recoverable/idempotent state each time.
7. Upgrade, reboot, attempt downgrade, uninstall/reinstall, and verify the
   documented key/inbox behavior.
8. Inspect server storage, device external storage, plugin state, archive, and
   logcat for plaintext, paths, tokens, key material, temporary SVGs, and stale
   decrypted files.

## Results and decision rules

Report two separate outcomes.

### Functional experiment pass

- One `.snplg` provides pairing, send, inbox, conversion, native display,
  replay, save, logout, and foreground lifecycle on supported Nomad firmware.
- Native crypto is byte-compatible with the existing protocol and whole-note
  E2EE remains intact.
- PR 119 runs under PluginHost Hermes without a browser/second runtime.
- The strict native player renders the generated full fixture corpus within
  measured memory/latency/e-ink budgets.
- No APK, WebView, `supernote-viewer`, plaintext relay format, or persistent
  plaintext scene/note cache is involved.

### Replacement candidate pass

In addition to the functional pass:

- Supernote documents an adequate per-plugin state/Keystore boundary, or an
  independent security review demonstrates an equivalent boundary against
  other native plugins in the shared PluginHost UID.
- Same-ID updates are authenticated, downgrade behavior is acceptable, keys
  and ciphertext survive supported updates, and uninstall reliably removes
  them.
- Permission and normal-entry behavior work across the supported firmware
  matrix.
- The native endpoint receives a focused security review, including the large
  native↔Hermes plaintext bridge and parser attack surface.

Failure of any replacement gate means keep the signed APK and current stable
plugin, even if the functional demo is compelling. Do not solve a failed
isolation test with secret directory names, obscure aliases, encoded keys, or
an undocumented PluginHost behavior.

## Deliverables

- `experiments/native-client-plugin/` source, build, archive verifier, and
  explicit non-production README;
- shared Java/Node/WebCrypto v1 conformance vectors and tests;
- pinned PR 119 revision/license/hash and Node-vs-Hermes SVG goldens;
- native strict-parser and renderer tests using the existing 68-page corpus;
- Nomad logs, timings, heap/bundle/archive measurements, screenshots/video,
  and permission/lifecycle matrix with secrets redacted;
- hostile-plugin isolation results and Supernote provenance/persistence answer;
- a final `functional: pass/fail` and `replacement: pass/fail` decision; and
- cleanup instructions that uninstall both throwaway plugins, revoke their
  staging devices, and remove test notes without touching the stable Ola Ink
  identity.
