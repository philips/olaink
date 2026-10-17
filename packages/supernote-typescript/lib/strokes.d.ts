/** A single point on a decoded pen stroke, already converted to page pixel
 * coordinates (same space as `ISupernote.pageWidth`/`pageHeight`). */
export interface IStrokePoint {
    x: number;
    y: number;
}
/** Pen tool a stroke was drawn with, decoded from `TOTALPATH`'s own per-stroke
 * `pen` field. Not every device tool has a confirmed id yet -- an
 * unrecognized numeric id is kept as `'unknown'` rather than guessed at (see
 * `parseStrokes`'s doc comment for how these were found). */
export type StrokePen = 'needlePoint' | 'inkPen' | 'marker' | 'calligraphy' | 'unknown';
/** One continuous pen stroke (a single pen-down-to-pen-up motion), decoded
 * from a page's `TOTALPATH` data -- including its real color, tool, and
 * thickness, not just geometry (see `parseStrokes`'s doc comment). */
export interface IStroke {
    points: IStrokePoint[];
    /** CSS `rgb(...)` color this stroke was actually drawn in on-device --
     * exact, not sampled from a raster. For an eraser stroke (`isEraser`),
     * this is always `rgb(255,255,255)` (white): `ERASER_COLOR`'s numeric
     * value happens to already be a valid (if reserved) grey level, so no
     * special-casing is needed to turn it into "paint over with white". */
    color: string;
    pen: StrokePen;
    /** Raw on-device thickness setting, in the same arbitrary device units
     * `TOTALPATH` itself uses (confirmed to order consistently with the
     * on-device width slider, but not confirmed to be linear in physical
     * units) -- scale like any other opaque magnitude, don't assume a
     * physical unit conversion. */
    thickness: number;
    /** True for a real eraser-tool motion (`TOTALPATH`'s reserved
     * `color === 255`), only ever present when `parseStrokes` was called
     * with `includeErasers: true` -- see that option's doc comment. Lets a
     * caller that draws strokes in order (`vectorInk` does) tell an
     * intentional "paint over with background" stroke apart from real ink
     * sharing the same white color (e.g. a white pen on a dark page), even
     * though both render identically. */
    isEraser?: boolean;
    /** The record's own `m_trailStatus` (`section_1`'s first `i32`, Ratta's
     * own name for what https://github.com/Walnut356/snlib calls `unk_8`),
     * present only when it is non-zero.
     *
     * **A non-zero value means the device no longer draws this record** --
     * this is the per-stroke visibility answer, read straight out of the
     * file rather than inferred from the page's raster. Confirmed against
     * Supernote's own vector PDF exports, which draw exactly the records
     * reading `0` and omit every marked one: `turkish-a6x-20230015-handwriting-erase.note` (152 of 189 ink
     * records live, 152 paths exported), `erase-n6-20230015-horizontal-1270.note` (61 of 82
     * live, 61 exported) and `link-n6-3.26.40-partial-erase-3p.note` page 3 (113
     * of 143, 113 exported).
     *
     * The value says *how* the record stopped being drawn. Codes seen
     * across the fixture corpus, each tied to a mechanism the fixture
     * itself documents (see plans/vector-format-spec.md for the evidence
     * per code):
     *
     * | Code | Meaning |
     * |---|---|
     * | `-2` | page cleared with no eraser or lasso record present (one instance; consistent with the binary's "CLEAN SCREEN" trail, unconfirmed) |
     * | `-3` | moved away by a lasso drag -- the ink now lives in a separate record at the new position |
     * | `-4` | **partially erased**: the surviving pieces follow as their own point-less, contour-only records (see `contour`) |
     * | `-16` | deleted via lasso-select-and-delete |
     * | `-99` | erased with the eraser tool, or otherwise removed whole |
     *
     * `-4` is the one code whose ink is still partly on the page, and the
     * surviving part is not this record: the device rewrites each surviving
     * fragment as a separate record with no `points` and its own `contour`,
     * stored immediately after this one. Drawing this record *and* those
     * would paint the erased part back in, so a renderer should skip every
     * record carrying a status and draw the fragments instead. That is what
     * the device itself does: its export of `link-n6-3.26.40-partial-erase-3p`
     * page 2 draws each erased line as exactly its own fragments, matching
     * their extents to the pixel, and never the line. */
    trailStatus?: number;
    /** True when this record is a filled rectangle -- a Heading or badge
     * background -- rather than a pen path, so its two points are opposite
     * corners of a box instead of the ends of a line. Read from the record's
     * own `stroke_kind` (`"0001"`).
     *
     * Having exactly two points is *not* the test, which is what this field
     * exists to correct: the ruler/straight-line tool also stores two points
     * (`stroke_kind: "straightLine"`), and so does the occasional ordinary
     * two-sample ink stroke (`"others"`). Across every fixture `stroke_kind`
     * separates all three cleanly -- 10 rectangles, 8 straight lines and 2
     * short ink strokes, with no overlap -- where counting points alone
     * turned each of `line-n5-20260016-ruler-tool.note`'s lines into either a filled box
     * or nothing at all. */
    isFilledRect?: boolean;
    /** True for the Stars feature's star mark, read from the record's own
     * `stroke_kind` (`"fiveStarsSignal"`) -- see `STAR_MARK_STROKE_KIND`,
     * which is also why such a stroke's `pen` is `'unknown'`. Ordinary ink
     * as far as rendering goes; the flag exists so a caller can tell that
     * this one's tool is genuinely unrecoverable rather than merely
     * unrecognized. */
    isStarMark?: boolean;
    /** The device's own rendered outline of this stroke (`point_contour` in
     * https://github.com/Walnut356/snlib) -- closed polygons, only present
     * when `parseStrokes` was called with `includeContours: true`.
     *
     * Stored by the device as absolute pixels in the note's own *native*
     * page space, so unlike `points` these are not re-derived from the
     * `pageWidth`/`pageHeight` handed to `parseStrokes`: the two share a
     * coordinate space only when those are the note's real dimensions.
     * Scale them yourself if you decode against scaled dimensions (`toSvg`
     * does, in `withUpscaledContour`).
     *
     * Unlike `points` (the pen's sampled *centerline*, which has to be
     * stroked at a uniform `thickness` to be drawn), this is the filled
     * region the device actually renders, so it carries the real
     * pressure-varying width along the stroke -- the same thing Supernote's
     * newer PDF exports draw as filled Bezier outlines rather than
     * fixed-width polylines. Usually one polygon; a stroke that crosses
     * itself can produce several, which is why this is an array of rings
     * (fill them with the nonzero winding rule, as SVG/PDF do by default).
     *
     * Verified against real fixtures on two device families: each ring's
     * bounding box matches its stroke's own transformed point extents
     * inflated by half the rendered width, and the enclosed area comes out
     * within a few percent of `pathLength * thickness / 100`.
     *
     * **A stroke's own outline is not a record of what survived erasing.**
     * An erased stroke keeps its full-area outline here, byte for byte like
     * a visible one -- what says it is gone is `trailStatus`, not this. The
     * one place a contour *does* carry surviving geometry is the point-less
     * records the device writes after a partially erased (`trailStatus`
     * `-4`) stroke: each holds one surviving fragment as a contour and
     * nothing else. See `ERASER_COLOR`'s doc comment and
     * plans/vector-format-spec.md's erase-records section. */
    contour?: IStrokePoint[][];
}
/**
 * Decodes a page's `TOTALPATH` buffer into pen strokes in page pixel space,
 * including each stroke's real color, tool, and thickness -- not sampled or
 * estimated, read directly from the same per-stroke metadata Supernote's own
 * software writes.
 *
 * `TOTALPATH` is undocumented (not covered by any known open-source
 * Supernote parser) and this decode was arrived at by reverse-engineering
 * real `.note` files rather than from a spec -- see
 * https://github.com/philips/supernote-typescript/issues/55 for the
 * original geometry investigation. An earlier version of this module found
 * stroke boundaries by brute-force byte-by-byte scanning for a
 * self-checksumming record shape, because that investigation never found
 * where (or whether) `TOTALPATH` stored anything beyond point coordinates --
 * confirmed exhaustively at the time by comparing strokes drawn with
 * different tools/colors/widths and finding identical bytes near each
 * record. That conclusion turned out to be an artifact of only ever looking
 * a few dozen bytes around a stroke's coordinate data: an independent Rust
 * implementation, https://github.com/Walnut356/snlib, documents a complete,
 * deterministic outer structure this module now follows instead:
 *
 * ```
 * u32 strokeCount
 * for each of strokeCount strokes:
 *   u32 strokeLen              // byte length of everything below, this stroke only
 *   StrokeConfig (208 bytes)   // pen, color, thickness, and ~20 other fields, most still unconfirmed
 *   disable_area_list          // u32 count + count*24 bytes, almost always empty
 *   points                     // u32 count + count*8 bytes -- (y, x) uint32 pairs
 *   ...more length-prefixed sections this module doesn't need and skips
 *      via strokeLen, not by parsing them (pressures, tilts, a nested
 *      per-point contour list, several sections of still-unconfirmed
 *      fixed-size fields, and more -- see snlib's `Stroke` struct for the
 *      full list, none of it needed for color/tool/thickness/geometry)
 * ```
 *
 * `strokeLen` alone is enough to always advance to the next real stroke
 * correctly, regardless of whether every field in between is understood --
 * unlike the old byte-scanning approach, this can't drift into a stroke's
 * own inner arrays (e.g. its nested contour-point list) and misread real,
 * structured-but-unrelated bytes as an independent phantom stroke (the root
 * cause of `rtr-n5-20230015-recognition.note`'s circular phantom stroke from the pre-fix
 * investigation in issue #56 -- there is no such stroke in the real
 * structure at all).
 *
 * `TOTALPATH`'s own address (`getContentAtAddress`, in `parsing.ts`) already
 * strips one length prefix, so `totalPathBuffer[0..4]` is `strokeCount`
 * directly, not `strokeCount`'s own length prefix again.
 *
 * The coordinate transform (confirmed pixel-exact against rendered ink on
 * multiple device families):
 * ```
 * scale = screenHeight / pageHeight   // screenHeight: this stroke's own StrokeConfig field
 * pixelX = -rawX / scale + pageWidth
 * pixelY =  rawY / scale
 * ```
 *
 * `screenHeight` is the page's EMR (digitizer hardware) max range, not a
 * pixel count -- independently confirmed against Ratta's published EMR
 * docs (https://docs.supernote.com/en/plugin-base/coordinate-system,
 * issue #111); see plans/vector-format-spec.md's "Cross-check against
 * Supernote's published EMR docs".
 *
 * Strokes whose `color` is `255` are excluded by default, not returned as
 * `IStroke`s -- see `ERASER_COLOR`'s doc comment: they're real pen motions
 * (Supernote's eraser is a physical gesture like any other tool), just never
 * meant to render as ink *themselves*. This is what `erase-n6-20230015-horizontal-1270.note`'s
 * phantom scribbles actually were: real eraser strokes, exactly identifiable
 * by this one field, not a decode bug and not something raster
 * cross-checking ever needed to guess at. Pass `includeErasers: true` (see
 * `ERASER_COLOR`'s doc comment) to keep them instead, as ordinary white
 * `isEraser: true` strokes, needed to reproduce a *partial* erase's visual
 * effect when drawing strokes in `TOTALPATH`'s own order.
 *
 * Strokes whose `stroke_kind` is `"0000"` are excluded unconditionally (no
 * `includeErasers`-style opt-in) -- see `LINK_TAG_STROKE_KIND`'s doc
 * comment: a link-tag indicator box, not ink, confirmed against
 * `link-n6-3.26.40-partial-erase-3p.note`'s own footer `LINK_*` metadata.
 *
 * Select gestures are excluded unconditionally too -- the loop drawn to
 * lasso-select content (for deletion, moving, or Keyword/Tag creation),
 * never rendered by the device. These are identified by the record-class
 * field rather than by pen id; see `RECORD_CLASS`, which is also what tells
 * a select apart from an erase when the two are otherwise identical.
 *
 * Returns `[]` if `totalPathBuffer` is `null`, too short to hold a single
 * stroke, or its layout isn't recognized (e.g. a genuinely blank page, or a
 * page whose `TOTALPATH` uses a structure this hasn't been validated
 * against yet).
 */
export interface ParseStrokesOptions {
    /** See `parseStrokes`' own doc comment and `ERASER_COLOR`'s. Default
     * false, matching every existing caller's assumption that `parseStrokes`
     * returns only real, visible ink. */
    includeErasers?: boolean;
    /** Also decode each stroke's rendered outline into `IStroke.contour` --
     * see that field's doc comment. Default false: it's several times more
     * geometry than `points`, and only a caller that actually fills the
     * outline (rather than stroking the centerline) needs it. */
    includeContours?: boolean;
}
export declare function parseStrokes(totalPathBuffer: Uint8Array | null, pageWidth: number, pageHeight: number, options?: ParseStrokesOptions): IStroke[];
