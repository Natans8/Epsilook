/* Hand-written declaration for the vendored .blp decoder (Kruithne/js-blp,
 * MIT). The .js beside it is what esbuild bundles; tsc reads this instead —
 * the vendored body is upstream's and stays out of type checking. Only the
 * surface texture.ts actually uses is declared. */

declare class BLPFile {
    constructor(buf: ArrayBuffer);

    readonly width: number;
    readonly height: number;

    /** Decode one mip level; with a canvas, draws the pixels straight into it. */
    getPixels(mipmap: number, canvas?: HTMLCanvasElement | null): Uint8Array;
}

export default BLPFile;
