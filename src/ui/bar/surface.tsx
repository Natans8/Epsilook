/**
 * @file The control surface: one floating panel under the bar, carrying whatever the open position can take.
 *
 * One anchor and one popover, sectioned by what it is offering — the shape the design ruled for every control
 * that will live here, of which completion is the first tenant. It draws in the CHIP LANGUAGE rather than in
 * prose: a door row wears the head cell it would become, a word row wears the vocabulary mark it would carry,
 * a remembered search is painted by the bar's own highlighter. What the reader picks is what they will see.
 *
 * The panel is an ordinary absolutely positioned child of the bar rather than a top-layer popover: it is never
 * clipped here, it scrolls with the page for free, and the top layer would buy nothing but a scroll listener to
 * keep its coordinates true. Anchoring is a measured left offset, because Firefox has no anchor positioning.
 *
 * Focus never leaves the slot. Every row is an `option` the input points at with `aria-activedescendant`, which
 * is the combobox contract: the caret stays where the reader is typing, and the surface is a list they steer.
 */
import type {ReactElement} from "react";
import {useLayoutEffect, useRef} from "react";
import {useTranslation} from "react-i18next";
import type {Offer, Offers} from "./offers";
import {Classed} from "./classed";
import {toneOf} from "./chip";
import {NEGATION} from "../../search/index";
import bar from "./bar.module.css";
import styles from "./surface.module.css";

/** The id one option answers to, so the input can point at it without moving the focus. */
export const optionId = (list: string, index: number): string => `${list}-opt-${String(index)}`;

/** One offer, drawn as the thing it will become. */
function Row({offer, negated, lit, id, onPick, onLight}: {
    readonly offer: Offer;
    readonly negated: boolean;
    readonly lit: boolean;
    readonly id: string;
    readonly onPick: () => void;
    readonly onLight: () => void;
}): ReactElement {
    const row = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        // The lit row follows the arrows into view; `nearest` scrolls the panel only when it has to.
        if (lit) row.current?.scrollIntoView({block: "nearest"});
    }, [lit]);

    const tone = toneOf(offer.tone);
    const body = offer.shape === "query"
        ? <span className={styles.query}><Classed text={offer.word} rich/></span>
        : offer.shape === "door"
            ? (
                // The exclusion class is this sheet's own: the chip's is a single class and would lose to the
                // door rule beside it, which is two deep so that it can override the head cell at all.
                <span className={`${bar.headCell} ${styles.door} ${tone} ${negated ? styles.excluded : ""}`}>
                    {negated ? NEGATION : ""}{offer.word}
                </span>
            )
            : <span className={`${styles.vocab} ${tone}`}>{offer.word}</span>;

    return (
        <div
            ref={row}
            id={id}
            role="option"
            aria-selected={lit}
            className={lit ? `${styles.row} ${styles.lit}` : styles.row}
            // The press must not leave the slot: the chip and this panel are one editing session, and a blur
            // would settle the very segment the row is about to write into.
            onMouseDown={(e) => {
                e.preventDefault();
            }}
            onClick={onPick}
            onMouseMove={onLight}
        >
            <span className={styles.word}>{body}</span>
            {/* Which kinds actually declare this property, where the column's own scope reaches more than one. */}
            {offer.owner !== undefined && <span className={styles.owner}>{offer.owner}</span>}
            {offer.note !== "" && <span className={styles.note}>{offer.note}</span>}
        </div>
    );
}

/**
 * The surface. Drawn only when there is something to offer, so an empty one never covers the page.
 */
export function Surface({offers, lit, listId, onPick, onLight}: {
    readonly offers: Offers;
    /** The lit offer's index in draw order, or -1 while the reader is still typing. */
    readonly lit: number;
    /** The panel's element id, which the input names in `aria-controls`. */
    readonly listId: string;
    readonly onPick: (offer: Offer) => void;
    readonly onLight: (index: number) => void;
}): ReactElement | null {
    const {t} = useTranslation();
    const panel = useRef<HTMLDivElement>(null);

    // The panel aligns its left edge with the open segment: measured after every render rather than from a
    // dependency list, because the anchor moves with each typed character while staying the same element, so
    // only the layout itself can say where it now is. Written straight to the style, not through state, so a
    // measurement can never ask for the render that would measure again.
    useLayoutEffect(() => {
        const el = panel.current;
        const host = el?.offsetParent;
        if (el == null || !(host instanceof HTMLElement)) return;
        // The open position stamps itself in the DOM, which is also how the bar's own press handling finds it.
        const anchor = host.querySelector<HTMLElement>("[data-open]");
        const room = Math.max(0, host.clientWidth - el.offsetWidth);
        const left = anchor === null ? 0 : Math.max(0, Math.min(anchor.offsetLeft, room));
        const next = `${String(Math.round(left))}px`;
        if (el.style.left !== next) el.style.left = next;
    });

    if (offers.groups.length === 0 && offers.takes === null) return null;
    let index = -1;
    return (
        <div
            ref={panel}
            id={listId}
            role="listbox"
            aria-label={t("surface.label")}
            className={styles.panel}
            data-surface=""
        >
            {/* What this position takes, before what it offers: the property, what it means, and how a value is
                written. The offers can only ever list WORDS, so without this line a numeric axis reads as though
                words were all it took. */}
            {offers.takes !== null && (
                <div className={styles.takes}>
                    <div className={styles.takesTitle}>{offers.takes.title}</div>
                    {offers.takes.what !== "" && <div className={styles.takesWhat}>{offers.takes.what}</div>}
                    <div className={styles.takesHow}>
                        <span className={styles.takesLabel}>{t("surface.takes")}</span>
                        {offers.takes.how}
                    </div>
                </div>
            )}
            {offers.groups.map((group) => (
                <div key={group.id} role="group" aria-labelledby={`${listId}-${group.id}`} className={styles.group}>
                    <div id={`${listId}-${group.id}`} className={styles.section}>{group.label}</div>
                    {group.offers.map((offer) => {
                        index += 1;
                        const held = index;
                        return (
                            <Row
                                key={`${group.id}:${offer.word}`}
                                offer={offer}
                                negated={offers.negated && offer.shape === "door"}
                                lit={held === lit}
                                id={optionId(listId, held)}
                                onPick={() => {
                                    onPick(offer);
                                }}
                                onLight={() => {
                                    onLight(held);
                                }}
                            />
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
