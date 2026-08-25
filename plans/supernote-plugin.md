# Supernote plugin — WRTN Share

## Purpose

The Supernote plugin is a narrow in-note hand-off surface. From an open note,
the user taps **WRTN Share** and the plugin launches the separately installed
WRTN Android companion application. The companion hosts the WRTN PWA in a
normal Android WebView; the PWA owns authentication, encryption, sending,
receiving, and playback.

The plugin must not become a second relay client. It has no inbox, account,
device key, polling loop, page-element serialization, stroke conversion, or
receiver note creation/append behavior.

## Hand-off contract

The preferred activity action is a unique explicit-purpose action such as
`dev.wrtn.OPEN_SHARE`, handled by the companion's exported `singleTop`
activity. React Native `Linking.sendIntent()` has been proven to launch a
fixture custom action and carry scalar extras on a Nomad; the retained fixture
uses `dev.wrtn.OPEN_SHARE`.

An intent carries only an opaque launch/draft handle and non-secret context. It
never contains note bytes, a bearer token, an authenticated URL, or a reusable
session. The companion validates its action/extras and gives the user a clear
install/open failure if no compatible application is present.

## Current-file constraint

Launching an APK is proven; handing it the full active `.note` is not. The
pure-JS Supernote SDK can query the current note and page or extract elements,
but does not provide binary `.note` reads. The target hand-off needs either:

1. a supported `content://` URI with a temporary read grant; or
2. a user-mediated Storage Access Framework/native companion bridge.

Do not pass a raw filesystem path, base64 file data, or extracted strokes.
`Linking.sendIntent()` cannot itself add a URI grant flag, so a PluginHost API
or a small supported native bridge may be necessary. Until this boundary works
on the real device, the Share button may open the companion but must not claim
that it sent the current note.

## Lifecycle and deployment

The stable plugin ID and the existing ADB install loop remain valid. A displayed
plugin view still stops its JS runtime when closed, but that is no longer a
delivery concern: the plugin has no background receive work. Log intent launch
success/failure under `ReactNativeJS` and validate the complete return-to-note
flow on device.

See [`plans/issue-15-e2ee-note-service.md`](issue-15-e2ee-note-service.md) for
the companion/PWA/service architecture and
[`experiments/wrtn-player-wrapper/README.md`](../experiments/wrtn-player-wrapper/README.md)
for the validated intent and WebView fixture.
