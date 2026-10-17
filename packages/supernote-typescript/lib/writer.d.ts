/**
 * Prototype `.note` writer.
 *
 * Emits the minimal file layout current Supernote firmware writes for a fresh
 * note (`noteSN_FILE_VER_20260016`, `APPLY_EQUIPMENT:N5`, 1920x2560 page
 * coordinates -- what both the Manta and, on current firmware, the Nomad
 * create), mirroring a pristine device-created note block for block:
 *
 *   signature | header | BG bitmap | per page: MAIN bitmap, MAINLAYER,
 *   BGLAYER, page | footer | "tail" | footer address
 *
 * Every block is a 4-byte little-endian length followed by its bytes; every
 * address is the absolute file offset of a block's length prefix.
 *
 * Scope: one visible layer (MAINLAYER) of raster ink over the blank white
 * template, plus optional text boxes. A device text box (firmware Chauvet
 * 2608, `SN_FILE_VER_20260016`) is three things, all of which are written:
 *
 * - a `TOTALPATH` record: a 5-point closed rectangle with `stroke_kind`
 *   `"0000"` whose trailing string holds the box's Unicode text, rect, font
 *   and style as base64 CSV -- the device's editable source of truth;
 * - its rendered pixels in MAINLAYER -- what non-device renderers show;
 * - its rect in the page's `DISABLE` list with `PAGETEXTBOX:1`.
 *
 * A box with pixels but no record is shown by the device, but is dropped the
 * moment the device redraws the page's text boxes (e.g. when the user adds
 * one of their own). No strokes, recognition, titles, links, keywords, or
 * other templates.
 */
/** Encoded Ratta RLE color bytes this writer emits. */
export declare const RattaColor: {
    readonly black: 97;
    /** Transparent: lets the layer below show through. */
    readonly background: 98;
    /** Dark gray as written by current (X2-era) firmware; decodes to 157. */
    readonly darkGray: 157;
    /** Light gray as written by current (X2-era) firmware; decodes to 201. */
    readonly gray: 201;
    readonly white: 101;
};
export declare const WRITER_PAGE_WIDTH = 1920;
export declare const WRITER_PAGE_HEIGHT = 2560;
/** A page-pixel rectangle. */
export interface IRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** A text box: its page rect plus, optionally, the text the device should
 * treat as its editable content (without it the box is raster-only). */
export interface WritableTextBox extends IRect {
    text?: string;
    /** Font size in page pixels, as the device's text-box font size. Default 48. */
    fontSize?: number;
    /** Line advance in page pixels. Default 63, the device's for size 48. */
    lineHeight?: number;
}
export interface WritablePage {
    /**
     * MAINLAYER pixels: one encoded Ratta color byte (see `RattaColor`) per
     * pixel, row-major, `WRITER_PAGE_WIDTH * WRITER_PAGE_HEIGHT` long.
     * Omitted means a blank (fully transparent) layer.
     */
    mainLayer?: Uint8Array;
    /** Text boxes, written as `DISABLE` rectangles plus (when they carry
     * `text`) editable `TOTALPATH` text-box records. Their pixels belong in
     * `mainLayer`. */
    textBoxes?: WritableTextBox[];
    /** Explicit page ID (tests); generated when omitted. */
    pageId?: string;
}
export interface WriteNoteOptions {
    pages: WritablePage[];
    /** Explicit file ID (tests); generated when omitted. */
    fileId?: string;
    /** Clock for generated IDs. */
    now?: Date;
    /** Random source in [0, 1) for generated IDs. */
    random?: () => number;
}
/**
 * Encodes one encoded color byte per pixel as Ratta RLE, using the same run
 * forms the device writes: `(color, 0xff)` for 0x4000-pixel runs, a two-pair
 * `(color, 0x80|hi) (color, lo)` for 129..16383 pixels, and `(color, n-1)`
 * for 1..128 pixels.
 */
export declare function encodeRattaRle(pixels: Uint8Array): Uint8Array;
/**
 * Generates a device-style ID: prefix, `yyyyMMddHHmmssSSS`, three more
 * digits, then 12 random alphanumerics (e.g.
 * `P20260922115611225954fC6CMr1DUYjH`).
 */
export declare function generateNoteId(prefix: 'F' | 'P', now?: Date, random?: () => number): string;
/**
 * Encodes one text box as the `TOTALPATH` record the device writes for it.
 * Field layout per `plans/vector-format-spec.md`; the values of the fields
 * that spec leaves unexplained are copied from device-created text boxes.
 */
export declare function encodeTextBoxRecord(box: WritableTextBox & {
    text: string;
}, options: {
    pageNumber: number;
    trailNumber: number;
    id: string;
}): Uint8Array;
/** Serializes pages into a complete `.note` file. */
export declare function writeNote(options: WriteNoteOptions): Uint8Array;
