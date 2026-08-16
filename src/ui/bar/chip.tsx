/**
 * @file Committed clauses as DOM: the sectioned chip, the lane, freeform text, and raw error text.
 *
 * Everything rendered here is a view of the parse — {@link clauseView} decides what shows; this module only puts it
 * on screen. Interaction goes back up through callbacks: opening a clause for editing, deleting it, growing it.
 */
import type {ReactElement} from "react";
import {useTranslation} from "react-i18next";
import type {ClauseView, LaneItem, Segment} from "./segments";
import styles from "./chip.module.css";

/** The chip tone per column, as the token triplet the wash and border read. */
const TONES: Record<string, string> = {
    model: "var(--model-rgb)",
    sound: "var(--soundkit-rgb)",
    anim: "var(--animkit-rgb)",
    fx: "var(--fx-rgb)",
    mech: "224, 168, 120",
    spell: "var(--gold-rgb)",
    id: "var(--gold-rgb)",
};

/** The inline style carrying a chip's tone, read by the wash and border rules. */
const toneStyle = (tone: string): Record<string, string> =>
    TONES[tone] === undefined ? {} : {"--chip-rgb": TONES[tone]};

/** One classed run of chip text; a colour value draws its swatch grouped tight with the word. */
function Seg({segment}: { readonly segment: Segment }): ReactElement {
    if (segment.swatch !== undefined) {
        return (
            <span className={styles.colourGroup}>
                <span className={styles.swatch} style={{background: segment.swatch}}/>
                <span className={styles.vocab}>{segment.text}</span>
            </span>
        );
    }
    return <span className={styles[segment.kind]}>{segment.text}</span>;
}

/** A run of segments, negation fused into one red unit when asked. */
function Segs({segments, negated}: { readonly segments: readonly Segment[];
    readonly negated?: boolean }): ReactElement {
    const body = segments.map((segment, i) => <Seg key={i} segment={segment}/>);
    if (negated === true) return <span className={styles.negtok}>−{body}</span>;
    return <>{body}</>;
}

/** What the chip row tells the bar about a gesture on one clause. */
export interface ChipActions {
    /** Open the clause span for editing. */
    readonly open: (start: number, end: number) => void;
    /** Delete the clause span. */
    readonly remove: (start: number, end: number) => void;
    /** Grow the clause into a lane with an open slot. */
    readonly grow: (start: number, end: number) => void;
}

/** How one committed clause presents beyond its content. */
export interface ChipState {
    /** Amber warn state: the query still runs. */
    readonly warn: boolean;
    /** Armed by Backspace: the next Backspace deletes it whole. */
    readonly armed: boolean;
    /** Highlighted from the tray's row — the two-way squiggle linkage. */
    readonly linked: boolean;
}

/** The class list of a chip or lane enclosure. */
function enclosureClass(base: string, view: {negated: boolean}, state: ChipState): string {
    return [
        base,
        view.negated ? styles.neg : "",
        state.warn ? styles.warn : "",
        state.armed ? styles.armed : "",
        state.linked ? styles.linked : "",
    ].filter(Boolean).join(" ");
}

/** One item inside a lane. */
function LaneEntry({item, actions}: { readonly item: LaneItem;
    readonly actions: ChipActions }): ReactElement {
    if (item.is === "or") return <span className={styles.or}>or</span>;
    if (item.is === "raw") return <span className={styles.rawWarn}>{item.text}</span>;
    if (item.is === "text") {
        return (
            <span className={styles.laneText}>
                <Segs segments={item.segments} negated={item.negated}/>
            </span>
        );
    }
    return (
        <span className={`${styles.chip} ${item.negated ? styles.neg : ""}`}>
            <span className={styles.sect}>
                <span className={styles.head}>{item.negated ? `−${item.head}` : item.head}</span>
            </span>
            <span className={styles.content}>
                <Segs segments={item.segments}/>
            </span>
        </span>
    );
}

/**
 * One committed clause.
 *
 * @returns The chip, lane, text run or raw text, wired to its gestures.
 */
export function CommittedClause({view, span, state, actions}: {
    readonly view: ClauseView;
    readonly span: { start: number; end: number };
    readonly state: ChipState;
    readonly actions: ChipActions;
}): ReactElement {
    const {t} = useTranslation();
    const open = (): void => { actions.open(span.start, span.end); };

    if (view.is === "raw") {
        return <span className={styles.rawErr} data-own-press="" onClick={open}>{view.text}</span>;
    }
    if (view.is === "text") {
        return (
            <span className={`${styles.freeText} ${view.negated ? styles.neg : ""}`} data-own-press="" onClick={open}>
                <Segs segments={view.segments} negated={view.negated}/>
            </span>
        );
    }

    const x = (
        <button
            type="button" className={styles.x} title={t("bar.delete")}
            onClick={(e) => { e.stopPropagation(); actions.remove(span.start, span.end); }}
        >
            ×
        </button>
    );
    const add = (
        <button
            type="button" className={styles.add} title={t("bar.add")}
            onClick={(e) => { e.stopPropagation(); actions.grow(span.start, span.end); }}
        >
            +
        </button>
    );
    const head = view.negated ? `−${view.head}` : view.head;

    if (view.is === "chip") {
        return (
            <span
                className={enclosureClass(styles.chip, view, state)} style={toneStyle(view.tone)}
                data-own-press="" onClick={open}
            >
                <span className={styles.sect}>
                    {x}
                    <span className={styles.head}>{head}</span>
                </span>
                <span className={styles.content}>
                    <Segs segments={view.body}/>
                </span>
                {add}
            </span>
        );
    }

    return (
        <span
            className={enclosureClass(styles.lane, view, state)} style={toneStyle(view.tone)}
            data-own-press="" onClick={open}
        >
            <span className={styles.sect}>
                {x}
                <span className={styles.head}>{head}</span>
            </span>
            {view.items.map((item, i) => <LaneEntry key={i} item={item} actions={actions}/>)}
            {add}
        </span>
    );
}
