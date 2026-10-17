import { ISupernote, IPage, ILayerNames } from './format.js';
import { IStroke, IStrokePoint } from './strokes.js';
/** How to render one decoded stroke -- see `deriveStrokeStyle`. For a
 * `'path'`, `color`/`width`/`tier` come directly from the stroke's own real
 * `TOTALPATH` metadata (`IStroke.color`/`thickness`/`pen`), not sampled from
 * a raster -- see https://github.com/philips/supernote-typescript/issues/56
 * and https://github.com/Walnut356/snlib for how that metadata was found.
 *
 * `'rect'` is a distinct record shape TOTALPATH itself encodes, not a style
 * choice: such a record's two points are a filled rectangle's opposite
 * corners rather than a pen path, and it says so in its own `stroke_kind`
 * (`IStroke.isFilledRect`). Having two points is *not* the test -- the
 * ruler tool and the odd two-sample ink stroke store two points too, and
 * treating those as rectangles drew a straight line as a filled box or
 * nothing at all.
 *
 * Unlike `'path'`, a rect's own `color`/`pen`
 * fields are *not* meaningful (confirmed against a real fixture with four
 * differently-colored heading backgrounds on one page: every one of their
 * 2-point records reads the same, uninformative `color` regardless of the
 * background's real, visibly different color). For a Heading's rect (the
 * common case), the real color lives losslessly in the `.note` footer's own
 * `TITLE_*` metadata instead -- see `findMatchingTitleStyle` -- so
 * `deriveStrokeStyle` looks that up first. Only a rect with no
 * matching `TITLE_*` entry (badges/highlight boxes, which aren't Headings)
 * falls back to sampling the page's own rendered ink for color/fill, the way
 * every stroke's style used to be sampled before real per-stroke metadata
 * was found: what fraction of the rectangle's own bounding box is already
 * real ink also separates a solid background (~97-99% filled) from a
 * diagonal cross-hatch one (~25%) -- both confirmed against Supernote's own
 * "Heading" feature, see
 * https://support.supernote.com/1759244-using-titles-keywords-and-stars.
 * `fill` records solid
 * vs. hatch so renderers can draw the latter as something visibly non-solid
 * instead of collapsing it to a solid block that would hide anything drawn
 * on top (confirmed on a real fixture: a hatched heading's own black label
 * text is the same color as the hatch, so a solid fill hides it entirely).
 *
 * `'path'`'s `tier` is `'marker'` exactly when the stroke's own real `pen`
 * field says `'marker'` -- it records the *tool*, not a fixed layer. Whether
 * a given marker stroke ends up beneath the page's other ink is decided per
 * stroke from what it actually crosses; see `isHighlighterPass`. */
export type StrokeStyle = {
    shape: 'path';
    color: string;
    width: number;
    tier: 'marker' | 'pen';
} | {
    shape: 'rect';
    color: string;
    fill: 'solid' | 'hatch';
} | {
    shape: 'skip';
};
/** Rings with fewer than 3 points enclose no area, so they'd render as
 * nothing at all -- dropped so a record left holding only degenerate rings
 * falls back to its centerline rather than emitting an invisible path. */
export declare const MIN_CONTOUR_RING_POINTS = 3;
/** Grey level of a `rgb(g,g,g)` ink color -- every color `parseStrokes`
 * produces is a grey, so the red channel alone orders them from black (0) to
 * white (254). */
export declare function greyLevel(color: string): number;
interface StrokeBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}
/** A stroke's own extent, from its sampled centerline or -- for a record
 * that has none, like the sticker plugin's silhouette -- its rendered
 * outline. `null` when the record carries no geometry at all. */
export declare function strokeBounds(stroke: IStroke): StrokeBounds | null;
export declare function boundsOverlap(a: StrokeBounds, b: StrokeBounds): boolean;
/**
 * Whether the marker-tool stroke at `index` is a *highlighter pass* -- a
 * wash the device paints beneath the ink already on the page -- rather than
 * a mark that covers what it crosses.
 *
 * The device settles this by darkness, not by tool: where a marker stroke
 * meets ink that is already darker than it, the darker ink stays on top.
 * Confirmed on the device's own renders of three fixtures, in both
 * directions:
 *
 * - `blank-a6x-3.15.27-shapes-rtr.note` page 1's "TEXT HIGHLIGHT"
 *   bands and `link-n6-3.26.40-partial-erase-3p.note` page 1's grey marker rows --
 *   grey marker records written *after* the black pen strokes they cross,
 *   which the device still draws with the black ink fully legible on top.
 * - `sticker-n5-20260016-plugin-artwork.note` page 2 -- a *black* marker line drawn across the sticker
 *   plugin's artwork, which the device draws over the top, hiding the
 *   sticker's own white detail strokes where the line crosses them (see
 *   https://github.com/philips/supernote-typescript/issues/82). Sorting
 *   every marker beneath every pen stroke is what got this backwards, and
 *   is why this is decided per stroke.
 *
 * White is the exception the darkness rule can't express: a white marker is
 * never a highlight, it's a cover-up, and the device draws it over whatever
 * it crosses -- `erase-n5-20260016-all-mechanisms.note` page 1 and `erase-n5-20260016-white-pen-cover.note` page 2 (white
 * marker over a black marker band) and `link-n6-3.26.40-partial-erase-3p.note`
 * page 1's white marker row (over black pen lines), all of which the device
 * renders as the white winning.
 *
 * Only ink recorded *before* this stroke is considered: anything recorded
 * after it already paints over it in record order, which is what the device
 * does too.
 */
export declare function isHighlighterPass(index: number, boundsList: (StrokeBounds | null)[], greys: number[], drawable: boolean[]): boolean;
/** A backend-independent drawing primitive for one piece of vector ink. */
export type VectorInkPrimitive = {
    kind: 'rect';
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    fill: 'solid' | 'hatch';
} | {
    kind: 'filledPath';
    rings: IStrokePoint[][];
    color: string;
} | {
    kind: 'strokedPath';
    points: IStrokePoint[];
    color: string;
    width: number;
};
/** Builds the ordered list of vector-ink primitives for a page. Strokes are
 * drawn in `TOTALPATH` buffer order, with two exceptions:
 *
 * - **`'rect'`s first.** A Heading's `'rect'` background record sits *after*
 *   the digit stroke it's meant to sit behind, so drawing it in place covers
 *   that ink entirely.
 * - **A highlighter pass beneath the rest.** A marker stroke lighter than
 *   ink it crosses is a wash under that ink even though its record comes
 *   later -- see `isHighlighterPass`.
 *
 * Relative order within each group still follows `strokes`. */
export declare function buildVectorInkPrimitives(strokes: IStroke[], styles: StrokeStyle[] | undefined): VectorInkPrimitive[];
/** A rectangle occupied by an object the file stores only in the ink bitmap,
 * not in TOTALPATH. Coordinates are in the page's native pixel space. */
export interface RasterInkRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * `DISABLE` is a pipe-separated list of `x,y,width,height` rectangles. On
 * recent N5 files it marks text boxes and Digests: their pixels are present
 * in MAINLAYER, but there are no corresponding TOTALPATH records to turn
 * into vector paths. Keep these regions rasterized when replacing the rest
 * of a page's ink with vectors.
 */
export declare function parseDisabledInkRects(disable: string | undefined): RasterInkRect[];
/** Raster-only regions that must remain when page `pageNumber` is vectorized.
 *
 * `DISABLE` covers text boxes and Digest excerpts. A Digest's separately
 * rendered PDF-link label sits immediately outside its `DISABLE` rectangle,
 * but is likewise absent from `TOTALPATH`. Links with `FONTSIZE > 0` are
 * those on-device typeset labels; ordinary link-tag rectangles use a zero
 * font size and can enclose genuine vector handwriting, so must not be
 * retained as a raster overlay. The first four characters of a `links` key
 * are the 1-indexed source page number (see `_parseLinks`). */
export declare function rasterInkRectsForPage(note: ISupernote, pageNumber: number): RasterInkRect[];
/** Returns `page` with vectorizable ink layers cleared. `DISABLE` text-box
 * and Digest rectangles remain as a compact raster overlay because the file
 * has no vector representation for their contents. */
export declare function withoutInkLayers(page: IPage, pageWidth: number, pageHeight: number, retainRasterInk?: boolean, rasterInkRects?: RasterInkRect[]): IPage;
export declare const INK_LAYER_NAMES: ILayerNames[];
/** A page's rendered ink, decoded once per page. Two uses: the fallback
 * source for a `'rect'` stroke's color/fill (see `deriveStrokeStyle`) when
 * it has no matching `TITLE_*` footer entry, and -- more fundamentally --
 * the only available record of which strokes were *erased*
 * (`strokeInkPresence`). */
export interface InkMask {
    /** 1 where that pixel (row-major, `y * pageWidth + x`) is real rendered
     * ink, 0 otherwise. */
    isInk: Uint8Array;
    inkPixelCount: number;
    /** RGB of each `isInk` pixel, 3 bytes per pixel at the same index * 3;
     * meaningless where `isInk` is 0. */
    colors: Uint8Array;
}
/** Decodes `page`'s ink layers (MAINLAYER/LAYER1-3) into one composited
 * `InkMask`, or `null` if the page has no ink layer data at all. */
export declare function buildInkMask(page: IPage, pageWidth: number, pageHeight: number): InkMask | null;
/**
 * What fraction of `stroke` still has matching ink in `mask`, the page's own
 * rendered output -- i.e. how much of it the device actually still draws.
 *
 * `displayColor` is the color the stroke is *rendered* in rather than
 * `IStroke.color`, because those differ for Heading label contrast (see
 * `applyHeadingContrastOverrides`).
 */
export declare function strokeInkPresence(stroke: IStroke, displayColor: string, mask: InkMask, pageWidth: number, pageHeight: number): number;
export declare function modeColor(colorCounts: Map<string, number>): string | undefined;
export declare function rectBounds(p0: IStrokePoint, p1: IStrokePoint, pageWidth: number, pageHeight: number): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
};
/** A Heading rect's real fill/text color, decoded from its `TITLE_*` footer
 * metadata instead of sampled from the raster. */
export interface TitleStyle {
    fill: 'solid' | 'hatch';
    backgroundColor: string;
    textColor: string;
}
/** Decodes an `ITitle.TITLESTYLE` value (7 decimal digits, `1BBBFFF`) into a
 * `TitleStyle` -- `BBB` is the background's grey level, `FFF` the displayed
 * label text's grey level. */
export declare function parseTitleStyle(titleStyle: string): TitleStyle;
/** One page's `TITLE_*` footer entries (Headings), reduced to their page-pixel
 * rect and decoded `TitleStyle`. */
export interface TitleRectEntry {
    x: number;
    y: number;
    width: number;
    height: number;
    style: TitleStyle;
}
/** `note.titles` is keyed by the footer's `TITLE_PPPPYYYYXXXX` suffix --
 * 4-digit page number, then the title's own `y`/`x` -- across the whole
 * note, not scoped per page, so filtering by the page-number prefix is how
 * one page's own Headings are found. */
export declare function buildTitleIndex(note: ISupernote, pageNumber: number): TitleRectEntry[];
export declare function findMatchingTitleStyle(titleIndex: TitleRectEntry[], p0: IStrokePoint, p1: IStrokePoint): TitleStyle | undefined;
export declare function sampleRect(mask: InkMask, pageWidth: number, pageHeight: number, p0: IStrokePoint, p1: IStrokePoint): {
    fillFraction: number;
    color: string | undefined;
};
/** Converts `IStroke.thickness` to a stroke-width in page pixels. */
export declare const THICKNESS_TO_PIXEL_SCALE = 100;
export declare function signedRingArea(ring: IStrokePoint[]): number;
export declare function polylineLength(points: IStrokePoint[]): number;
/**
 * The width to actually draw `stroke` at, in page pixels. See
 * `src/svg.ts`'s earlier doc comment for the derivation; this is the same
 * value used by the SVG vector-ink renderer.
 */
export declare function strokeRenderWidth(stroke: IStroke): number;
/**
 * Derives a `StrokeStyle` for one decoded stroke. See `StrokeStyle`'s doc
 * comment for details.
 */
export declare function deriveStrokeStyle(stroke: IStroke, mask: InkMask | null, titleIndex: TitleRectEntry[], pageWidth: number, pageHeight: number): StrokeStyle;
export declare function isInsideRectBounds(point: IStrokePoint, bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}): boolean;
/**
 * Supernote's Heading feature auto-recolors its label text for contrast
 * against the heading's own background. This applies that override to the
 * relevant `'path'` strokes.
 */
export declare function applyHeadingContrastOverrides(strokes: IStroke[], styles: StrokeStyle[], titleIndex: TitleRectEntry[], mask: InkMask | null, pageWidth: number, pageHeight: number): StrokeStyle[];
/** Scales a decoded stroke's `contour` by `factor`. `parseStrokes` transforms
 * `points` using the page dimensions it's handed, so passing upscaled
 * dimensions upscales them for free -- but `contour` arrives in the note's
 * native page space and has to be scaled here. */
export declare function withUpscaledContour(stroke: IStroke, factor: number): IStroke;
/** The vector-ink data prepared for one page. */
export interface VectorInkPage {
    pageNumber: number;
    /** Whether this page's raster ink should be replaced with the vector
     * primitives derived from `strokes`/`styles`. */
    useVectorInk: boolean;
    /** Decoded strokes, already scaled to the rendering coordinate space
     * (i.e. upscaled if requested). */
    strokes: IStroke[];
    /** A `StrokeStyle` for each stroke in `strokes`, in the same order. */
    styles: StrokeStyle[];
}
/**
 * Decodes the vector ink for each requested page and decides, per page,
 * whether the decoded strokes are trustworthy enough to replace the page's
 * rasterized ink layers. This is shared by the SVG and PDF renderers so both
 * make the same decision and draw the same strokes.
 */
export declare function prepareVectorInkPages(note: ISupernote, pageNumbers: number[] | undefined, upscale: number): VectorInkPage[];
/** Builds a copy of `note` with vectorizable ink layers removed for every
 * page where `prepareVectorInkPages` decided vector ink should replace the
 * raster ink. `DISABLE` text-box/Digest regions remain in this legacy
 * single-raster result; use `buildVectorInkBackgroundNote` together with
 * `buildRasterInkOverlayNote` when vector paths must remain beneath them. */
export declare function buildRenderNoteForVectorInk(note: ISupernote, vectorInkPages: VectorInkPage[]): ISupernote;
/** The template/background raster beneath vector ink. Raster-only text-box
 * and Digest pixels are deliberately excluded here so callers can paint them
 * over vector paths at their original layer order. */
export declare function buildVectorInkBackgroundNote(note: ISupernote, vectorInkPages: VectorInkPage[]): ISupernote;
/** A transparent raster containing only bitmap-only text-box/Digest ink for
 * vectorized pages. It must be painted after vector paths: some text lies on
 * top of a decoded marker/highlighter stroke in the original layer stack. */
export declare function buildRasterInkOverlayNote(note: ISupernote, vectorInkPages: VectorInkPage[]): ISupernote;
export {};
