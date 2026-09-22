# Write-on SVG examples

These are browser/debug/export illustrations of the typed `NativeWriteStroke`
contract, not assets the native NPK interprets as general SVG.

- `centerline-reveal.svg` — a stroke with centreline points: reveal by length.
- `contour-swap.svg` — draw a centreline preview, then atomically replace it
  with the exact pressure-contour fill.
- `contour-fade.svg` — safe fallback for a fill contour with no centreline:
  short fade only; never infer a pen route.

The native probe implements equivalent behavior with Canvas paths and an
explicit `postDelayed` scheduler because PluginHost cannot host WebView and
Nomad has Android animator scale set to zero.
