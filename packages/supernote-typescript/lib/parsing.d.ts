import { ICover, IFooter, IHeader, IKeyword, ILayer, ILayerInfo, ILink, IRecognitionElement, IPage, ISupernote, ITitle } from './format.js';
/** Get content at location. */
export declare function getContentAtAddress(buffer: Uint8Array, address: number, byteLength: number): Uint8Array | null;
/** Parse key-value pairs. */
export declare function parseKeyValue(buffer: Uint8Array, address: number, byteLength: number): Record<string, string | string[]>;
/** Extract key-value pairs from content. */
export declare function extractKeyValue(content: string): Record<string, string | string[]>;
/** Extract nested key-values from a record. */
export declare function extractNestedKeyValue(record: Record<string, string | string[]>, delimiter?: string, prefixes?: string[]): Record<string, Record<string, string>>;
/** Extract layer info from the content string. */
export declare function extractLayerInfo(content: string): ILayerInfo[];
/** Extract plain recognized text, one recognition element per line. */
export declare function extractText(elements: IRecognitionElement[]): string;
/** Extract recognized text grouped into paragraphs. Wrapped lines within a
 * paragraph are reflowed onto one line; a vertical gap of roughly a line
 * height or more is treated as a paragraph break. */
export declare function extractParagraphs(elements: IRecognitionElement[]): string;
/** Supernote X series note. */
export declare class SupernoteX implements ISupernote {
    pageWidth: number;
    pageHeight: number;
    addressSize: number;
    lengthFieldSize: number;
    signature: string;
    version: number;
    defaultLayers: string[];
    header: IHeader;
    footer: IFooter;
    keywords: Record<string, IKeyword[]>;
    titles: Record<string, ITitle[]>;
    links: Record<string, ILink[]>;
    pages: IPage[];
    cover?: ICover;
    constructor(buffer: Uint8Array);
    /** Parse note contents from buffer. */
    _parseBuffer(buffer: Uint8Array): Partial<SupernoteX>;
    /** Parse Supernote file signature from buffer. */
    _parseSignature(buffer: Uint8Array): string;
    /** Parse the footer of a Supernote file's buffer contents. */
    _parseFooter(buffer: Uint8Array): IFooter;
    /** Parse the header of a Supernote file's buffer contents.
     * Relies on the address as given in the file's footer. */
    _parseHeader(buffer: Uint8Array): IHeader;
    /** Parse pages of a Supernote file's buffer contents.
     * Relies on the address as given in the file's footer. */
    _parsePages(buffer: Uint8Array): IPage[];
    /** Parse text of a Supernote file's buffer contents.
     * Relies on the address as given in the file's footer. */
    _parseRecognition(buffer: Uint8Array, text: string): IRecognitionElement[] | undefined;
    _extractText(elements: IRecognitionElement[]): string;
    _extractParagraphs(elements: IRecognitionElement[]): string;
    /** Parse layer at a specific address in a Supernote file's buffer contents. */
    _parseLayer(buffer: Uint8Array, address: number): ILayer;
    /** Parse cover from Supernote file's buffer contents. */
    _parseCover(buffer: Uint8Array): ICover | undefined;
    /** Parse keywords from Supernote file's buffer contents. */
    _parseKeywords(buffer: Uint8Array): Record<string, IKeyword[]>;
    /** Parse a single keyword entry at a certain buffer address. */
    _parseKeyword(buffer: Uint8Array, address: number): IKeyword;
    /** Parse titles from Supernote file's buffer contents. */
    _parseTitles(buffer: Uint8Array): Record<string, ITitle[]>;
    /** Parse links from Supernote file's buffer contents.
     * The returned Record's keys (taken as-is from the file's own `LINKO_*`
     * footer keys) aren't just unique identifiers: their first 4 characters,
     * read as an integer, are the 1-indexed page the link is actually drawn
     * on -- verified against real device-created notes, and the only
     * reliable way to find a link's source page (`ILink.OBJPAGE` isn't; see
     * its doc comment). The remaining characters are the link's own
     * `LINKRECT` `y,x,h,w` digits, zero-padded to 4 each and concatenated --
     * cosmetic, just enough to keep keys with links on the same page
     * distinct. E.g. key `"00021253011801320743"` for a link on page 2 with
     * `LINKRECT: "118,1253,743,132"` (`x,y,w,h`): `0002` + `1253` (y) +
     * `0118` (x) + `0132` (h) + `0743` (w).
     * See https://github.com/philips/supernote-typescript/issues/32. */
    _parseLinks(buffer: Uint8Array): Record<string, ILink[]>;
    /** Parse a single link entry at a certain buffer address. */
    _parseLink(buffer: Uint8Array, address: number): ILink;
    /** Parse a single title entry at a certain buffer address. */
    _parseTitle(buffer: Uint8Array, address: number): ITitle;
}
