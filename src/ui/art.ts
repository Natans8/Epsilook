/**
 * @file The small vendored art the interface may draw beside a word.
 *
 * A closed vocabulary sometimes has a picture the reader already knows better than the word — an expansion's
 * badge is recognised at a glance where `wod` has to be read and decoded. So an offer may carry a cosmetic,
 * and this is where the ones we ship are declared: the surface itself stays free of art of its own.
 *
 * The files are VENDORED under `site/img/expansions/`, not hotlinked, and their extensions differ because the
 * source's do — which is why this maps to a NAME rather than deriving one from the word.
 */

/** The expansion badges, in ladder order: the first entry is the first expansion. */
const EXPANSION_ART: readonly string[] = [
    "vanilla.png", "tbc.gif", "wotlk.png", "cata.png", "mop.png", "wod.png",
    "legion.png", "bfa.png", "shadowlands.png", "dragonflight.png", "tww.png", "midnight.png",
];

/**
 * The badge for each expansion of a ladder, by the word that names it.
 *
 * The ladder arrives in order, so its position IS the expansion's number — the same key the art is filed
 * under. A ladder longer than the art we ship simply stops carrying badges at that point.
 *
 * @param rungs The expansions as the pack spells them, lowest first.
 * @param base Where the site's files are served from.
 * @returns The badge URL for every rung that has one.
 */
export function expansionArt(rungs: readonly string[], base: string): Readonly<Record<string, string>> {
    const held: Record<string, string> = {};
    for (const [at, rung] of rungs.entries()) {
        const file = EXPANSION_ART[at];
        if (file !== undefined) held[rung] = `${base}img/expansions/${file}`;
    }
    return held;
}
