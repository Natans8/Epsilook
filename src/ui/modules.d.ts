/**
 * CSS Modules, as esbuild bundles them: importing a `*.module.css` file yields its local class names.
 */
declare module "*.module.css" {
    const classes: Record<string, string>;
    export default classes;
}
