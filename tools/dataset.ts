/**
 * @file The pack-backed {@link Dataset}: search 2.0's row model, read out of the shipped pack.
 *
 * A temporary bridge: it reshapes 1.0's loaded indexes ({@link SpellData}) into the rows the kernel evaluates, so
 * the battery and the bench can run the real pack through `run()` before the pack itself ships rows. Once it does,
 * `rows()` becomes a read and the reshaping half of this file goes away.
 *
 * It lives in tools/ for the reason tools/query.ts does: everything under src/ must be reachable from src/main.ts,
 * and nothing in the app drives the 2.0 engine yet.
 *
 * One deliberate gap remains, waiting on data the pack does not carry in the needed shape rather than on code
 * here: an alternative name (SpellOverrideName) reaches 1.0's corpus but no 2.0 row, because SpellData folds it
 * into `namesL` and keeps no per-spell list to build a row from.
 */
import type {RowAt, RowIndex, RowTable} from "../src/packrows";
import {indexRows, storedAt} from "../src/packrows";
import type {SpellData, VersionEntry} from "../src/data";
import {buildIndexes, DELIVERY_BREAKS_ON_MOVE, DELIVERY_CHANNELLED} from "../src/data";
import {pickVersion, readPack} from "./packfile";

import type {
    Ask, Column, Dataset, Kind, Row, RowSource, RowTest, ScopeTerm, Stored, ValueExpr,
} from "../src/search/index";
import {
    animColumn, catalogue, colour as colourType, COLOUR_NAMES, fold, fxColumn, id as idType, idColumn, KINDS,
    mechColumn, modelColumn, setOrdinalLadder, soundColumn, spellColumn, squash, TARGET_ROLES,
    text as textType, wordOf,
} from "../src/search/index";

// The kinds this file builds rows for, under their own names. Taken off the catalogue rather than off the door, which
// carries it as a namespace so the game's nouns do not crowd out the language's.
const {
    animKit, attached, aura, barrage, camo, chain, debuff, delivery, description, desaturate, detect, display,
    dissolve, effect, equipped, expansion, freeze, gameObject, ghost, glow, ground, icon, invis, item, keybind,
    location, loose, missile, morph, mount, name: nameKind, origin, passenger, pose, replace, scale, screen,
    seats, shadowy, shapeshift, sound: soundKind, speed, spellId: spellIdKind, summon, tint, tracking, trail,
    transparency, triggers,
} = catalogue;

/**
 * Loads one shipped pack and builds 1.0's indexes over it.
 *
 * @param want A version prefix such as `9.2.7`, or nothing for the default pack.
 * @returns The indexed data and its roster entry.
 * @throws If no pack matches.
 */
export function loadPack(want?: string): { data: SpellData; entry: VersionEntry } {
    const entry = pickVersion(want);
    return {data: buildIndexes(readPack(entry)), entry};
}

const row = (kind: Kind, props: Record<string, Stored>): Row => ({kind, props});

/* ------------------------------------------------------------------- the row tables, read */

/**
 * One column's rows, read out of the pack rather than rebuilt from it.
 *
 * The pack pools the distinct rows of each kind, so a materialised {@link Row} is cached per POOL SLOT and every spell
 * that has that row shares the one object. The cache is therefore bounded by how many different rows the build has,
 * not by how many times spells use them — measured on Shadowlands, 379 thousand against 1.73 million — and a second
 * query over the same rows allocates nothing at all.
 *
 * This is what `Column.rows()` being a read means: the reshaping the bridge used to do per call happened in the build.
 */
class PackRowSource implements RowSource {
    private readonly index: RowIndex;
    private readonly built: (Row | undefined)[];

    constructor(private readonly table: RowTable, private readonly kinds: Map<string, Kind>,
                private readonly vocabs: Record<string, (value: number) => string | undefined>) {
        this.index = indexRows(table);
        this.built = Array.from<Row | undefined>({length: this.index.owner.length});
    }

    rows(spell: number): readonly Row[] {
        const out: Row[] = [];
        for (let i = this.index.at[spell]; i < this.index.at[spell + 1]; i++) {
            const ref = this.table.refs[i];
            out.push(this.built[ref] ??= this.materialise(this.index.owner[ref]));
        }
        return out;
    }

    /** How many rows the spell has, straight off the shipped counts. */
    size(spell: number): number {
        return this.table.counts[spell];
    }

    /**
     * One pooled row as the kind it is.
     *
     * What a stored number MEANS is the catalogue's to say, never the pack's: a property whose first two notations are
     * an id and a name carries both, one whose first notation is textual carries the text alone, and anything else is
     * the number itself. That split is read off the declaration, so a property that gains a notation needs no edit
     * here.
     */
    private materialise(at: RowAt): Row {
        const kind = this.kinds.get(at.kind);
        if (!kind) throw new Error(`pack ships rows of unknown kind "${at.kind}"`);
        const props: Record<string, Stored> = {};
        for (const [name, prop] of Object.entries(kind.props)) {
            const stored = storedAt(this.table, at, name);
            if (stored === undefined) continue;
            const lookup = this.vocabs[this.table.vocab[at.kind]?.[name] ?? ""];
            const text = lookup?.(stored);
            if (prop.types[0] === idType && prop.types[1] === textType) {
                props[name] = text === undefined ? stored : {id: stored, text};
            } else if (lookup !== undefined) {
                if (text !== undefined && text !== "") props[name] = text;
            } else {
                props[name] = stored;
            }
        }
        return row(kind, props);
    }
}

/**
 * The kinds of one column, by the word the pack names them with.
 *
 * @throws If the pack ships a kind this build has no declaration for — a pack and a catalogue that disagree must fail
 *   loudly, because the silent alternative is rows quietly vanishing from every answer.
 */
function kindsOf(column: Column): Map<string, Kind> {
    const out = new Map<string, Kind>();
    for (const kind of KINDS.values()) {
        if (kind.column === column) out.set(wordOf(kind), kind);
    }
    return out;
}

/** A mask joins a row's props only when it says something: 0 means the pack has no answer, not "plays on nobody". */
const withMask = (props: Record<string, Stored>, mask: number | undefined): Record<string, Stored> => {
    if (mask) props.target = mask;
    return props;
};

/* ------------------------------------------------------------------- the row sources, one builder per column */

function spellRows(d: SpellData, i: number): Row[] {
    const id = d.ids[i];
    const rows: Row[] = [row(nameKind, {text: d.names[i]})];
    if (d.subtexts[i]) rows.push(row(nameKind, {text: d.subtexts[i]}));
    for (const [pool, of] of [
        [d.descriptionText, d.descriptionOf], [d.encounterText, d.encounterOf], [d.auraText, d.auraOf],
    ] as const) {
        const at = of[i];
        if (at) rows.push(row(description, {text: pool[at]}));
    }
    if (d.icons[i]) {
        const props: Record<string, Stored> = {name: d.icons[i]};
        const fid = d.iconFids[d.iconOf[i] - 1];
        if (fid) props.fid = fid;
        rows.push(row(icon, props));
    }

    // Delivery exists only where the pack ships it; on such packs every spell has one row, because "instant" is the
    // complement, not a shipped list. A channel-only spell carries no cast value at all — `cast:instant` means "no
    // bar", and a channel is not a bar.
    if (d.spellDelivery.size) {
        const del = d.spellDelivery.get(id);
        const props: Record<string, Stored> = {};
        if (!del) props.cast = 0;
        else {
            if (del.castMs > 0) props.cast = del.castMs;
            if (del.flags & DELIVERY_CHANNELLED) props.channel = del.durMs;
            if (del.flags & DELIVERY_BREAKS_ON_MOVE) props.breaksmove = 1;
        }
        if (d.spellAttrs.get("unbreakablechannel")?.has(id)) props.unbreakable = 1;
        if (d.spellAttrs.get("actionsduringchannel")?.has(id)) props.unhindered = 1;
        rows.push(row(delivery, props));
    }
    return rows;
}

function idRows(d: SpellData, i: number): Row[] {
    const rows: Row[] = [row(spellIdKind, {value: d.ids[i]})];
    const era = d.eras[i];
    if (era >= 0 && d.expansions[era]) rows.push(row(expansion, {rung: d.expansions[era].key}));
    return rows;
}

/**
 * The model categories the pack numbers, resolved to kinds once. The unnamed category is the plain attached model.
 *
 * @throws If a category word matches no kind — a new pack category or a renamed kind word must fail loudly, because
 *   the silent alternative is rows evaluating under the wrong kind.
 */
function catKinds(d: SpellData): Map<number, Kind> {
    const byWord = new Map<string, Kind>(
        [missile, ground, trail, barrage, display, item].map((kind) => [kind.word ?? "", kind]));
    const out = new Map<number, Kind>();
    for (const [cat, word] of Object.entries(d.modelCatNames)) {
        const kind = word === "" ? attached : byWord.get(word);
        if (!kind) throw new Error(`no model kind for pack category "${word}"`);
        out.set(Number(cat), kind);
    }
    return out;
}

function fxRows(d: SpellData, i: number): Row[] {
    const id = d.ids[i];
    const rows: Row[] = [];
    /** One row per texture, sharing the entry's other props; one row with none when the entry has no texture. */
    const perTexture = (kind: Kind, fids: readonly number[] | undefined,
                        props: Record<string, Stored>, mask: number | undefined): void => {
        const paths = (fids ?? []).map((fid) => d.files.get(fid)?.path).filter((p): p is string => !!p);
        if (paths.length === 0) {
            rows.push(row(kind, withMask({...props}, mask)));
            return;
        }
        for (const path of paths) rows.push(row(kind, withMask({...props, texture: path}, mask)));
    };
    const attachName = (a: number | undefined): string | null =>
        a === undefined ? null : (a < 0 ? "full body" : (d.attachmentNames[a] || null));

    for (const r of d.spellChainRows.get(id) ?? []) {
        const props: Record<string, Stored> = {};
        if (r.src >= 0 && d.attachmentNames[r.src]) props.from = d.attachmentNames[r.src];
        if (r.dst >= 0 && d.attachmentNames[r.dst]) props.to = d.attachmentNames[r.dst];
        const info = d.fxChains.get(r.chain);
        // 0xFFFFFF means untinted — the texture's own colour, which is no colour to search by.
        if (info && info.color !== 0xffffff) props.colour = info.color;
        perTexture(chain, d.fxTextures.get(r.chain), props, d.fxTargets.get(id)?.get(r.chain));
    }
    for (const dis of d.spellDissolves.get(id) ?? []) {
        const props: Record<string, Stored> = {};
        const at = attachName(d.dissolveAttach.get(dis));
        if (at) props.attach = at;
        perTexture(dissolve, d.dissolveTextures.get(dis), props, d.dissolveTargets.get(id)?.get(dis));
    }
    for (const sh of d.spellShadowies.get(id) ?? []) {
        const props: Record<string, Stored> = {};
        const at = attachName(d.shadowyAttach.get(sh));
        if (at) props.attach = at;
        // The primary of the two: the secondary is the pass's falloff, not a second answer to "what colour".
        const tone = d.shadowyColors.get(sh);
        if (tone) props.colour = tone.primary;
        rows.push(row(shadowy, withMask(props, d.shadowyTargets.get(id)?.get(sh))));
    }
    for (const gm of d.spellGhostMats.get(id) ?? []) {
        const props: Record<string, Stored> = {};
        const tone = d.ghostMatColors.get(gm);
        if (tone !== undefined) props.colour = tone;
        rows.push(row(ghost, withMask(props, d.ghostMatTargets.get(id)?.get(gm))));
    }
    for (const g of d.spellGlows.get(id) ?? []) {
        const props: Record<string, Stored> = {};
        const colour = d.glowColors.get(g);
        if (colour !== undefined) props.colour = colour;
        rows.push(row(glow, withMask(props, d.glowTargets.get(id)?.get(g))));
    }
    for (const t of d.spellTints.get(id) ?? []) {
        const colour = d.tintColors.get(t);
        rows.push(row(tint, withMask(colour === undefined ? {} : {colour},
            d.tintTargets.get(id)?.get(t))));
    }
    for (const pct of d.spellTransps.get(id) ?? []) {
        rows.push(row(transparency, withMask({percent: pct},
            d.transparencyTargets.get(id)?.get(pct))));
    }
    for (const pct of d.spellDesaturates.get(id) ?? []) {
        rows.push(row(desaturate, withMask({percent: pct},
            d.desaturateTargets.get(id)?.get(pct))));
    }
    if (d.spellFreezes.has(id)) rows.push(row(freeze, {}));
    if (d.spellCamos.has(id)) rows.push(row(camo, {}));
    for (const c of d.spellMorphs.get(id) ?? []) {
        const named = d.morphNames.get(c);
        rows.push(row(morph, withMask(
            {display: named ? {id: c, text: named} : c}, d.morphTargets.get(id)?.get(c))));
    }
    for (const f of d.spellShapeshifts.get(id) ?? []) {
        const form = d.shapeshiftNames.get(f);
        rows.push(row(shapeshift, withMask(form ? {form} : {},
            d.shapeshiftTargets.get(id)?.get(f))));
    }
    for (const e of d.spellScaleMods.get(id) ?? []) {
        rows.push(row(scale, withMask({amount: e.pct}, e.mask)));
    }
    for (const e of d.spellSummons.get(id) ?? []) {
        const named = d.summonNames.get(e.creatureId);
        const props: Record<string, Stored> = {
            creature: named ? {id: e.creatureId, text: named} : e.creatureId,
        };
        const control = d.summonControlNames[e.control];
        if (control) props.control = control;
        rows.push(row(summon, withMask(props, d.summonTargets.get(id)?.get(e.creatureId))));
    }
    for (const obj of d.spellObjects.get(id) ?? []) {
        const named = d.objectNames.get(obj);
        rows.push(row(gameObject, withMask(
            {object: named ? {id: obj, text: named} : obj}, d.objectTargets.get(id)?.get(obj))));
    }
    for (const sc of d.spellScreens.get(id) ?? []) {
        perTexture(screen, (d.screenTextures.get(sc) ?? []).map((t) => t.fid), {},
            d.screenTargets.get(id)?.get(sc));
    }
    if (d.spellAttrs.get("tracktargetinchannel")?.has(id)) rows.push(row(tracking, {}));
    return rows;
}

function mechRows(d: SpellData, i: number): Row[] {
    const id = d.ids[i];
    const rows: Row[] = [];
    // One 1.0 mechanic row is one SpellEffect carrying both halves; the 2.0 kinds split them, so an APPLY_AURA row
    // yields an effect row and an aura row sharing the mask.
    for (const m of d.spellMechanics.get(id) ?? []) {
        if (m.effect) {
            const named = d.effectNames.get(m.effect);
            rows.push(row(effect, withMask(named ? {name: named} : {}, m.mask)));
        }
        if (m.aura) {
            const named = d.auraNames.get(m.aura);
            rows.push(row(aura, withMask(named ? {name: named} : {}, m.mask)));
        }
    }
    const linkName = (other: number): string => {
        const at = d.spellIndex.get(other);
        return at === undefined ? "" : d.names[at];
    };
    for (const [kind, links] of [[triggers, d.spellTriggers], [origin, d.spellOrigins]] as const) {
        for (const l of links.get(id) ?? []) {
            const named = linkName(l.spell);
            const spell: Stored = named ? {id: l.spell, text: named} : l.spell;
            // One row per word the edge prints: a pair joined two ways is two facts, which is the grain the pack
            // ships and the only one on which `how:periodically` can select.
            if (l.kinds.length === 0) rows.push(row(kind, withMask({spell}, l.mask)));
            for (const word of l.kinds) rows.push(row(kind, withMask({spell, how: word}, l.mask)));
        }
    }
    for (const areaId of d.spellAreas.get(id) ?? []) {
        const named = d.areaNames.get(areaId);
        rows.push(row(location, named ? {area: named} : {}));
    }
    for (const e of d.spellInvisTypes.get(id) ?? []) {
        rows.push(row(invis, withMask({channel: e.type}, d.invisTargets.get(id)?.get(e.type))));
    }
    for (const e of d.spellDetectTypes.get(id) ?? []) {
        rows.push(row(detect, withMask(
            {channel: e.type, count: d.invisTypeSpells.get(e.type)?.length ?? 0},
            d.detectTargets.get(id)?.get(e.type))));
    }
    for (const v of d.spellVehicles.get(id) ?? []) {
        const seatNames = d.vehicleSeats.get(v) ?? [];
        // Each row carries the vehicle's whole seat count beside one seat's attachment, so a scope can bind both.
        const mask = d.vehicleTargets.get(id)?.get(v);
        if (seatNames.length === 0) rows.push(row(seats, withMask({count: 0}, mask)));
        for (const attach of seatNames) {
            rows.push(row(seats, withMask(
                attach ? {count: seatNames.length, attach} : {count: seatNames.length}, mask)));
        }
    }
    for (const e of d.spellSpeedMods.get(id) ?? []) {
        rows.push(row(speed, withMask({amount: e.pct, mode: e.move}, e.mask)));
    }
    for (const o of d.spellKeybinds.get(id) ?? []) {
        const kb = d.keybinds.get(o);
        if (kb) {
            rows.push(row(keybind, withMask({key: `${kb.fn} ${kb.when}`.trim()},
                d.keybindTargets.get(id)?.get(o))));
        }
    }
    if (d.spellAttrs.get("auraisdebuff")?.has(id)) rows.push(row(debuff, {}));
    return rows;
}

/* ------------------------------------------------------------------- the inverted side: candidates() */

/** A vocabulary entry: one squashed haystack, and the spell indexes any match seeds. */
interface Vocab {
    readonly sq: string;
    readonly spells: readonly number[];
}

/** Adds one value to the set at `map[key]`, creating the set on first use. */
function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    let set = map.get(key);
    if (!set) map.set(key, set = new Set());
    set.add(value);
}

/** The union of every vocabulary hit for one squashed token, into `into`. */
function probeVocab(vocabs: readonly Vocab[], token: string, into: Set<number>): void {
    for (const v of vocabs) {
        if (!v.sq.includes(token)) continue;
        for (const at of v.spells) into.add(at);
    }
}

/**
 * Everything `candidates()` probes, built once per dataset.
 *
 * The vocabularies are what make a seed cheap: scanning 33k file paths or 79k deduped descriptions is two orders of
 * magnitude less work than materialising every spell's rows — the measured case for narrowing before walking. Every
 * haystack is squashed with the matcher's own `squash`, because a seed built under a different normalisation than
 * the verifier's would silently lose answers.
 */
interface Inverted {
    /** Spell indexes with any row, per column; spell and id are total and stay unseeded. */
    readonly presence: ReadonlyMap<Column, ReadonlySet<number>>;
    /** Spell indexes with any row of the kind. */
    readonly kindPresence: ReadonlyMap<Kind, ReadonlySet<number>>;
    /** Per-spell squashed name corpus (name + subtext + alt names), scanned flat — measured too cheap to index. */
    readonly namesSq: readonly string[];
    /** The three prose pools, squashed, with their per-spell index arrays. */
    readonly pools: readonly { sq: readonly string[]; of: readonly number[] }[];
    readonly iconsSq: readonly string[];
    /** Every corpus vocabulary that can answer a plain term, one flat list. */
    readonly plainVocab: readonly Vocab[];
    /** Content vocabularies per column, for the columns whose whole content surface is enumerable. */
    readonly content: ReadonlyMap<Column, readonly Vocab[]>;
    /** Column content that answers a whole number by identity: linked spells, channels, kit ids, refs. */
    readonly digits: ReadonlyMap<Column, (n: number) => Iterable<number>[]>;
    /** Kinds whose rows carry a quantity a numeric-looking token could match, per column. */
    readonly numericKinds: ReadonlyMap<Column, readonly Kind[]>;
    /** Kinds whose rows carry a colour a hex triplet or colour name could match, per column. */
    readonly colourKinds: ReadonlyMap<Column, readonly Kind[]>;
}

function invert(d: SpellData, cats: Map<number, Kind>): Inverted {
    const index = (spell: number): number => d.spellIndex.get(spell) ?? -1;
    const indexes = (spellIds: Iterable<number>): number[] =>
        [...spellIds].map(index).filter((at) => at >= 0);

    const presence = new Map<Column, Set<number>>();
    const kindPresence = new Map<Kind, Set<number>>();
    const mark = (column: Column, kind: Kind, spell: number): void => {
        const at = index(spell);
        if (at < 0) return;
        let col = presence.get(column);
        if (!col) presence.set(column, col = new Set());
        col.add(at);
        let per = kindPresence.get(kind);
        if (!per) kindPresence.set(kind, per = new Set());
        per.add(at);
    };
    const markAll = (column: Column, kind: Kind, spellIds: Iterable<number>): void => {
        for (const spellId of spellIds) mark(column, kind, spellId);
    };

    for (const [spellId, entries] of d.spellModelCats) {
        for (const e of entries) {
            const kind = cats.get(e.cat) ?? attached;
            mark(modelColumn, kind === attached && e.fid < 0 ? equipped : kind, spellId);
        }
    }
    markAll(modelColumn, mount, d.spellMounts.keys());
    markAll(soundColumn, soundKind, d.spellSounds.keys());
    markAll(animColumn, animKit, d.spellAnimKits.keys());
    markAll(animColumn, loose, d.spellVisualAnims.keys());
    markAll(animColumn, replace, d.spellReplaceAnims.keys());
    markAll(animColumn, passenger, d.spellPassengerAnims.keys());
    markAll(animColumn, pose, d.spellAttrs.get("preventsanim") ?? []);
    markAll(fxColumn, chain, d.spellChainRows.keys());
    markAll(fxColumn, dissolve, d.spellDissolves.keys());
    markAll(fxColumn, shadowy, d.spellShadowies.keys());
    markAll(fxColumn, ghost, d.spellGhostMats.keys());
    markAll(fxColumn, glow, d.spellGlows.keys());
    markAll(fxColumn, tint, d.spellTints.keys());
    markAll(fxColumn, transparency, d.spellTransps.keys());
    markAll(fxColumn, desaturate, d.spellDesaturates.keys());
    markAll(fxColumn, freeze, d.spellFreezes);
    markAll(fxColumn, camo, d.spellCamos);
    markAll(fxColumn, morph, d.spellMorphs.keys());
    markAll(fxColumn, shapeshift, d.spellShapeshifts.keys());
    markAll(fxColumn, scale, d.spellScaleMods.keys());
    markAll(fxColumn, summon, d.spellSummons.keys());
    markAll(fxColumn, gameObject, d.spellObjects.keys());
    markAll(fxColumn, screen, d.spellScreens.keys());
    markAll(fxColumn, tracking, d.spellAttrs.get("tracktargetinchannel") ?? []);
    for (const [spellId, rows] of d.spellMechanics) {
        for (const m of rows) {
            if (m.effect) mark(mechColumn, effect, spellId);
            if (m.aura) mark(mechColumn, aura, spellId);
        }
    }
    markAll(mechColumn, triggers, d.spellTriggers.keys());
    markAll(mechColumn, origin, d.spellOrigins.keys());
    markAll(mechColumn, location, d.spellAreas.keys());
    markAll(mechColumn, invis, d.spellInvisTypes.keys());
    markAll(mechColumn, detect, d.spellDetectTypes.keys());
    markAll(mechColumn, seats, d.spellVehicles.keys());
    markAll(mechColumn, speed, d.spellSpeedMods.keys());
    markAll(mechColumn, keybind, d.spellKeybinds.keys());
    markAll(mechColumn, debuff, d.spellAttrs.get("auraisdebuff") ?? []);

    const namesSq = d.namesL.map(squash);
    const pools = [
        {sq: d.descriptionText.map(squash), of: d.descriptionOf},
        {sq: d.encounterText.map(squash), of: d.encounterOf},
        {sq: d.auraText.map(squash), of: d.auraOf},
    ];
    const iconsSq = d.iconNames.map(squash);

    /* The vocabularies. Each is a SUPERSET of what its rows' textual props can match — 1.0's per-category corpora
     * carry extra words (hues, hexes, category words) beyond what a 2.0 row stores, which costs verification time
     * and never answers. What a seed must never be is UNDERSIZED, so a column's list includes every vocabulary any
     * of its textual props reads. */
    const vocab = (into: Vocab[], haystacks: Iterable<[string, Iterable<number>]>): void => {
        for (const [text, spellIds] of haystacks) {
            const sq = squash(text);
            if (sq) into.push({sq, spells: indexes(spellIds)});
        }
    };
    /** One corpus map — key to 1.0 search haystack — joined with its parallel key-to-spells map. */
    const corpusVocab = <K, >(into: Vocab[], corpora: ReadonlyMap<K, string>,
                              spells: ReadonlyMap<K, Iterable<number>>): void => {
        vocab(into, [...corpora].map(([key, corpus]): [string, Iterable<number>] =>
            [corpus, spells.get(key) ?? []]));
    };

    const modelVocab: Vocab[] = [];
    vocab(modelVocab, d.modelFids.map((fid) =>
        [d.files.get(fid)?.path ?? "", d.modelSpells.get(fid) ?? []]));
    corpusVocab(modelVocab, d.itemSearchL, d.itemSpells);
    corpusVocab(modelVocab, d.mountSearchL, d.mountSpells);
    // Attachment points and motions are enum props, so a content term reaches them, and a display/item ref is an
    // identity a whole number names; all three index in the same walk.
    const modelRefs = new Map<number, Set<number>>();
    {
        const byAttach = new Map<string, Set<number>>();
        const byMotion = new Map<string, Set<number>>();
        for (const [spellId, entries] of d.spellModelCats) {
            for (const e of entries) {
                if (e.src >= 0 && d.attachmentNames[e.src]) addTo(byAttach, d.attachmentNames[e.src], spellId);
                if (e.dst >= 0 && d.attachmentNames[e.dst]) addTo(byAttach, d.attachmentNames[e.dst], spellId);
                if (e.motion) addTo(byMotion, e.motion, spellId);
                if (e.ref) addTo(modelRefs, e.ref, spellId);
            }
        }
        vocab(modelVocab, byAttach);
        vocab(modelVocab, byMotion);
    }

    const soundVocab: Vocab[] = [];
    vocab(soundVocab, d.soundFids.map((fid) =>
        [d.files.get(fid)?.path ?? "", d.soundSpells.get(fid) ?? []]));
    corpusVocab(soundVocab, d.soundKitName, d.soundKitSpells);

    const animVocab: Vocab[] = [];
    vocab(animVocab, d.animNames.map((animName, animId): [string, Iterable<number>] => [animName, [
        ...(d.visualAnimSpells.get(animId) ?? []),
        ...(d.replaceSpells.get(animId) ?? []),
        ...(d.animAnimKits.get(animId) ?? []).flatMap((kitId) => d.animKitSpells.get(kitId) ?? []),
    ]]));
    // A boneset match is per row, but a seed only needs "some kit of this spell animates the region" — the
    // verification walk answers the per-row half.
    vocab(animVocab, d.bonesetNames.map((boneset): [string, Iterable<number>] => [boneset, (() => {
        const spells: number[] = [];
        for (const [kitId, byAnim] of d.animKitAnimBoneset) {
            for (const names of byAnim.values()) {
                if (names.includes(boneset)) {
                    spells.push(...(d.animKitSpells.get(kitId) ?? []));
                    break;
                }
            }
        }
        return spells;
    })()]));

    const mechVocab: Vocab[] = [];
    // One pass over the flat mechanic arrays builds both reverse maps; a per-name scan would visit them once per
    // enum entry — hundreds of full sweeps of ~372k rows.
    {
        const effectSpells = new Map<number, Set<number>>();
        const auraSpells = new Map<number, Set<number>>();
        const {spellIds, effects, auras} = d.mechanicCols;
        for (let k = 0; k < spellIds.length; k++) {
            if (effects[k]) addTo(effectSpells, effects[k], spellIds[k]);
            if (auras[k]) addTo(auraSpells, auras[k], spellIds[k]);
        }
        corpusVocab(mechVocab, d.effectNames, effectSpells);
        corpusVocab(mechVocab, d.auraNames, auraSpells);
    }
    corpusVocab(mechVocab, d.triggersSearchL, d.triggersSpells);
    corpusVocab(mechVocab, d.originSearchL, d.originSpells);
    corpusVocab(mechVocab, d.areaSearchL, d.areaSpells);
    corpusVocab(mechVocab, d.speedSearchL, d.speedSpells);
    corpusVocab(mechVocab, d.vehicleSearchL, d.vehicleSpells);
    corpusVocab(mechVocab, d.keybindSearchL, d.keybindSpells);

    const fxVocab: Vocab[] = [];
    corpusVocab(fxVocab, d.fxSearchL, d.fxSpells);
    // The chain corpus carries hue and textures but not the beam's attach pair, which is a pair of enum props here.
    {
        const byAttach = new Map<string, Set<number>>();
        for (const [spellId, chainRows] of d.spellChainRows) {
            for (const r of chainRows) {
                for (const at of [r.src, r.dst]) {
                    const word = at >= 0 ? d.attachmentNames[at] : "";
                    if (word) addTo(byAttach, word, spellId);
                }
            }
        }
        vocab(fxVocab, byAttach);
    }
    corpusVocab(fxVocab, d.shadowySearchL, d.shadowySpells);
    corpusVocab(fxVocab, d.dissolveSearchL, d.dissolveSpells);
    corpusVocab(fxVocab, d.screenSearchL, d.screenSpells);
    corpusVocab(fxVocab, d.morphSearchL, d.morphSpells);
    corpusVocab(fxVocab, d.shapeshiftSearchL, d.shapeshiftSpells);
    corpusVocab(fxVocab, d.summonPairSearchL, d.summonPairSpells);
    corpusVocab(fxVocab, d.objectSearchL, d.objectSpells);

    // Plain search reads only the props declared plain, a subset of each column's content, so the union of the
    // content vocabularies is a sound plain seed.
    const plainVocab = [...modelVocab, ...soundVocab, ...animVocab, ...mechVocab, ...fxVocab];

    /* The identity answers for a digit token, per column. A bare number in content dispatches to an id/count
     * notation before text, so a sound seed must answer by identity as well as by substring. The count-typed props
     * (seats, detect) answer with their kind's whole presence: small sets, and a count has no index. */
    const digits = new Map<Column, (n: number) => Iterable<number>[]>();
    digits.set(modelColumn, (n) => [indexes(modelRefs.get(n) ?? [])]);
    digits.set(soundColumn, (n) => [indexes(d.soundKitSpells.get(n) ?? [])]);
    digits.set(animColumn, (n) => [indexes(d.animKitSpells.get(n) ?? [])]);
    digits.set(mechColumn, (n) => [
        indexes(d.triggersSpells.get(n) ?? []),
        indexes(d.originSpells.get(n) ?? []),
        indexes(d.invisTypeSpells.get(n) ?? []),
        indexes(d.detectTypeSpells.get(n) ?? []),
    ]);
    digits.set(fxColumn, (n) => [
        indexes(d.morphSpells.get(n) ?? []),
        indexes(d.objectSpells.get(n) ?? []),
        // A summon's creature id keys the pair map as "creature:control".
        ...[...d.summonPairSpells].filter(([key]) => key.startsWith(`${n}:`))
            .map(([, spellIds]) => indexes(spellIds)),
    ]);

    /* Which kinds a numeric-looking or colour token could match, derived from the declarations rather than listed:
     * a hand list would go quietly stale the day a kind gains such a property, and a stale list here is an
     * undersized seed. The id type is excluded — identity is exact, and the `digits` lookups above answer it. */
    const numericKinds = new Map<Column, Kind[]>();
    const colourKinds = new Map<Column, Kind[]>();
    for (const kind of KINDS.values()) {
        const types = Object.values(kind.props).flatMap((prop) => prop.types);
        if (types.some((type) => type.quantity === true && type !== idType)) {
            numericKinds.set(kind.column, [...(numericKinds.get(kind.column) ?? []), kind]);
        }
        if (types.includes(colourType)) {
            colourKinds.set(kind.column, [...(colourKinds.get(kind.column) ?? []), kind]);
        }
    }

    const content = new Map<Column, readonly Vocab[]>([
        [modelColumn, modelVocab], [soundColumn, soundVocab], [animColumn, animVocab],
        [mechColumn, mechVocab], [fxColumn, fxVocab],
    ]);
    return {presence, kindPresence, namesSq, pools, iconsSq, plainVocab, content, digits, numericKinds, colourKinds};
}

/**
 * The probe tokens one value expression needs, squashed, or `null` when the expression cannot be seeded from text.
 *
 * A glob keeps only its longest literal run — anything the pattern matches must contain it. An alternation needs
 * every branch seedable, because the seed unions branches. Comparisons, ranges and presence return `null`: they
 * select by order, which no substring vocabulary answers.
 */
function probeTokens(expr: ValueExpr): string[] | null {
    switch (expr.op) {
        case "anyOf": {
            const all: string[] = [];
            for (const alt of expr.alternatives) {
                const tokens = probeTokens(alt);
                if (tokens === null) return null;
                all.push(...tokens);
            }
            return all;
        }
        case "contains":
        case "exact": {
            const written = "text" in expr.operand ? expr.operand.text : String(expr.operand.value);
            const sq = squash(written);
            return sq ? [sq] : null;
        }
        case "glob": {
            const written = "text" in expr.operand ? expr.operand.text : String(expr.operand.value);
            const runs = written.split("*").map(squash).filter(Boolean);
            if (runs.length === 0) return null;
            return [runs.reduce((a, b) => (b.length > a.length ? b : a))];
        }
        default:
            return null;
    }
}

/**
 * Builds the {@link Dataset} the kernel runs against, over one loaded pack.
 *
 * Rows are materialised per call rather than held: the honest cost of the reshaping this file exists to retire, and
 * what `candidates()` keeps off the common path. Loads the pack's expansion ladder as the ordinal vocabulary, keys
 * and aliases both, so `xpac:classic` ranks against a pack whose key for it is `vanilla`.
 *
 * @param d 1.0's loaded indexes.
 * @returns The dataset, with row sources for all seven columns and an inverted `candidates()`.
 */
export function packDataset(d: SpellData): Dataset {
    // The ordinal ladder is module-level state, so the last dataset built owns it: a caller holding two datasets at
    // once must not interleave ordinal queries across them. Every current caller builds and queries one at a time.
    setOrdinalLadder(d.expansions.map((xp) => [xp.key, ...xp.aliases].join(" ")));
    const cats = catKinds(d);
    const builders = new Map<Column, (i: number) => Row[]>([
        [spellColumn, (i) => spellRows(d, i)],
        [idColumn, (i) => idRows(d, i)],
        [fxColumn, (i) => fxRows(d, i)],
        [mechColumn, (i) => mechRows(d, i)],
    ]);

    // The three columns the pack ships as rows are read; the two that do not yet
    // ship rows are still built per call, which is what remains of the bridge.
    const packed = new Map<Column, RowSource>([
        [modelColumn, new PackRowSource(d.rowTables.model, kindsOf(modelColumn), d.rowVocabs)],
        [soundColumn, new PackRowSource(d.rowTables.sound, kindsOf(soundColumn), d.rowVocabs)],
        [animColumn, new PackRowSource(d.rowTables.anim, kindsOf(animColumn), d.rowVocabs)],
    ]);

    let inverted: Inverted | null = null;
    const invertedSide = (): Inverted => (inverted ??= invert(d, cats));

    const plainSeed = (value: ValueExpr): Set<number> | null => {
        const tokens = probeTokens(value);
        if (tokens === null) return null;
        const inv = invertedSide();
        const seed = new Set<number>();
        for (const token of tokens) {
            for (let i = 0; i < inv.namesSq.length; i++) if (inv.namesSq[i].includes(token)) seed.add(i);
            for (const pool of inv.pools) {
                const hit = pool.sq.map((sq) => sq.includes(token));
                for (let i = 0; i < pool.of.length; i++) if (pool.of[i] && hit[pool.of[i]]) seed.add(i);
            }
            {
                const hit = inv.iconsSq.map((sq) => sq.includes(token));
                for (let i = 0; i < d.iconOf.length; i++) if (d.iconOf[i] && hit[d.iconOf[i] - 1]) seed.add(i);
            }
            probeVocab(inv.plainVocab, token, seed);
            if (/^\d+$/.test(token)) {
                const at = d.spellIndex.get(Number(token));
                if (at !== undefined) seed.add(at);
            }
        }
        return seed;
    };

    /**
     * A content seed for one column: the substring vocabularies, the identity answers for a whole number, and the
     * kind presences a quantity or a colour could match — because a bare token dispatches to every notation its
     * row's properties read, not only to text.
     *
     * `null` — fall back to the column presence — for a target-role word, which matches masks no vocabulary indexes.
     */
    const contentSeed = (column: Column, value: ValueExpr): Set<number> | null => {
        const inv = invertedSide();
        const vocabs = inv.content.get(column);
        if (!vocabs) return null;
        const tokens = probeTokens(value);
        if (tokens === null) return null;
        const seed = new Set<number>();
        for (const token of tokens) {
            if (TARGET_ROLES.includes(token)) return null;
            probeVocab(vocabs, token, seed);
            if (/^\d+$/.test(token)) {
                for (const found of inv.digits.get(column)?.(Number(token)) ?? []) {
                    for (const at of found) if (at >= 0) seed.add(at);
                }
            }
            if (/\d/.test(token)) {
                for (const kind of inv.numericKinds.get(column) ?? []) {
                    for (const at of inv.kindPresence.get(kind) ?? []) seed.add(at);
                }
            }
            if (/^[0-9a-f]{6}$/.test(token) || COLOUR_NAMES[fold(token)] !== undefined) {
                for (const kind of inv.colourKinds.get(column) ?? []) {
                    for (const at of inv.kindPresence.get(kind) ?? []) seed.add(at);
                }
            }
        }
        return seed;
    };

    // `null` means "not indexed", never "no spells": the spell and id columns are outside the presence index, and a
    // kind the pack has no rows for is indistinguishable from one — either way the caller must fall back, because an
    // empty seed would answer the query with nothing.
    const kindSeed = (kind: Kind): ReadonlySet<number> | null =>
        invertedSide().kindPresence.get(kind) ?? null;

    /** The seed for one scope group: its first positive evaluable term. `null` when no term can anchor one. */
    const groupSeed = (column: Column, group: readonly ScopeTerm[]): Iterable<number> | null => {
        for (const term of group) {
            if (term.not || term.state !== "ok" || term.ask === null) continue;
            const ask = term.ask;
            if (ask.on === "kindWord") return kindSeed(ask.kind);
            if (ask.on === "content") return contentSeed(column, ask.value) ?? columnSeed(column);
            if (ask.on === "props") {
                const union = new Set<number>();
                for (const ref of ask.props) {
                    const seed = kindSeed(ref.kind);
                    if (seed === null) return null;
                    for (const at of seed) union.add(at);
                }
                return union;
            }
            // A count term anchors nothing: `count:0` is satisfied by spells with no rows at all.
        }
        return null;
    };

    const columnSeed = (column: Column): ReadonlySet<number> | null => {
        // The spell and id columns are total: every spell has a name and a number, so there is nothing to narrow.
        if (column === spellColumn || column === idColumn) return null;
        return invertedSide().presence.get(column) ?? new Set();
    };

    const testSeed = (column: Column, base: Iterable<number> | null,
                      test: RowTest | null): Iterable<number> | null => {
        if (test === null || test.is === "exists") return base;
        if (test.is === "content") return contentSeed(column, test.value) ?? base;
        if (test.is === "props") return base;
        // Alternation groups union, so the seed is the union of each group's anchor — and one unseedable group
        // (a count-only conjunction can match spells with no rows) makes the whole ask unseedable.
        const union = new Set<number>();
        for (const group of test.terms) {
            const seed = groupSeed(column, group);
            if (seed === null) return null;
            for (const at of seed) union.add(at);
        }
        return union;
    };

    return {
        spells: d.ids.length,
        source(column: Column) {
            const read = packed.get(column);
            if (read) return read;
            const build = builders.get(column);
            return build ? {rows: build} : null;
        },
        candidates(ask: Ask): Iterable<number> | null {
            if (ask.on === "plain") return plainSeed(ask.value);
            if (ask.on === "prop") return kindSeed(ask.ref.kind);
            if (ask.on === "kind") return testSeed(ask.kind.column, kindSeed(ask.kind), ask.test);
            return testSeed(ask.column, columnSeed(ask.column), ask.test);
        },
    };
}
