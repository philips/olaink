# Rendering an Ola Ink SVG scene inside an `.snplg`

Status: proven by the disposable probe `experiments/animated-svg-plugin/`
(v0.0.18, Nomad-tested end to end) and the format spec
[`ola-ink-svg-scene-v1.md`](ola-ink-svg-scene-v1.md). This plan turns that
prototype into the production renderer that ships inside the real Ola Ink
plugin.

## Goal

Inside a PluginHost `.snplg`, open any note page exported with
`toSvg(note, { vectorInk: true, embedScene: true })` and:

1. render the finished page natively (no WebView, no general SVG engine);
2. replay the handwriting in write order with centreline reveal + contour
   swap;
3. page through multi-page documents with a deliberate e-ink page turn.

Non-goals: free scroll/zoom, thumbnails, text selection/search overlays,
editing, and any plaintext persistence of scenes (the PWA keeps exporting;
`.note` bytes stay encrypted end to end).

## Architecture

```text
PWA (companion, WebView)                .snplg (PluginHost, native)
  toSvg(…, {embedScene:true})             React Native UI (page picker,
  → v1 scene SVG per page        ──────►    transport controls)
                                          AnimatedSvgDocumentView (native)
                                            XmlPullParser (strict v1 subset)
                                            Canvas + postDelayed scheduler
                                            assets/fixtures/*.svg, one page
                                              parsed at a time
```

- The scene files ship as `.snplg` archive members (PluginHost extracts them
  under `filesDir/plugins/<pluginID>/`), exactly like the probe's
  `fixtures/`. They are static page exports, not the source `.note`; nothing
  plaintext beyond the chosen pages is added to the device beyond what the
  user already sees on screen.
- One native `ViewManager` (`SimpleViewManager`) owns everything: parsing,
  timeline, drawing. React state holds only selection/playback/speed.
- The RN wrapper drives PluginHost's `invalidatePluginView()` at the chosen
  refresh cadence (measured sweet spot: 10 FPS host refresh over a 10 FPS
  native timeline).

## Parsing (strict v1 subset)

Implement per `ola-ink-svg-scene-v1.md` "Parser validation and safety":

- `XmlPullParser` with DTD/external entities disabled; size caps on XML bytes,
  JSON bytes, image bytes, stroke count, points per path, total points.
- Root checks: `oi:scene-version == 1`; read `viewBox`,
  `document-id`/`page-index`/`page-count`.
- Metadata: exactly one `oi-scene` element, exact ID + MIME type, JSON
  `version == 1`, reject unknown keys and unknown `oi:role` values.
- Path grammar: absolute `M`/`L`/`Z` only (producer form: comma-separated
  pairs, two fractional digits — accept any finite decimal otherwise);
  reject empty `d`; reject duplicate IDs and dangling references.
- Roles: `final-contour` (honor its real paint: fill **or**
  fill=none+stroke), `erase-cover` (always stroke, never fill), `centerline`
  (hidden write geometry).
- Static content: background PNG (`data-page-background`), optional
  `data-raster-ink-overlay` PNG, invisible OCR `<text>` (skip for replay,
  optional for display), unreferenced static geometry drawn as-is.
- Timing: use `t0Ms`/`durationMs` when present; otherwise
  `clamp(lengthPx / 250 * 1000, 80, 1200)` ms with a 30 ms pen lift.

## Playback model (from the probe)

- Page timeline = strokes sorted by `writeOrder`; per stroke, reveal its
  centreline with `PathMeasure.getSegment`, then commit its final-contour
  paint; missing centreline ⇒ alpha fade of the contour. `erase-cover`
  strokes draw their white stroke as they move.
- Frame loop: `View.postDelayed` at 10 FPS (Nomad's
  `animator_duration_scale=0` kills `ValueAnimator`); each frame redraws the
  committed composite in `zOrder` (prefix-redraw baseline; measure
  incremental/ cursor variants later against ghosting).
- Z-order: committed contours paint in numeric `zOrder`; the active stroke's
  centreline rides on top; the raster-ink overlay is static and paints above
  everything on every frame.
- Speed control scales the timeline (`1/2/5/10×`, 5× from the old APK);
  pause/resume preserves the timeline position; the 1000 ms page-turn hold
  and static-page dwell stay real time.
- Multi-page: group by caller-owned `document-id` (never `FILE_ID`), order
  by `page-index`; parse the next page during the hold on a worker thread
  (generation counter discards stale loads); recycle decoded bitmaps on
  swap; keep at most current + next page in memory.

## Production hardening (beyond the probe)

1. **Strictness.** The probe is deliberately lenient (compat demo). The
   production parser implements the full reject list in the spec and fails
   the page with a visible, logged error instead of rendering a partial
   scene.
2. **Deterministic fixtures.** Each exporter test artifact becomes a
   regression: golden parse (JSON/path lengths, durations), plus
   screenshot comparison on Nomad for erase/white-pen, highlighter,
   calligraphy widths, landscape, contour-only, raster/background-only
   pages.
3. **Memory & latency budgets.** Targets to measure on Nomad before
   shipping: page parse < 500 ms for a 1 MB scene (hidden inside the 1000 ms
   hold), < 25 MB resident per open document (one 1920×2560 RGB_565 bitmap
   ≈ 10 MB), no allocation churn per frame beyond one `Path` scratch.
4. **E-ink quality pass.** Compare prefix-redraw vs incremental-commit vs
   cursor variants at 5/10/15 FPS on-device; pick per measured flashing and
   ghosting; quantize the host refresh loop accordingly.
5. **Scene delivery & lifecycle.** Pages are exported by the PWA on demand
   and written where the plugin reads them (existing encrypted-exchange
   transport decides the channel; scenes are plaintext page exports, so they
   must not be persisted longer than the viewing session — delete on
   `closePluginView()` and on document close). `closePluginView()` stops the
   plugin runtime, which now also means "stop delivery" — safe because the
   player is the only consumer.
6. **Permissions.** None beyond PluginHost defaults (the probe requests
   none); parsing reads only the plugin's own extracted files.

## Milestones

1. **M1 — Renderer library.** Extract the probe's parser + timeline into a
   tested module (JVM-unit the grammar/timeline code with Robolectric or
   plain fakes; device-instrumented the rest). Strict validation on.
2. **M2 — Document shell.** Real plugin ID, page picker fed by the PWA
   export, strict-error UI, page cache/lifecycle rules above.
3. **M3 — On-device quality.** E-ink variant sweep, memory/latency
   measurement against the budgets, fixture regression suite wired to the
   exporter's test artifacts.
4. **M4 — Integration.** Replace the probe's file layout with the real
   delivery channel, remove the disposable probe, and fold the plan doc +
   spec into the plugin README.
