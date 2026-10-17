/**
 * Typesets plain text into `.note` text boxes for the prototype writer.
 *
 * Text is laid out with a caller-supplied TrueType/OpenType font (via
 * fontkit), rasterized with a small anti-aliased nonzero-winding scanline
 * filler, quantized to the device's black / dark-gray / gray ink bytes, and
 * placed in MAINLAYER. Each page gets one text box carrying the same text,
 * which `writeNote` turns into the device's editable text-box record plus a
 * `DISABLE` rectangle.
 *
 * The device shows our pixels until it next redraws the page's text boxes;
 * from then on it lays the record's text out itself (in
 * DroidSansFallbackFull, 48px, 63px line advance by default). Using a
 * metrically similar font here -- Droid Sans / Noto Sans -- keeps the two
 * renderings close.
 */
import fontkit from '@pdf-lib/fontkit';
import { WritablePage } from './writer.js';
type Font = ReturnType<typeof fontkit.create>;
export interface TextBoxOptions {
    /** TrueType/OpenType font bytes used to typeset the text. */
    fontBytes: Uint8Array;
    /** Font size in page pixels (em height). Default 48, the device's default
     * text-box size. */
    fontSize?: number;
    /** Line advance as a multiple of the font size. Default 63/48, the
     * device's own advance for its text boxes. */
    lineHeight?: number;
    /** Page margin in page pixels. Default 150. */
    margin?: number;
    /** Quantize edge coverage to gray ink for smoother glyphs. Default true. */
    antialias?: boolean;
}
export interface CreateTextNoteOptions extends TextBoxOptions {
    text: string;
    /** Clock / randomness / IDs forwarded to `writeNote` (tests). */
    now?: Date;
    random?: () => number;
    fileId?: string;
}
interface LaidOutLine {
    /** Glyphs with their pen x offset in font units. */
    glyphs: {
        glyph: ReturnType<Font['getGlyph']>;
        x: number;
    }[];
    width: number;
    /** The source text the line holds. */
    text: string;
    /** Whether a hard line break (end of paragraph) follows this line. */
    hard: boolean;
}
/** Splits text into lines no wider than `maxWidth` font units. Paragraphs
 * break on `\n`; words wrap on spaces; over-long words break by glyph. */
export declare function layoutLines(font: Font, text: string, maxWidth: number): LaidOutLine[];
/**
 * Typesets `text` onto as many pages as it needs, one text box per page,
 * sized to the text it holds.
 */
export declare function layoutTextPages(text: string, options: TextBoxOptions): WritablePage[];
/** Creates a complete `.note` whose pages hold `text` as text boxes. */
export declare function createTextNote(options: CreateTextNoteOptions): Uint8Array;
/** A text box read back from a page's `TOTALPATH`. */
export interface ITextBox {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSize: number;
}
/**
 * Reads the editable text boxes (`stroke_kind` `"0000"` records carrying a
 * base64 CSV, see `plans/note-writer.md`) out of a page's `totalPathBuffer`.
 * Records of any other kind, hidden records (superseded edits, deleted
 * boxes), and malformed ones are skipped.
 */
export declare function extractTextBoxes(totalPathBuffer: Uint8Array | null): ITextBox[];
export {};
