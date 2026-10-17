import { encodePng } from 'image-js';
import { toImage } from './conversion.js';
import { recognitionCoordinateScale } from './pdf.js';
import { buildVectorInkPrimitives, prepareVectorInkPages, buildVectorInkBackgroundNote, buildRasterInkOverlayNote, rasterInkRectsForPage, } from './vector-ink.js';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64-encodes `bytes` without `Buffer` (Node-only) or `btoa`
 * (call-stack-limited on large inputs), so it works the same in Node and
 * the browser at the size of a full-page PNG. */
function encodeBase64(bytes) {
    const chars = [];
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i];
        const hasB1 = i + 1 < len;
        const hasB2 = i + 2 < len;
        const b1 = hasB1 ? bytes[i + 1] : 0;
        const b2 = hasB2 ? bytes[i + 2] : 0;
        chars.push(BASE64_CHARS[b0 >> 2]);
        chars.push(BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]);
        chars.push(hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=');
        chars.push(hasB2 ? BASE64_CHARS[b2 & 0x3f] : '=');
    }
    return chars.join('');
}
const XML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
};
function escapeXml(text) {
    return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}
/** Builds one invisible, positioned `<text>` element per recognized word, so
 * the word can be found/selected/copied in an SVG viewer despite the ink
 * itself being part of the rasterized `<image>` beneath it. Mirrors
 * `drawRecognitionText` in pdf.ts, adapted to SVG: SVG's y-axis already runs
 * top-down like the recognition boxes (no PDF-style flip needed), and SVG's
 * own `textLength`/`lengthAdjust` attributes do the stretch-to-fit-the-box
 * scaling natively instead of needing a manually computed horizontal-scale
 * percentage. */
function buildRecognitionTextElements(page, renderWidth, equipment, nativePageWidth) {
    const scale = recognitionCoordinateScale(renderWidth, equipment, nativePageWidth);
    const elements = [];
    for (const element of page.recognitionElements) {
        if (element.type !== 'Text')
            continue;
        for (const word of element.words) {
            const box = word['bounding-box'];
            if (!box)
                continue;
            const label = decodeURIComponent(escape(word.label));
            if (!label)
                continue;
            const x = box.x * scale;
            const y = box.y * scale;
            const width = box.width * scale;
            const height = box.height * scale;
            // SVG positions text by its baseline, not a bounding-box corner;
            // anchoring at the box's bottom edge approximates the baseline
            // closely enough for search/selection (exact glyph metrics aren't
            // available, and this isn't rendered visibly anyway).
            const baselineY = y + height;
            elements.push(`<text x="${x}" y="${baselineY}" font-size="${height}" textLength="${width}" ` +
                `lengthAdjust="spacingAndGlyphs" fill="transparent">${escapeXml(label)}</text>`);
        }
    }
    return elements.join('');
}
/** Deterministic, XML-id-safe name for the hatch `<pattern>` used by a given
 * color. */
function hatchPatternId(color) {
    return `hatch-${color.replace(/[^a-zA-Z0-9]/g, '-')}`;
}
/** A `<pattern>` def drawing diagonal stripes in `color` over a white
 * background, standing in for the `'hatch'` rect fill. */
function buildHatchPatternDef(color) {
    const id = hatchPatternId(color);
    return (`<pattern id="${id}" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">` +
        `<rect width="10" height="10" fill="white"/>` +
        `<line x1="0" y1="0" x2="0" y2="10" stroke="${color}" stroke-width="5"/>` +
        `</pattern>`);
}
/** Renders one `VectorInkPrimitive` as an SVG element. */
function renderPrimitiveToSvg(primitive) {
    if (primitive.kind === 'rect') {
        const fill = primitive.fill === 'hatch' ? `url(#${hatchPatternId(primitive.color)})` : primitive.color;
        const element = `<rect x="${primitive.x.toFixed(2)}" y="${primitive.y.toFixed(2)}" ` +
            `width="${primitive.width.toFixed(2)}" height="${primitive.height.toFixed(2)}" fill="${fill}"/>`;
        return primitive.fill === 'hatch' ? { element, hatchColor: primitive.color } : { element };
    }
    if (primitive.kind === 'filledPath') {
        const d = primitive.rings
            .map((ring) => ring.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ') + ' Z')
            .join(' ');
        return { element: `<path d="${d}" fill="${primitive.color}"/>` };
    }
    const d = primitive.points
        .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' ');
    return {
        element: `<path d="${d}" fill="none" stroke="${primitive.color}" stroke-width="${primitive.width}" ` +
            `stroke-linecap="round" stroke-linejoin="round"/>`,
    };
}
/** Renders an ordered list of vector-ink primitives to SVG markup. */
function buildSvgElements(primitives) {
    const elements = [];
    const hatchColors = new Set();
    for (const primitive of primitives) {
        const { element, hatchColor } = renderPrimitiveToSvg(primitive);
        elements.push(element);
        if (hatchColor)
            hatchColors.add(hatchColor);
    }
    const defs = [...hatchColors].map(buildHatchPatternDef).join('');
    return { defs, elements: elements.join('') };
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
export function addSvgPage(page, image, pageWidth, pageHeight, options = {}) {
    const { dpi, includeText = true, strokes, strokeStyles, overlayImage, equipment, nativePageWidth } = options;
    const pngBytes = image instanceof Uint8Array ? image : encodePng(image);
    const base64 = encodeBase64(pngBytes);
    const overlayBase64 = overlayImage
        ? encodeBase64(overlayImage instanceof Uint8Array ? overlayImage : encodePng(overlayImage))
        : undefined;
    const widthAttr = dpi ? `${pageWidth / dpi}in` : `${pageWidth}`;
    const heightAttr = dpi ? `${pageHeight / dpi}in` : `${pageHeight}`;
    const textElements = includeText ? buildRecognitionTextElements(page, pageWidth, equipment, nativePageWidth ?? pageWidth) : '';
    const { defs, elements: strokeElements } = strokes && strokes.length ? buildSvgElements(buildVectorInkPrimitives(strokes, strokeStyles)) : { defs: '', elements: '' };
    return (`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${widthAttr}" height="${heightAttr}" viewBox="0 0 ${pageWidth} ${pageHeight}">` +
        (defs ? `<defs>${defs}</defs>` : '') +
        `<image data-page-background="true" x="0" y="0" width="${pageWidth}" height="${pageHeight}" xlink:href="data:image/png;base64,${base64}"/>` +
        strokeElements +
        (overlayBase64
            ? `<image data-raster-ink-overlay="true" x="0" y="0" width="${pageWidth}" height="${pageHeight}" xlink:href="data:image/png;base64,${overlayBase64}"/>`
            : '') +
        textElements +
        `</svg>`);
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
export async function toSvg(note, options = {}) {
    const { pageNumbers, dpi, includeText, upscale = 1, vectorInk = false } = options;
    const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;
    const vectorInkPages = vectorInk ? prepareVectorInkPages(note, pageNumbers, upscale) : [];
    const renderNote = vectorInk ? buildVectorInkBackgroundNote(note, vectorInkPages) : note;
    const overlayNote = vectorInk ? buildRasterInkOverlayNote(note, vectorInkPages) : undefined;
    const images = await toImage(renderNote, pageNumbers, { upscale });
    const overlayImages = overlayNote ? await toImage(overlayNote, pageNumbers, { upscale }) : undefined;
    // Scale dpi along with the raster so widthAttr/heightAttr (pageWidth /
    // dpi) come out the same physical size regardless of upscale.
    const effectiveDpi = dpi ? dpi * upscale : dpi;
    return pages.map((page, i) => {
        const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
        const vip = vectorInkPages.find((p) => p.pageNumber === pageNumber);
        const strokes = vip?.useVectorInk ? vip.strokes : undefined;
        const strokeStyles = strokes ? vip.styles : undefined;
        return addSvgPage(page, images[i], images[i].width, images[i].height, {
            dpi: effectiveDpi,
            includeText,
            strokes,
            strokeStyles,
            overlayImage: vip?.useVectorInk && rasterInkRectsForPage(note, pageNumber).length ? overlayImages?.[i] : undefined,
            equipment: note.header.APPLY_EQUIPMENT,
            nativePageWidth: note.pageWidth,
        });
    });
}
