import { ILayerNames, ISupernote, IRecognitionElement } from './format.js';
import { Image } from "image-js";
import { ColorInstance } from 'color';
/** The minimal layer shape `toImage` needs to rasterize a page: enough to
 * decode/composite, without the address/protocol metadata `ILayer` carries. */
export interface IRenderableLayer {
    LAYERNAME: ILayerNames;
    bitmapBuffer: Uint8Array | null;
}
/** The minimal page shape `toImage` needs to rasterize a page. Only layers
 * named in `LAYERSEQ` need to be present. */
export interface IRenderablePage extends Partial<Record<ILayerNames, IRenderableLayer>> {
    PAGESTYLE: string;
    LAYERSEQ: ILayerNames[];
}
/** The minimal note shape `toImage` needs: page pixel dimensions plus the
 * per-page layer data, without the class instance or unrelated pages/fields.
 * `ISupernote` (and its full `IPage`/`ILayer` types) satisfy this structurally,
 * so `toImage` continues to accept `ISupernote` unchanged; this narrower type
 * additionally lets a single-page slice (see `extractPageRenderData`) be
 * passed to `toImage` after being sent through a Worker's structured clone,
 * without reconstructing a fake `ISupernote`. */
export interface IRenderableNote {
    pageWidth: number;
    pageHeight: number;
    pages: IRenderablePage[];
}
/** The minimal page shape `addPdfPage`/`addTextOnlyPdfPage` need: everything
 * `IRenderablePage` carries for rasterization, plus the already-parsed
 * recognition data for the invisible searchable-text layer, without `IPage`'s
 * various protocol/address/raw-file metadata fields neither function reads.
 * `IPage` continues to satisfy this structurally, so existing callers
 * passing a full parsed `IPage` are unaffected; this only additionally lets
 * a minimal, Worker-clonable slice (see `extractPdfPageData`) be passed
 * directly, e.g. to build a whole PDF inside a Worker without reconstructing
 * a fake `IPage` there. */
export interface IPdfPage extends IRenderablePage {
    recognitionElements: IRecognitionElement[];
}
/** Overlays `sourceImage` onto `destinationImage` in place. Both must be
 * 8-bit RGBA images of matching dimensions.
 *
 * Operates on the raw pixel buffers as packed uint32s instead of going
 * through `Image.getPixel`/`setPixel`, which allocate a fresh JS array per
 * pixel touched (two per pixel, for both reads and the write). For a
 * megapixel-scale page composited across several overlay layers, that adds
 * up to millions of short-lived array allocations; this does none. */
export declare function compositeImages(sourceImage: Image, destinationImage: Image): void;
/** Bicubic-resizes an 8-bit RGBA image up by `factor`, without the color
 * fringing a naive resize would produce at ink/transparent edges:
 * flattenToWhite()'s own comment below notes background pixels are packed
 * as black at alpha 0, since nothing normally looks at their color. A plain
 * resize interpolates color and alpha channels independently, so it *would*
 * look at that stored black and blend it into partially-transparent edge
 * pixels - darkening non-black ink (white highlighter, gray marker) right
 * where anti-aliasing should be smoothing it, not tinting it. Premultiplying
 * by alpha before the resize and dividing it back out after (standard
 * "premultiplied alpha" compositing) keeps interpolated color anchored to
 * the actual ink color instead of the meaningless color underneath it. */
export declare function upscaleImage(image: Image, factor: number): Image;
/** Flattens an image with an alpha channel onto an opaque white background,
 * producing a plain image (RGB, or GREY for a GREYA source) with no alpha
 * channel at all - for a destination (e.g. a PDF page, see
 * addPdfPage()/toPdf()) that has no "behind" for a transparent pixel to
 * show, unlike an on-screen `<img>` sitting over a page background.
 *
 * This is *not* the same as just discarding the alpha channel
 * (`convertColor()` to a non-alpha model, which keeps each pixel's existing
 * color channels untouched and only drops alpha): background/unwritten
 * pixels here are packed with their color channels at 0 - i.e. black - and
 * alpha at 0 (see RattaRLEDecoder.buildPackedTranslation()), specifically
 * *because* nothing ever looks at their color when alpha is respected. Only
 * actually blending each pixel toward white by its own alpha (standard
 * "flatten onto a background color" alpha compositing) gives the right
 * result for both fully-transparent (-> white) and fully-opaque (-> its own
 * color, unchanged) pixels, and everything anti-aliased in between; simply
 * dropping alpha would instead reveal every background pixel's *actual*
 * stored color - black - as if it had been solid ink all along. */
export declare function flattenToWhite(image: Image): Image;
export interface ToImageOptions {
    /** Downsample factor (positive integer, default 1 = full resolution).
     * Output pages are `ceil(pageWidth / scale)` x `ceil(pageHeight / scale)`.
     * At `scale > 1`, each layer is decoded directly at the reduced
     * resolution via `RattaRLEDecoder.decodeAtScale` rather than decoded at
     * full resolution and downscaled afterward, so a full `pageWidth` x
     * `pageHeight` buffer is never allocated -- meant for cheap thumbnails
     * on memory-constrained devices, see
     * https://github.com/philips/supernote-typescript/issues/40. */
    scale?: number;
    /** Smooth upscale factor (finite number >= 1, default 1 = no upscaling).
     * Applied via upscaleImage() as a bicubic resize *after* decoding/
     * compositing, not by decoding at a higher resolution - Supernote's
     * layers are fixed-resolution rasters (decodeAtScale samples them, it
     * doesn't invent detail), so there's nothing extra to recover, only
     * visible stair-stepping on stroke edges to soften. Mirrors Ratta's own
     * "200%" export option; combines with `scale` (applied on top of
     * whatever resolution `scale` decoded at), see
     * https://github.com/philips/supernote-obsidian-plugin/issues/212.
     * The bicubic resize is real per-pixel CPU work (~10s for a single
     * full-resolution Manta page at `upscale: 1.5` on a dev laptop) -- fine
     * for an on-demand export, not something to run on every page of a
     * scrolling viewer. */
    upscale?: number;
}
/**
 * Convert a Supernote file to one or more image-js image objects.
 * @param note Parsed Supernote, or the minimal `IRenderableNote` slice
 * produced by `extractPageRenderData` (e.g. when rendering off-main-thread).
 * @param pageNumbers Optional page numbers to export (defaults to all). Indexing starts at 1.
 * @param options See `ToImageOptions`.
 */
export declare function toImage(note: IRenderableNote, pageNumbers?: number[], options?: ToImageOptions): Promise<Image[]>;
/**
 * Extracts the minimal, structured-clone-safe slice of `note` needed to
 * render page `pageNumber` off-main-thread (e.g. posted to a Web Worker or
 * `worker_threads` worker), without cloning the whole note (every other
 * page's buffers, or the `SupernoteX` instance and its methods, which don't
 * survive structured clone). Feed the result straight back into `toImage`:
 * `toImage(extractPageRenderData(note, n), [1])`.
 * @param note Parsed Supernote.
 * @param pageNumber Page number to extract (1-indexed).
 */
export declare function extractPageRenderData(note: ISupernote, pageNumber: number): IRenderableNote;
/**
 * Same as `extractPageRenderData`, but for building a PDF page (see
 * `IPdfPage`) rather than just rasterizing one: additionally carries the
 * recognized-text data `addPdfPage`/`addTextOnlyPdfPage` need for the
 * invisible searchable-text layer. Lets a whole PDF be assembled
 * off-main-thread (e.g. inside a Worker, alongside `createPdfContext` +
 * `addPdfPage` there too - `pdf-lib` itself has no DOM dependency and runs
 * fine in a Worker; only its *objects* aren't structured-clone-safe, so the
 * whole `createPdfContext`-through-`save()` sequence has to happen in one
 * place; see the Worker's own comment for why that matters for keeping a
 * host UI responsive during a large export).
 * @param note Parsed Supernote.
 * @param pageNumber Page number to extract (1-indexed).
 */
export declare function extractPdfPageData(note: ISupernote, pageNumber: number): {
    pageWidth: number;
    pageHeight: number;
    pages: IPdfPage[];
};
/** Color palette to use as substitutes for the Supernote's colors. */
export interface IColorPalette extends Record<string, ColorInstance> {
    background: ColorInstance;
    black: ColorInstance;
    darkGray: ColorInstance;
    gray: ColorInstance;
    white: ColorInstance;
    markerBlack: ColorInstance;
    markerDarkGray: ColorInstance;
    markerGray: ColorInstance;
    darkGrayX2: ColorInstance;
    grayX2: ColorInstance;
    markerDarkGrayX2: ColorInstance;
    markerGrayX2: ColorInstance;
}
/** An encoded color palette as found in the Supernote's file buffer. */
export interface IEncodedPalette extends Record<string, number> {
    black: number;
    background: number;
    darkGray: number;
    gray: number;
    white: number;
    markerBlack: number;
    markerDarkGray: number;
    markerGray: number;
    darkGrayX2: number;
    grayX2: number;
    markerDarkGrayX2: number;
    markerGrayX2: number;
}
/** Decoder for the Ratta RLE protocol. */
export declare class RattaRLEDecoder {
    encodedPalette: IEncodedPalette;
    specialLengthMarker: number;
    specialLength: number;
    specialLengthForBlank: number;
    /**
     * @param buffer Input buffer following Ratta RLE protocol.
     * @param width Page width.
     * @param height Page height.
     * @param palette Optionally custom palette.
     * @param allBlank Blank toggle.
     * @returns Decoded buffer.
     * Adopted from https://github.com/jya-dev/supernote-tool.
     */
    decode(buffer: Uint8Array, width: number, height: number, palette?: IColorPalette, allBlank?: boolean): Uint8Array<ArrayBuffer>;
    /**
     * Like `decode`, but samples directly at a reduced resolution instead of
     * decoding a full `width` x `height` buffer and downscaling afterward, so
     * the full-resolution buffer is never allocated -- for cheap thumbnails
     * on memory-constrained devices, see
     * https://github.com/philips/supernote-typescript/issues/40. Uses
     * nearest-neighbor sampling: output pixel `(x, y)` takes the color of
     * full-resolution pixel `(x * factor, y * factor)`.
     * @param buffer Input buffer following Ratta RLE protocol.
     * @param width Full-resolution page width.
     * @param height Full-resolution page height.
     * @param factor Downsample factor (positive integer). `1` samples every
     * pixel -- equivalent to, but slower than, `decode` itself, so prefer
     * `decode` directly at factor `1`.
     * @param palette Optionally custom palette.
     * @param allBlank Blank toggle.
     * @returns Decoded buffer sized `ceil(width / factor)` x
     * `ceil(height / factor)` (not necessarily an exact divisor of the input
     * dimensions), plus those output dimensions.
     */
    decodeAtScale(buffer: Uint8Array, width: number, height: number, factor: number, palette?: IColorPalette, allBlank?: boolean): {
        data: Uint8Array;
        width: number;
        height: number;
    };
    /** Walks `buffer`'s encoded (color, length) runs following Ratta RLE's
     * two-byte length-extension scheme, invoking `fill(cursor, color,
     * length)` for each run in turn and threading its return value through
     * as the next cursor. Shared by `decode` and `decodeAtScale` so both
     * stay in sync with this parsing logic; only how a run gets written
     * (`fillRun` vs. `fillRunAtScale`) differs between them.
     * @param totalPixels Full-resolution pixel count (`width * height`),
     * needed to size the trailing run correctly regardless of any
     * downsampling `fill` itself does.
     * @returns The final cursor, which callers compare against
     * `totalPixels` to confirm the buffer decoded to the expected size.
     */
    private _walkRuns;
    /** Fills `length` pixels starting at `cursor` with the color for
     * `encodedColor`, and returns the cursor advanced past the run. */
    fillRun(pixels: Uint32Array, cursor: number, encodedColor: number, length: number, translation: Record<number, number>): number;
    /** Like `fillRun`, but writes into a `factor`-downsampled output buffer
     * instead of a full `fullWidth` x (`totalPixels`/`fullWidth`) one, only
     * computing/writing the sample pixels (nearest-neighbor, the top-left
     * corner of each `factor` x `factor` block) that fall within this run --
     * skipping whole sample rows/columns between them arithmetically rather
     * than iterating every full-resolution pixel the run covers, so the cost
     * of a run scales with the *output* pixels it contains, not the
     * full-resolution ones. */
    fillRunAtScale(outPixels: Uint32Array, outWidth: number, fullWidth: number, totalPixels: number, factor: number, cursor: number, length: number, encodedColor: number, translation: Record<number, number>): number;
    /** RGBA used for encoded colors outside the known palette: fully
     * transparent, matching the previous per-pixel fallback. */
    private readonly unknownColorPacked;
    /** Precomputes a packed RGBA uint32 per encoded palette byte, so the hot
     * decode loop never touches the `color` library. */
    buildPackedTranslation(pal: IColorPalette): Record<number, number>;
    adjustTailLength(tailLength: number, uncompressedLength: number, expectedLength: number): number;
}
