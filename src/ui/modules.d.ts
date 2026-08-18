/**
 * CSS Modules, as esbuild bundles them: importing a `*.module.css` file yields its local class names.
 */
declare module "*.module.css" {
    const classes: Record<string, string>;
    export default classes;
}

/**
 * `regex-colorizer`, which ships no types: the one call this app makes, and its options.
 *
 * Declared rather than depended on through `@types` because the package has none published; the shape is read
 * from its own JSDoc.
 */
declare module "regex-colorizer" {
    /** Returns HTML for the pattern with its syntax marked up. */
    export function colorizePattern(pattern: string, options?: {flags?: string}): string;
}
