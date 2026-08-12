/* Hand-written declaration for the vendored CSS named-colour list
 * (colorjs/color-name, MIT). The .js beside it is upstream's body verbatim;
 * tsc reads this instead, and only the surface the colour adapter uses is
 * declared. */

declare const colors: Readonly<Record<string, readonly [number, number, number]>>;

export default colors;
