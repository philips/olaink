import { RattaRLEDecoder } from './conversion.js';
import { parseStrokes } from './strokes.js';
/** Rings with fewer than 3 points enclose no area, so they'd render as
 * nothing at all -- dropped so a record left holding only degenerate rings
 * falls back to its centerline rather than emitting an invisible path. */
export const MIN_CONTOUR_RING_POINTS = 3;
/** Grey level of a `rgb(g,g,g)` ink color -- every color `parseStrokes`
 * produces is a grey, so the red channel alone orders them from black (0) to
 * white (254). */
export function greyLevel(color) {
    return Number(/rgb\((\d+)/.exec(color)?.[1] ?? '0');
}
/** How far apart two grey levels must sit to count as different shades.
 * The device's own palette entries are far apart (0, 157, 201, 254) while
 * the same shade is recorded a level apart in places (0 vs 1, 157 vs 158,
 * 201 vs 202 -- see plans/vector-format-spec.md), so anything in between
 * separates "the same shade" from "a genuinely lighter one" without needing
 * the palette itself. */
const SAME_GREY_TOLERANCE = 16;
/** At or above this grey level, ink is the palette's white -- the color
 * used to paint *over* something rather than to shade it (see
 * `isHighlighterPass`). */
const WHITE_INK_MIN_GREY = 250;
/** A stroke's own extent, from its sampled centerline or -- for a record
 * that has none, like the sticker plugin's silhouette -- its rendered
 * outline. `null` when the record carries no geometry at all. */
export function strokeBounds(stroke) {
    const points = stroke.points.length ? stroke.points : (stroke.contour ?? []).flat();
    if (points.length === 0)
        return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX)
            minX = point.x;
        if (point.x > maxX)
            maxX = point.x;
        if (point.y < minY)
            minY = point.y;
        if (point.y > maxY)
            maxY = point.y;
    }
    return { minX, maxX, minY, maxY };
}
export function boundsOverlap(a, b) {
    return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}
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
export function isHighlighterPass(index, boundsList, greys, drawable) {
    const bounds = boundsList[index];
    if (!bounds)
        return false;
    const grey = greys[index];
    if (grey >= WHITE_INK_MIN_GREY)
        return false;
    for (let i = 0; i < index; i++) {
        const other = boundsList[i];
        if (!other || !drawable[i])
            continue;
        if (greys[i] + SAME_GREY_TOLERANCE >= grey)
            continue;
        if (boundsOverlap(bounds, other))
            return true;
    }
    return false;
}
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
export function buildVectorInkPrimitives(strokes, styles) {
    const rects = [];
    const highlighters = [];
    const ink = [];
    const boundsList = strokes.map(strokeBounds);
    const greys = strokes.map((_, i) => {
        const style = styles?.[i];
        return style && style.shape !== 'skip' ? greyLevel(style.color) : 0;
    });
    const drawable = strokes.map((_, i) => styles?.[i]?.shape === 'path');
    for (let i = 0; i < strokes.length; i++) {
        const stroke = strokes[i];
        const style = styles?.[i];
        if (!style || style.shape === 'skip')
            continue;
        if (style.shape === 'rect') {
            if (stroke.points.length < 2)
                continue;
            const [p0, p1] = stroke.points;
            rects.push({
                kind: 'rect',
                x: Math.min(p0.x, p1.x),
                y: Math.min(p0.y, p1.y),
                width: Math.abs(p1.x - p0.x),
                height: Math.abs(p1.y - p0.y),
                color: style.color,
                fill: style.fill,
            });
            continue;
        }
        const rings = stroke.contour?.filter((ring) => ring.length >= MIN_CONTOUR_RING_POINTS) ?? [];
        let primitive = null;
        if (rings.length > 0) {
            primitive = { kind: 'filledPath', rings, color: style.color };
        }
        else if (stroke.points.length > 0) {
            primitive = { kind: 'strokedPath', points: stroke.points, color: style.color, width: style.width };
        }
        if (!primitive)
            continue;
        const bucket = style.tier === 'marker' && isHighlighterPass(i, boundsList, greys, drawable) ? highlighters : ink;
        bucket.push(primitive);
    }
    return [...rects, ...highlighters, ...ink];
}
/**
 * `DISABLE` is a pipe-separated list of `x,y,width,height` rectangles. On
 * recent N5 files it marks text boxes and Digests: their pixels are present
 * in MAINLAYER, but there are no corresponding TOTALPATH records to turn
 * into vector paths. Keep these regions rasterized when replacing the rest
 * of a page's ink with vectors.
 */
export function parseDisabledInkRects(disable) {
    if (!disable || disable === 'none')
        return [];
    return disable.split('|').flatMap((part) => {
        if (!part)
            return [];
        const [x, y, width, height] = part.split(',').map(Number);
        return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
            ? [{ x, y, width, height }]
            : [];
    });
}
/** Raster-only regions that must remain when page `pageNumber` is vectorized.
 *
 * `DISABLE` covers text boxes and Digest excerpts. A Digest's separately
 * rendered PDF-link label sits immediately outside its `DISABLE` rectangle,
 * but is likewise absent from `TOTALPATH`. Links with `FONTSIZE > 0` are
 * those on-device typeset labels; ordinary link-tag rectangles use a zero
 * font size and can enclose genuine vector handwriting, so must not be
 * retained as a raster overlay. The first four characters of a `links` key
 * are the 1-indexed source page number (see `_parseLinks`). */
export function rasterInkRectsForPage(note, pageNumber) {
    const page = note.pages[pageNumber - 1];
    if (!page)
        return [];
    const linkRects = Object.entries(note.links).flatMap(([key, links]) => {
        if (Number(key.slice(0, 4)) !== pageNumber)
            return [];
        return links.flatMap((link) => {
            if (!(Number(link.FONTSIZE) > 0))
                return [];
            const [x, y, width, height] = link.LINKRECT.split(',').map(Number);
            return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
                ? [{ x, y, width, height }]
                : [];
        });
    });
    return [...parseDisabledInkRects(page.DISABLE), ...linkRects];
}
function isInAnyRect(x, y, rects) {
    return rects.some((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}
/** Encodes ordinary (non-extended) Ratta RLE runs. Short runs are legal for
 * every length up to 128 pixels, which is enough here and keeps the masked
 * bitmap encoder deliberately small. */
function encodeRattaRuns(colors) {
    const encoded = [];
    for (let start = 0; start < colors.length;) {
        const color = colors[start];
        let end = start + 1;
        while (end < colors.length && colors[end] === color && end - start < 128)
            end++;
        encoded.push(color, end - start - 1);
        start = end;
    }
    return new Uint8Array(encoded);
}
/** A valid all-transparent Ratta bitmap, used to give `toImage` a canvas
 * for pages that have no bitmap-only overlay. */
function transparentRattaBitmap(pageWidth, pageHeight) {
    const pixelCount = pageWidth * pageHeight;
    const output = new Uint8Array(Math.ceil(pixelCount / 128) * 2);
    const background = new RattaRLEDecoder().encodedPalette.background;
    for (let run = 0, start = 0; start < pixelCount; run++, start += 128) {
        output[run * 2] = background;
        output[run * 2 + 1] = Math.min(128, pixelCount - start) - 1;
    }
    return output;
}
/** Returns a Ratta bitmap retaining only pixels inside `rects`. The decoder's
 * palette translation supplies the reverse RGB-to-code lookup, so this keeps
 * the source layer's exact rendered colours rather than guessing a palette. */
function retainRasterInkInRects(bitmapBuffer, rects, pageWidth, pageHeight) {
    if (!bitmapBuffer || rects.length === 0)
        return null;
    const decoder = new RattaRLEDecoder();
    const pixels = decoder.decode(bitmapBuffer, pageWidth, pageHeight);
    const colorCodes = new Map();
    for (const [code, packed] of Object.entries(decoder.buildPackedTranslation({}))) {
        const rgba = new Uint8Array(new Uint32Array([packed]).buffer);
        colorCodes.set(rgba.join(','), Number(code));
    }
    // The normal transparent background code is always available, even if a
    // custom palette omitted it from the translation above.
    const transparentCode = decoder.encodedPalette.background;
    const colors = new Uint8Array(pageWidth * pageHeight);
    for (let p = 0, offset = 0; p < colors.length; p++, offset += 4) {
        if (!isInAnyRect(p % pageWidth, Math.floor(p / pageWidth), rects)) {
            colors[p] = transparentCode;
            continue;
        }
        colors[p] = colorCodes.get(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`) ?? transparentCode;
    }
    return encodeRattaRuns(colors);
}
/** Returns `page` with vectorizable ink layers cleared. `DISABLE` text-box
 * and Digest rectangles remain as a compact raster overlay because the file
 * has no vector representation for their contents. */
export function withoutInkLayers(page, pageWidth, pageHeight, retainRasterInk = true, rasterInkRects = parseDisabledInkRects(page.DISABLE)) {
    const retainedRects = retainRasterInk ? rasterInkRects : [];
    const retain = (name) => retainRasterInkInRects(page[name].bitmapBuffer, retainedRects, pageWidth, pageHeight);
    return {
        ...page,
        MAINLAYER: { ...page.MAINLAYER, bitmapBuffer: retain('MAINLAYER') },
        LAYER1: { ...page.LAYER1, bitmapBuffer: retain('LAYER1') },
        LAYER2: { ...page.LAYER2, bitmapBuffer: retain('LAYER2') },
        LAYER3: { ...page.LAYER3, bitmapBuffer: retain('LAYER3') },
    };
}
export const INK_LAYER_NAMES = ['MAINLAYER', 'LAYER1', 'LAYER2', 'LAYER3'];
/** Decodes `page`'s ink layers (MAINLAYER/LAYER1-3) into one composited
 * `InkMask`, or `null` if the page has no ink layer data at all. */
export function buildInkMask(page, pageWidth, pageHeight) {
    const inkLayers = INK_LAYER_NAMES.map((name) => page[name]).filter((layer) => layer?.bitmapBuffer && layer.bitmapBuffer.length);
    if (inkLayers.length === 0)
        return null;
    const decoder = new RattaRLEDecoder();
    const isInk = new Uint8Array(pageWidth * pageHeight);
    const colors = new Uint8Array(pageWidth * pageHeight * 3);
    let inkPixelCount = 0;
    for (const layer of inkLayers) {
        const pixels = decoder.decode(layer.bitmapBuffer, pageWidth, pageHeight);
        for (let i = 0, p = 0; p < isInk.length; i += 4, p++) {
            if (isInk[p])
                continue;
            if (pixels[i + 3] > 0) {
                isInk[p] = 1;
                colors[p * 3] = pixels[i];
                colors[p * 3 + 1] = pixels[i + 1];
                colors[p * 3 + 2] = pixels[i + 2];
                inkPixelCount++;
            }
        }
    }
    return inkPixelCount > 0 ? { isInk, inkPixelCount, colors } : null;
}
/** Below this fraction of a 2-point stroke's own bounding rectangle already
 * being real ink, `deriveStrokeStyle` treats it as `'skip'` rather than
 * `'rect'`. */
const MIN_RECT_FILL_FRACTION = 0.15;
/** At or above this fill fraction, a 'rect' is treated as `'solid'` fill. */
const SOLID_RECT_MIN_FILL_FRACTION = 0.5;
/** How many points along a stroke `strokeInkPresence` samples. */
const INK_PRESENCE_SAMPLE_COUNT = 60;
/** Below this fraction of a stroke's sampled points finding matching ink in
 * the page's own render, the stroke is dropped entirely. */
const MAX_HIDDEN_INK_PRESENCE = 0.05;
/** How far from a sampled point `strokeInkPresence` looks for matching ink,
 * beyond the stroke's own rendered half width. */
const INK_PRESENCE_SEARCH_MARGIN_PX = 1;
/** How far a rendered ink pixel's grey level may sit from the stroke's own
 * declared color and still count as that stroke's ink. */
const INK_PRESENCE_GREY_TOLERANCE = 48;
/**
 * What fraction of `stroke` still has matching ink in `mask`, the page's own
 * rendered output -- i.e. how much of it the device actually still draws.
 *
 * `displayColor` is the color the stroke is *rendered* in rather than
 * `IStroke.color`, because those differ for Heading label contrast (see
 * `applyHeadingContrastOverrides`).
 */
export function strokeInkPresence(stroke, displayColor, mask, pageWidth, pageHeight) {
    if (stroke.points.length === 0)
        return 1;
    const targetGrey = greyLevel(displayColor);
    const radius = Math.max(1, Math.round(stroke.thickness / (THICKNESS_TO_PIXEL_SCALE * 2))) + INK_PRESENCE_SEARCH_MARGIN_PX;
    const step = Math.max(1, Math.floor(stroke.points.length / INK_PRESENCE_SAMPLE_COUNT));
    let sampled = 0;
    let found = 0;
    for (let i = 0; i < stroke.points.length; i += step) {
        sampled++;
        const centerX = Math.round(stroke.points[i].x);
        const centerY = Math.round(stroke.points[i].y);
        let hit = false;
        for (let y = centerY - radius; y <= centerY + radius && !hit; y++) {
            if (y < 0 || y >= pageHeight)
                continue;
            for (let x = centerX - radius; x <= centerX + radius; x++) {
                if (x < 0 || x >= pageWidth)
                    continue;
                const p = y * pageWidth + x;
                if (!mask.isInk[p])
                    continue;
                if (Math.abs(mask.colors[p * 3] - targetGrey) <= INK_PRESENCE_GREY_TOLERANCE) {
                    hit = true;
                    break;
                }
            }
        }
        if (hit)
            found++;
    }
    return sampled > 0 ? found / sampled : 1;
}
export function modeColor(colorCounts) {
    let bestKey;
    let bestCount = 0;
    for (const [key, count] of colorCounts) {
        if (count > bestCount) {
            bestCount = count;
            bestKey = key;
        }
    }
    return bestKey;
}
export function rectBounds(p0, p1, pageWidth, pageHeight) {
    return {
        minX: Math.max(0, Math.floor(Math.min(p0.x, p1.x))),
        maxX: Math.min(pageWidth - 1, Math.ceil(Math.max(p0.x, p1.x))),
        minY: Math.max(0, Math.floor(Math.min(p0.y, p1.y))),
        maxY: Math.min(pageHeight - 1, Math.ceil(Math.max(p0.y, p1.y))),
    };
}
/** Decodes an `ITitle.TITLESTYLE` value (7 decimal digits, `1BBBFFF`) into a
 * `TitleStyle` -- `BBB` is the background's grey level, `FFF` the displayed
 * label text's grey level. */
export function parseTitleStyle(titleStyle) {
    const backgroundDigits = titleStyle.slice(1, 4);
    const textDigits = titleStyle.slice(4, 7);
    const isHatch = backgroundDigits === '000' && textDigits === '000';
    const backgroundGrey = Number(backgroundDigits);
    const textGrey = Number(textDigits);
    return {
        fill: isHatch ? 'hatch' : 'solid',
        backgroundColor: `rgb(${backgroundGrey},${backgroundGrey},${backgroundGrey})`,
        textColor: `rgb(${textGrey},${textGrey},${textGrey})`,
    };
}
/** `note.titles` is keyed by the footer's `TITLE_PPPPYYYYXXXX` suffix --
 * 4-digit page number, then the title's own `y`/`x` -- across the whole
 * note, not scoped per page, so filtering by the page-number prefix is how
 * one page's own Headings are found. */
export function buildTitleIndex(note, pageNumber) {
    const pagePrefix = String(pageNumber).padStart(4, '0');
    const entries = [];
    for (const [key, titles] of Object.entries(note.titles)) {
        if (!key.startsWith(pagePrefix))
            continue;
        for (const title of titles) {
            const rectParts = Array.isArray(title.TITLERECT) ? title.TITLERECT : String(title.TITLERECT).split(',');
            const [x, y, width, height] = rectParts.map(Number);
            entries.push({ x, y, width, height, style: parseTitleStyle(title.TITLESTYLE) });
        }
    }
    return entries;
}
/** A rect stroke's transformed corners land within ~1px of its `TITLERECT`
 * counterpart, so a small tolerance absorbs float rounding. */
const TITLE_RECT_MATCH_TOLERANCE_PX = 2;
export function findMatchingTitleStyle(titleIndex, p0, p1) {
    const x = Math.min(p0.x, p1.x);
    const y = Math.min(p0.y, p1.y);
    const width = Math.abs(p1.x - p0.x);
    const height = Math.abs(p1.y - p0.y);
    const entry = titleIndex.find((candidate) => Math.abs(candidate.x - x) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
        Math.abs(candidate.y - y) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
        Math.abs(candidate.width - width) <= TITLE_RECT_MATCH_TOLERANCE_PX &&
        Math.abs(candidate.height - height) <= TITLE_RECT_MATCH_TOLERANCE_PX);
    return entry?.style;
}
export function sampleRect(mask, pageWidth, pageHeight, p0, p1) {
    const { minX, maxX, minY, maxY } = rectBounds(p0, p1, pageWidth, pageHeight);
    const colorCounts = new Map();
    let total = 0;
    let filled = 0;
    for (let y = minY; y <= maxY; y++) {
        const rowStart = y * pageWidth;
        for (let x = minX; x <= maxX; x++) {
            total++;
            const p = rowStart + x;
            if (!mask.isInk[p])
                continue;
            filled++;
            const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
            colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
        }
    }
    return { fillFraction: total > 0 ? filled / total : 0, color: modeColor(colorCounts) };
}
/** Converts `IStroke.thickness` to a stroke-width in page pixels. */
export const THICKNESS_TO_PIXEL_SCALE = 100;
export function signedRingArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
    }
    return sum / 2;
}
export function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++)
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
}
/**
 * The width to actually draw `stroke` at, in page pixels. See
 * `src/svg.ts`'s earlier doc comment for the derivation; this is the same
 * value used by the SVG vector-ink renderer.
 */
export function strokeRenderWidth(stroke) {
    const nominalWidth = stroke.thickness / THICKNESS_TO_PIXEL_SCALE;
    if (!stroke.contour || stroke.contour.length === 0)
        return nominalWidth;
    const enclosedArea = Math.abs(stroke.contour.reduce((sum, ring) => sum + signedRingArea(ring), 0));
    if (enclosedArea <= 0)
        return nominalWidth;
    const length = polylineLength(stroke.points);
    const measuredWidth = (Math.sqrt(length * length + Math.PI * enclosedArea) - length) / (Math.PI / 2);
    return measuredWidth > 0 ? measuredWidth : nominalWidth;
}
/**
 * Derives a `StrokeStyle` for one decoded stroke. See `StrokeStyle`'s doc
 * comment for details.
 */
export function deriveStrokeStyle(stroke, mask, titleIndex, pageWidth, pageHeight) {
    if (stroke.isFilledRect && stroke.points.length >= 2 && !stroke.isEraser) {
        const [p0, p1] = stroke.points;
        const titleStyle = findMatchingTitleStyle(titleIndex, p0, p1);
        if (titleStyle)
            return { shape: 'rect', color: titleStyle.backgroundColor, fill: titleStyle.fill };
        if (!mask)
            return { shape: 'skip' };
        const { fillFraction, color } = sampleRect(mask, pageWidth, pageHeight, p0, p1);
        if (fillFraction < MIN_RECT_FILL_FRACTION)
            return { shape: 'skip' };
        return {
            shape: 'rect',
            color: color ? `rgb(${color})` : 'black',
            fill: fillFraction >= SOLID_RECT_MIN_FILL_FRACTION ? 'solid' : 'hatch',
        };
    }
    return {
        shape: 'path',
        color: stroke.color,
        width: strokeRenderWidth(stroke),
        tier: stroke.pen === 'marker' ? 'marker' : 'pen',
    };
}
const MIN_INSIDE_RECT_FRACTION = 0.8;
export function isInsideRectBounds(point, bounds) {
    return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}
/**
 * Supernote's Heading feature auto-recolors its label text for contrast
 * against the heading's own background. This applies that override to the
 * relevant `'path'` strokes.
 */
export function applyHeadingContrastOverrides(strokes, styles, titleIndex, mask, pageWidth, pageHeight) {
    const rectInfoList = strokes
        .map((stroke, i) => {
        if (styles[i].shape !== 'rect')
            return null;
        const [p0, p1] = stroke.points;
        return {
            bounds: rectBounds(p0, p1, pageWidth, pageHeight),
            textColor: findMatchingTitleStyle(titleIndex, p0, p1)?.textColor,
        };
    })
        .filter((info) => info !== null);
    if (rectInfoList.length === 0)
        return styles;
    return styles.map((style, i) => {
        if (style.shape !== 'path')
            return style;
        const stroke = strokes[i];
        if (stroke.isEraser)
            return style;
        const matchedRect = rectInfoList.find((info) => {
            const insideCount = stroke.points.filter((point) => isInsideRectBounds(point, info.bounds)).length;
            return insideCount / stroke.points.length >= MIN_INSIDE_RECT_FRACTION;
        });
        if (!matchedRect)
            return style;
        if (matchedRect.textColor)
            return { ...style, color: matchedRect.textColor };
        if (!mask)
            return style;
        const colorCounts = new Map();
        for (const point of stroke.points) {
            const xi = Math.round(point.x);
            const yi = Math.round(point.y);
            if (xi < 0 || xi >= pageWidth || yi < 0 || yi >= pageHeight)
                continue;
            const p = yi * pageWidth + xi;
            if (!mask.isInk[p])
                continue;
            const key = `${mask.colors[p * 3]},${mask.colors[p * 3 + 1]},${mask.colors[p * 3 + 2]}`;
            colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
        }
        const sampled = modeColor(colorCounts);
        return sampled ? { ...style, color: `rgb(${sampled})` } : style;
    });
}
/** Scales a decoded stroke's `contour` by `factor`. `parseStrokes` transforms
 * `points` using the page dimensions it's handed, so passing upscaled
 * dimensions upscales them for free -- but `contour` arrives in the note's
 * native page space and has to be scaled here. */
export function withUpscaledContour(stroke, factor) {
    if (factor === 1 || !stroke.contour)
        return stroke;
    return {
        ...stroke,
        contour: stroke.contour.map((ring) => ring.map((point) => ({ x: point.x * factor, y: point.y * factor }))),
    };
}
/**
 * Decodes the vector ink for each requested page and decides, per page,
 * whether the decoded strokes are trustworthy enough to replace the page's
 * rasterized ink layers. This is shared by the SVG and PDF renderers so both
 * make the same decision and draw the same strokes.
 */
export function prepareVectorInkPages(note, pageNumbers, upscale) {
    const pages = pageNumbers ? pageNumbers.map((n) => note.pages[n - 1]) : note.pages;
    const strokesPerPage = pages.map((page) => parseStrokes(page.totalPathBuffer, note.pageWidth * upscale, note.pageHeight * upscale, {
        includeErasers: true,
        includeContours: true,
    }).map((stroke) => withUpscaledContour(stroke, upscale)));
    const result = [];
    pages.forEach((page, i) => {
        const pageNumber = pageNumbers ? pageNumbers[i] : i + 1;
        const nativeStrokes = parseStrokes(page.totalPathBuffer, note.pageWidth, note.pageHeight, {
            includeErasers: true,
            includeContours: true,
        });
        if (nativeStrokes.length === 0) {
            result.push({ pageNumber, useVectorInk: false, strokes: [], styles: [] });
            return;
        }
        const mask = buildInkMask(page, note.pageWidth, note.pageHeight);
        const titleIndex = buildTitleIndex(note, pageNumber);
        const styles = mask
            ? nativeStrokes.map((stroke) => deriveStrokeStyle(stroke, mask, titleIndex, note.pageWidth, note.pageHeight))
            : nativeStrokes.map(() => ({ shape: 'skip' }));
        const displayStyles = applyHeadingContrastOverrides(nativeStrokes, styles, titleIndex, mask, note.pageWidth, note.pageHeight);
        const finalStyles = displayStyles.map((style, j) => {
            const stroke = nativeStrokes[j];
            if (style.shape !== 'path' || stroke.isEraser)
                return style;
            if (stroke.trailStatus !== undefined)
                return { shape: 'skip' };
            if (!mask)
                return style;
            return strokeInkPresence(stroke, style.color, mask, note.pageWidth, note.pageHeight) < MAX_HIDDEN_INK_PRESENCE
                ? { shape: 'skip' }
                : style;
        });
        if (mask && finalStyles.every((style) => style.shape === 'skip')) {
            result.push({ pageNumber, useVectorInk: false, strokes: strokesPerPage[i], styles: [] });
            return;
        }
        const scaledStyles = finalStyles.map((style) => style.shape === 'path' ? { ...style, width: style.width * upscale } : style);
        result.push({ pageNumber, useVectorInk: true, strokes: strokesPerPage[i], styles: scaledStyles });
    });
    return result;
}
/** Builds a copy of `note` with vectorizable ink layers removed for every
 * page where `prepareVectorInkPages` decided vector ink should replace the
 * raster ink. `DISABLE` text-box/Digest regions remain in this legacy
 * single-raster result; use `buildVectorInkBackgroundNote` together with
 * `buildRasterInkOverlayNote` when vector paths must remain beneath them. */
export function buildRenderNoteForVectorInk(note, vectorInkPages) {
    const useVectorInkByPage = new Map(vectorInkPages.map((p) => [p.pageNumber, p.useVectorInk]));
    return {
        ...note,
        pages: note.pages.map((page, i) => useVectorInkByPage.get(i + 1)
            ? withoutInkLayers(page, note.pageWidth, note.pageHeight, true, rasterInkRectsForPage(note, i + 1))
            : page),
    };
}
/** The template/background raster beneath vector ink. Raster-only text-box
 * and Digest pixels are deliberately excluded here so callers can paint them
 * over vector paths at their original layer order. */
export function buildVectorInkBackgroundNote(note, vectorInkPages) {
    const useVectorInkByPage = new Map(vectorInkPages.map((p) => [p.pageNumber, p.useVectorInk]));
    return {
        ...note,
        pages: note.pages.map((page, i) => useVectorInkByPage.get(i + 1) ? withoutInkLayers(page, note.pageWidth, note.pageHeight, false) : page),
    };
}
/** A transparent raster containing only bitmap-only text-box/Digest ink for
 * vectorized pages. It must be painted after vector paths: some text lies on
 * top of a decoded marker/highlighter stroke in the original layer stack. */
export function buildRasterInkOverlayNote(note, vectorInkPages) {
    const useVectorInkByPage = new Map(vectorInkPages.map((p) => [p.pageNumber, p.useVectorInk]));
    const transparentBitmap = transparentRattaBitmap(note.pageWidth, note.pageHeight);
    const clear = (page) => ({
        ...page,
        MAINLAYER: { ...page.MAINLAYER, bitmapBuffer: transparentBitmap },
        LAYER1: { ...page.LAYER1, bitmapBuffer: null },
        LAYER2: { ...page.LAYER2, bitmapBuffer: null },
        LAYER3: { ...page.LAYER3, bitmapBuffer: null },
        BGLAYER: { ...page.BGLAYER, bitmapBuffer: null },
    });
    return {
        ...note,
        pages: note.pages.map((page, i) => {
            const rasterInkRects = rasterInkRectsForPage(note, i + 1);
            if (!useVectorInkByPage.get(i + 1) || rasterInkRects.length === 0)
                return clear(page);
            return {
                ...withoutInkLayers(page, note.pageWidth, note.pageHeight, true, rasterInkRects),
                BGLAYER: { ...page.BGLAYER, bitmapBuffer: null },
            };
        }),
    };
}
