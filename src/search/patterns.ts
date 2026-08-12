/**
 * @file The one compiler for `/…/` patterns, shared by the language's two sides.
 *
 * The parser validates a pattern through this and the evaluator runs what it returns, so the flags can never
 * disagree — case-insensitive always (the family convention), unicode-strict. Living in its own module keeps the
 * parser free of the matcher, which the layer guard enforces.
 */

/**
 * Compiled patterns, memoised: one query tests one pattern against many rows, and the parser's validation of a
 * pattern seeds the entry its evaluation will use. A string records a pattern that does not compile — the engine's
 * own complaint — so a bad one costs a single throw. The size cap only bounds a long typing session's churn;
 * recompiling after a clear is deterministic and cheap.
 */
const PATTERNS = new Map<string, RegExp | string>();

/**
 * Escapes text for literal use inside a regular expression, including inside a character class.
 *
 * @param text The literal text.
 * @returns The text with every metacharacter escaped.
 */
export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);
}

/**
 * Compiles a pattern's source, memoised.
 *
 * @param source A regular expression's source, as written between the slashes.
 * @returns The compiled pattern, or why it will not compile.
 */
export function compilePattern(source: string): RegExp | string {
    let pattern = PATTERNS.get(source);
    if (pattern === undefined) {
        if (PATTERNS.size > 512) PATTERNS.clear();
        try {
            pattern = new RegExp(source, "iu");
        } catch (error) {
            pattern = error instanceof Error ? error.message : String(error);
        }
        PATTERNS.set(source, pattern);
    }
    return pattern;
}
