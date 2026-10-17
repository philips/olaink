import { Image } from 'image-js';
import { IPdfPage } from './conversion.js';
import { ISupernote } from './format.js';
import { IStroke } from './strokes.js';
import { StrokeStyle } from './vector-ink.js';
export interface AddSvgPageOptions {
    /** Assumed pixel density of the source page raster, used to size the SVG
     * in physical units (inches) via its `width`/`height` attributes; the
     * `viewBox` (and so the coordinate space `image`/text sit in) always
     * stays in raw pixels regardless. Omit to size the SVG in pixels too. */
    dpi?: number;
    /** Whether to overlay the recognized handwriting (RTR) text invisibly, as
     * `addPdfPage` does for PDF output. Default true. */
    includeText?: boolean;
    /** Pen strokes to draw as real vector `<path>` elements on top of
     * `image`, instead of relying on `image` for ink -- see
     * `ToSvgOptions.vectorInk`. Coordinates must already be in the same
     * pixel space as `pageWidth`/`pageHeight` (`parseStrokes`'s output is).
     * Omit (or pass `[]`) to render `image` as the only source of ink. */
    strokes?: IStroke[];
    /** How to render each of `strokes`, aligned by index -- see `StrokeStyle`.
     * A stroke with no entry (or an out-of-range index) is skipped entirely;
     * scale a `'path'` entry's width along with `upscale` if rendering
     * strokes onto an upscaled raster (a `'rect'` entry's size instead comes
     * straight from its stroke's own already-upscaled points, so it needs no
     * separate scaling). */
    strokeStyles?: StrokeStyle[];
    /** A transparent bitmap-only ink overlay painted after vector strokes.
     * Used for text boxes/Digests that have no TOTALPATH representation. */
    overlayImage?: Image | Uint8Array;
    /** Device family this page's note was produced by
     * (`header.APPLY_EQUIPMENT`, e.g. 'A5X', 'N5', 'N6', 'A6X'), used to pick
     * the correct recognition-coordinate scale - see
     * `recognitionCoordinateScale`. Omitting it (with `nativePageWidth`)
     * keeps the legacy 1920-reference-canvas behavior (correct only for A5X
     * and Manta, wrong for N6/A6X); `toSvg()` always passes the note's real
     * equipment. */
    equipment?: string;
    /** The note's own `pageWidth` (the device's native, pre-upscale page
     * width) - needed to pick the recognition canvas for non-A5X devices
     * when the embedded `image` is upscaled beyond it. Defaults to `pageWidth`
     * (i.e. no upscale), which is correct for non-upscaled renders.
     * `toSvg()` always passes `note.pageWidth`. */
    nativePageWidth?: number;
}
/**
 * Builds one standalone SVG document for a page: the rasterized image
 * embedded as a base64 data URI, with the recognized handwriting (RTR) text
 * drawn invisibly on top at the position it was written, so the word can be
 * found/selected/copied in an SVG viewer that supports text search (e.g. a
 * browser).
 *
 * `image` may be an `image-js` `Image` (e.g. straight from `toImage`) or
 * already-PNG-encoded bytes (e.g. from a Worker that already called
 * `toImage` + `encodePng` off-main-thread). Unlike `addPdfPage`, this
 * doesn't touch any non-structured-clone-safe objects, so — one more
 * difference from the PDF path — it can run inside a Worker too, not just on
 * the main thread.
 */
export declare function addSvgPage(page: IPdfPage, image: Image | Uint8Array, pageWidth: number, pageHeight: number, options?: AddSvgPageOptions): string;
export interface ToSvgOptions {
    /** Page numbers to export (1-indexed). Defaults to all pages. */
    pageNumbers?: number[];
    /** See `AddSvgPageOptions.dpi`. */
    dpi?: number;
    /** See `AddSvgPageOptions.includeText`. */
    includeText?: boolean;
    /** See `ToImageOptions.upscale`. The resulting SVG's pixel `viewBox` (and
     * so the recognized-text overlay's coordinate space, via
     * `recognitionCoordinateScale`) scales up right along with the embedded
     * raster - both are sized off the actual produced image, not off
     * `note.pageWidth`/`note.pageHeight`, so text stays aligned to the ink at
     * any upscale factor. When `dpi` is also set, it's scaled by the same
     * factor so the physical `width`/`height` (inches) stay put - `upscale`
     * raises pixel density for a sharper render at the same physical size
     * (like a "retina" image), it doesn't enlarge the page. */
    upscale?: number;
    /** Render each page's pen strokes as real vector `<path>` elements
     * decoded from its `TOTALPATH` data (including each stroke's real color,
     * tool, and thickness -- see `parseStrokes`), instead of leaving ink to
     * the rasterized image -- crisp at any zoom, instead of the
     * fixed-resolution bitmap `toSvg` otherwise embeds.
     *
     * Applied per page, not globally: a page whose strokes decode
     * successfully gets its bitmap ink layers (MAINLAYER/LAYER1-3) left out
     * of the raster and replaced with vector paths; a page with no decodable
     * strokes at all (e.g. genuinely blank, or a `TOTALPATH` structure this
     * hasn't been validated against) keeps its normal rasterized ink instead,
     * rather than silently rendering blank. Background layers (templates, PDF
     * style) are always rasterized either way, since they aren't stored as
     * vector data. Default false. */
    vectorInk?: boolean;
}
/**
 * Render a Supernote note to one SVG document per page, each showing the
 * rasterized page image with the recognized handwriting (RTR) text drawn
 * invisibly on top of it, at the position it was written, so the text can be
 * found/selected/copied in an SVG viewer.
 *
 * SVG has no native multi-page container, so this returns one SVG string per
 * page rather than a single document — pair each with its page number for
 * filenames, e.g. `notebook-page-1.svg`.
 *
 * Convenience wrapper around `toImage` + `addSvgPage`, all run on the
 * current thread. To render pages in parallel across Workers, call
 * `extractPdfPageData` + `toImage` + `encodePng` + `addSvgPage` in each
 * Worker instead — see the README's PDF section for the equivalent
 * `extractPdfPageData` pattern (SVG's own `addSvgPage` step can join the
 * others inside the Worker, since none of it needs the main thread).
 */
export declare function toSvg(note: ISupernote, options?: ToSvgOptions): Promise<string[]>;
