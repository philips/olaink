/** Raw pen tool ids observed in `TOTALPATH`'s `pen` field -- reverse
 * engineered against `stroke-n5-20260016-isolation-tools-colors-widths.note` (which isolates one tool per
 * stroke) and cross-referenced against
 * https://github.com/Walnut356/snlib/blob/main/src/pen.rs, an independent
 * Rust implementation with a matching (if only partially enumerated) `Pen`
 * enum. `10`/`11` match that enum's `NeedlePoint`/`Marker` exactly; `16` is
 * this repo's own finding (unconfirmed against snlib, which doesn't list a
 * value for `InkPen`), consistently seen wherever a stroke's tool is known
 * to be the ink pen. Any other id maps to `'unknown'` rather than a guess.
 *
 * `15` is the calligraphy pen: `caligraphy-n5-20260016-widths-erase.note` (named for the tool)
 * carries 59 ink strokes and every one of them reads 15 -- its only other
 * records are eraser and lasso gestures -- as does `stroke-n5-20260016-isolation-tools-colors-widths.note`
 * page 2's calligraphy stroke. One id, not several.
 *
 * `5` is the marker again, under the id older firmware used for it -- see
 * `STAR_MARK_STROKE_KIND` for the one other thing that lands in this slot.
 * Ratta's own engine (`flutter_note_lib.dll`, see
 * plans/vector-format-spec.md Part 1.4) treats `5` and `11` as the same
 * tool in both places it distinguishes tools at all: the routine that
 * rewrites a stroke's color into its marker variant (`0 -> 1`, `48 -> 49`,
 * `80 -> 81`) runs for `penType == 5 || penType == 11` and nothing else,
 * and `getRecognDataPointerEventWithFile`, which feeds handwriting
 * recognition, skips `penType` `4`, `5` and `11` -- the lasso and both
 * marker ids. The fixtures agree: `test-a5x-20220011-old-pen-ids.note` is the only
 * `SN_FILE_VER_20220011` (A5X) file here, its ink pen is `1` rather than
 * `16`, and its three `pen=5` strokes carry color `81` -- the marker form
 * of `80` -- at thickness 1500, rendering in the page's own raster as wide
 * grey highlighter bands over the black handwriting. No fixture contains
 * both `5` and `11`, which is what an id superseded across a firmware
 * generation looks like -- the same pattern as `1` -> `16` for the ink pen. */
const PEN_IDS = {
    10: 'needlePoint',
    16: 'inkPen',
    11: 'marker',
    5: 'marker',
    15: 'calligraphy',
};
/** Grey `color` values that older firmware stored as *ids* rather than as
 * the grey level they render at, mapped to the levels current firmware
 * stores directly. Only `.note` files old enough to predate the change use
 * them -- here, only `test-a5x-20220011-old-pen-ids.note` (`SN_FILE_VER_20220011`, A5X).
 *
 * Without this a stroke's color is simply wrong: `48` is dark grey, not the
 * near-black `rgb(48,48,48)` reads as. Supernote's own vector export of
 * that fixture (`test-a5x-20220011-old-pen-ids.pdf`) settles which grey each id means, the same
 * ground truth the canonical 157/201 palette comes from. Its page 1 draws
 * exactly three ink colors, and each one's paths land on one of our
 * decoded color groups with nothing left over:
 *
 * | our `color` | device draws | extents agree to | our points inside it |
 * |---|---|---|---|
 * | `0` (34 strokes) | `0` | 0-2 px | 100% |
 * | `48` (21 strokes) | **157** | 0-2 px | 100% |
 * | `81` (3 strokes) | **201** | 14-16 px, i.e. the band's own half width | 100% |
 *
 * The `+1` marker forms (`49`, `81`) map to the `+1` forms of the same
 * greys, keeping that rule (see `PEN_IDS`) true in both encodings -- the
 * device's export draws a marker at the base grey either way, exactly as it
 * does for a modern marker storing 158/202. Only `48` and `81` occur in any
 * fixture; `49` and `80` are their unobserved counterparts, included
 * because leaving half of a pair out would decode one marker correctly and
 * its pen wrongly.
 *
 * Applied unconditionally rather than gated on the file version, which
 * `parseStrokes` never sees -- it is handed a `TOTALPATH` buffer, not the
 * header. Safe because these four values are not grey levels any firmware
 * stores: the real palette is 0/157/158/201/202/254, plus 255 for the
 * eraser. A color device could in principle put a literal 48 here, which is
 * the one thing that would need the version gate. */
const LEGACY_GREY_IDS = {
    48: 157,
    49: 158,
    80: 201,
    81: 202,
};
/** Reserved `color` value meaning "this isn't ink at all, it's an eraser
 * stroke" -- confirmed against https://github.com/Walnut356/snlib's `Color`
 * enum (`Eraser = 255`) and directly against real fixtures: the exact
 * strokes that used to decode as smooth-but-nonexistent phantom ink in
 * `erase-n6-20230015-horizontal-1270.note` (see issue #56) carry this color. By default,
 * `parseStrokes` filters these out entirely -- they're real,
 * correctly-decoded pen motions, just not strokes that were ever meant to
 * render as visible ink themselves (Supernote's eraser tool is itself a
 * physical pen motion the digitizer records like any other).
 *
 * That default is right for "give me this page's real ink", but wrong for
 * reproducing what the page actually *looks like*: dropping these strokes
 * silently un-does every *partial* erase (dragging the eraser tool over
 * part of some real ink, as opposed to a whole-stroke select-and-delete,
 * which leaves no TOTALPATH trace at all and needs no special handling
 * here) -- the ink an eraser stroke was meant to cover stays in TOTALPATH
 * exactly as originally drawn, at its real pre-erase color, since the erase
 * is recorded as its own later, separate stroke rather than as an edit to
 * the ink it covers. `parseStrokes`' `includeErasers` option keeps these
 * strokes instead (as ordinary white `isEraser: true` ink, since
 * `ERASER_COLOR` already *is* a valid white grey level), so a caller that
 * draws every stroke in `TOTALPATH`'s own order paints over the erased ink
 * with white the same way the real device does, rather than leaving it
 * fully visible. Confirmed directly against `erase-n6-20230015-horizontal-1270.note` and
 * `link-n6-3.26.40-partial-erase-3p.note` (whose "ERASER on MARKER"/"ERASER on PEN
 * LINES" fixture rows exist specifically to exercise this): each eraser
 * stroke's own record sits immediately after, and closely traces the
 * shape/bounds of, the ink it was dragged over. */
const ERASER_COLOR = 255;
/** Reserved `stroke_kind` value (see `STROKE_CONFIG.STROKE_KIND_OFFSET`)
 * meaning "this is a link-tag indicator box, not ink" -- confirmed directly
 * against `link-n6-3.26.40-partial-erase-3p.note` (named for exactly this
 * feature): every 5-point `stroke_kind: "0000"` record's bounding box
 * matches one of the note's own footer `LINK_*` entries' `LINKRECT`
 * pixel-exact, the same way a `TITLE_*` entry's `TITLERECT` matches a
 * Heading's 2-point rect record (see `plans/vector-format-spec.md`'s
 * `TITLE_`/`KEYWORD_` section). Never shown in the page's own rendered ink
 * -- it's a UI affordance marking a link's source region, not something the
 * user drew -- so `parseStrokes` excludes it unconditionally, the same as
 * an eraser stroke's own motion path, just without an `includeErasers`-style
 * opt-in: unlike an eraser, there's no legitimate reason to want this
 * rendered as ink. Distinct from `"0001"`, the 2-point rect `stroke_kind`
 * (a Heading/badge background fill, see `TitleStyle` in `src/svg.ts`) --
 * that one *is* handled specially precisely because its `TITLE_*`-derived
 * fill is real, intended content. */
const LINK_TAG_STROKE_KIND = '0000';
/** `stroke_kind` of a filled-rectangle record -- a Heading or badge
 * background, whose two points are opposite corners rather than a pen path
 * (see `IStroke.isFilledRect`). */
const FILLED_RECT_STROKE_KIND = '0001';
/** `stroke_kind` of the Stars feature's star mark (see
 * https://support.supernote.com/1759244-using-titles-keywords-and-stars).
 * Real, user-created content that renders like any other ink -- unlike
 * `LINK_TAG_STROKE_KIND`, it is not filtered out.
 *
 * It gets its own flag because the device overwrites the record's `pen`
 * field for it, so that field can't be trusted here: Ratta's own engine
 * (see `PEN_IDS`) walks every trail on save and, for each one whose
 * `predictName` -- this field -- equals `fiveStarsSignal`, stores `5` into
 * `penType` and `100` into `m_thickness`. Both stores are visible in
 * `flutter_note_lib.dll` at `0x180092f3c` and `0x1800bcc29`, and the one
 * star record in the fixtures
 * (`blank-a6x-3.15.27-shapes-rtr.note` page 1) reads exactly
 * `pen=5, thickness=100`. Whatever tool the user had selected is gone, so
 * `parseStrokes` reports `'unknown'` for a star rather than the `'marker'`
 * `5` would otherwise decode to -- the id is real, it just isn't this
 * record's tool. */
const STAR_MARK_STROKE_KIND = 'fiveStarsSignal';
/** `pen` id of a lasso/selection path. This used to be how such records were
 * identified; `RECORD_CLASS.LASSO` is now, because it states the record's
 * kind rather than inferring it from a pen id that firmware reuses across
 * tools (`pen === 1` is both the older ink pen and the Nomad-era eraser).
 *
 * It is still tested, for one specific record: `sticker-n5-20260016-plugin-artwork.note` page 1's last
 * record is not a stroke at all. Its `StrokeConfig` reads
 * `screenHeight: 120` on a 2560-tall page, `thickness: 0`, zero points, and
 * a `color` of 2012028940 -- the bytes are sticker data being read through
 * the wrong struct (see #68). It happens to land `4` in the `pen` slot, so
 * the old test dropped it by accident, while the record-class test keeps it
 * (its class slot reads a perfectly ordinary `5000`) and would emit
 * `rgb(2012028940,...)`, an invalid CSS color. Keeping both conditions costs
 * nothing and holds output identical until sticker records are understood
 * properly. */
const LASSO_PEN_ID = 4;
/** Byte layout of the fixed-size header (`StrokeConfig` in
 * https://github.com/Walnut356/snlib) every stroke record starts with.
 * Offsets confirmed against real fixtures: `DOC_KIND_OFFSET` is exactly
 * where the byte string `superNoteNote` (this module's previous scanning
 * landmark) is found on every real stroke checked. Only the fields this
 * module actually reads are named; the rest of the 208-byte header
 * (recognition-mode flags, font height, bounding box, screen width, and
 * more, all still unconfirmed) is skipped over as a fixed span. */
const STROKE_CONFIG = {
    PEN_OFFSET: 0,
    COLOR_OFFSET: 4,
    THICKNESS_OFFSET: 8,
    /** 52-byte C string -- Ratta's own name for it is `predictName` (see
     * plans/vector-format-spec.md Part 1.4). Real ink always reads
     * `"others"`; the special values this module checks for are
     * `LINK_TAG_STROKE_KIND` (`"0000"`), `FILLED_RECT_STROKE_KIND`
     * (`"0001"`, a 2-point rect record) and `STAR_MARK_STROKE_KIND`
     * (`"fiveStarsSignal"`, still real user-drawn ink). */
    STROKE_KIND_OFFSET: 48,
    STROKE_KIND_SIZE: 52,
    /** In the same device units `parseStrokes`' `scale` divides through --
     * this is the field the previous version of this module already relied
     * on for the same purpose, under the name `nativeHeightBound`, before
     * this byte layout was known (found back then via a
     * `superNoteNote`-relative offset instead of `StrokeConfig`'s own).
     *
     * Cross-validated against Ratta's published EMR docs
     * (https://docs.supernote.com/en/plugin-base/coordinate-system, issue
     * #111): this is the page's EMR max range, and reads exactly the values
     * the doc's page-size -> EMR table lists for every current Nomad/Manta
     * fixture (~8.45 units/px). Older A5X firmware reads a larger, different
     * range not in that table, so the per-stroke field stays authoritative.
     * See plans/vector-format-spec.md "Cross-check against Supernote's
     * published EMR docs". */
    SCREEN_HEIGHT_OFFSET: 128,
    DOC_KIND_OFFSET: 136,
    /** See `RECORD_CLASS`. Documented as a constant `5000` by
     * https://github.com/Walnut356/snlib (as `unk_5`) -- it isn't. */
    RECORD_CLASS_OFFSET: 40,
    SIZE: 208,
};
/** What kind of thing a stroke record *is*, read as an `i32` from
 * `STROKE_CONFIG.RECORD_CLASS_OFFSET`. snlib documents this field as a
 * constant `5000` (`unk_5`); it isn't. Every record in every `.note`
 * fixture (2,601 of them, across every device family and firmware here)
 * falls into exactly one of four groups:
 *
 * | Value | Records | What |
 * |---|---|---|
 * | `5000` | 2514 | real ink -- every pen, every color, including white |
 * | `0` | 22 | geometry derived from two points: a Heading background (`"0001"`), a link-tag box (`"0000"`), or a ruler line (`"straightLine"`) |
 * | `-1`, `-2`, `-4` | 46 | an eraser gesture (three tool modes/eras) |
 * | `-5` | 19 | a lasso selection path |
 *
 * The eraser/lasso split is exact: `-5` holds every `pen === 4` record and
 * nothing else, which is why it can replace that test. It is also the
 * durable form of it -- firmware reuses pen ids across tools (`pen === 1`
 * is both the older ink pen and the Nomad-era eraser), whereas this field
 * states the record's kind directly.
 *
 * **What this field does not do** is say whether an erase gesture actually
 * erased anything. That was the hope -- Supernote's own engine classifies
 * trails as `TRAIL_ERASE_AREA` / `ERASE_LINE_COLOR_VALUE` / `CLEAN SCREEN`
 * / `this is region selection trail` / `trail ERASER select:` as it
 * replays them, so some discriminator exists -- but it is not this one.
 * `erase-n5-20260016-all-mechanisms.note`, which exercises every erase mechanism, carries genuine
 * erasers at `-4`, while `link-n6-3.26.40-partial-erase-3p.note` page 3's `-4`
 * records sit on top of fully visible keyword text and erased nothing. Same
 * class, opposite outcome. So this identifies the *tool*, never the
 * *result*, and a geometric erase replay still cannot be driven from it. */
const RECORD_CLASS = {
    INK: 5000,
    /** A lasso/selection *path* -- the loop a user draws to select content
     * (then delete it, move it, or turn it into a Keyword/Tag). Not ink, and
     * never rendered by the device, so it is excluded unconditionally like
     * `LINK_TAG_STROKE_KIND`: whatever the selection *did* is not recoverable
     * from the record (see plans/vector-format-spec.md's erase-records
     * section), but the loop itself is never visible content either way.
     *
     * Holds exactly the records that previously matched `pen === 4` -- all
     * reading `color: 0`, `thickness: 200`, and frequently recorded as two
     * byte-identical consecutive records. That those are never rendered was
     * established against every fixture that has one: `erase-n5-20260016-all-mechanisms.note` (a
     * lasso-select-then-delete; the loop is absent from both the device
     * raster and `erase-n5-20260016-all-mechanisms.pdf`, Supernote's own export),
     * `link-n6-3.26.40-partial-erase-3p.note` page 3 (keyword/tag-creation
     * selections around fully-visible words -- rendering these drew phantom
     * black circles around the text), and `color-n6-20230015-unknown-palette.note` (a path with
     * ~0% presence in the page's own rendered ink).
     *
     * Holds every real lasso path, and `pen === 4` holds the same set plus
     * exactly one record that isn't a lasso -- see `LASSO_PEN_ID`. */
    LASSO: -5,
};
/** Sizes of the two fixed-layout sections that sit between `epa_grays` and
 * `point_contour` in a stroke record -- `Section1` and `Section2` in
 * https://github.com/Walnut356/snlib, whose declared field lists come out
 * to different totals than these. Solved directly instead: the only
 * `(Section1, Section2)` pair that makes *every* record on a page parse
 * byte-exactly, jointly across pages from two device families (N5/Manta
 * `erase-n5-20260016-no-white-pen.note`, and the older `erase-n6-20230015-horizontal-1270.note`). The
 * resulting contour geometry then independently validates -- see
 * `IStroke.contour`. Only the span sizes matter here; nothing in either
 * section is read. */
const SECTION_1_SIZE = 52;
const SECTION_2_SIZE = 10;
/** Decodes a fixed-size, NUL-padded C string field (`stroke_kind`/`doc_kind`
 * -- see `STROKE_CONFIG`) -- trims at the first NUL rather than including
 * the trailing padding bytes as part of the string. */
function readFixedCString(view, pos, size) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, size);
    const nul = bytes.indexOf(0);
    return new TextDecoder('utf8').decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}
/** Reads the `point_contour` rings that follow a stroke's `epa_grays`
 * array, starting at `pos` (the first byte after it) -- see
 * `IStroke.contour` for what they are and `SECTION_1_SIZE` for how the two
 * fixed sections in between were sized. Returns `undefined` rather than
 * throwing if anything doesn't line up (a truncated record, or a firmware
 * whose section sizes differ), so an unrecognized layout costs the caller
 * only the contour, never the stroke.
 *
 * Unlike `points`, contour coordinates are stored as float32 pairs already
 * in final page-pixel space -- no `screenHeight` scaling and no x mirroring
 * (confirmed by matching them against transformed stroke extents on both a
 * portrait and a landscape fixture). */
function readContour(view, byteLength, pos, strokeEnd) {
    let p = pos + SECTION_1_SIZE;
    if (p + 4 > strokeEnd)
        return undefined;
    const controlNumCount = view.getUint32(p, true);
    p += 4 + controlNumCount * 4 + SECTION_2_SIZE;
    if (p + 4 > strokeEnd)
        return undefined;
    const ringCount = view.getUint32(p, true);
    p += 4;
    if (ringCount > MAX_CONTOUR_RINGS)
        return undefined;
    const rings = [];
    for (let i = 0; i < ringCount; i++) {
        if (p + 4 > strokeEnd)
            return undefined;
        const pointCount = view.getUint32(p, true);
        p += 4;
        if (p + pointCount * 8 > strokeEnd || p + pointCount * 8 > byteLength)
            return undefined;
        const ring = new Array(pointCount);
        for (let j = 0; j < pointCount; j++) {
            const offset = p + j * 8;
            ring[j] = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true) };
        }
        rings.push(ring);
        p += pointCount * 8;
    }
    return rings;
}
/** Sanity cap on `point_contour`'s ring count, so a misaligned read on an
 * unvalidated firmware bails out instead of trying to allocate a bogus
 * array. Real strokes use one ring, occasionally a handful where the stroke
 * crosses itself. */
const MAX_CONTOUR_RINGS = 1000;
/** Reads one stroke record starting at `pos` (immediately after its own
 * `strokeLen` prefix -- see `parseStrokes`), or `null` if there isn't
 * enough buffer left to hold at least a full `StrokeConfig` header plus an
 * empty `disable_area_list`/`points` pair. Never throws on a truncated or
 * corrupt tail -- returns `null` so the caller can stop cleanly rather than
 * crash on a real file this hasn't been validated against. */
function tryParseStroke(view, byteLength, pos, strokeEnd, includeContours) {
    if (pos + STROKE_CONFIG.SIZE + 8 > byteLength)
        return null;
    const pen = view.getUint32(pos + STROKE_CONFIG.PEN_OFFSET, true);
    const color = view.getUint32(pos + STROKE_CONFIG.COLOR_OFFSET, true);
    const thickness = view.getUint32(pos + STROKE_CONFIG.THICKNESS_OFFSET, true);
    const strokeKind = readFixedCString(view, pos + STROKE_CONFIG.STROKE_KIND_OFFSET, STROKE_CONFIG.STROKE_KIND_SIZE);
    const screenHeight = view.getUint32(pos + STROKE_CONFIG.SCREEN_HEIGHT_OFFSET, true);
    if (screenHeight === 0)
        return null;
    const recordClass = view.getInt32(pos + STROKE_CONFIG.RECORD_CLASS_OFFSET, true);
    let p = pos + STROKE_CONFIG.SIZE;
    // disable_area_list: length-prefixed array of 3-ScreenCoord entries (24
    // bytes each), almost always empty in practice -- still real length data
    // to skip past, not a fixed gap.
    if (p + 4 > byteLength)
        return null;
    const disableAreaCount = view.getUint32(p, true);
    p += 4 + disableAreaCount * 24;
    if (p + 4 > byteLength)
        return null;
    const pointCount = view.getUint32(p, true);
    p += 4;
    if (p + pointCount * 8 > byteLength)
        return null;
    const points = new Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
        const offset = p + i * 8;
        // ScreenCoord stores (y, x) in that order, not (x, y) -- see
        // parseStrokes' doc comment for the coordinate transform this feeds.
        points[i] = [view.getUint32(offset, true), view.getUint32(offset + 4, true)];
    }
    p += pointCount * 8;
    // pressures (u16), tilts (4 bytes each), flag_draw (1 byte each),
    // epa_points (8), epa_grays (4) -- all length-prefixed, all skipped
    // wholesale; Section1 (and so the erase mark) begins immediately after.
    for (const elementSize of [2, 4, 1, 8, 4]) {
        if (p + 4 > strokeEnd)
            return { pen, color, thickness, strokeKind, screenHeight, recordClass, points, trailStatus: 0 };
        p += 4 + view.getUint32(p, true) * elementSize;
    }
    // section_1 starts here: m_trailStatus, then m_copy -- the latter holds
    // the tool/operation ids catalogued in plans/vector-format-spec.md, which
    // nothing needs to decode, since m_trailStatus states per stroke what
    // each of those operations did to it.
    const trailStatus = p + 4 <= strokeEnd ? view.getInt32(p, true) : 0;
    const contour = includeContours ? readContour(view, byteLength, p, strokeEnd) : undefined;
    return { pen, color, thickness, strokeKind, screenHeight, recordClass, points, trailStatus, contour };
}
export function parseStrokes(totalPathBuffer, pageWidth, pageHeight, options = {}) {
    if (!totalPathBuffer || totalPathBuffer.length < STROKE_CONFIG.SIZE || pageHeight <= 0 || pageWidth <= 0)
        return [];
    const view = new DataView(totalPathBuffer.buffer, totalPathBuffer.byteOffset, totalPathBuffer.byteLength);
    const byteLength = totalPathBuffer.length;
    const strokeCount = view.getUint32(0, true);
    if (strokeCount === 0 || strokeCount > 1_000_000)
        return [];
    const strokes = [];
    /** `at` is how many strokes had already been emitted when the loop was
     * recorded, so everything before that index preceded it on the page. */
    let pos = 4;
    for (let i = 0; i < strokeCount; i++) {
        if (pos + 4 > byteLength)
            break;
        const strokeLen = view.getUint32(pos, true);
        const strokeStart = pos + 4;
        const strokeEnd = strokeStart + strokeLen;
        if (strokeLen === 0 || strokeEnd > byteLength)
            break;
        const raw = tryParseStroke(view, byteLength, strokeStart, strokeEnd, options.includeContours === true);
        const isEraser = raw?.color === ERASER_COLOR;
        const isLinkTag = raw?.strokeKind === LINK_TAG_STROKE_KIND;
        // `RECORD_CLASS.LASSO` is the durable test -- it states the record's
        // kind, rather than inferring it from a pen id firmware reuses across
        // tools. The `pen` check is kept alongside it, and deliberately: see
        // `LASSO_PEN_ID`, which is no longer really "the lasso test" so much
        // as a guard against one record in `sticker-n5-20260016-plugin-artwork.note` whose StrokeConfig
        // isn't a StrokeConfig at all.
        const isLassoPath = raw?.recordClass === RECORD_CLASS.LASSO || raw?.pen === LASSO_PEN_ID;
        const isStarMark = raw?.strokeKind === STAR_MARK_STROKE_KIND;
        if (raw && !isLinkTag && !isLassoPath && (!isEraser || options.includeErasers)) {
            const scale = raw.screenHeight / pageHeight;
            // An older file stores some greys as ids -- see LEGACY_GREY_IDS.
            // Read after the isEraser test above, which keys on the reserved
            // 255 this never touches.
            const grey = LEGACY_GREY_IDS[raw.color] ?? raw.color;
            strokes.push({
                points: raw.points.map(([y, x]) => ({ x: -x / scale + pageWidth, y: y / scale })),
                color: `rgb(${grey},${grey},${grey})`,
                // A star mark's `pen` was overwritten by the device and names
                // no tool -- see `STAR_MARK_STROKE_KIND`.
                pen: isStarMark ? 'unknown' : (PEN_IDS[raw.pen] ?? 'unknown'),
                thickness: raw.thickness,
                ...(isEraser ? { isEraser: true } : {}),
                ...(raw.trailStatus !== 0 ? { trailStatus: raw.trailStatus } : {}),
                ...(raw.strokeKind === FILLED_RECT_STROKE_KIND ? { isFilledRect: true } : {}),
                ...(isStarMark ? { isStarMark: true } : {}),
                ...(raw.contour ? { contour: raw.contour } : {}),
            });
        }
        pos = strokeEnd;
    }
    return strokes;
}
