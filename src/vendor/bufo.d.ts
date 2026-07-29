/* Hand-written declaration for the vendored byte-buffer helper
 * (Kruithne/node-bufo, MIT) — js-blp's only dependency. Nothing in src/
 * touches Bufo directly, so the surface declared here is just what js-blp.js
 * needs to import. */

declare class Bufo {
    constructor(input: ArrayBuffer | ArrayLike<number> | Bufo | string | DataView | number);

    readonly byteLength: number;
}

export default Bufo;
