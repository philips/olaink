import { PDFDocument, PDFFont } from 'pdf-lib';
import { Image } from 'image-js';
import { IPdfPage } from './conversion.js';
import { ISupernote } from './format.js';
import { IStroke } from './strokes.js';
import { StrokeStyle } from './vector-ink.js';
/** Scale factor to convert a recognized word's native bounding-box units into
 * raster-pixel units at the given `renderWidth`, for a note produced by
 * `equipment` (`header.APPLY_EQUIPMENT`, e.g. 'A5X', 'N5', 'N6', 'A6X') whose
 * native page width is `nativePageWidth` (the note's `pageWidth`, NOT the
 * possibly-upscaled render width). Pass the real equipment + nativePageWidth
 * for correct results on every device family and at every upscale factor;
 * omitting both keeps the legacy 1920-reference-canvas behavior (correct only
 * for A5X and Manta, wrong for N6/A6X - see the comment above).
 *
 * Exported so other exporters positioning an invisible text overlay over
 * the same recognition data (e.g. svg.ts, and the obsidian plugin's own
 * wordOverlay.ts) share this instead of re-deriving it. */
export declare function recognitionCoordinateScale(renderWidth: number, equipment?: string, nativePageWidth?: number): number;
export interface ToPdfOptions {
    /** Page numbers to export (1-indexed). Defaults to all pages. */
    pageNumbers?: number[];
    /** Bytes of a Unicode-capable TTF/OTF font to embed for the invisible text
     * layer. Defaults to the standard Helvetica font, which only supports
     * Latin (WinAnsi) text and will throw for other scripts. */
    fontBytes?: Uint8Array;
    /** Assumed pixel density of the source page raster, used to size PDF
     * pages in points. Supernote doesn't record this in the file; 300 matches
     * known device screen densities. Only affects the physical/print page
     * size, not searchability. */
    dpi?: number;
    /** Render each page's pen strokes as real vector paths instead of
     * rasterizing the ink layers -- crisp at any zoom. When enabled, the
     * bitmap ink layers (MAINLAYER/LAYER1-3) are stripped from the page image
     * and replaced with vector primitives derived from `TOTALPATH`. Default
     * false. */
    vectorInk?: boolean;
    /** Smooth upscale factor applied to the rasterized background before
     * vector ink is drawn on top. Must be >= 1. Coordinates are upscaled
     * along with the background so the vector ink stays aligned. */
    upscale?: number;
}
export interface PdfContext {
    pdfDoc: PDFDocument;
    font: PDFFont;
}
/**
 * Creates the PDF document and embeds the invisible-text-layer font.
 * Main-thread only: the returned `pdf-lib` objects aren't structured-clone-safe
 * and so can't be created in or handed to a Worker.
 */
export declare function createPdfContext(options?: Pick<ToPdfOptions, 'fontBytes'>): Promise<PdfContext>;
export interface AddPdfPageOptions {
    /** Assumed pixel density of the source page raster; see `ToPdfOptions.dpi`. */
    dpi?: number;
    /** Pen strokes to draw as vector paths on top of `image`, instead of
     * leaving ink to the raster. Coordinates must be in the same pixel space
     * as the supplied `image`. Omit (or pass `[]`) to render only `image`. */
    strokes?: IStroke[];
    /** How to render each of `strokes`, aligned by index -- see `StrokeStyle`. */
    strokeStyles?: StrokeStyle[];
    /** A transparent bitmap-only ink overlay painted after vector strokes. */
    overlayImage?: Image | Uint8Array;
    /** Device family this page's note was produced by
     * (`header.APPLY_EQUIPMENT`, e.g. 'A5X', 'N5', 'N6', 'A6X'), used to pick
     * the correct recognition-coordinate scale - see
     * `recognitionCoordinateScale`. Omitting it (with `nativePageWidth`)
     * keeps the legacy 1920-reference-canvas behavior (correct only for A5X
     * and Manta, wrong for N6/A6X); `toPdf()` always passes the note's real
     * equipment. */
    equipment?: string;
    /** The note's own `pageWidth` (the device's native, pre-upscale page
     * width) - needed to pick the recognition canvas for non-A5X devices
     * when `image` is upscaled beyond it. Defaults to `image`'s width (i.e.
     * no upscale), which is correct for non-upscaled renders.
     * `toPdf()` always passes `note.pageWidth`. */
    nativePageWidth?: number;
}
/**
 * Adds one rendered page to `ctx`: the page image, plus the recognized
 * handwriting (RTR) text drawn invisibly on top of it at the position it was
 * written, so PDF viewers can search for and select the handwritten words.
 *
 * `image` may be an `image-js` `Image` (e.g. straight from `toImage`) or
 * already-PNG-encoded bytes (e.g. from a Worker that already called
 * `toImage` + `encodePng` off-main-thread) — accepting bytes avoids the main
 * thread needing to reconstruct an `Image` just to re-encode it.
 *
 * When `options.strokes`/`options.strokeStyles` are supplied, the ink layers
 * in `image` are expected to have been omitted and the strokes are drawn as
 * vector paths on top of the background before the text layer is added.
 *
 * Main-thread only: `ctx` holds `pdf-lib` objects.
 */
export declare function addPdfPage(ctx: PdfContext, page: IPdfPage, image: Image | Uint8Array, options?: AddPdfPageOptions): Promise<void>;
/**
 * Adds one page to `ctx` with the recognized text drawn invisibly, same as
 * addPdfPage(), but with no image at all — for a PDF whose only purpose is
 * to be handed to pdf.js so its getTextContent()/getViewport() can be used
 * (e.g. to build a searchable/selectable text layer over a page that's
 * actually displayed some other way, such as a directly-rendered canvas).
 * `pdfPage.render()` is never called against such a PDF, so the image would
 * be pure dead weight: embedding a full-resolution PNG only for pdf-lib to
 * decode, recompress, and serialize it is real, size-proportional work
 * (seconds for a many-page/high-resolution note) for bytes nothing ever
 * looks at. `pageWidth`/`pageHeight` (pixels) size the PDF page the same way
 * the image's own dimensions would via addPdfPage().
 */
export declare function addTextOnlyPdfPage(ctx: PdfContext, page: IPdfPage, pageWidth: number, pageHeight: number, options?: AddPdfPageOptions): Promise<void>;
/**
 * Render a Supernote note to a PDF where each page shows the rasterized
 * page image with the recognized handwriting (RTR) text drawn invisibly on
 * top of it, at the position it was written, so PDF viewers can search for
 * and select the handwritten words.
 *
 * With `vectorInk: true`, each page's ink is drawn as vector paths instead
 * of rasterized pixels, giving a crisp result at any zoom. The bitmap ink
 * layers are left out of the page image and replaced by primitives decoded
 * from `TOTALPATH`.
 *
 * Convenience wrapper around `createPdfContext` + `addPdfPage`, all run on
 * the current thread. To render pages in parallel across Workers, call
 * `extractPageRenderData` + `toImage` + `encodePng` in each Worker and
 * `createPdfContext` + `addPdfPage` on the main thread instead — see the
 * README.
 */
export declare function toPdf(note: ISupernote, options?: ToPdfOptions): Promise<Uint8Array>;
