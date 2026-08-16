/**
 * @file The control surface: one floating dropdown anchored to the open chip, offering structure and closed
 * vocabularies — never the corpus.
 *
 * The governing principle, the user's own words: the query is aware of syntax and enums, not of data. An empty bar
 * offers history and the axis doors; free typing offers axis shortcuts only; an open chip offers whatever control
 * its slot's type asks for — words for a picker, a clean track for a number, the native picker for a colour. Soft
 * hints for the value being composed render here too, in the message section; committed diagnostics stay in the
 * tray.
 */
import type {ReactElement} from "react";
import {useTranslation} from "react-i18next";
import type {PackDomain} from "../../data";
import type {Head, Kind, Prop} from "../../search/index";
import {
    doorOf, formatValue, HEADS, hintOf, kindsOf, nameOf, parseValue, propNameOf, sentinelOf, TARGET_ROLES, wordOf,
} from "../../search/index";
import styles from "./surface.module.css";

/** What the surface is anchored to and offering for. */
export type SurfaceContext =
    /** Empty bar, focused: recent searches, then the axis doors. */
    | { readonly at: "menu" }
    /** Free text with no head yet: the axis shortcuts that match it. */
    | { readonly at: "free"; readonly word: string }
    /** An open chip: the head's own control. */
    | { readonly at: "open"; readonly head: Head; readonly rest: string };

/** What the surface can do to the bar. */
export interface SurfaceActions {
    /** Replaces the open slot's text. */
    readonly setRest: (rest: string) => void;
    /** Opens an axis door — as if the reader typed `word:`. */
    readonly openAxis: (word: string) => void;
    /** Replaces the whole query — a history entry. */
    readonly recall: (query: string) => void;
}

/** The principal spelling of every top-level door, deduplicated — synonyms are ways in, not rows. */
export function axisDoors(): { word: string; hint: string }[] {
    const rows: { word: string; hint: string }[] = [];
    for (const [word, head] of HEADS) {
        if (head.role === "column" && word === head.column.key) {
            rows.push({word, hint: head.column.hint});
        } else if (head.role === "kind" && word === head.kind.word) {
            rows.push({word, hint: head.kind.hint});
        } else if (head.role === "prop" && word === doorOf(head.name, head.prop)) {
            rows.push({word, hint: hintOf(head.prop)});
        }
    }
    return rows.toSorted((a, b) => a.word.localeCompare(b.word));
}

/** The property the open head edits, when it names exactly one — a kind head with one numeric subject included. */
function propOfHead(head: Head): { kind: Kind; name: string; prop: Prop } | null {
    if (head.role === "prop") return {kind: head.kind, name: head.name, prop: head.prop};
    if (head.role === "kind") {
        const numeric = Object.entries(head.kind.props).filter(([, prop]) => prop.qualifier !== true
            && (prop.types[0].ui === "number" || prop.types[0].ui === "range"));
        if (numeric.length === 1) return {kind: head.kind, name: numeric[0][0], prop: numeric[0][1]};
    }
    return null;
}

/** Keeps focus in the editing session: a mousedown on a control must not blur the slot. */
const keepFocus = (e: { preventDefault: () => void }): void => { e.preventDefault(); };

/** One clickable row: a word and its one-line note. */
function Row({word, note, onPick}: {
    readonly word: string; readonly note?: string; readonly onPick: () => void;
}): ReactElement {
    return (
        <button type="button" className={styles.row} onMouseDown={keepFocus} onClick={onPick}>
            <span className={styles.rowWord}>{word}</span>
            {note !== undefined && <span className={styles.rowNote}>{note}</span>}
        </button>
    );
}

/**
 * Axes whose pack domain is keyed under a different name than their door.
 *
 * TODO: the link between a property and its `meta.domains` key is declared nowhere — the build names domains by its
 * own axis names. Until one side declares the other, this table carries the two that differ.
 */
const DOMAIN_KEYS: Record<string, string> = {cast: "casttime", seats: "seat"};

/** The domain the pack measured for this axis, under any of the spellings the build keys it by. */
function domainOf(
    domains: Record<string, PackDomain> | undefined, head: Head,
): PackDomain | undefined {
    if (domains === undefined) return undefined;
    const at = propOfHead(head);
    if (at === null) return undefined;
    const door = doorOf(at.name, at.prop);
    const keys = [
        DOMAIN_KEYS[door] ?? "", door,
        head.role === "kind" ? wordOf(head.kind) : "",
        at.name, at.prop.full ?? "", propNameOf(at.name, at.prop),
    ];
    for (const key of keys) {
        if (key !== "" && domains[key] !== undefined) return domains[key];
    }
    return undefined;
}

/** The trailing number in the slot, with what surrounds it, so steppers and sliders can rewrite it in place. */
function splitNumber(rest: string): { prefix: string; num: number; suffix: string } | null {
    const match = /^(.*?)(-?\d+(?:\.\d+)?)([^\d]*)$/.exec(rest);
    if (match === null) return null;
    return {prefix: match[1], num: Number(match[2]), suffix: match[3]};
}

/** The comparison the slot opens with, for the operator segment. */
const OPS: readonly { symbol: string; written: string }[] = [
    {symbol: "≥", written: ">="}, {symbol: "=", written: "="}, {symbol: "≤", written: "<="},
];

/**
 * The number control: a clean track between the pack's measured bounds, sentinel words on the control, stepper
 * arrows beside the value, the comparison segment, and the unit selector where the type reads several notations.
 */
function NumberControl({head, rest, domain, actions}: {
    readonly head: Head; readonly rest: string;
    readonly domain: PackDomain | undefined; readonly actions: SurfaceActions;
}): ReactElement | null {
    const {t} = useTranslation();
    const at = propOfHead(head);
    if (at === null) return null;
    const type = at.prop.types[0];
    const split = splitNumber(rest);
    const opNow = OPS.find((op) => rest.trimStart().startsWith(op.written))
        ?? (rest.trimStart().startsWith(">") ? OPS[0] : rest.trimStart().startsWith("<") ? OPS[2] : null);
    // The slider moves in STORED units — the domain's space — so the slot is read back through the property's own
    // notations, never as its bare display number: "2.5s" is 2500, not 2.5.
    const bare = rest.replace(/^\s*[<>=]+/, "").trim();
    const parsed = bare === "" ? null : parseValue(at.prop, bare);
    const stored = typeof parsed?.value === "number" ? parsed.value : null;

    /** Writes a stored value into the slot in the canonical spelling, keeping the comparison already there. */
    const write = (stored: number): void => {
        const op = opNow?.written ?? "";
        actions.setRest(op + formatValue(at.prop, stored));
    };

    const sentinels = Object.entries(at.prop.sentinels ?? {});
    const notations = type.notations ?? [];
    return (
        <div className={styles.control} onMouseDown={keepFocus}>
            <div className={styles.controlRow}>
                <span className={styles.segmented}>
                    {OPS.map((op) => (
                        <button
                            key={op.symbol} type="button"
                            className={`${styles.segBtn} ${opNow?.symbol === op.symbol ? styles.on : ""}`}
                            onClick={() => {
                                const bare = split === null ? rest.replace(/^[<>=]+/, "") : rest;
                                const stripped = bare.replace(/^\s*[<>=]+/, "");
                                actions.setRest((op.written === "=" ? "=" : op.written) + stripped);
                            }}
                        >
                            {op.symbol}
                        </button>
                    ))}
                </span>
                {split !== null && type.storage === "int" && (
                    <span className={styles.stepper}>
                        <button
                            type="button" className={styles.stepBtn}
                            onClick={() => { actions.setRest(`${split.prefix}${String(split.num + 1)}${split.suffix}`); }}
                        >
                            ▲
                        </button>
                        <button
                            type="button" className={styles.stepBtn}
                            onClick={() => { actions.setRest(`${split.prefix}${String(split.num - 1)}${split.suffix}`); }}
                        >
                            ▼
                        </button>
                    </span>
                )}
                {notations.length > 1 && (
                    <span className={styles.segmented} title={t("surface.unit")}>
                        {notations.map((notation) => (
                            <button
                                key={notation.unit} type="button" className={styles.segBtn}
                                onClick={() => {
                                    const held = split?.num;
                                    if (held === undefined) return;
                                    const shown = notation.position === "before"
                                        ? `${notation.unit}${String(held)}` : `${String(held)}${notation.unit}`;
                                    actions.setRest((opNow?.written ?? "") + shown);
                                }}
                            >
                                {notation.unit === "" ? "·" : notation.unit}
                            </button>
                        ))}
                    </span>
                )}
            </div>
            {domain !== undefined && (
                <>
                    <input
                        type="range" className={styles.slider}
                        min={domain.p1} max={domain.p99} step={domain.step}
                        value={stored ?? domain.median}
                        onChange={(e) => { write(Number(e.target.value)); }}
                    />
                    <div className={styles.bounds}>
                        <span>{formatValue(at.prop, domain.p1)}</span>
                        {domain.clipped && <span>{t("surface.clipped")}</span>}
                        <span>{formatValue(at.prop, domain.p99)}</span>
                    </div>
                </>
            )}
            {sentinels.length > 0 && (
                <div className={styles.controlRow}>
                    {sentinels.map(([, word]) => (
                        <button
                            key={word} type="button" className={styles.wordBtn}
                            onClick={() => { actions.setRest(word); }}
                        >
                            {word}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** The word list a picker offers — a closed vocabulary only, sentinels included, never the corpus. */
function PickerControl({head, actions}: {
    readonly head: Head; readonly actions: SurfaceActions;
}): ReactElement {
    const at = propOfHead(head);
    const sentinels = at === null ? [] : Object.values(at.prop.sentinels ?? {});
    return (
        <div className={styles.section}>
            {sentinels.map((word) => (
                <Row key={word} word={word} onPick={() => { actions.setRest(word); }}/>
            ))}
            {at !== null && <div className={styles.message}>{hintOf(at.prop)}</div>}
        </div>
    );
}

/** The glyph panel: a checkbox per target role, the multi-select emitting ONE anyOf term per the standing law. */
function GlyphControl({rest, actions}: {
    readonly rest: string; readonly actions: SurfaceActions;
}): ReactElement {
    const picked = new Set(rest.replace(/[()]/g, "").split("|").map((word) => word.trim()).filter(Boolean));
    const toggle = (role: string): void => {
        const next = new Set(picked);
        if (next.has(role)) next.delete(role);
        else next.add(role);
        const words = TARGET_ROLES.filter((word) => next.has(word));
        actions.setRest(words.length > 1 ? `(${words.join("|")})` : words[0] ?? "");
    };
    return (
        <div className={styles.section} onMouseDown={keepFocus}>
            {TARGET_ROLES.map((role) => (
                <label key={role} className={styles.check}>
                    <input type="checkbox" checked={picked.has(role)} onChange={() => { toggle(role); }}/>
                    {role}
                </label>
            ))}
        </div>
    );
}

/** The native colour picker, our tokens on its chrome; matching is exact, so a miss is the ordinary zero-result. */
function ColourControl({actions}: { readonly actions: SurfaceActions }): ReactElement {
    return (
        <div className={styles.control} onMouseDown={keepFocus}>
            <input
                type="color" className={styles.colour}
                onChange={(e) => { actions.setRest(e.target.value.slice(1)); }}
            />
        </div>
    );
}

/**
 * The floating control surface.
 *
 * @returns The dropdown, or null when the context offers nothing.
 */
export function Surface({context, domains, history, messages, actions}: {
    readonly context: SurfaceContext;
    readonly domains: Record<string, PackDomain> | undefined;
    readonly history: readonly string[];
    /** Soft hints for the value being composed — the silent-while-typing channel. */
    readonly messages: readonly string[];
    readonly actions: SurfaceActions;
}): ReactElement | null {
    const {t} = useTranslation();

    if (context.at === "menu") {
        return (
            <div className={styles.surface} onMouseDown={keepFocus}>
                <div className={styles.section}>
                    <div className={styles.heading}>{t("surface.history")}</div>
                    {history.length === 0 && <div className={styles.message}>{t("surface.noHistory")}</div>}
                    {history.map((query) => (
                        <Row key={query} word={query} onPick={() => { actions.recall(query); }}/>
                    ))}
                </div>
                <div className={styles.section}>
                    <div className={styles.heading}>{t("surface.axes")}</div>
                    {axisDoors().map((door) => (
                        <Row
                            key={door.word} word={door.word} note={door.hint}
                            onPick={() => { actions.openAxis(door.word); }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (context.at === "free") {
        const matches = axisDoors().filter((door) => door.word.startsWith(context.word.toLowerCase()));
        if (matches.length === 0 || context.word === "") return null;
        return (
            <div className={styles.surface} onMouseDown={keepFocus}>
                <div className={styles.section}>
                    <div className={styles.heading}>{t("surface.axes")}</div>
                    {matches.map((door) => (
                        <Row
                            key={door.word} word={`${door.word}:`} note={door.hint}
                            onPick={() => { actions.openAxis(door.word); }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    const {head} = context;
    const at = propOfHead(head);
    const ui = at?.prop.types[0].ui;
    const type = at === null ? undefined : at.prop.types[0];

    return (
        <div className={styles.surface} onMouseDown={keepFocus}>
            {head.role === "column" && (
                <div className={styles.section}>
                    <div className={styles.heading}>{t("surface.kinds")}</div>
                    {kindsOf(head.column).filter((kind) => kind.word !== undefined).map((kind) => (
                        <Row
                            key={kind.id} word={wordOf(kind)} note={kind.hint}
                            onPick={() => { actions.setRest(wordOf(kind)); }}
                        />
                    ))}
                </div>
            )}
            {head.role === "kind" && (
                <div className={styles.section}>
                    <div className={styles.heading}>{nameOf(head.kind)}</div>
                    {Object.entries(head.kind.props).map(([name, prop]) => (
                        <Row
                            key={name} word={propNameOf(name, prop)} note={hintOf(prop)}
                            onPick={() => { actions.setRest(`{${name}: }`); }}
                        />
                    ))}
                </div>
            )}
            {(ui === "number" || ui === "range" || ui === "dial") && (
                <NumberControl head={head} rest={context.rest} domain={domainOf(domains, head)} actions={actions}/>
            )}
            {(ui === "picker" || ui === "toggle") && <PickerControl head={head} actions={actions}/>}
            {ui === "glyphs" && <GlyphControl rest={context.rest} actions={actions}/>}
            {ui === "colour" && <ColourControl actions={actions}/>}
            {(ui === "text" || ui === undefined) && at !== null && (
                <div className={styles.message}>{hintOf(at.prop)}</div>
            )}
            {messages.length > 0 && (
                <div className={styles.section}>
                    {messages.map((message) => <div key={message} className={styles.message}>{message}</div>)}
                </div>
            )}
            {type?.notations !== undefined && (
                <div className={styles.footnote}>
                    {t("surface.notation", {
                        forms: type.notations.map((n) => (n.unit === "" ? "bare" : n.unit)).join(", "),
                    })}
                </div>
            )}
            {at !== null && sentinelOf(at.prop, context.rest.trim()) === null && context.rest.trim() === ""
                && <div className={styles.footnote}>{t("surface.empty")}</div>}
        </div>
    );
}
