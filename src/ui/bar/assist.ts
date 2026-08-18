/**
 * @file The control surface's state: what the caret can be handed, and what taking it does.
 *
 * The offers themselves are a pure read of the open position ({@link ./offers!offersAt}); what lives here is
 * the state around them — where the caret sits inside the slot, which row is lit, whether the panel has been
 * put away, and the searches this browser remembers. Taking an offer is TYPING it, so every path below ends in
 * the session's own rewrite rather than in an edit of its own.
 *
 * Split out of the bar because it reaches the session through four calls and nothing reaches back into it.
 */
import {useId, useMemo, useRef, useState} from "react";
import type {Assist} from "./open";
import type {Offer, Offers, Vocabulary} from "./offers";
import {flatOffers, NO_OFFERS, offerSlot, offersAt} from "./offers";
import {slotStart, writeSlot} from "./plan";
import {optionId} from "./surface";
import type {EditingSession} from "./session";

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
    // The lit offer, and the surface put away, each stamped with the situation they were decided in: both are
    // answers about one arrangement of query, position and caret, and they lapse the moment that arrangement
    // changes. Stamping is what keeps them out of the effects that would otherwise have to clear them.
    const [litAt, setLitAt] = useState({stamp: "", index: -1});
    const [dismissed, setDismissed] = useState("");
    const listId = useId();


    // What the caret can be handed. A bar at rest holds no caret, so there is nothing to offer and nothing to
    // compute; everywhere else the offers are a pure read of the open position.
    const offers = useMemo(
        () => (rest ? NO_OFFERS : offersAt(at, caretInSlot, history, vocab)),
        [rest, at, caretInSlot, history, vocab]);
    const flat = useMemo(() => flatOffers(offers), [offers]);
    // One arrangement of query, position and caret — what the light and the dismissal were decided about.
    //
    // NUMBERED, because an arrangement returned to is not the arrangement that was left. A light steered
    // to at `xpac:6` was decided about those characters under that caret; type them again later and a
    // plain comparison hands back the light that was already spent, so Enter applies an offer the reader
    // never chose instead of running their query. The count only has to DIFFER between visits, never to
    // be sequential, so a render thrown away costs nothing.
    const arrangement = JSON.stringify([text, clamped, gapAt ?? -1, caretInSlot]);
    const visit = useRef({arrangement: "", count: 0});
    if (visit.current.arrangement !== arrangement) {
        visit.current = {arrangement, count: visit.current.count + 1};
    }
    const stamp = `${arrangement}#${String(visit.current.count)}`;
    const shown = (offers.groups.length > 0 || offers.takes !== null) && dismissed !== stamp;
    const lit = shown && litAt.stamp === stamp ? litAt.index : -1;

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
        // The ghost and the light say the same thing in two places, so only one of them is ever drawn: the
        // ghost while the reader types, the light once they have started steering the list.
        ghost: shown && lit < 0 ? offers.ghost : "",
        listId,
        activeId: lit >= 0 ? optionId(listId, lit) : undefined,
        move: (dir): void => {
            if (flat.length === 0) return;
            const next = lit < 0 ? (dir === 1 ? 0 : flat.length - 1) : (lit + dir + flat.length) % flat.length;
            setDismissed("");
            setLitAt({stamp, index: next});
        },
        pick: (): void => {
            if (lit >= 0) applyOffer(flat[lit]);
        },
        close: (): void => {
            setDismissed(stamp);
            setLitAt({stamp: "", index: -1});
        },
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
            const best = lit >= 0 ? flat[lit] : flat[0];
            if (best !== undefined) applyOffer(best);
        },
    };


    return {
        assist, offers, shown, lit, listId, setCaretInSlot,
        onPick: applyOffer,
        onLight: (index): void => {
            // The pointer reports every move over a row; only a move to another row is news.
            setLitAt((was) => (was.index === index && was.stamp === stamp ? was : {stamp, index}));
        },
    };
}
