/**
 * @file The control surface's panel state, which both bars answer to.
 *
 * What is on offer at a position is a pure read of it ({@link ./offers!offersAt}). What lives here is the state
 * AROUND those offers — which row is lit, whether the panel has been put away, and which completion the slot
 * draws — together with the arithmetic that steers them.
 *
 * One statement, two callers, because these are rules about a list rather than about a bar: the chip bar and the
 * plaintext view differ only in how they DELIVER a taken offer, which stays each surface's own business. Written
 * twice, they drifted — one surface previewing one word and writing another, one reopening a dismissed panel and
 * the other not — and neither divergence was declared anywhere.
 */
import {useId, useState} from "react";
import type {Offer, Offers} from "../utils/offers";
import {flatOffers, offerGhost} from "../utils/offers";

/** The id one option answers to, so the input can point at it without moving the focus. */
export const optionId = (list: string, index: number): string => `${list}-opt-${String(index)}`;

/** The panel's state, and everything a keyboard or a pointer may do to it. */
export interface OfferPanel {
    /** Every offer in draw order — what the arrows walk and what a pick indexes into. */
    readonly flat: readonly Offer[];
    /** Whether the panel is drawn. */
    readonly shown: boolean;
    /** The lit row's index in draw order, or -1 while the reader has lit none. */
    readonly lit: number;
    /** The completion drawn dim after the caret, or empty. */
    readonly ghost: string;
    /**
     * The offer the ghost stands for, or undefined where it stands for none.
     *
     * The ghost and the key that takes it must name ONE offer. Read separately they chose separately — the
     * ghost the first offer anywhere that completed the typed characters, the key whichever row headed the
     * list — so a completion further down previewed one word and delivered another.
     */
    readonly ghosted: Offer | undefined;
    /** The listbox's id, which the field names in `aria-controls`. */
    readonly listId: string;
    /** Walks the light through the offers, wrapping at either end. */
    readonly move: (dir: -1 | 1) => void;
    /** Dismisses the surface until what is on offer changes. */
    readonly close: () => void;
    /** Lights one row, for a pointer moving over the panel. */
    readonly light: (index: number) => void;
    /** Puts the light out — what taking an offer, or leaving the field, does. */
    readonly reset: () => void;
}

/**
 * The panel's state for one position.
 *
 * @param offers What the position can be handed.
 * @param arrangement What the light and the dismissal were decided ABOUT — the query, the position and the
 *   caret, spelled however the calling surface identifies them. Two visits to the same arrangement must produce
 *   the same string; the numbering below is what tells them apart.
 * @returns The panel state and its gestures.
 */
export function useOfferPanel(offers: Offers, arrangement: string): OfferPanel {
    const listId = useId();
    // The lit offer and the dismissal, each stamped with the situation it was decided in: both are answers
    // about one arrangement of query, position and caret, and they lapse the moment that arrangement changes.
    // Stamping is what keeps them out of the effects that would otherwise have to clear them.
    const [litAt, setLitAt] = useState({stamp: "", index: -1});
    const [dismissed, setDismissed] = useState("");
    // NUMBERED, because an arrangement returned to is not the arrangement that was left. A light steered to at
    // `xpac:6` was decided about those characters under that caret; type them again later and a plain
    // comparison hands back the light that was already spent, so Enter applies an offer the reader never chose
    // instead of running their query. A dismissal returned to reads the same way, and stays shut.
    //
    // The count only has to DIFFER between visits, never to be sequential, so a render thrown away costs
    // nothing. Counted in STATE and adjusted during render: React re-runs the component before it renders any
    // child, so the pass that reads the stale count is discarded rather than drawn.
    const [visit, setVisit] = useState({arrangement: "", count: 0});
    if (visit.arrangement !== arrangement) setVisit({arrangement, count: visit.count + 1});
    const stamp = `${arrangement}#${String(visit.count)}`;

    const flat = flatOffers(offers);
    // Counted by ROWS, not groups: a group narrowed down to nothing must not hold an empty panel open.
    const shown = (flat.length > 0 || offers.takes !== null) && dismissed !== stamp;
    const lit = shown && litAt.stamp === stamp ? litAt.index : -1;
    // While the reader types, the ghost is the best completion; once they steer the list — arrows or the
    // pointer — the lit row previews instead, so what Enter would write is visible before it is taken.
    const ghosted = lit >= 0 ? flat[lit] : flat[offers.ghostAt];
    const ghost = shown ? (lit < 0 ? offers.ghost : offerGhost(offers, flat[lit])) : "";

    return {
        flat,
        shown,
        lit,
        ghost,
        ghosted,
        listId,
        move: (dir): void => {
            if (flat.length === 0) return;
            const next = lit < 0 ? (dir === 1 ? 0 : flat.length - 1) : (lit + dir + flat.length) % flat.length;
            setDismissed("");
            setLitAt({stamp, index: next});
        },
        close: (): void => {
            setDismissed(stamp);
            setLitAt({stamp: "", index: -1});
        },
        light: (index): void => {
            // The pointer reports every move over a row; only a move to another row is news.
            setLitAt((was) => (was.index === index && was.stamp === stamp ? was : {stamp, index}));
        },
        reset: (): void => {
            setLitAt({stamp: "", index: -1});
        },
    };
}
