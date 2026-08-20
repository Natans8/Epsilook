/**
 * @file The bar: the query's segments in a row, one position open — a segment being edited, or a GAP between
 * segments where the caret can rest and type a new term.
 *
 * The frame for everything here, the user's own: think in terms of what is actually typed and how it is
 * evaluated on commit. The query text is the single source of truth; each gesture is a REWRITE of it, and the
 * bar's own state is only WHICH position is open plus the operation stacks. Arrows walk the full line:
 * chip — gap — chip — gap — tail, committing whatever they leave. Undo and redo land the caret where the change
 * happened, not at the end.
 *
 * Settled segments render at rest through the committed-chip component: chips and lanes for structured asks,
 * classed raw text for freeform terms and errors. Their affordances — open, ×, per-term ×, + — come back here
 * as rewrites of the text, each an undoable operation.
 */
import type {ReactElement, Ref} from "react";
import {Fragment, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from "react";
import {paint, runsWithin} from "../../search/index";
import type {BarSegment} from "./plan";
import {segmentsOf, slotStart} from "./plan";
import {OpenSegment} from "./open";
import {ChipArt, SettledSegment} from "./chip";
import {Classed} from "./classed";
import type {Vocabulary} from "./offers";
import {NO_VOCABULARY} from "./offers";
import {Surface} from "./surface";
import {useEditingSession} from "./session";
import {useBarSelection} from "./selection";
import {useBarAssist} from "./assist";
import {recentQueries, rememberQuery} from "../history";
import styles from "./bar.module.css";

/**
 * The bar.
 */
/** One frozen empty map, so a bar with no art does not hand the context a fresh object each render. */
const EMPTY_ART: Readonly<Record<string, string>> = Object.freeze({});

/**
 * What the panel around the bar may ask of it. A control outside the bar that rewrites the query — the
 * simplify button — goes through this rather than through the text prop, so the rewrite is one operation on
 * the bar's OWN undo stack and Ctrl+Z takes it back.
 */
export interface BarHandle {
    /** Applies one whole-query rewrite as an undoable operation, the caret landing on the fresh tail. */
    rewrite(next: string): void;
}

export function Bar({text, onText, placeholder, vocab = NO_VOCABULARY, handle}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /** The closed vocabularies the loaded pack carries — what the surface can offer beyond the language. */
    readonly vocab?: Vocabulary;
    /** The panel's door for undoable whole-query rewrites. */
    readonly handle?: Ref<BarHandle>;
}): ReactElement {
    // The searches this browser remembers. Shared, because the SESSION knows when a query was finished with
    // and the SURFACE knows what to do with one.
    const [history, setHistory] = useState(recentQueries);
    const remember = (query: string): void => {
        setHistory(rememberQuery(query));
    };

    // The bar's three concerns. The session owns the open position and every rewrite; the selection and the
    // surface both call into it and neither calls back out — except for the one hand-off below, which is the
    // session clearing a selection whenever it opens a fresh position. That single edge is what the ref
    // carries, so the selection can take the session as an ordinary value.
    const clearing = useRef<() => void>(() => {
        // Nothing to clear until the selection is built, which is one line below.
    });
    const editing = useEditingSession(text, onText, () => {
        clearing.current();
    }, remember);
    const selection = useBarSelection(text, onText, editing);
    // Written after the render rather than during it: the session only ever calls this from an event, which is
    // long after the layout effect has pointed it at the selection built this pass.
    useLayoutEffect(() => {
        clearing.current = selection.clear;
    });
    const {
        sel, selectedText, onSelectAll, onSelectPast, onBarDown, onBarMove, onBarUp, onBarClick, onBarKeys,
        onBarPaste,
    } = selection;
    const {
        at, gapAt, caret, session, focused, setFocused, onKeystroke, commitOpen, onArrow, onCommit, onCancel,
        onEdge, onUndo, onRedo, actionsFor, pushUndo, openTail,
    } = editing;

    // The panel's rewrite door: one undoable operation through the session's own machinery, so Ctrl+Z takes
    // back an applied simplify exactly as it takes back any other operation.
    useImperativeHandle(handle, () => ({
        rewrite: (next: string): void => {
            if (next === text) return;
            pushUndo(text);
            clearing.current();
            openTail(next);
        },
    }));

    const segments = useMemo(() => segmentsOf(text), [text]);
    // The slot holds a FRAGMENT, so it cannot paint itself: the whole query is painted once and each surface
    // takes its own slice, which is what makes an open chip read exactly as the plain view reads.
    const painted = useMemo(() => paint(text), [text]);
    const slotRuns = useMemo(
        () => runsWithin(painted, {start: slotStart(at), end: slotStart(at) + at.slot.length})
            // Stripped of their state: a value half typed is not a value that failed, and `scale:x` on its way
            // to `scale:x5` was being squiggled as though the reader had finished and got it wrong. Diagnostics
            // belong to a committed query — which is the law's silent-while-typing half, drawn.
            .map((run) => {
                if (run.state === undefined) return run;
                const {state: _dropped, ...quiet} = run;
                return quiet;
            }),
        [painted, at]);
    // At rest — no focus, or a bar-wide selection standing — the open position renders settled like every
    // other segment. A selection is a stretch of the settled query, so nothing inside it is in its editing form.
    const rest = (!focused && text !== "") || sel !== null;
    const {assist, offers, shown, lit, listId, setCaretInSlot, onPick, onLight} =
        useBarAssist(text, editing, rest, vocab, history);
    const openStart = gapAt === null && !rest ? at.before.length : -1;
    // The slot fills the bar only as the true tail; anywhere else — a mid-bar word, a gap — it hugs, or it
    // would shove every chip after it to the far edge.
    const mode: "fill" | "hug" | "gap" = gapAt !== null ? "gap"
        : at.head === null && at.after.trim() === "" ? "fill" : "hug";

    const open = (
        <OpenSegment
            key={`open-${String(session)}`}
            at={at}
            mode={mode}
            hidden={rest}
            seize={focused || text === ""}
            highlight={<Classed text={at.slot} runs={slotRuns} mirrored/>}
            caret={caret}
            placeholder={text === "" ? placeholder : undefined}
            label={placeholder}
            assist={assist}
            onFlip={actionsFor(at.before.length).negateOpen}
            onCaret={setCaretInSlot}
            onKeystroke={onKeystroke}
            onArrow={onArrow}
            onEdge={onEdge}
            onCommit={onCommit}
            onCancel={onCancel}
            onUndo={onUndo}
            onRedo={onRedo}
            onSelectAll={onSelectAll}
            onSelectPast={onSelectPast}
            onWake={() => {
                setFocused(true);
            }}
            onSettle={() => {
                setFocused(false);
                // Focus left the bar: the segment settles into its committed spelling — the editing form's
                // braces must never outlive the editing. The slot text is unchanged by a simplify, so no
                // session reset and no focus theft.
                const step = commitOpen();
                if (step.text !== text) onText(step.text);
                // A search the reader has finished with is one they may want back, and its committed spelling
                // is the one worth keeping — never the half-typed shape it passed through on the way.
                remember(step.text);
            }}
        />
    );

    /**
     * One stretch of query text that no segment claims — the separator between two chips.
     *
     * It is drawn rather than implied, because it is a character of the query: it can be selected, it can be
     * deleted, and the space a reader sees between two chips is the one they typed. A gap between chips wide
     * enough to read but not made of the query's own characters is what made words look like objects.
     */
    const between = (from: number, to: number): ReactElement => {
        const covered = sel !== null && sel.from <= from && sel.to >= to;
        return (
            <span
                key={`sep-${String(from)}`}
                className={covered ? `${styles.sep} ${styles.selected}` : styles.sep}
                data-at={from}
                data-plain=""
            >
                {text.slice(from, to)}
            </span>
        );
    };

    /** One settled segment: a chip, or a stretch of the query's own text. */
    const settled = (seg: BarSegment): ReactElement => {
        const covered = sel !== null && sel.from <= seg.start && sel.to >= seg.end;
        // Text paints its own selection character by character; a chip is atomic, so the whole of it paints.
        const inside = sel === null || !seg.plain ? undefined
            : {start: Math.max(sel.from, seg.start) - seg.start, end: Math.min(sel.to, seg.end) - seg.start};
        const cls = [styles.settled, seg.plain ? "" : styles.chipHost,
            covered && !seg.plain ? styles.selected : ""].filter((held) => held !== "").join(" ");
        return (
            <span
                key={seg.start}
                className={cls}
                data-at={seg.start}
                data-end={seg.end}
                // Plain text draws its own characters, so a point inside it resolves to one of them; a chip
                // draws its parse instead and can only answer with an edge.
                data-plain={seg.plain ? "" : undefined}
                // A chip draws its parse, so its rendered text reads as one run of glued words. The label is
                // the segment's own query text, which says what it asks and is what a reader would type to
                // say it again. Text needs none: it reads as itself.
                role={seg.plain ? undefined : "group"}
                aria-label={seg.plain ? undefined : text.slice(seg.start, seg.end)}
            >
                <SettledSegment
                    text={text.slice(seg.start, seg.end)}
                    at={seg.start}
                    act={actionsFor(seg.start)}
                    selected={inside}
                />
            </span>
        );
    };

    // Every child is a keyed SIBLING of the bar — the open fragment included, wherever it sits. Nesting it
    // inside a per-segment fragment made a gap's first keystroke a REMOUNT (the subtree changed parents, the
    // key could not save it), which killed the input's caret mid-session. Together the children cover the
    // query text exactly once, which is what lets a point resolve to an offset and back.
    const children: ReactElement[] = [];
    let drawn = 0;
    for (const seg of segments) {
        if (seg.start > drawn) children.push(between(drawn, seg.start));
        drawn = seg.end;
        if (!rest && (gapAt === seg.start || (gapAt === null && seg.start === openStart))) {
            children.push(<Fragment key="open">{open}</Fragment>);
            if (gapAt === null) continue;
        }
        // An empty settled segment — a doubled separator's residue — draws nothing and takes no press:
        // opening a zero-width nothing is how phantom chiplets appear.
        if (seg.start !== seg.end) children.push(settled(seg));
    }
    if (drawn < text.length) children.push(between(drawn, text.length));
    // At rest the input stays mounted out of sight — same keyed sibling, so waking never remounts it —
    // holding the bar's place in the tab order until focus brings the editing form back.
    if (rest) children.push(<Fragment key="open">{open}</Fragment>);


    return (
        <ChipArt value={vocab.art ?? EMPTY_ART}>
            <div
                className={styles.qbar}
                // Focusable but never tabbed to: while a selection stands its keys are the bar's own, and the
                // press that made it deliberately moved focus nowhere. Tab still reaches the slot, which is the
                // one control a keyboard is looking for.
                tabIndex={-1}
                onMouseDownCapture={onBarDown}
                onMouseMove={onBarMove}
                onMouseUp={onBarUp}
                onClick={onBarClick}
                onKeyDownCapture={onBarKeys}
                onPasteCapture={onBarPaste}
                data-selection={sel === null ? undefined : selectedText()}
            >
                {children}
                {shown && (
                    <Surface offers={offers} lit={lit} listId={listId} onPick={onPick} onLight={onLight}/>
                )}
            </div>
        </ChipArt>
    );
}
