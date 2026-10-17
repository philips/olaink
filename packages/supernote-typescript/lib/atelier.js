import initSqlJs from 'sql.js';
import { Image, ImageColorModel, decodePng } from 'image-js';
import { compositeImages } from './conversion.js';
const SURFACE_TABLE_PATTERN = /^surface_\d+$/;
/** Tiles address their grid column in the upper bits and row in the lower
 * bits of `tid`, i.e. `tid = col * TILE_ID_STRIDE + row + offset`, where
 * `offset` depends on the tile's absolute position on Atelier's (much
 * larger) virtual canvas. Reverse-engineered from the fixed `tids` table in
 * https://github.com/Ziv-Ink/Atelier-parser/blob/main/atelierparser.py and
 * confirmed against a real device-generated `.spd` file (row/col spans
 * derived this way matched that file's `surface.width`/`surface.height`).
 * Deriving row/col this way (rather than assuming a canvas size) means it
 * keeps working regardless of where on the virtual canvas a document's
 * tiles happen to sit. */
const TILE_ID_STRIDE = 4096;
/** Parsed Supernote Atelier `.spd` file. */
export class SupernoteAtelier {
    constructor() { }
    /**
     * Parse a `.spd` file's contents.
     * @param buffer Raw file contents.
     * @param sqlJsConfig Passed through to `sql.js`'s `initSqlJs`, e.g. to
     * supply `locateFile` when bundling for the browser.
     */
    static async open(buffer, sqlJsConfig) {
        const SQL = await initSqlJs(sqlJsConfig);
        const db = new SQL.Database(buffer);
        try {
            const note = new SupernoteAtelier();
            note.config = note._parseConfig(db);
            note.fmtVer = note._parseFmtVer(note.config);
            note.thumbnailBuffer = note._parseThumbnail(note.config);
            note.viewport = note._parseViewport(note.config);
            note.canvasSize = note._parseCanvasSize(note.config);
            note.layers = note._parseLayers(note.config);
            note.surfaces = note._parseSurfaces(db);
            note._gridBounds = computeGridBounds(Object.values(note.surfaces).flat());
            return note;
        }
        finally {
            db.close();
        }
    }
    /** Read every row of the `config` table into a name -> bytes map. */
    _parseConfig(db) {
        const config = {};
        const results = db.exec('SELECT name, value FROM config');
        for (const row of results[0]?.values ?? []) {
            const [name, value] = row;
            config[name] = toBytes(value);
        }
        return config;
    }
    _parseFmtVer(config) {
        if (!('fmt_ver' in config))
            return undefined;
        const parsed = parseInt(decodeUtf8(config.fmt_ver), 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }
    _parseThumbnail(config) {
        const thumbnail = config.thumbnail;
        return thumbnail && thumbnail.length > 0 ? thumbnail : null;
    }
    _parseViewport(config) {
        if (!('vp.x' in config) || !('vp.y' in config) || !('vp.scale' in config))
            return undefined;
        const x = parseFloat(decodeUtf8(config['vp.x']));
        const y = parseFloat(decodeUtf8(config['vp.y']));
        const scale = parseFloat(decodeUtf8(config['vp.scale']));
        if ([x, y, scale].some(Number.isNaN))
            return undefined;
        return { x, y, scale };
    }
    _parseLayers(config) {
        if (!('ls' in config))
            return undefined;
        return decodeAtelierLayers(config.ls);
    }
    _parseCanvasSize(config) {
        if (!('surface.width' in config) || !('surface.height' in config))
            return undefined;
        const width = parseFloat(decodeUtf8(config['surface.width']));
        const height = parseFloat(decodeUtf8(config['surface.height']));
        if ([width, height].some(Number.isNaN))
            return undefined;
        return { width, height };
    }
    /** Read every row of every `surface_{n}` tile table found in the file.
     * Real files aren't limited to `surface_1`/`surface_2` (e.g. an imported
     * background "Reference Layer" was observed in a real file as
     * `surface_9999`, its `ls` layer id), so the tables to read are
     * discovered from `sqlite_master` rather than assumed. */
    _parseSurfaces(db) {
        const tableNames = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? [])
            .map((row) => row[0])
            .filter((name) => SURFACE_TABLE_PATTERN.test(name));
        const surfaces = {};
        for (const name of tableNames) {
            const results = db.exec(`SELECT tid, tile FROM ${name}`);
            surfaces[name] = (results[0]?.values ?? []).map((row) => {
                const [tid, tile] = row;
                return { tid, bitmapBuffer: toBytes(tile) };
            });
        }
        return surfaces;
    }
    /**
     * Stitch a surface's tiles into a single composite image, positioned by
     * their tile ids (see `TILE_ID_STRIDE`). The output is sized and
     * positioned against the tile grid bounds of *every* surface in the
     * file (not just this one), so images from different surfaces of the
     * same file line up and can be composited directly (e.g. drawing layers
     * over an imported background that covers a larger area). Grid cells
     * with no tile (nothing drawn there) are left transparent. Returns
     * `null` if the surface doesn't exist or has no tiles anywhere in the file.
     */
    async toImage(surfaceName = 'surface_1') {
        const tiles = this.surfaces[surfaceName];
        if (!tiles || tiles.length === 0 || this._gridBounds === null)
            return null;
        const { minRow, minCol, maxRow, maxCol } = this._gridBounds;
        const decoded = await Promise.all(tiles.map(async (tile) => ({
            row: tile.tid % TILE_ID_STRIDE,
            col: Math.floor(tile.tid / TILE_ID_STRIDE),
            image: normalizeTransparentPixels(decodePng(tile.bitmapBuffer).convertBitDepth(8).convertColor(ImageColorModel.RGBA)),
        })));
        const tileWidth = decoded[0].image.width;
        const tileHeight = decoded[0].image.height;
        const output = new Image((maxCol - minCol + 1) * tileWidth, (maxRow - minRow + 1) * tileHeight, {
            colorModel: ImageColorModel.RGBA,
        });
        // image-js defaults a new image's alpha channel to fully opaque (and
        // RGB to 0, i.e. opaque black), not transparent. Grid cells with no
        // tile need to read as "nothing here" -- both for this method's own
        // callers and for compositeImages() in toCompositeImage(), which
        // would otherwise treat this opaque black filler as real content and
        // paint over whatever it's layered onto.
        output.getRawImage().data.fill(0);
        for (const { image, row, col } of decoded) {
            pasteImage(output, image, (col - minCol) * tileWidth, (row - minRow) * tileHeight);
        }
        return output;
    }
    /**
     * Stitch and flatten a set of surfaces into one final image, in the same
     * aligned coordinate space `toImage` uses. Surfaces are layered
     * bottom-to-top using `layers` (from the `ls` config value) reversed:
     * that list has been observed with the frontmost/topmost layer first
     * (matching how most layer panels list layers), and painting back to
     * front puts it visually on top. This ordering is a best-effort guess
     * alongside the rest of `layers`, see the module doc comment; if `ls`
     * didn't decode, surfaces are composited in an arbitrary order instead.
     * @param visibleSurfaces Surface names to include (e.g. from a
     * layer-visibility toggle), in any order -- composite order is still
     * decided by `layers`/`ls`, not by the order given here. Defaults to
     * every surface in the file. Names not present in the file are ignored.
     * Returns `null` if nothing ends up included (no tiles at all, or an
     * empty/all-excluded `visibleSurfaces`).
     */
    async toCompositeImage(visibleSurfaces) {
        let order = this._compositeOrder();
        if (visibleSurfaces !== undefined) {
            const visible = new Set(visibleSurfaces);
            order = order.filter((surfaceName) => visible.has(surfaceName));
        }
        const images = [];
        for (const surfaceName of order) {
            const image = await this.toImage(surfaceName);
            if (image !== null)
                images.push(image);
        }
        if (images.length === 0)
            return null;
        const output = images[0].clone();
        for (let i = 1; i < images.length; i++) {
            compositeImages(images[i], output);
        }
        return output;
    }
    /** Bottom-to-top surface names to composite in `toCompositeImage`. */
    _compositeOrder() {
        if (this.layers && this.layers.length > 0) {
            return [...this.layers].reverse().map((layer) => `surface_${layer.id}`);
        }
        return Object.keys(this.surfaces);
    }
}
/** Bounding box, in tile grid coordinates, of every tile across every
 * surface passed in. `null` if `tiles` is empty. */
function computeGridBounds(tiles) {
    if (tiles.length === 0)
        return null;
    const rows = tiles.map((t) => t.tid % TILE_ID_STRIDE);
    const cols = tiles.map((t) => Math.floor(t.tid / TILE_ID_STRIDE));
    return {
        minRow: Math.min(...rows),
        minCol: Math.min(...cols),
        maxRow: Math.max(...rows),
        maxCol: Math.max(...cols),
    };
}
/** Zeroes the RGB of every fully-transparent pixel in an 8-bit RGBA image, in
 * place. `pasteImage` and `compositeImages` (from `conversion.ts`, reused by
 * `toCompositeImage`) both treat a pixel as "nothing here" by checking
 * whether its packed RGBA value is exactly zero -- which a transparent pixel
 * only satisfies if its RGB happens to be zero too. PNG encoders are free to
 * leave arbitrary RGB behind a zero alpha (a fully-transparent white pixel,
 * e.g. `(255, 255, 255, 0)`, is packed as non-zero), so tiles need this
 * normalization before compositing, rather than assuming every encoder
 * zeroes RGB under a transparent alpha. */
function normalizeTransparentPixels(image) {
    const data = image.getRawImage().data;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
        }
    }
    return image;
}
/** Copies `source`'s pixels into `destination` at pixel offset `(x, y)`. Both
 * must be 8-bit RGBA images. */
function pasteImage(destination, source, x, y) {
    const dst = destination.getRawImage();
    const src = source.getRawImage();
    if (dst.bitDepth !== 8 || src.bitDepth !== 8 || dst.channels !== 4 || src.channels !== 4) {
        throw new Error('pasteImage only supports 8-bit RGBA images.');
    }
    const rowBytes = src.width * src.channels;
    for (let row = 0; row < src.height; row++) {
        const srcStart = row * rowBytes;
        const dstStart = ((y + row) * dst.width + x) * dst.channels;
        dst.data.set(src.data.subarray(srcStart, srcStart + rowBytes), dstStart);
    }
}
function toBytes(value) {
    if (value === null)
        return new Uint8Array();
    if (value instanceof Uint8Array)
        return value;
    if (typeof value === 'string')
        return new TextEncoder().encode(value);
    return new TextEncoder().encode(String(value));
}
function decodeUtf8(bytes) {
    return new TextDecoder('utf8').decode(bytes);
}
/** Reads a protobuf varint starting at `offset`, returning its value and the
 * offset just past it. */
function readVarint(data, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (true) {
        if (pos >= data.length)
            throw new Error('Truncated varint.');
        const byte = data[pos++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            break;
        shift += 7;
    }
    return [result >>> 0, pos];
}
/** Minimal protobuf wire-format walker: enough to read `ls`'s top-level
 * varint and length-delimited fields. Only wire types 0 (varint) and 2
 * (length-delimited) are supported, which is all `ls` has been observed to
 * use; anything else stops decoding early rather than misinterpreting bytes. */
function readProtoFields(data) {
    const fields = [];
    let pos = 0;
    while (pos < data.length) {
        const [tag, afterTag] = readVarint(data, pos);
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;
        if (wireType === 0) {
            const [value, next] = readVarint(data, afterTag);
            fields.push({ fieldNumber, wireType, value });
            pos = next;
        }
        else if (wireType === 2) {
            const [len, next] = readVarint(data, afterTag);
            if (next + len > data.length)
                throw new Error('Truncated length-delimited field.');
            fields.push({ fieldNumber, wireType, value: data.subarray(next, next + len) });
            pos = next + len;
        }
        else {
            break;
        }
    }
    return fields;
}
/** Best-effort decode of the `ls` config value into a layer list: field 1 is
 * a repeated submessage per layer, with the layer id in its field 1 (varint)
 * and its name in field 2 (string). Returns `undefined` rather than throwing
 * if the bytes don't match this shape, since `ls`'s format is unconfirmed. */
function decodeAtelierLayers(data) {
    try {
        const layers = [];
        for (const field of readProtoFields(data)) {
            if (field.fieldNumber !== 1 || field.wireType !== 2)
                continue;
            const sub = readProtoFields(field.value);
            const idField = sub.find((f) => f.fieldNumber === 1 && f.wireType === 0);
            const nameField = sub.find((f) => f.fieldNumber === 2 && f.wireType === 2);
            if (!nameField)
                continue;
            layers.push({
                id: typeof idField?.value === 'number' ? idField.value : 0,
                name: decodeUtf8(nameField.value),
            });
        }
        return layers.length > 0 ? layers : undefined;
    }
    catch {
        return undefined;
    }
}
