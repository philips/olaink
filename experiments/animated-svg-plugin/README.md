# Animated SVG-scene NPK probe

Disposable Nomad experiment for the non-WebView rendering off-ramp in
[`plans/embedded-native-snplg-feasibility.md`](../../plans/embedded-native-snplg-feasibility.md).
It uses plugin ID `olainksvgprobe0001`; it is not Ola Ink and carries no
permission, note, key, account, database, or network code.

`animated-scene.svg` is the source vector scene. The probe deliberately does
**not** test general SVG, CSS animation, SMIL, or `react-native-svg`: Android
Canvas draws the same SVG path-data geometry with a `PathMeasure` reveal driven
by a `View.postDelayed` scheduler. The scene advances in 60 discrete frames
over six seconds (10 FPS); it cannot use `ValueAnimator` because Nomad has the
system animator duration scale set to zero. Its React Native wrapper probes
PluginHost's native `invalidatePluginView()` at that cadence to request
E-ink-visible refreshes. This establishes only that a dynamically loaded NPK
can mount and animate a constrained native vector scene without constructing a
WebView.

## Build and install

```sh
experiments/animated-svg-plugin/buildPlugin.sh
adb connect 100.103.149.40:5555
scripts/snplg-deploy.sh experiments/animated-svg-plugin --no-build
```

Open the probe from Plugin Manager and select each rendering experiment:
prefix redraw, incremental committed ink, moving cursor, and a top-to-bottom
reveal of `rtr-n5-20230015-recognition-1.svg`, with 5/10-FPS host refresh
variants; it also includes a two-page test that holds a completed page for
one second before replacing it with the next page. The supplied SVG is one
embedded PNG plus transparent OCR text, so its reveal is intentionally not
presented as a pen-stroke replay. **Replay** restarts the selected experiment and
**Pause** freezes it. Compare flashing, ghosting, readability, and apparent
motion. Capture `ReactNativeJS`, `OlaInkSvgProbe`, `PluginApp`, and
`PluginInstallManager` logs. Uninstall the disposable plugin after the test.

The **Fixture documents** tab replays the embedded-scene fixtures from
[`tests/`](../../tests/) end to end: 27 documents / 68 pages bundled as
archive members under `fixtures/`. The exporter now stamps the profile
format changes agreed after the first prototype: `oi:scene-version="1"`,
`oi:document-id`/`oi:page-index`/`oi:page-count` on the root, metadata
`"version":1`, and `oi:role="erase-cover"` on erase contours. The native
parser accepts only the
constrained profile (root `viewBox`, `<metadata>` stroke JSON, `M`/`L`/`Z`
path data, solid fills, and the embedded background PNG), sorts strokes by
`writeOrder`, previews each centreline with a `PathMeasure` reveal, swaps in
the final `zOrder`-sorted contour at stroke completion, and holds each
finished page for 1000 ms before turning to the next page in the same
viewport. A speed control cycles the write timeline at 1/2/5/10×; the 1000 ms
page hold stays real time so e-ink settling is unaffected. Pages without
stroke metadata (background/OCR-only exports) render statically for the same
hold. Scene geometry is letterboxed to the full plugin viewport at native
viewBox resolution.

This is not evidence for moving Ola Ink keys or encrypted records into
PluginHost. It only informs Phase 0.4 renderer feasibility.
