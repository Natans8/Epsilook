/**
 * @file What the control surface can hand the caret: the words the LANGUAGE knows, never the corpus.
 *
 * The governing rule is that input assistance knows axes, structure and closed vocabularies and nothing about the
 * data. So every offer below is read from a declaration — the doors from the head index, a column's kinds from the
 * kind registry, a kind's properties from its own record, a value's words from its type — and a word cannot come to
 * be typeable and unoffered.
 *
 * A pure read of the open plan: which characters an offer would replace, what each one puts there, and which
 * candidate the slot draws as a ghost. Applying an offer is exactly typing it, so nothing here rewrites a query;
 * the bar feeds the insertion through the same keystroke path a typed character takes.
 */
import type {BarPlan} from "./plan";
import {termStarts} from "./plan";
import type {Column, Kind, Prop} from "../../search/index";
import {
    bitmask, COUNT_PROP, flag, fold, GRAMMAR, HEADS, headWord, hintOf, kindsOf, operatorsOf, propIn,
    propNameOf, TARGET_ROLES, wordOf,
} from "../../search/index";
import {i18n} from "../../i18n";

/**
 * How an offer reads and what it does.
 *
 * A `door` opens an axis and carries its bind, so applying it transforms the segment into a chip; a `word` is one
 * word of the language dropped into the slot; a `query` is a whole remembered search and replaces the bar.
 */
export type OfferShape = "door" | "word" | "query";

/** The section an offer sits in. An identity rather than a label, so a test never reads translated prose. */
export type GroupId = "history" | "axes" | "kinds" | "props" | "sentinels" | "roles" | "words";

/** One thing the surface offers. */
export interface Offer {
    readonly shape: OfferShape;
    /** The word the row draws. */
    readonly word: string;
    /** What replaces the stub — a door carries its bind, a word stands alone, a query is the whole text. */
    readonly insert: string;
    /** The one line under the word, already in the reader's language. */
    readonly note: string;
    /** The column whose tone the row wears, where the offer belongs to one. */
    readonly tone?: string;
    /**
     * Every spelling this offer answers to, where it answers to more than its own word.
     *
     * A door reads by its full name and its synonyms — `animation` reaches `anim` — so narrowing has to see
     * them, while every surface still writes the one spelling the language writes.
     */
    readonly reads?: readonly string[];
    /**
     * The kinds that declare this property, where they are not all of the column's.
     *
     * A column's scope reads a property from any of its kinds, so `model:{motion:...}` is legal — but motion is
     * a MISSILE's property, and a list that shows it beside the column's own reads as though every model had
     * one. Naming the owner is what keeps the taxonomy honest without taking the ask away.
     */
    readonly owner?: string;
}

/** One titled section of the surface. */
export interface OfferGroup {
    readonly id: GroupId;
    readonly label: string;
    readonly offers: readonly Offer[];
}

/** What the position takes, said from the declarations: the subject, what it means, and how it is written. */
export interface Takes {
    /** The property's own name, as naming surfaces write it. */
    readonly title: string;
    /** What the property is — its declared description. */
    readonly what: string;
    /** How a value is written — the type's own line, which is where the examples live. */
    readonly how: string;
}

/** What the caret can be handed, and where it would land. */
export interface Offers {
    readonly groups: readonly OfferGroup[];
    /**
     * What this position takes, where the caret is composing a value.
     *
     * The offers alone can only ever list WORDS, so a numeric axis would read as though words were all it
     * accepted. The two lines come from two declarations — the property says what it is, the type says how to
     * write one — which is also the separation between a description and its examples.
     */
    readonly takes: Takes | null;
    /** The slot characters an offer replaces. */
    readonly stub: { readonly start: number; readonly end: number };
    /** The best candidate's remainder, drawn dim after the caret; empty when nothing completes what was typed. */
    readonly ghost: string;
    /** Whether a minus already stands before the word, so every offer here excludes rather than asks. */
    readonly negated: boolean;
}

/** Every offer in draw order — the flat list the arrows walk and Enter picks from. */
export function flatOffers(offers: Offers): Offer[] {
    return offers.groups.flatMap((held) => [...held.offers]);
}

/** Nothing on offer — what a bar at rest has, since a caret it does not hold can be handed nothing. */
export const NO_OFFERS: Offers = {groups: [], stub: {start: 0, end: 0}, ghost: "", negated: false, takes: null};

/**
 * What the slot would hold once an offer is taken, and where the caret would then sit in it.
 *
 * Taking an offer is a text edit like any other: the characters it was narrowed against give way to what it
 * spells. The bar hands the result to the ordinary keystroke path, so a picked door opens its scope through the
 * same gesture a typed colon fires.
 *
 * @param plan The open position's plan, as the offers were read from.
 * @param offers The offers, for the stub they replace.
 * @param offer The one being taken; a remembered query replaces the whole bar and is not written through here.
 * @returns The slot's new value and the caret's place in it.
 */
export function offerSlot(plan: BarPlan, offers: Offers, offer: Offer): { value: string; caret: number } {
    const value = plan.slot.slice(0, offers.stub.start) + offer.insert + plan.slot.slice(offers.stub.end);
    return {value, caret: offers.stub.start + offer.insert.length};
}

/** How much of a top-level word must be typed before the doors are offered — 1.0's own threshold. */
const DOOR_THRESHOLD = 2;

/**
 * The order the doors are offered in: what a reader reaches for first.
 *
 * Alphabetical is an ordering of the SPELLINGS, and a menu ordered by spelling teaches nothing — it opened on
 * `anim`, `cast`, `chain` because those words happen to start with the first letters of the alphabet. This is
 * the order of the questions instead: what the spell looks and sounds like, then what it is, then how it goes
 * off, then the long tail. A door missing from this list still appears, after the ones named here.
 */
const MENU_ORDER: readonly string[] = [
    "name", "model", "sound", "anim", "fx",
    "desc", "icon", "id", "xpac",
    "cast", "channel", "scale", "speed", "mech", "spell",
    "missile", "chain", "morph", "summon", "seats", "location", "triggers", "origin",
];

/** Where one door sits in the menu — the unlisted ones after every listed one, in their own order. */
const menuRank = (word: string): number => {
    const at = MENU_ORDER.indexOf(word);
    return at < 0 ? MENU_ORDER.length : at;
};

/** The term the caret sits in, in the coordinates of the text it was split from. */
function termAt(text: string, caret: number): { start: number; end: number } {
    const starts = termStarts(text);
    let held = 0;
    while (held + 1 < starts.length && starts[held + 1] <= caret) held += 1;
    return {start: starts[held], end: held + 1 < starts.length ? starts[held + 1] - 1 : text.length};
}

/** Where a term's own bind sits, or -1 — the depth-zero colon that makes the rest of it a value. */
function bindIn(term: string): number {
    let quote = false;
    let depth = 0;
    for (let at = 0; at < term.length; at++) {
        const ch = term[at];
        if (ch === GRAMMAR.escape && quote) {
            at += 1;
            continue;
        }
        if (ch === GRAMMAR.phrase) {
            quote = !quote;
            continue;
        }
        if (quote) continue;
        if (ch === GRAMMAR.scope.open || ch === GRAMMAR.group.open) depth += 1;
        else if (ch === GRAMMAR.scope.close || ch === GRAMMAR.group.close) depth -= 1;
        else if (ch === GRAMMAR.bind && depth <= 0) return at;
    }
    return -1;
}

/** Every door of the language, by the spelling it writes — the head index folded back onto the words it offers. */
function doorOffers(): Offer[] {
    const held = new Map<string, Offer & { reads: string[] }>();
    for (const [spelling, head] of HEADS) {
        const word = headWord(head);
        const found = held.get(word);
        if (found !== undefined) {
            found.reads.push(spelling);
            continue;
        }
        held.set(word, {
            shape: "door",
            word,
            insert: word + GRAMMAR.bind,
            note: head.role === "column" ? head.column.hint
                : head.role === "kind" ? head.kind.hint : hintOf(head.prop),
            tone: head.role === "column" ? head.column.key : head.kind.column.key,
            reads: [spelling],
        });
    }
    return [...held.values()].sort((a, b) => menuRank(a.word) - menuRank(b.word) || a.word.localeCompare(b.word));
}

/** The kinds of one column, as the words that name them inside its scope. */
function kindOffers(column: Column): Offer[] {
    return kindsOf(column)
        .filter((kind): kind is Kind & { word: string } => kind.word !== undefined)
        .map((kind): Offer => ({
            shape: "word",
            word: kind.word,
            insert: kind.word,
            note: kind.hint,
            tone: column.key,
        }))
        .sort((a, b) => a.word.localeCompare(b.word));
}

/** One property, as the offer that opens it: a flag word stands alone, everything else takes a bind. */
function propOffer(name: string, prop: Prop, tone: string, owner?: string): Offer {
    const valueless = prop.types.includes(flag);
    return {
        shape: valueless ? "word" : "door",
        word: name,
        insert: valueless ? name : name + GRAMMAR.bind,
        note: hintOf(prop),
        tone,
        owner,
    };
}

/**
 * Every property reachable inside one head's scope: a kind's own, or every kind's across a column.
 *
 * Under a COLUMN each property also names the kinds that declare it, unless every kind of the column does. The
 * language reads `model:{motion:parabola}` because a column looks the word up across its kinds — but motion
 * belongs to a MISSILE, and a flat list of every kind's properties reads as though the column had them all.
 */
function propOffers(context: { role: "column"; column: Column } | { role: "kind"; kind: Kind }): Offer[] {
    const tone = context.role === "column" ? context.column.key : context.kind.column.key;
    const kinds = context.role === "column" ? kindsOf(context.column) : [context.kind];
    const owners = new Map<string, string[]>();
    for (const kind of kinds) {
        for (const name of Object.keys(kind.props)) owners.set(name, [...owners.get(name) ?? [], wordOf(kind)]);
    }
    const held = new Map<string, Offer>();
    for (const kind of kinds) {
        for (const [name, prop] of Object.entries(kind.props)) {
            const mine = owners.get(name) ?? [];
            // Named only where naming it says something: one or two kinds is a fact a reader can use, and a
            // property on eight kinds of nine is the column's own however the ninth is declared.
            const owner = mine.length <= 2 && mine.length < kinds.length ? mine.join(" · ") : undefined;
            if (!held.has(name)) held.set(name, propOffer(name, prop, tone, owner));
        }
    }
    // The count axis has no door of its own and every scope can ask it, so it is offered wherever a scope is open.
    held.set(GRAMMAR.countWord, {
        shape: "door",
        word: GRAMMAR.countWord,
        insert: GRAMMAR.countWord + GRAMMAR.bind,
        note: hintOf(COUNT_PROP),
        tone,
    });
    return [...held.values()].sort((a, b) => a.word.localeCompare(b.word));
}

/**
 * The words one property's own value may be spelled with: its sentinels, a mask's roles, the any-word.
 *
 * ⚠ An enum's own values are missing from this list, and the reason is a missing declaration rather than a design
 * call: `chest` and the other attachment words live in the PACK's vocabularies, and no declaration says which
 * vocabulary a property reads. Both halves of the ruled picker — the word list and the cardinality that decides
 * whether to show one — wait on that link. The expansion ladder is the same gap seen from the other side: its
 * rungs are loaded from a pack, and the page never loads one.
 */
function valueOffers(prop: Prop, tone: string): { sentinels: Offer[]; words: Offer[]; roles: Offer[] } {
    const word = (spelling: string, note: string): Offer =>
        ({shape: "word", word: spelling, insert: spelling, note, tone});
    const sentinels = Object.values(prop.sentinels ?? {})
        .map((spelling) => word(spelling, i18n.t("ui:surface.sentinelNote")));
    // A role needs no note of its own: the section it sits under already says what it answers, and a note that
    // only restates the word is noise on every row.
    const roles = prop.types.includes(bitmask) ? TARGET_ROLES.map((role) => word(role, "")) : [];
    const any = operatorsOf(prop).includes("present")
        ? [word(GRAMMAR.anyWord, i18n.t("ui:surface.anyNote"))] : [];
    return {sentinels, words: any, roles};
}

/** One group's offers, narrowed by what has been typed: what starts with it first, then what merely contains it. */
function narrow(offers: readonly Offer[], typed: string): Offer[] {
    const held = fold(typed);
    if (held === "") return [...offers];
    const spellings = (offer: Offer): string[] => [offer.word, ...(offer.reads ?? [])].map(fold);
    const opens = (offer: Offer): boolean => spellings(offer).some((word) => word.startsWith(held));
    const holds = (offer: Offer): boolean => spellings(offer).some((word) => word.includes(held));
    return [...offers.filter(opens), ...offers.filter((offer) => !opens(offer) && holds(offer))];
}

/**
 * A narrowed group, or nothing where narrowing emptied it.
 *
 * A WORD already typed whole is dropped, because taking it would write what is already written. A door is kept:
 * the word may be complete, but the bind that turns it into an ask is not, and picking the row is how a reader
 * takes the word they typed through that door.
 */
function group(id: GroupId, offers: readonly Offer[], typed: string): OfferGroup[] {
    const narrowed = narrow(offers, typed)
        .filter((offer) => offer.shape !== "word" || fold(offer.word) !== fold(typed));
    return narrowed.length === 0 ? [] : [{id, label: i18n.t(`ui:surface.${id}`), offers: narrowed}];
}

/** The remembered searches, newest first, as offers that replace the whole bar. */
function historyGroup(history: readonly string[]): OfferGroup[] {
    if (history.length === 0) return [];
    const offers = history.map((query): Offer => ({shape: "query", word: query, insert: query, note: ""}));
    return [{id: "history", label: i18n.t("ui:surface.history"), offers}];
}

/** What a head opens: a column's scope, a kind's scope, or one property's value. */
type Context =
    | { readonly role: "column"; readonly column: Column }
    | { readonly role: "kind"; readonly kind: Kind }
    | { readonly role: "prop"; readonly prop: Prop; readonly tone: string; readonly name: string };

/** The head the caret's own segment sits under, resolved through the schema exactly as the parser resolves it. */
function contextOf(plan: BarPlan): Context | null {
    if (plan.head === null) return null;
    const head = HEADS.get(fold(plan.head.word));
    if (head === undefined) return null;
    if (head.role === "column") return {role: "column", column: head.column};
    if (head.role === "kind") return {role: "kind", kind: head.kind};
    return {role: "prop", prop: head.prop, tone: head.kind.column.key, name: head.name};
}

/**
 * The property an inner bind names, resolved through the parser's own lookup.
 *
 * `propIn` rather than a second matcher over the same fields: it reads a property's name, its full name, its
 * synonyms AND the active language's words, and a copy of that rule here would answer differently the moment a
 * localised word landed.
 */
function innerProp(context: Context, word: string): { prop: Prop; tone: string; name: string } | null {
    if (context.role === "prop") return null;
    const folded = fold(word);
    const tone = context.role === "column" ? context.column.key : context.kind.column.key;
    if (folded === GRAMMAR.countWord) return {prop: COUNT_PROP, tone, name: GRAMMAR.countWord};
    const kinds = context.role === "column" ? kindsOf(context.column) : [context.kind];
    for (const kind of kinds) {
        const name = propIn(kind, folded);
        if (name !== undefined) return {prop: kind.props[name], tone, name};
    }
    return null;
}

/**
 * What a value position takes: the property, what it is, and how a value is written.
 *
 * Two declarations rather than one string, which is also what separates a description from its examples: the
 * PROPERTY says what it means, the TYPE says how to spell one — and the type's line is where the examples live.
 *
 * @param prop The property being composed.
 * @param name Its own name, as the query writes it.
 * @returns The three lines the surface draws above the offers.
 */
function takesOf(prop: Prop, name: string): Takes {
    return {
        title: propNameOf(name, prop),
        what: hintOf(prop),
        // Every notation the property reads, in the order they are tried: a property with two of them takes
        // either, and saying only the first would teach half the axis.
        how: prop.types.map((type) => type.hint).join(" · "),
    };
}

/**
 * The unit a bare number is still missing, drawn as a ghost after it.
 *
 * A quantity type declares the notation its values are WRITTEN in, and that notation is what the chip will
 * display the number as anyway — so offering it while the number is being typed is the same fact said a moment
 * earlier. Only a suffix can be ghosted: a symbol that stands before its number is not a completion of it.
 *
 * @param prop The property being composed, where one is known.
 * @param typed What has been typed into the value so far.
 * @returns The symbol to draw after the caret, or an empty string.
 */
function unitGhost(prop: Prop | null, typed: string): string {
    if (prop === null || !/^-?\d+(\.\d+)?$/.test(typed)) return "";
    for (const type of prop.types) {
        const notation = type.notations?.[0];
        if (notation === undefined || notation.unit === "" || notation.position === "before") continue;
        return notation.glyph ?? notation.unit;
    }
    return "";
}

/** The three value groups one property offers, in the order the surface draws them. */
function valueGroups(prop: Prop, tone: string, typed: string): OfferGroup[] {
    const {sentinels, words, roles} = valueOffers(prop, tone);
    return [
        ...group("sentinels", sentinels, typed),
        ...group("roles", roles, typed),
        ...group("words", words, typed),
    ];
}

/**
 * What the surface offers at the caret.
 *
 * @param plan The open position's plan.
 * @param caret Where the caret sits inside the plan's slot.
 * @param history The remembered searches, newest first.
 * @returns The groups to draw, the slot characters an offer replaces, and the ghost the slot draws.
 */
export function offersAt(plan: BarPlan, caret: number, history: readonly string[]): Offers {
    const slot = plan.slot;
    const at = Math.min(Math.max(caret, 0), slot.length);
    // An empty bar is the one position with nothing typed to narrow by: it offers the whole menu.
    if ((plan.before + plan.open + plan.after).trim() === "") {
        return {
            groups: [...historyGroup(history), ...group("axes", doorOffers(), "")],
            takes: null,
            stub: {start: at, end: at},
            ghost: "",
            negated: false,
        };
    }

    const term = termAt(slot, at);
    const context = contextOf(plan);
    const bind = bindIn(slot.slice(term.start, term.end));
    // Past a term's own bind the caret is composing a VALUE, so the property that bind names is what answers.
    const bound = bind >= 0 && at > term.start + bind && context !== null && context.role !== "prop";
    const boundWord = bound ? slot.slice(term.start, term.start + bind) : "";
    const inner = bound && context !== null ? innerProp(context, boundWord) : null;
    // A leading minus negates whatever follows it, so it is not part of the word an offer replaces — and every
    // offer made under one excludes rather than asks, which the rows say for themselves.
    const negated = inner === null && slot.startsWith(GRAMMAR.negate, term.start);
    const from = inner !== null ? term.start + bind + 1 : term.start + (negated ? 1 : 0);
    const stub = {start: Math.min(from, at), end: Math.max(term.end, at)};
    const typed = slot.slice(stub.start, at);
    // The surface completes what the caret is at the END of. A caret dropped into the middle of a word is a
    // reader going back to fix something, not one composing a word — offering completions there is how a list
    // comes to open at every click, and it would be offering to replace the half of the word past the caret.
    if (at < stub.end) return NO_OFFERS;

    // A bind whose word is not a property of what the scope asks about: the parse will say so at commit, and
    // while the reader is still typing this surface is the channel that says it — with the properties that ARE
    // there, which is the answer rather than the complaint.
    const foreign = bound && inner === null;

    // The property whose value is being composed, whichever door reached it: a property's own door, an inner
    // bind, or a KIND's word — which is the door to its subject, the first property it declares.
    const subject = context?.role === "kind" ? Object.entries(context.kind.props)[0] : undefined;
    const composing = inner !== null ? inner
        : context?.role === "prop" ? {prop: context.prop, tone: context.tone, name: context.name}
            : subject !== undefined && bind < 0
                ? {prop: subject[1], tone: context?.role === "kind" ? context.kind.column.key : "", name: subject[0]}
                : null;
    const groups = ((): OfferGroup[] => {
        // A kind's scope offers its properties as well as its subject's words: `scale:{}` takes an amount, and
        // `scale:{attach:...}` is the same scope saying something else about the same row. Past an inner bind
        // it does NOT: there the caret is inside that property's value, where a property name is not a value.
        if (context?.role === "kind" && composing !== null && inner === null) {
            return [
                ...valueGroups(composing.prop, composing.tone, typed),
                ...group("props", propOffers(context), typed),
            ];
        }
        if (composing !== null) return valueGroups(composing.prop, composing.tone, typed);
        if (context === null) return typed.length < DOOR_THRESHOLD ? [] : group("axes", doorOffers(), typed);
        if (context.role === "prop") return [];
        // The word before the bind is unknown here, so what is on offer is the properties it could have been.
        if (foreign) return group("props", propOffers(context), "");

        return [
            ...(context.role === "column" ? group("kinds", kindOffers(context.column), typed) : []),
            ...group("props", propOffers(context), typed),
        ];
    })();
    const scope = context !== null && context.role !== "prop" ? context : null;
    const takes = foreign && scope !== null
        ? {
            title: boundWord,
            what: i18n.t("diagnostics:scope.foreignProperty", {
                kind: scope.role === "column" ? scope.column.key : wordOf(scope.kind),
                word: boundWord,
            }),
            how: "",
        }
        : composing === null ? null : takesOf(composing.prop, composing.name);

    // The ghost is drawn in the slot's own mirror, so it may only ever be appended: anywhere but the end it would
    // shift the mirrored text out from under the field's own caret.
    const atEnd = at === slot.length && stub.end === at;
    const best = groups[0]?.offers[0];
    const completes = best !== undefined && best.shape !== "query" && typed !== ""
        && atEnd && best.insert.startsWith(typed);
    const unit = atEnd ? unitGhost(composing?.prop ?? null, typed) : "";
    return {groups, takes, stub, ghost: completes ? best.insert.slice(typed.length) : unit, negated};
}
