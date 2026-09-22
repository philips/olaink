# Native SVG-scene handoff for `supernote-typescript`

This is an experimental rendering contract for the non-WebView Ola Ink plugin
research. 

## Device result and hard constraint

The Nomad PluginHost cannot construct `WebView`. A native Canvas `ViewManager`
*can* display an animated vector-path probe. The device has Android's global
`animator_duration_scale=0`, so `ValueAnimator` completes immediately; native
playback must use an explicit `View.postDelayed`/`Handler` frame scheduler.

### One-file embedded SVG profile

A separate scene file is not required. Keep the final static page as ordinary
SVG and embed a small, versioned Supernote animation profile in that same SVG.
Browsers that do not know the profile still render the final contours; the
native renderer reads only the documented metadata and referenced elements.
For example:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:oi="https://olaink.com/ns/vector-scene/1"
     viewBox="0 0 1920 2560" oi:scene-version="1">
  <metadata id="oi-scene" type="application/vnd.olaink.vector-scene+json">
    {"strokes":[{"id":"s12","writeOrder":12,"zOrder":4,
      "centerline":"s12-line","contour":"s12-fill"}]}
  </metadata>
  <!-- Normal static SVG: the browser displays this final contour. -->
  <path id="s12-fill" fill="#111" d="M…Z" oi:role="final-contour"/>
  <!-- Hidden static/debug geometry; native uses it only while writing. -->
  <path id="s12-line" fill="none" stroke="#111" d="M…L…"
        oi:role="centerline"/>
</svg>
```

Use standard SVG only for the final visual geometry. Put write order, z-order,
roles, and optional timing hints in `<metadata>`/the `oi:` namespace; do not
encode runtime behavior with CSS, SMIL, or scripts. The native parser must
allow only this constrained profile (root/viewBox, metadata JSON, known path
attributes, and the approved path grammar), reject unknown animation data, and
render with Canvas. This is still a schema, but it is one self-contained,
forward-versioned SVG artifact rather than another file to pair or migrate.

The profile cannot recover information that the source SVG never contained.
For example, adding metadata after the fact to a contour-only SVG cannot
produce its missing real centreline or `TOTALPATH` write order; the
supernote-typescript exporter must embed those while it still has the decoded
stroke records.

## Prototype feedback to the exporter (fixture player v0.0.16)

The native fixture player played all 27 documents / 68 pages on Nomad at
1–10× speed. Validated as-is: absolute `M`/`L`/`Z`-only path data, `rgb()`
colours, the `<metadata>` stroke JSON (`id`/`writeOrder`/`zOrder`/
`centerline`/`contour`), per-page files with background PNG data URIs,
fully-erased strokes dropped with dense `zOrder` kept for survivors, and
transparent-fill OCR `<text>`. Requested changes, in priority order:

1. **Mark erase strokes explicitly.** Today an erase stroke is only
   recognisable by inference: its contour has `fill="none"` plus a
   page-coloured `stroke` (white pen covering ink). The first native pass
   misread that as a filled path and painted a giant black blob — a real bug
   shipped because the encoding is implicit. Add `oi:role="erase-cover"` on
   the contour path, or `"composite":"cover"` in the metadata entry. Keep the
   white-stroke rendering so unaware browsers still show correct output.
2. **Version the profile.** Emit `oi:scene-version="1"` on the root and
   `"version":1` inside the metadata JSON so native parsers can refuse or
   adapt to future changes instead of mis-parsing silently.
3. **Group pages in-file.** Filename conventions (`-page-N-`) worked but are
   brittle. Emit `oi:document-id`, `oi:page-index`, and `oi:page-count` on
   the root so players can assemble documents without parsing names.
4. **Embed real timing when available.** Duration is currently a renderer
   heuristic (`clamp(lengthPx / 250 * 1000, 80, 1200)` ms, 30 ms pen lift).
   If the `.note` records per-stroke timestamps, emit optional
   `"t0Ms"`/`"durationMs"` per stroke; renderers fall back to the heuristic
   when absent.
5. **State the missing-centreline contract.** An absent `centerline` ref
   means "fade the contour in; do not invent motion". Never emit an empty
   `d` — that crashed the first parser.
6. **Keep the constrained grammar frozen.** Absolute commands only, `M`/`L`/
   `Z` only, `rgb()`/`#rrggbb` colours only, no transforms, no arcs, no
   relative commands. The native Canvas parser (and its tests) depends on
   exactly this subset; anything more must come with a version bump.

Also keep emitting the current fixture families (erase/white-pen,
highlighter, calligraphy widths, landscape pages, background-only pages):
the probe now replays them on-device and each one exercises a distinct
renderer path.
