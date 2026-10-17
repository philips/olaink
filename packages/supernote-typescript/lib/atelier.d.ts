import { SqlJsConfig } from 'sql.js';
import { Image } from 'image-js';
/**
 * Support for `.spd` files created by the Supernote Atelier app.
 *
 * Unlike `.note` files (see `SupernoteX`), a `.spd` file is a plain SQLite
 * database. Its schema and the meaning of several `config` entries are not
 * publicly documented; the layout used here was reverse-engineered from
 * https://github.com/Ziv-Ink/Atelier-parser, a community tool that writes
 * `.spd` files, and cross-checked against a real device-generated `.spd`
 * file (which is how the dynamic `surface_*` naming and `surface.width`/
 * `surface.height` config entries below were found; that tool only ever
 * writes `surface_1`/`surface_2` and doesn't set those two keys at all). The
 * `ls` layer list is still a best-effort decode: its format is unconfirmed.
 */
/** A single Atelier canvas tile, as stored in a `surface_*` table. */
export interface IAtelierTile {
    /** Tile id. Encodes the tile's grid position (see `toImage`). */
    tid: number;
    /** PNG-encoded tile image content. */
    bitmapBuffer: Uint8Array;
}
/** Viewport position/zoom the editor had open, decoded from `vp.x`/`vp.y`/`vp.scale`. */
export interface IAtelierViewport {
    x: number;
    y: number;
    scale: number;
}
/** Canvas pixel size, decoded from `surface.width`/`surface.height`. Tiles are
 * only stored for grid cells that have been drawn on, so this can be larger
 * than the bounding box of any one surface's own tiles (see `toImage`). */
export interface IAtelierCanvasSize {
    width: number;
    height: number;
}
/** A layer entry decoded from the `ls` config value.
 * Best-effort: `ls`'s format isn't documented, see the module doc comment.
 * `id` matches the numeric suffix of the corresponding `surface_{id}` table,
 * e.g. `{ id: 9999, name: 'Reference Layer' }` pairs with `surface_9999`. */
export interface IAtelierLayer {
    id: number;
    name: string;
}
/** Name of a tile table found in a `.spd` file, e.g. `surface_1`. Real files
 * aren't limited to `surface_1`/`surface_2`: layers can use arbitrary
 * `surface_{layerId}` names (a "Reference Layer" observed in a real file used
 * `surface_9999`), so this is whatever `surface_*` tables the file has. */
export type IAtelierSurfaceName = string;
/** Parsed Supernote Atelier `.spd` file. */
export declare class SupernoteAtelier {
    fmtVer?: number;
    thumbnailBuffer: Uint8Array | null;
    viewport?: IAtelierViewport;
    /** Canvas pixel size, decoded from `surface.width`/`surface.height`. */
    canvasSize?: IAtelierCanvasSize;
    layers?: IAtelierLayer[];
    /** Every `config` entry as raw bytes, keyed by name, for values not
     * otherwise exposed (e.g. `frames`) or when the best-effort decodes above
     * come back empty. */
    config: Record<string, Uint8Array>;
    /** Tiles per surface, keyed by surface name (e.g. `surface_1`). */
    surfaces: Record<IAtelierSurfaceName, IAtelierTile[]>;
    /** Tile grid bounds shared across every surface in the file, so that
     * images from different surfaces line up when composited (see `toImage`).
     * `null` if the file has no tiles at all. */
    private _gridBounds;
    private constructor();
    /**
     * Parse a `.spd` file's contents.
     * @param buffer Raw file contents.
     * @param sqlJsConfig Passed through to `sql.js`'s `initSqlJs`, e.g. to
     * supply `locateFile` when bundling for the browser.
     */
    static open(buffer: Uint8Array, sqlJsConfig?: SqlJsConfig): Promise<SupernoteAtelier>;
    /** Read every row of the `config` table into a name -> bytes map. */
    private _parseConfig;
    private _parseFmtVer;
    private _parseThumbnail;
    private _parseViewport;
    private _parseLayers;
    private _parseCanvasSize;
    /** Read every row of every `surface_{n}` tile table found in the file.
     * Real files aren't limited to `surface_1`/`surface_2` (e.g. an imported
     * background "Reference Layer" was observed in a real file as
     * `surface_9999`, its `ls` layer id), so the tables to read are
     * discovered from `sqlite_master` rather than assumed. */
    private _parseSurfaces;
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
    toImage(surfaceName?: IAtelierSurfaceName): Promise<Image | null>;
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
    toCompositeImage(visibleSurfaces?: Iterable<IAtelierSurfaceName>): Promise<Image | null>;
    /** Bottom-to-top surface names to composite in `toCompositeImage`. */
    private _compositeOrder;
}
