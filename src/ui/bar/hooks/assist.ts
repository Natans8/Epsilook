/**
 * @file The control surface's state: what the caret can be handed, and what taking it does.
 *
 * The offers themselves are a pure read of the open position ({@link ./offers!offersAt}), and the panel's own
 * state — the lit row, the dismissal, the ghost — is {@link ./panel!useOfferPanel}, which the plaintext view
 * shares. What lives here is the chip bar's half: where the caret sits inside the slot, and what taking an
 * offer DOES. Taking one is TYPING it, so every path below ends in the session's own rewrite rather than in an
 * edit of its own.
 *
 * Split out of the bar because it reaches the session through four calls and nothing reaches back into it.
 */
import {useMemo, useState} from "react";
import type {Offer, Offers, Vocabulary} from "../utils/offers";
import {NO_OFFERS, offerSlot, offersAt} from "../utils/offers";
import {optionId, useOfferPanel} from "./panel";
import {slotStart, writeSlot} from "../utils/plan";
import type {EditingSession} from "./session";

/**
 * The control surface as the slot sees it: what is on offer, and the four things a keyboard can do about it.
 *
 * The slot owns the keys because the caret never leaves it — a combobox steers its list from the field — so the
 * surface's own gestures have to be answered here, before the bar's traversal claims the same keys.
 */
export interface Assist {
    /** How many offers stand, whether or not the panel is drawn — what the arrows have to steer. */
    readonly count: number;
    /** Whether the panel is drawn. Escape puts it away without touching the offers behind it. */
    readonly open: boolean;
    /** The lit offer's index, or -1 when the reader has lit none. */
    readonly lit: number;
    /** The completion drawn dim after the caret, or empty. */
    readonly ghost: string;
    /** The panel's element id, which the field names in `aria-controls`. */
    readonly listId: string;
    /** The lit option's element id, which the field points at while the focus stays put. */
    readonly activeId?: string;
    /** Walks the light through the offers, wrapping at either end. */
    readonly move: (dir: -1 | 1) => void;
    /** Applies the lit offer. */
    readonly pick: () => void;
    /** Dismisses the surface until what is on offer changes. */
    readonly close: () => void;
    /** Takes the ghost into the slot. */
    readonly accept: () => void;
}

/** What the bar draws of the control surface, and the contract the slot answers to. */
export interface BarAssist {
    /** The contract the open slot takes: the combobox keys, the ghost, and what each of them does. */
    readonly assist: Assist;
    /** The offers as read, for the panel itself. */
    readonly offers: Offers;
    /** Whether the panel stands. */
    readonly shown: boolean;
    /** The lit row's index in draw order, or -1 while the reader is still typing. */
    readonly lit: number;
    /** The listbox's id, which the field points at. */
    readonly listId: string;
    /** Where the caret sits inside the slot, as the input reports it. */
    readonly setCaretInSlot: (at: number) => void;
    /** Takes one offer, for the panel's own rows. */
    readonly onPick: (offer: Offer) => void;
    /** Lights one row, for the pointer moving over the panel. */
    readonly onLight: (index: number) => void;
}

/**
 * The control surface's state.
 *
 * @param text The query text.
 * @param editing The session — read for the open position, called for every rewrite.
 * @param rest Whether the bar is at rest, holding no caret: there is then nothing to offer.
 * @param vocab The closed vocabularies the loaded pack carries.
 * @param history The remembered searches — held by the bar, because the SESSION decides when a query was
 *   finished with and this decides what to do with it.
 * @returns The assist contract and what the panel needs to draw.
 */
export function useBarAssist(
    text: string,
    editing: EditingSession,
    rest: boolean,
    vocab: Vocabulary,
    history: readonly string[],
): BarAssist {
    const {at, clamped, gapAt, pushUndo, openTail, applyStep, writeAtGap} = editing;
    // Where the caret sits inside the slot, as the input reports it — what the surface can offer depends on it.
    const [caretInSlot, setCaretInSlot] = useState(0);

    // What the caret can be handed. A bar at rest holds no caret, so there is nothing to offer and nothing to
    // compute; everywhere else the offers are a pure read of the open position.
    const offers = useMemo(
        () => (rest ? NO_OFFERS : offersAt(at, caretInSlot, history, vocab)),
        [rest, at, caretInSlot, history, vocab]);
    // One arrangement of query, position and caret — what the light and the dismissal are decided about.
    const {flat, shown, lit, ghost, ghosted, listId, move, close, light} =
        useOfferPanel(offers, JSON.stringify([text, clamped, gapAt ?? -1, caretInSlot]));

    /**
     * Takes one offer into the query, exactly as the keystrokes that would have written it: the stub the offers
     * were computed against gives way to what the offer spells, and the ordinary rewrite path does the rest —
     * so a picked door opens its scope by the same gesture a typed colon does, in one undoable step.
     */
    const applyOffer = (offer: Offer): void => {
        if (offer.shape === "query") {
            pushUndo(text);
            openTail(offer.insert);
            return;
        }
        const {value, caret: within} = offerSlot(at, offers, offer);
        if (writeAtGap(value)) return;
        applyStep({text: writeSlot(at, value), caret: slotStart(at) + within, operation: true}, true, value);
    };

    const assist: Assist = {
        count: flat.length,
        open: shown,
        lit,
        ghost,
        listId,
        activeId: lit >= 0 ? optionId(listId, lit) : undefined,
        move,
        pick: (): void => {
            if (lit >= 0) applyOffer(flat[lit]);
        },
        close,
        /**
         * Takes the completion the slot is showing.
         *
         * A ghost is an offer's own remainder, a UNIT the number is missing, or the CLOSERS an enclosure
         * wants; only the first has a row to pick, and the others are written straight into the slot as the
         * keystrokes they stand for.
         */
        accept: (): void => {
            if (lit < 0 && offers.ghostIs !== null && offers.ghostIs !== "offer") {
                const value = at.slot.slice(0, caretInSlot) + offers.ghost + at.slot.slice(caretInSlot);
                applyStep({
                    text: writeSlot(at, value),
                    caret: slotStart(at) + caretInSlot + offers.ghost.length,
                    operation: true,
                }, true, value);
                return;
            }
            // Whatever the slot DREW: the ghost names its own offer, so the word previewed and the word
            // delivered cannot come apart.
            if (ghosted !== undefined) applyOffer(ghosted);
        },
    };

    return {assist, offers, shown, lit, listId, setCaretInSlot, onPick: applyOffer, onLight: light};
}
