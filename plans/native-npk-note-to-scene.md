# Plan: native NPK `.note` → scene SVG path

Status: superseded. The project abandoned all in-plugin note conversion,
SVG, Canvas, and animation work in favor of
[`single-snplg-file-exchange.md`](single-snplg-file-exchange.md).

## The simple idea

The earlier plan mixed two separate jobs:

```text
read .note → convert to SVG → draw SVG
```

The failed E3 experiment tried to do **convert to SVG** in React Native/Hermes
by bundling the browser-oriented upstream converter. That bundle consumed too
much memory.

The replacement puts both byte-heavy jobs in the NPK Java code:

```text
Supernote-supported source handle
        │
        ▼
NPK: read bounded whole .note bytes
        │
        ▼
NPK: parse .note and make one small native Scene object per page
        │
        ├── NPK Canvas renderer draws the Scene directly
        │
        └── optional: serialize the same Scene as constrained v1 SVG
             only for regression/golden comparison, never for a WebView
```

React Native is only the controls: inbox rows, page number, Replay, Pause,
speed, errors, and permission explanations. It never receives `.note` bytes,
private keys, session tokens, SVG text, or a filesystem path.

“SVG-native rendered” means the NPK owns the SVG-scene grammar and Canvas
painting. It does **not** mean a browser, `<img>`, `react-native-svg`,
`supernote-viewer`, `image-js`, WebCrypto, or WebView is used.

## What is a Scene?

A `Scene` is a small Java model, not a general SVG document:

```text
Scene
  page width/height
  background PNG bytes or decoded Bitmap
  static objects (rect/path/image)
  strokes, each with:
    final contour Path + Paint
    optional centreline Path + Paint
    writeOrder, zOrder, duration
```

The existing `ola-ink-svg-scene-v1.md` stays the interchange specification.
The NPK may either build this model directly from parsed note strokes or parse
an already-generated v1 SVG. Direct construction is the preferred production
path because it avoids large XML strings and another plaintext bridge.

## Non-negotiable boundary before coding

The plugin currently has no supported binary read handle for the active note.
The SDK exposes metadata/elements, but not a sanctioned stream of complete
`.note` bytes. Therefore do **not** use a raw external-storage path, copy the
file, or pass it through an intent.

Phase N0 is a prerequisite, not an implementation detail:

1. Obtain a Supernote-supported `content://` read grant, SAF selection, or
   reviewed native source bridge that supplies the exact whole-note bytes.
2. Define a native `DocumentSourceHandle` that is random, single-use,
   process-local, and revoked on close/reset.
3. NPK validates the handle’s source, `.note` type, stable size, and a strict
   maximum before reading.
4. If Supernote cannot provide this, stop the active-note/send half of E4.
   Inbox conversion can still be evaluated from decrypted in-memory bytes.

## Phases

### N1 — extract the reusable note parser

Goal: establish whether upstream PR 119’s **binary parser/stroke decoder** can
be ported to Java without its browser/image-js raster pipeline.

- Inventory the exact PR 119 code needed for `SupernoteX`, page headers,
  `TOTALPATH`, stroke styles, layer records, and bitmap references.
- Create Java models with size limits before allocations: note bytes, pages,
  layers, records, stroke count, points/stroke, total points, bitmap bytes,
  dimensions, and decompression ratio.
- Port a single fixture parser first; every integer offset/length must be
  bounds-checked and overflow-safe.
- Add JVM tests that compare page count, viewBox, stroke IDs/order, tool/color,
  point counts, and bitmap digests against Node goldens from the pinned source.
- Keep the upstream Apache LICENSE, commit, local patch list, and test fixture
  hashes in a provenance file.

Exit: Java parses one public fixture and emits a bounded `Scene` model with no
React bridge and no external file write.

### N2 — native bitmap and vector scene construction

Goal: turn parsed content into a displayable page without `image-js`.

- Decode source PNG directly with Android `BitmapFactory` using bounds-first
  decode and a pixel cap; recycle bitmaps on page close.
- For Supernote encoded bitmap layers, port only the needed RLE/PNG conversion
  into Java. If a layer cannot be decoded, show a page-level unsupported error;
  never silently drop ink.
- Convert sampled strokes to Android `Path` and `Paint`; preserve vector
  contour, centreline, width, color, erase cover, writeOrder, and zOrder.
- Build the final composite in z-order. Keep at most current and next page.
- Optionally serialize the Scene to v1 SVG only in host tests so Java output
  can be compared byte-for-byte/semantically with PR 119 goldens. Do not send
  serialized SVG to React Native in normal operation.

Exit: NPK renders a static page matching a selected Node golden within an
explicit screenshot-diff threshold.

### N3 — strict v1 SVG-scene parser and Canvas player

Goal: replace the E0 hard-coded Canvas line in `OlaInkSvgDocumentView`.

- Implement a strict, DTD-disabled `XmlPullParser` for the documented v1
  subset only: root identity/viewBox, one metadata block, absolute M/L/Z paths,
  final contours, centerlines, erase covers, embedded PNGs, and known static
  objects.
- Reject unknown roles, duplicate/dangling IDs, malformed/non-finite paths,
  non-canonical data URIs, oversized XML/JSON/images, and invalid timing.
- Reuse the same Java `Scene` model for both direct-note construction and SVG
  parsing; Canvas never knows which source produced it.
- Implement `PathMeasure` centreline reveal, contour swap/fade fallback,
  real-time 1000 ms page hold, 1/2/5/10× speed, pause/resume, generation-based
  cancellation, and a 10 FPS `postDelayed` scheduler.

Exit: supplied valid v1 SVG scenes replay natively; malformed scenes fail
closed with a visible page error and no crash.

### N4 — bounded NPK document API

Goal: give E4 only UI-safe handles and metadata.

```text
openDecryptedNote(bytesHandle) -> documentHandle + public display summary
openSourceNote(sourceHandle)   -> documentHandle + public display summary
getPageSummary(documentHandle, index) -> page count/index + timing only
setActivePage(documentHandle, index)
setPlayback(documentHandle, paused|speed|restart)
releaseDocument(documentHandle)
```

- `bytesHandle` is supplied by native E2 decrypt; it is never a JS byte array.
- `sourceHandle` comes only from N0’s approved bridge.
- A document handle owns the current/next Scene cache and releases bitmaps,
  paths, plaintext buffers, and parser state on close.
- React Native passes handles and integers only; the native View receives the
  scene/document handle through a typed property, not an SVG string.

Exit: force-stop, view close, handle reuse, malformed input, and cancellation
leave no plaintext files and no stale scene visible after reopening.

### N5 — E4 integration, only after N0–N4 pass

- E2 inbox sync decrypts a record into a native bytes handle.
- NPK validates, parses, constructs a Scene, and accepts it before ACK.
- RN lists only current-session display metadata and drives the native player.
- Sending uses the approved N0 source handle and native E1 crypto; no note
  crosses React Native.
- Save Note uses a supported write grant and native atomic write.

## Measured stop conditions

Record numbers; do not raise caps to make a demo pass:

- 5 MiB whole note: first page visible in 3 s target.
- One 1 MiB scene equivalent: parse under 500 ms target.
- Current + next page: under 25 MiB incremental resident target, excluding the
  pre-existing PluginHost baseline.
- Ten open/close loops: no monotonic native/Dalvik heap growth.
- Any parser crash, missing ink/bitmap, unbounded allocation, or a native
  module exception that closes PluginHost is a failure.

The full browser/image-js attempt already failed this gate at 312 MiB native
PSS and more than 70 s for an 82 KiB fixture. It is retained as negative
E3 evidence, not as a fallback.

## Decision

This plan can prove functional native rendering, but it cannot overturn E1:
PluginHost’s shared Android Keystore and unauthenticated same-ID update
behavior remain a production replacement no-go. All identities/accounts and
fixtures remain disposable until Supernote provides a stronger security
boundary.
