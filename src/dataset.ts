/**
 * @file The pack-backed {@link Dataset}: search 2.0's row model, read out of the shipped pack.
 *
 * Every column a spell can carry more than one of is READ rather than reshaped: the pack ships those rows and
 * {@link PackRowSource} hands them over as the kinds they already are. The two columns that are one row per spell —
 * its name and its number — are read off the per-spell columns, because there is nothing to pool.
 *
 * The inverted side `candidates()` narrows with is built from the same materialised rows the verifier walks: every
 * textual value a row can match seeds by the text its vocabulary resolves, every id-typed property answers a whole
 * number by identity, and presence falls out of the same walk. Building the seed from what the verifier reads is
 * what makes it sound by construction — a seed built from any other source could disagree with the match.
 *
 * Runtime-neutral on purpose: it turns an already-loaded pack into a dataset and never touches the filesystem or the
 * network, so the browser and the Node tools share it. Each runtime keeps its own way of picking the bytes up —
 * `tools/dataset.ts` reads the module set off disk, the presentation layer fetches it — and both hand the assembled
 * pack to {@link fromPack}.
 */
import type {RowAt, RowIndex, RowPack, RowTable} from "./packrows";
import {DELIVERY_BREAKS_ON_MOVE, DELIVERY_CHANNELLED, indexRows, rowTableOf, storedAt} from "./packrows";
import type {VersionEntry} from "./data";

import type {
    Ask, Column, Dataset, Kind, Row, RowSource, RowTest, Rung, ScopeTerm, Stored, ValueExpr,
} from "./search/index";
import {
    animColumn, catalogue, colour as colourType, COLOUR_NAMES, fold, fxColumn, id as idType, idColumn, KINDS,
    mechColumn, modelColumn, setOrdinalLadder, soundColumn, spellColumn, squash, TARGET_ROLES,
    kindsOf, text as textType, wordOf,
} from "./search/index";

// The kinds this file builds rows for, under their own names. Taken off the catalogue rather than off the door, which
// carries it as a namespace so the game's nouns do not crowd out the language's. Only the spell and id columns need
// their kinds by name — every pooled column's rows arrive under the kind word the pack ships.
const {delivery, description, expansion, icon, name: nameKind, spellId: spellIdKind} = catalogue;

/** One deduplicated prose pool and the per-spell indexes into it; `of[i]` of nought means the spell has none. */
interface TextPool {
    readonly text: readonly string[];
    readonly of: readonly number[];
}

/** The per-spell columns of the `spells` section, the core and locale halves already merged by the pack reader. */
interface SpellsSection {
    readonly ids: readonly number[];
    /** One-based index into the icon pool; nought means no icon. */
    readonly icons: readonly number[];
    /** Index into the expansion ladder; negative means unplaced. */
    readonly eras: readonly number[];
    readonly names: readonly string[];
    readonly subtexts: readonly string[];
    readonly altNames: readonly string[];
}

/** The three cooked prose pools of the `spellText` section. */
interface SpellTextSection {
    readonly descriptions: TextPool;
    readonly auras: TextPool;
    readonly encounters: TextPool;
}

/** The expansion ladder the pack ships, parallel arrays in rung order. */
interface ExpansionsSection {
    /** What a row stores, and what the pack keys the expansion by. */
    readonly keys: readonly string[];
    /** The abbreviation the game itself uses, where it has one. */
    readonly shorts?: readonly string[];
    /** The expansion's full title. */
    readonly labels?: readonly string[];
    readonly aliases?: readonly (readonly string[])[];
}

/** One spell's cast-and-channel shape, keyed off the `spellDelivery` section. */
interface Delivery {
    readonly castMs: number;
    readonly durMs: number;
    readonly flags: number;
}

/**
 * One loaded pack, viewed through the sections the dataset reads.
 *
 * The row tables stay on {@link LoadedPack.pack} and are reached by {@link rowTableOf}; what this resolves up front
 * is the per-spell columns, the prose pools and the two id-keyed side tables, so the row builders read fields rather
 * than fishing sections out of an untyped bag.
 */
export interface LoadedPack {
    readonly pack: RowPack;
    readonly entry: VersionEntry;
    /** The language the pack was loaded in. */
    readonly locale: string;
    readonly spells: SpellsSection;
    readonly text: SpellTextSection;
    readonly iconNames: readonly string[];
    readonly iconFids: readonly number[];
    /** Cast-and-channel per spell id; empty where the pack ships no delivery section. */
    readonly delivery: ReadonlyMap<number, Delivery>;
    /** Spell ids per attribute-flag word. */
    readonly attrs: ReadonlyMap<string, ReadonlySet<number>>;
    readonly expansions: ExpansionsSection;
    /** Spell id to its dense position. */
    readonly index: ReadonlyMap<number, number>;
}

/** One section, or a loud refusal — a pack too old for the row model cannot be read at all. */
function sectionOf(pack: RowPack, name: string): unknown {
    const held = pack[name];
    if (held === undefined) throw new Error(`pack ships no ${name} — packs older than the row model are unreadable`);
    return held;
}

/**
 * Resolves the sections the dataset reads out of one loaded pack.
 *
 * @param pack The pack, as {@link readPack} returns it.
 * @param entry Its roster entry.
 * @param locale The language it was loaded in.
 * @returns The typed view.
 * @throws If a section the row builders need is absent.
 */
export function fromPack(pack: RowPack, entry: VersionEntry, locale: string): LoadedPack {
    const spells = sectionOf(pack, "spells") as SpellsSection;
    const deliverySection = pack.spellDelivery as
        { spellIds: number[]; castMs: number[]; durMs: number[]; flags: number[] } | undefined;
    const deliveries = new Map<number, Delivery>();
    if (deliverySection) {
        for (let k = 0; k < deliverySection.spellIds.length; k++) {
            deliveries.set(deliverySection.spellIds[k], {
                castMs: deliverySection.castMs[k], durMs: deliverySection.durMs[k],
                flags: deliverySection.flags[k],
            });
        }
    }
    const attrs = new Map<string, ReadonlySet<number>>(
        Object.entries((pack.spellAttrs ?? {}) as Record<string, number[]>)
            .map(([word, ids]) => [word, new Set(ids)]));
    const index = new Map<number, number>();
    for (let at = 0; at < spells.ids.length; at++) index.set(spells.ids[at], at);
    return {
        pack, entry, locale, spells,
        text: sectionOf(pack, "spellText") as SpellTextSection,
        iconNames: sectionOf(pack, "iconNames") as readonly string[],
        iconFids: sectionOf(pack, "iconFids") as readonly number[],
        delivery: deliveries, attrs,
        expansions: sectionOf(pack, "expansions") as ExpansionsSection,
        index,
    };
}

/**
 * Each vocabulary a row property resolves through, as one lookup from a stored number to its text.
 *
 * The pack says where each lives and how it is keyed, and there are only two shapes: two parallel columns a reader
 * pairs into a map, or a section indexed by the stored number itself. Reading that here rather than off the loaded
 * 1.0 indexes is the point — the row tables are the pack's, and nothing about them goes through the old engine.
 *
 * A paired vocabulary costs a map, and it is built on the first lookup rather than here: a query touches a handful of
 * the declared vocabularies and every one of them was being paired up front — 63,669 entries on Shadowlands, one of
 * them a second copy of a map this module builds again a few lines later.
 */
function rowVocabularies(pack: RowPack): Record<string, (value: number) => string | undefined> {
    const found: Record<string, (value: number) => string | undefined> = {};
    for (const [name, where] of Object.entries(pack.rowVocabs ?? {})) {
        const section = (pack as unknown as Record<string, unknown>)[where.in];
        if (!section) continue;
        if (where.keys !== undefined && where.values !== undefined) {
            const block = section as Record<string, unknown>;
            const keys = block[where.keys] as number[] | undefined;
            const values = block[where.values] as string[] | undefined;
            if (!keys || !values) continue;
            let byKey: Map<number, string> | undefined;
            found[name] = (value) => {
                if (!byKey) {
                    byKey = new Map<number, string>();
                    for (let i = 0; i < keys.length; i++) byKey.set(keys[i], values[i]);
                }
                return byKey.get(value);
            };
        } else if (where.values !== undefined) {
            // The middle shape: one named column of the section, itself indexed by the stored number.
            const column = (section as Record<string, unknown>)[where.values] as string[] | undefined;
            if (!column) continue;
            found[name] = (value) => column[value];
        } else {
            const direct = section as Record<number, string>;
            found[name] = (value) => direct[value];
        }
    }
    return found;
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
                private readonly vocabs: Record<string, (value: number) => string | number | undefined>) {
        this.index = indexRows(table);
        this.built = Array.from<Row | undefined>({length: this.index.owner.length});
    }

    rows(spell: number): readonly Row[] {
        const out: Row[] = [];
        for (let i = this.index.at[spell]; i < this.index.at[spell + 1]; i++) {
            out.push(this.rowByRef(this.table.refs[i]));
        }
        return out;
    }

    /** How many rows the spell has, straight off the shipped counts. */
    size(spell: number): number {
        return this.table.counts[spell];
    }

    /** One pooled row by its column-wide reference, materialised once and shared with every other reader. */
    rowByRef(ref: number): Row {
        return this.built[ref] ??= this.materialise(this.index.owner[ref]);
    }

    /**
     * The spell indexes holding each pooled row, one list per column-wide reference.
     *
     * This is the pooling read backwards — `refs` says which rows a spell has, this says which spells a row is on —
     * and it is what lets the inverted side attribute a row's text to its owners in one walk instead of one walk
     * per vocabulary.
     */
    owners(): readonly (readonly number[])[] {
        const owners: number[][] = Array.from({length: this.index.owner.length}, () => []);
        const {at} = this.index;
        const refs = this.table.refs;
        for (let spell = 0; spell + 1 < at.length; spell++) {
            for (let j = at[spell]; j < at[spell + 1]; j++) owners[refs[j]].push(spell);
        }
        return owners;
    }

    /**
     * One pooled row as the kind it is.
     *
     * What a stored number MEANS is the catalogue's to say, never the pack's: a property whose first two notations are
     * an id and a name carries both, one whose first notation is textual carries the text alone, and anything else is
     * the number itself. That split is read off the declaration, so a property that gains a notation needs no edit
     * here.
     *
     * A vocabulary may resolve to a NUMBER as well as a word — a tint row stores which tint it is and its vocabulary
     * gives back the packed colour — which needs no case of its own: the resolved value is the property's value
     * whatever type it has, and only the id-and-name pair asks what it got.
     */
    private materialise(at: RowAt): Row {
        const kind = this.kinds.get(at.kind);
        if (!kind) throw new Error(`pack ships rows of unknown kind "${at.kind}"`);
        const props: Record<string, Stored> = {};
        for (const [name, prop] of Object.entries(kind.props)) {
            const stored = storedAt(this.table, at, name);
            if (stored === undefined) continue;
            const lookup = this.vocabs[this.table.vocab[at.kind]?.[name] ?? ""];
            const resolved = lookup?.(stored);
            if (prop.types[0] === idType && prop.types[1] === textType) {
                props[name] = typeof resolved === "string" ? {id: stored, text: resolved} : stored;
            } else if (lookup !== undefined) {
                if (resolved !== undefined) props[name] = resolved;
            } else {
                props[name] = stored;
            }
        }
        return row(kind, props);
    }
}

/** The kinds of one column, by the word the pack names them with. */
function kindsByWord(column: Column): Map<string, Kind> {
    return new Map(kindsOf(column).map((kind) => [wordOf(kind), kind]));
}

/* ------------------------------------------------------------------- the row sources, one builder per column */

/**
 * The spell column's rows: its names, its prose, its icon, its delivery.
 *
 * The alternative names are deliberately NOT a row: the pack joins a spell's override names into one searchable
 * string, and a row made of that blob would anchor-match a name no spell has. They stay in the seed corpus, where
 * matching is substring.
 *
 * TODO: one name row per override name needs the pack to ship them as a list rather than joined.
 */
function spellRows(l: LoadedPack, i: number): Row[] {
    const {spells, text} = l;
    const id = spells.ids[i];
    const rows: Row[] = [row(nameKind, {text: spells.names[i]})];
    if (spells.subtexts[i]) rows.push(row(nameKind, {text: spells.subtexts[i]}));
    for (const pool of [text.descriptions, text.encounters, text.auras]) {
        const at = pool.of[i];
        if (at) rows.push(row(description, {text: pool.text[at]}));
    }
    if (spells.icons[i]) {
        const props: Record<string, Stored> = {name: l.iconNames[spells.icons[i] - 1]};
        const fid = l.iconFids[spells.icons[i] - 1];
        if (fid) props.fid = fid;
        rows.push(row(icon, props));
    }

    // Delivery exists only where the pack ships it; on such packs every spell has one row, because "instant" is the
    // complement, not a shipped list. A channel-only spell carries no cast value at all — `cast:instant` means "no
    // bar", and a channel is not a bar.
    if (l.delivery.size) {
        const del = l.delivery.get(id);
        const props: Record<string, Stored> = {};
        if (!del) props.cast = 0;
        else {
            if (del.castMs > 0) props.cast = del.castMs;
            if (del.flags & DELIVERY_CHANNELLED) props.channel = del.durMs;
            if (del.flags & DELIVERY_BREAKS_ON_MOVE) props.breaksmove = 1;
        }
        if (l.attrs.get("unbreakablechannel")?.has(id)) props.unbreakable = 1;
        if (l.attrs.get("actionsduringchannel")?.has(id)) props.unhindered = 1;
        rows.push(row(delivery, props));
    }
    return rows;
}

function idRows(l: LoadedPack, i: number): Row[] {
    const rows: Row[] = [row(spellIdKind, {value: l.spells.ids[i]})];
    const era = l.spells.eras[i];
    if (era >= 0 && l.expansions.keys[era]) rows.push(row(expansion, {rung: l.expansions.keys[era]}));
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
    /** Content vocabularies per column; their union is every corpus vocabulary that can answer a plain term. */
    readonly content: ReadonlyMap<Column, readonly Vocab[]>;
    /** Column content answering a whole number by identity: every stored value of an id-declaring property. */
    readonly digits: ReadonlyMap<Column, ReadonlyMap<number, ReadonlySet<number>>>;
    /** Kinds whose rows carry a quantity a numeric-looking token could match, per column. */
    readonly numericKinds: ReadonlyMap<Column, readonly Kind[]>;
    /** Kinds whose rows carry a colour a hex triplet or colour name could match, per column. */
    readonly colourKinds: ReadonlyMap<Column, readonly Kind[]>;
}

function invert(l: LoadedPack, sources: ReadonlyMap<Column, PackRowSource>): Inverted {
    const presence = new Map<Column, Set<number>>();
    const kindPresence = new Map<Kind, Set<number>>();
    const content = new Map<Column, readonly Vocab[]>();
    const digits = new Map<Column, ReadonlyMap<number, ReadonlySet<number>>>();
    // Squashing goes through the spelling-fold regexes, so it is memoised across rows: the pools deduplicate
    // values, but many rows still resolve one file path or one name.
    const squashed = new Map<string, string>();
    const sq = (text: string): string => {
        let held = squashed.get(text);
        if (held === undefined) squashed.set(text, held = squash(text));
        return held;
    };

    /* ONE walk over each column's materialised pools builds everything the seeds read. The rows are exactly what the
     * verifier walks, so a seed built here is a superset of any answer by construction: a textual value seeds under
     * the text its vocabulary resolved, an id-and-name pair seeds under both, and a bare number seeds by identity
     * wherever its property declares the id notation. Distinct texts MERGE across rows — two rows resolving one file
     * path become one haystack carrying both owner lists — which keeps the scan the size of the vocabulary rather
     * than the size of the pool. */
    for (const [column, source] of sources) {
        const owners = source.owners();
        const colPresence = new Set<number>();
        presence.set(column, colPresence);
        const byText = new Map<string, Set<number>>();
        const byId = new Map<number, Set<number>>();
        const textual = (text: string, own: readonly number[]): void => {
            const folded = sq(text);
            if (!folded) return;
            for (const at of own) addTo(byText, folded, at);
        };
        const identity = (id: number, own: readonly number[]): void => {
            for (const at of own) addTo(byId, id, at);
        };
        for (let ref = 0; ref < owners.length; ref++) {
            const own = owners[ref];
            if (own.length === 0) continue;
            const r = source.rowByRef(ref);
            for (const at of own) colPresence.add(at);
            let per = kindPresence.get(r.kind);
            if (!per) kindPresence.set(r.kind, per = new Set());
            for (const at of own) per.add(at);
            for (const [name, value] of Object.entries(r.props)) {
                if (typeof value === "string") {
                    textual(value, own);
                } else if (typeof value === "object") {
                    // The record form is keyed by type name; its strings seed as text, and its numbers seed by
                    // identity exactly when the property declares the id notation.
                    const ids = r.kind.props[name].types.includes(idType);
                    for (const held of Object.values(value)) {
                        if (typeof held === "string") textual(held, own);
                        else if (ids) identity(held, own);
                    }
                } else if (r.kind.props[name].types.includes(idType)) {
                    identity(value, own);
                }
            }
        }
        content.set(column, [...byText].map(([text, spells]) => ({sq: text, spells: [...spells]})));
        digits.set(column, byId);
    }

    const namesSq = l.spells.names.map((name, i) =>
        squash([name, l.spells.subtexts[i], l.spells.altNames[i]].filter(Boolean).join(" ")));
    const pools = [l.text.descriptions, l.text.encounters, l.text.auras].map((pool) => ({
        sq: pool.text.map(squash), of: pool.of,
    }));
    const iconsSq = l.iconNames.map(squash);

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

    return {presence, kindPresence, namesSq, pools, iconsSq, content, digits, numericKinds, colourKinds};
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
 * Reads the pack's expansion ladder as the ordered vocabulary the ordinal type is parsed and compared within.
 *
 * The SHORT is the name: the keys are inconsistent about it — `tbc` and `wotlk` are abbreviations where
 * `shadowlands` and `dragonflight` are spelled out — and the shorts are not. The key still reads, because it is
 * what a row stores, and so does every alias the pack declares, which is how `xpac:classic` and `xpac:6` both
 * reach the rung the pack keys as `vanilla` and `wod`.
 *
 * @param expansions The pack's ladder section.
 * @returns The rungs, lowest first.
 */
function expansionLadder(expansions: ExpansionsSection): Rung[] {
    return expansions.keys.map((key, i) => ({
        word: expansions.shorts?.[i] ?? key,
        reads: [key, ...(expansions.aliases?.[i] ?? [])],
        note: expansions.labels?.[i],
    }));
}

/**
 * Builds the {@link Dataset} the kernel runs against, over one loaded pack.
 *
 * Row materialisation is lazy and cached per pool slot; the first `candidates()` call walks every pool to build the
 * inverted side, so it materialises and retains the lot — a deliberate trade, since the seeds must read every row
 * once anyway and later queries then allocate nothing. Loads the pack's expansion ladder as the ordinal vocabulary
 * (see {@link expansionLadder}), so a rung answers to every spelling the pack declares for it.
 *
 * @param l The loaded pack.
 * @returns The dataset, with row sources for all seven columns and an inverted `candidates()`.
 */
export function packDataset(l: LoadedPack): Dataset {
    // The ordinal ladder is module-level state, so the last dataset built owns it: a caller holding two datasets at
    // once must not interleave ordinal queries across them. Every current caller builds and queries one at a time.
    setOrdinalLadder(expansionLadder(l.expansions));
    // The spell's own name and its number are the two columns the pack does not ship rows for: a spell has exactly
    // one of each, so there is nothing to pool and they are read off the per-spell columns directly.
    const builders = new Map<Column, (i: number) => Row[]>([
        [spellColumn, (i) => spellRows(l, i)],
        [idColumn, (i) => idRows(l, i)],
    ]);

    // Every column a spell can carry more than one of is READ. Nothing here reshapes a row any more.
    const vocabularies = rowVocabularies(l.pack);
    const packed = new Map<Column, PackRowSource>(
        ([[modelColumn, "model"], [soundColumn, "sound"], [animColumn, "anim"],
            [fxColumn, "fx"], [mechColumn, "mech"]] as const).map(
            ([column, key]) =>
                [column, new PackRowSource(rowTableOf(l.pack, key), kindsByWord(column),
                    vocabularies)]));

    let inverted: Inverted | null = null;
    const invertedSide = (): Inverted => (inverted ??= invert(l, packed));

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
                const icons = l.spells.icons;
                for (let i = 0; i < icons.length; i++) if (icons[i] && hit[icons[i] - 1]) seed.add(i);
            }
            for (const vocabs of inv.content.values()) probeVocab(vocabs, token, seed);
            if (/^\d+$/.test(token)) {
                const at = l.index.get(Number(token));
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
                for (const at of inv.digits.get(column)?.get(Number(token)) ?? []) seed.add(at);
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
        spells: l.spells.ids.length,
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
