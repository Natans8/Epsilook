/**
 * @file The control surface: one floating dropdown anchored to the open chip, offering structure and closed
 * vocabularies — never the corpus.
 *
 * The governing principle, the user's own words: the query is aware of syntax and enums, not of data. An empty bar
 * offers history and the axis doors; free typing offers axis shortcuts only; an open chip offers whatever control
 * its slot's type asks for. Every operator the comparison segment shows comes from the property's OWN declaration —
 * an axis that refuses ordering shows no ordering, exactly as the parser would refuse it.
 *
 * Focus law: the chip and this surface are ONE editing session. A button steals no focus (its mousedown is
 * swallowed), while a slider or a bound slot takes focus legitimately — both live inside the bar's wrap, and only
 * a press outside the wrap ends the session.
 */
import type {KeyboardEvent, ReactElement} from "react";
import {useTranslation} from "react-i18next";
import type {PackDomain} from "../../data";
import type {Head, Kind, Prop} from "../../search/index";
import {
    doorOf, formatValue, HEADS, hintOf, kindsOf, nameOf, operatorsOf, parseValue, propNameOf, TARGET_ROLES, wordOf,
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
    /** Returns focus to the editing slot — Escape from anywhere in the surface. */
    readonly focusSlot: () => void;
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

/** Swallows a button press before it can steal the slot's focus. Buttons only — a slider needs its mouse. */
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

/* ------------------------------------------------------------------- the number control */

/** The comparison spellings, in number-line order. Offered only where the property's operators include them. */
const COMPARISONS = [
    {name: "lt", symbol: "<", written: "<"},
    {name: "lte", symbol: "≤", written: "<="},
    {name: "exact", symbol: "=", written: "="},
    {name: "gte", symbol: "≥", written: ">="},
    {name: "gt", symbol: ">", written: ">"},
] as const;

/** How the slot text currently reads: its comparison, its range split, and its bare value text. */
interface SlotShape {
    readonly op: (typeof COMPARISONS)[number] | null;
    /** The text after any comparison symbol. */
    readonly bare: string;
    /** The two bound texts, when the bare text is a range. */
    readonly bounds: readonly [string, string] | null;
}

/** Reads the slot. The range split ignores a leading minus, which is a sign rather than the separator. */
function slotShape(rest: string): SlotShape {
    const trimmed = rest.trim();
    const op = COMPARISONS.filter((c) => trimmed.startsWith(c.written))
        .toSorted((a, b) => b.written.length - a.written.length)[0] ?? null;
    const bare = op === null ? trimmed : trimmed.slice(op.written.length).trim();
    const range = /^(.+?[^-\s])-(.+)$/.exec(bare);
    const bounds = op === null && range !== null ? [range[1], range[2]] as const : null;
    return {op, bare, bounds};
}

/** The stored value a bound's text reads as, or null. */
function storedOf(prop: Prop, text: string): number | null {
    if (text.trim() === "") return null;
    const parsed = parseValue(prop, text.trim());
    return typeof parsed?.value === "number" ? parsed.value : null;
}

/**
 * The number control: the property's own comparisons, a clean track between the pack's measured bounds, sentinel
 * words on the control, steppers beside an integer value, and the unit selector where several notations read.
 * A range ask gets both bounds as typed slots over a dual-handle track.
 */
function NumberControl({head, rest, domain, actions}: {
    readonly head: Head; readonly rest: string;
    readonly domain: PackDomain | undefined; readonly actions: SurfaceActions;
}): ReactElement | null {
    const {t} = useTranslation();
    const at = propOfHead(head);
    if (at === null) return null;
    const type = at.prop.types[0];
    const offered = operatorsOf(at.prop);
    const comparisons = COMPARISONS.filter((c) => offered.includes(c.name));
    const rangeOffered = offered.includes("range");
    const shape = slotShape(rest);
    const stored = shape.bounds === null ? storedOf(at.prop, shape.bare) : null;
    const lo = shape.bounds === null ? null : storedOf(at.prop, shape.bounds[0]);
    const hi = shape.bounds === null ? null : storedOf(at.prop, shape.bounds[1]);
    const write = (value: number): string => formatValue(at.prop, value);

    /** Rewrites the slot with a comparison, keeping the value; the active comparison toggles off. */
    const setOp = (written: string): void => {
        const value = shape.bounds === null ? shape.bare : shape.bounds[0];
        if (shape.op?.written === written) actions.setRest(value);
        else actions.setRest(written + value);
    };
    const toRange = (): void => {
        if (shape.bounds !== null) { actions.setRest(shape.bare.split("-")[0]); return; }
        const from = shape.bare !== "" ? shape.bare : write(domain?.p1 ?? 0);
        const to = domain !== undefined ? write(domain.p99) : from;
        actions.setRest(`${from}-${to}`);
    };
    const setBound = (which: 0 | 1, text: string): void => {
        const bounds = shape.bounds ?? [shape.bare, shape.bare];
        const next = which === 0 ? [text, bounds[1]] : [bounds[0], text];
        actions.setRest(`${next[0]}-${next[1]}`);
    };

    const sentinels = Object.entries(at.prop.sentinels ?? {});
    const notations = type.notations ?? [];
    const showOps = comparisons.length > 1 || rangeOffered;
    return (
        <div className={styles.control}>
            {showOps && (
                <div className={styles.controlRow}>
                    <span className={styles.segmented}>
                        {comparisons.map((c) => (
                            <button
                                key={c.name} type="button" onMouseDown={keepFocus}
                                className={`${styles.segBtn} ${shape.op?.name === c.name ? styles.on : ""}`}
                                onClick={() => { setOp(c.written); }}
                            >
                                {c.symbol}
                            </button>
                        ))}
                        {rangeOffered && (
                            <button
                                type="button" onMouseDown={keepFocus}
                                className={`${styles.segBtn} ${shape.bounds !== null ? styles.on : ""}`}
                                onClick={toRange}
                            >
                                –
                            </button>
                        )}
                    </span>
                    {shape.bounds === null && /^-?\d+$/.test(shape.bare) && type.storage === "int" && (
                        <span className={styles.stepper}>
                            <button
                                type="button" className={styles.stepBtn} onMouseDown={keepFocus}
                                onClick={() => { actions.setRest((shape.op?.written ?? "") + String(Number(shape.bare) + 1)); }}
                            >
                                ▲
                            </button>
                            <button
                                type="button" className={styles.stepBtn} onMouseDown={keepFocus}
                                onClick={() => { actions.setRest((shape.op?.written ?? "") + String(Number(shape.bare) - 1)); }}
                            >
                                ▼
                            </button>
                        </span>
                    )}
                    {notations.length > 1 && shape.bounds === null && (
                        <span className={styles.segmented} title={t("surface.unit")}>
                            {notations.map((notation) => (
                                <button
                                    key={notation.unit} type="button" className={styles.segBtn} onMouseDown={keepFocus}
                                    onClick={() => {
                                        const held = /-?\d+(?:\.\d+)?/.exec(shape.bare)?.[0];
                                        if (held === undefined) return;
                                        const shown = notation.position === "before"
                                            ? `${notation.unit}${held}` : `${held}${notation.unit}`;
                                        actions.setRest((shape.op?.written ?? "") + shown);
                                    }}
                                >
                                    {notation.unit === "" ? "·" : notation.unit}
                                </button>
                            ))}
                        </span>
                    )}
                </div>
            )}
            {shape.bounds !== null && (
                <div className={styles.controlRow}>
                    <input
                        className={styles.bound} value={shape.bounds[0]}
                        onChange={(e) => { setBound(0, e.target.value); }}
                        spellCheck={false} autoComplete="off"
                    />
                    <span className={styles.boundDash}>–</span>
                    <input
                        className={styles.bound} value={shape.bounds[1]}
                        onChange={(e) => { setBound(1, e.target.value); }}
                        spellCheck={false} autoComplete="off"
                    />
                </div>
            )}
            {domain !== undefined && shape.bounds === null && (
                <input
                    type="range" className={styles.slider}
                    min={domain.p1} max={domain.p99} step={domain.step}
                    value={stored ?? domain.median}
                    onChange={(e) => { actions.setRest((shape.op?.written ?? "") + write(Number(e.target.value))); }}
                />
            )}
            {domain !== undefined && shape.bounds !== null && (
                <div className={styles.dual}>
                    <input
                        type="range" min={domain.p1} max={domain.p99} step={domain.step}
                        value={Math.min(lo ?? domain.p1, hi ?? domain.p99)}
                        onChange={(e) => { setBound(0, write(Number(e.target.value))); }}
                    />
                    <input
                        type="range" min={domain.p1} max={domain.p99} step={domain.step}
                        value={hi ?? domain.p99}
                        onChange={(e) => { setBound(1, write(Number(e.target.value))); }}
                    />
                </div>
            )}
            {domain !== undefined && (
                <div className={styles.bounds}>
                    <span>{write(domain.p1)}</span>
                    {domain.clipped && <span>{t("surface.clipped")}</span>}
                    <span>{write(domain.p99)}</span>
                </div>
            )}
            {sentinels.length > 0 && (
                <div className={styles.controlRow}>
                    {sentinels.map(([, word]) => (
                        <button
                            key={word} type="button" className={styles.wordBtn} onMouseDown={keepFocus}
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
        <div className={styles.section}>
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
        <div className={styles.control}>
            <input
                type="color" className={styles.colour}
                onChange={(e) => { actions.setRest(e.target.value.slice(1)); }}
            />
        </div>
    );
}

/** Focus walking inside the surface: the arrows move across its buttons, Escape returns to the slot. */
function onSurfaceKeys(e: KeyboardEvent<HTMLDivElement>, focusSlot: () => void): void {
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        focusSlot();
        return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    // A slider or a text slot owns its own arrow keys.
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input")];
    const from = focusable.indexOf(target);
    const next = focusable[from + (e.key === "ArrowDown" ? 1 : -1)];
    if (next !== undefined) {
        e.preventDefault();
        next.focus();
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusSlot();
    }
}

/**
 * The floating control surface.
 *
 * @returns The dropdown, or null when the context offers nothing.
 */
export function Surface({context, domains, history, messages, actions, left}: {
    readonly context: SurfaceContext;
    readonly domains: Record<string, PackDomain> | undefined;
    readonly history: readonly string[];
    /** Soft hints for the value being composed — the silent-while-typing channel. */
    readonly messages: readonly string[];
    readonly actions: SurfaceActions;
    /** Where the open chip sits, so the surface anchors to it rather than to the bar. */
    readonly left: number;
}): ReactElement | null {
    const {t} = useTranslation();
    const anchor = {left};

    if (context.at === "menu") {
        return (
            <div
                className={styles.surface} style={anchor}
                onKeyDown={(e) => { onSurfaceKeys(e, actions.focusSlot); }}
            >
                <div className={styles.scroll}>
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
            </div>
        );
    }

    if (context.at === "free") {
        const matches = axisDoors().filter((door) => door.word.startsWith(context.word.toLowerCase()));
        if (matches.length === 0 || context.word === "") return null;
        return (
            <div
                className={styles.surface} style={anchor}
                onKeyDown={(e) => { onSurfaceKeys(e, actions.focusSlot); }}
            >
                <div className={styles.scroll}>
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
            </div>
        );
    }

    const {head} = context;
    const at = propOfHead(head);
    const ui = at?.prop.types[0].ui;
    const type = at === null ? undefined : at.prop.types[0];

    return (
        <div
            className={styles.surface} style={anchor}
            onKeyDown={(e) => { onSurfaceKeys(e, actions.focusSlot); }}
        >
            <div className={styles.scroll}>
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
            </div>
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
        </div>
    );
}
