/**
 * @file Shared argument reading for the search CLIs.
 *
 * A query may itself start with a dash — negation is language syntax — so flags stop at the first argument that is
 * not a declared flag and everything after is an operand, the way grep and git treat theirs. A leading `--`
 * separator between the flags and the operands is tolerated.
 */

/**
 * Reads the process arguments as declared flags followed by operands.
 *
 * @param known Every flag the CLI accepts, spelled with its dashes.
 * @returns The flags found before the first operand, and every operand after them.
 */
export function cliArgs(known: readonly string[]): { flags: ReadonlySet<string>; positionals: string[] } {
    const args = process.argv.slice(2);
    const flagCount = args.findIndex((arg) => !known.includes(arg));
    const flags = args.slice(0, flagCount < 0 ? args.length : flagCount);
    const positionals = args.slice(flags.length).filter((arg, i) => !(i === 0 && arg === "--"));
    return {flags: new Set(flags), positionals};
}
