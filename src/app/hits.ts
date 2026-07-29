import type {MechanicRow, FileEntry} from "../data";
import type {QueryGroup, QueryToken} from "../search";
import {activeData, state} from "./state";
import type {HitToken} from "./state";
import * as P from "../pills";
import * as Search from "../search";
/**
 * The query tokens that can highlight in a given field's column — the
 * field's own plus the unscoped free text.
 */
export function tokensFor(field: string): HitToken[] {
    return state.tokens.filter((t) => t.field === field || t.field === "all");
}

/**
 * As tokensFor, but whole (positive) groups — a hit must satisfy every
 * token of at least one of them.
 */
function groupsFor(field: string): QueryGroup[] {
    return state.groups.filter((g) => !g.not && (g.field === field || g.field === "all"));
}

/**
 * Does any positive chip of `field` accept this entity?
 *
 * `test` receives ONE combination of a chip's tokens, with alternation
 * already distributed by the engine — so a hit test never has to know that
 * `|` exists, exactly as the matchers in search.js don't. Every hit test in
 * this file goes through here, and that is what keeps highlighting in step
 * with selection: a pill can only light up under a combination that could
 * have selected its spell.
 */
export function anyGroup(field: string, test: (tokens: QueryToken[]) => boolean): boolean {
    return groupsFor(field).some((g) => Search.combosOf(g).some(test));
}

/**
 * Did a positive chip of `field` NAME this category word outright — as a
 * whole token, not as a fragment of some longer value?
 *
 * This is the "full keyword hit" test hitsFirst ranks on. Equality, not
 * substring, is the whole point: `mech:speed` names the speed category,
 * while `mech:spe` merely reaches it (and reaches half the enum names too),
 * so only the first has earned the top of the cell.
 */
export function wordIsNamed(field: string, word: string): boolean {
    if (!word) return false;
    return anyGroup(field, (ts) => ts.some((t) => t.text === word));
}

// hit = the entity fully satisfies at least one chip of its field
export function fileIsHit(file: FileEntry | undefined, field: string): boolean {
    if (!file) return false;
    return anyGroup(field, (ts) => ts.every((t) => file.searchL.includes(t.text)));
}

// kit ids live in the sound:/anim: fields since the soundkit:/animkit:
// merge — a chip's numeric tokens hit the kit whose id they equal
export function kitIsHit(kitId: number, field: string): boolean {
    const searchField = field === "soundkit" ? "sound" : "anim";
    return anyGroup(searchField, (ts) => ts.some((t) => Number(t.text) === kitId));
}

// anim pills can be hit through their group's category word too — the
// headless groups carry one ("replace", "passenger"); kit groups pass "".
// Mirrors spellsByAnim's token test.
export function animIsHit(animId: number, groupWord = ""): boolean {
    const nameL = activeData().animNamesL[animId];
    return anyGroup("anim", (ts) =>
        ts.every((t) => groupWord.includes(t.text) || nameL.includes(t.text)));
}

// a replacement pill is a hit when either side's anim matches the query,
// under the "replace" word or by anim name. It lives here rather than beside
// its renderer because tags.ts wants it and render.ts is the only thing tags
// would otherwise have to import — one line was the whole of the cycle
// between the two biggest modules.
export const replaceAnimHit = (a: number): boolean => animIsHit(a, "replace");

/* A mechanic pill matches when any mech: group is satisfied by the names on
   * that ROW — effect, aura and implicit targets together. Row-level rather
   * than name-level, so mech:"school_damage unit_target_enemy" lights the one
   * effect that is both, not every row that has either. */
export function mechanicIsHit(row: MechanicRow): boolean {
    const d = activeData();
    const corpus = [
        d.effectNamesL.get(row.effect), d.auraNamesL.get(row.aura),
        d.implicitTargetNamesL.get(row.targetA), d.implicitTargetNamesL.get(row.targetB),
    ].filter(Boolean).join(" ");
    return anyGroup("mech", (ts) => ts.every((t) => corpus.includes(t.text)));
}

/* Every fx pill lights up through ONE matcher — the pill-type registry's
   * (src/pilltypes.ts), which is the same one spellsByFx selects spells
   * with. Before, each of these was a hand-written twin of a scan loop in
   * search.js, with comments asking the next person to keep them in lockstep;
   * a pill can now only light up under a query that really selected it.
   *
   * Each name below is that matcher bound to one type, so the renderers read
   * as before and a typo'd type key fails loudly at load, not silently at
   * match time. A pill id's shape varies per type, hence the `any`. */
function isHitOf(key: string): (id?: any) => boolean {
    const type = P.TYPES.get(key);
    if (!type) throw new Error(`unknown pill type "${key}"`);
    // id is optional: valueless pill types (freeze, camo) call with no id
    return (id: any = undefined) =>
        anyGroup(type.field, (ts) => P.idMatches(type, activeData(), id, ts));
}

export const fxChainIsHit = isHitOf("fx:chain");
export const dissolveIsHit = isHitOf("fx:dissolve");
export const glowIsHit = isHitOf("fx:glow");
export const shadowyIsHit = isHitOf("fx:shadowy");
export const ghostMatIsHit = isHitOf("fx:ghostmat");
export const tintIsHit = isHitOf("fx:tint");
export const desatIsHit = isHitOf("fx:desaturate");
export const transpIsHit = isHitOf("fx:transparency");
export const freezeIsHit = isHitOf("fx:freeze");
export const camoIsHit = isHitOf("fx:camo");
export const screenIsHit = isHitOf("fx:screen");
export const shapeshiftIsHit = isHitOf("fx:shapeshift");
export const morphIsHit = isHitOf("fx:morph");
export const keybindIsHit = isHitOf("fx:keybind");
/** A gameobject-spawn pill keys on the gameobject_template entry. */
export const objectIsHit = isHitOf("fx:object");
/** A mount pill keys on the CreatureDisplayID it rides on. */
export const mountIsHit = isHitOf("model:mount");
/** A speed pill keys on the (movement, percent) pair it displays. */
export const speedIsHit = isHitOf("fx:speed");
/** A scale pill keys on the percent, which is all it displays. */
export const scaleIsHit = isHitOf("fx:scale");
/** Summons key on the (creature, control) pair the pill actually shows. */
const summonPairIsHit = isHitOf("fx:summon");
export const summonIsHit = (creatureId: number, control: number): boolean =>
    summonPairIsHit(creatureId + ":" + control);
/** Both sides of an invisibility channel key on the invisibility TYPE. */
const invisIsHit = isHitOf("fx:invis"), detectIsHit = isHitOf("fx:detect");
export const channelIsHit = (side: string, type: number): boolean =>
    (side === "invis" ? invisIsHit : detectIsHit)(type);

/* The one fx pill the registry cannot decide alone: a seat pill is ONE
   * attachment point, while the registry's corpus is per-VEHICLE (every seat
   * name it has). Matching by vehicle would light every point of a vehicle
   * when the query names one of them. The seat count still comes from the
   * registry's numeric axis, so the two halves cannot disagree about it. */
export function vehicleIsHit(attachment: string, seats: number): boolean {
    const nameL = (attachment || "").toLowerCase();
    // "mech", not "fx": this is the one migrated category whose hit test is
    // hand-written rather than derived from the registry via isHitOf, so it
    // is the one place the column move had to be repeated by hand.
    return anyGroup("mech", (ts) => ts.every((t) =>
        "seat".includes(t.text) || nameL.includes(t.text)
        || P.matchNumeric(t.text, seats)));
}
