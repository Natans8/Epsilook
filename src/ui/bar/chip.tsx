/**
 * @file The committed chip — the at-rest form of a settled segment, the design's second visual mode.
 *
 * The open segment is the editing form; this is what a segment looks like when the caret is elsewhere. The
 * engine's {@link describe} read decides everything semantic — chip against lane against raw text, and what each
 * piece of a body is — so this file only turns that model into DOM: the sectioned anatomy `[× head | body +]`,
 * one accent per chip from its column tone, and the delimiter-free rendering the language rules.
 *
 * Freeform terms and invalid clauses render as classed raw text, exactly as the whole bar did before chips.
 * A chip owns its own presses, because its rendered text is not its raw text: each part aims within the window
 * of raw text it draws. Plain text owns none of them — it is text, so the bar's own hit test lands the caret on
 * the character a press fell on, and a press that turns into a drag selects instead.
 */
import type {MouseEvent as ReactMouseEvent, ReactElement, ReactNode} from "react";
import {useMemo} from "react";
import {useTranslation} from "react-i18next";
import type {ChipView, LaneView, Piece, Span} from "../../search/index";
import {describe, GRAMMAR, NEGATION, parse} from "../../search/index";
import {Classed} from "./classed";
import styles from "./bar.module.css";

/**
 * Heads are lowercase everywhere: `scale`, never `Scale`.
 *
 * The head is the word the reader types, so it is spelled the way they would type it — which also means no
 * acronym can ever be spelled wrong, because there is no capitalisation rule to get wrong. The value beside it
 * carries the weight instead.
 */
export const headCase = (word: string): string => word.toLowerCase();

/** What a settled segment can ask of the bar. Offsets are into the segment's own raw spelling. */
export interface SegmentActions {
    /** Opens the segment for editing: at the slot's start or end, or at a raw offset. */
    readonly open: (side: "start" | "end" | number) => void;
    /** Removes the segment whole. */
    readonly remove: () => void;
    /**
     * Removes one term from inside the segment's scope, by its index among the lane's items.
     *
     * An INDEX rather than a span: a press settles whatever segment was open first, and that commit can rewrite
     * the very segment being acted on (trimming a scope's interior shifts every span inside it). The index
     * survives that, because a commit never adds or removes a term.
     */
    readonly removeTerm: (index: number) => void;
    /** Grows the segment: a fresh term slot, or a fresh value alternative. */
    readonly grow: (flavour: "term" | "alternative") => void;
    /** Flips the whole segment between asking for and excluding what it names. */
    readonly negate: () => void;
    /** Flips one of a lane's terms, by its index among the items. */
    readonly negateTerm: (index: number) => void;
}

/** The column tones, by key; a column without a declared tone renders neutral. */
const TONES: Record<string, string | undefined> = {
    model: styles.toneModel, sound: styles.toneSound, anim: styles.toneAnim,
    fx: styles.toneFx, mech: styles.toneMech, spell: styles.toneSpell, id: styles.toneSpell,
};

/**
 * The tone one column wears, for any surface that draws in the chip language.
 *
 * The control surface draws the chip an offer would become, so it reads the tones from here rather than keeping
 * a second table: a column added to one of them and not the other would show two colours for one axis.
 *
 * @param column The column's key.
 * @returns Its tone class, or an empty string where the column declares none.
 */
export const toneOf = (column: string | undefined): string =>
    (column === undefined ? "" : TONES[column] ?? "");

/**
 * A guarded press: the chip owns it — no bar-level aim, no focus theft before the open lands. The event is
 * handed on, because most of these presses read the point they landed on.
 *
 * On the CLICK rather than the mousedown, so that a press which turns into a drag selects instead of opening.
 * A click fires on the nearest ancestor the press and the release share, so a drag that leaves the chip never
 * reaches this at all — which is exactly the distinction the gesture needs.
 */
const press = (act: (e: ReactMouseEvent) => void) => (e: ReactMouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    act(e);
};

/**
 * The raw offset a press aimed at, where it can be known.
 *
 * A chip displays transformed text, so there is no character map in general — but most body text IS a verbatim
 * slice of the raw spelling: corpus words, vocabulary words, phrases. The pressed text node's content is looked
 * up inside the window of raw text the pressed thing draws; found, the caret lands on the aimed character,
 * exactly as it does on raw settled text. Not found — a notated number, a display glyph — the caller falls back
 * to its edge.
 *
 * @param e The press.
 * @param raw The segment's raw text.
 * @param window The slice of it the pressed element draws.
 * @returns The aimed offset into the raw text, or null where the display has no character map.
 */
function aimAt(e: ReactMouseEvent, raw: string, window: Span): number | null {
    const at = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (at == null || at.offsetNode.nodeType !== Node.TEXT_NODE) return null;
    const piece = at.offsetNode.textContent ?? "";
    if (piece === "") return null;
    // First occurrence wins; ambiguity costs at most the sibling occurrence of the same word.
    const found = raw.slice(window.start, window.end).indexOf(piece);
    if (found < 0) return null;
    return window.start + found + Math.min(at.offset, piece.length);
}

/**
 * The delete button: one mark, drawn as geometry rather than typed as a glyph, and never taking the press as
 * an open.
 *
 * A font's `×` is not centred on its line box — measured in the shipped face, the cross's ink sits 1.5px low
 * at 12px, a fraction of the font size rather than a fixed amount. Centring the box therefore cannot centre
 * the mark, and a nudge measured for one size and face is wrong at the next: this is the bug that was fixed by
 * hand in 1.0 and came back here. Two lines crossing at the middle of a square viewBox are centred by
 * construction, at any size, in any face.
 */
function Affordance({label, onPress}: {
    readonly label: string;
    readonly onPress: () => void;
}): ReactElement {
    return (
        // The slot is a line box of the neighbouring text's own metrics, so the mark inside it can align to
        // that text rather than to a cell that is taller than the text: see the CSS for why that matters.
        <span className={styles.markSlot}>
            <button
                type="button"
                className={styles.chipX}
                aria-label={label}
                // Out of the sequential tab order on purpose: a bar of six chips would otherwise put a dozen
                // affordances between Tab and the query input, which is the one thing a keyboard reaches for.
                // Their keyboard path is the bar's own — select a chip and press Delete.
                tabIndex={-1}
                onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    onPress();
                }}
            >
                <svg className={styles.mark} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                    <path d="M3.6 3.6 8.4 8.4 M8.4 3.6 3.6 8.4"/>
                </svg>
            </button>
        </span>
    );
}

/** The alternation connective, wherever a gate or a lane run meets the next — the typed word, never a symbol. */
function Or(): ReactElement {
    return <span className={styles.vOr}>{GRAMMAR.orWord}</span>;
}

/**
 * A body's pieces as one continuous inline run: real spaces between pieces, never flex gaps, so the text reads
 * as text. A swatch stays tight against the word that follows it, grouped under one vocabulary mark.
 */
function Pieces({pieces, text}: { readonly pieces: readonly Piece[]; readonly text: string }): ReactElement {
    const out: ReactNode[] = [];
    for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (out.length > 0) out.push(" ");
        if (piece.is === "swatch") {
            const word = pieces[i + 1];
            out.push(
                <span key={i} className={styles.vGroup}>
                    <span className={styles.swatch} style={{background: piece.colour}}/>
                    {word !== undefined && "text" in word ? word.text : ""}
                </span>,
            );
            i += 1;
            continue;
        }
        if (piece.is === "or") {
            out.push(<Or key={i}/>);
            continue;
        }
        if (piece.is === "dead") {
            out.push(
                <span key={i} className={styles.deadFrag}>
                    <Classed text={text.slice(piece.span.start, piece.span.end)}/>
                </span>,
            );
            continue;
        }
        if (piece.is === "phrase") {
            out.push(
                <span key={i}>
                    <span className={styles.vQuote}>{GRAMMAR.phrase}</span>
                    {piece.text}
                    <span className={styles.vQuote}>{GRAMMAR.phrase}</span>
                </span>,
            );
            continue;
        }
        const cls = piece.is === "word" ? styles.vWord
            : piece.is === "meta" ? styles.vMeta
                : piece.is === "op" ? styles.vOp : undefined;
        out.push(<span key={i} className={cls}>{piece.text}</span>);
    }
    return <>{out}</>;
}

/**
 * The sectioned head cell every chip, lane and inner bind opens with: `[x -Head]`, the divider carried by
 * structure and the negation fused into the head as one red unit.
 */
function Sect({head, not, hint, className, onOpen}: {
    readonly head: string;
    readonly not: boolean;
    /** What pressing the head does, said in words — the gesture has no other way to announce itself. */
    readonly hint: string;
    /** Which cell this is — the outer chip's, or an inner bind's tighter one. */
    readonly className: string;
    /**
     * What a press on the cell does. The head is the exclusion toggle, as it was in 1.0: the word names what
     * the chip asks, so flipping it is what says "not that". Opening the chip is the value's press.
     */
    readonly onOpen?: (e: ReactMouseEvent) => void;
}): ReactElement {
    return (
        <span
            className={className}
            title={onOpen === undefined ? undefined : hint}
            onClick={onOpen === undefined ? undefined : press(onOpen)}
        >
            <span className={not ? styles.negHead : undefined}>
                {not ? NEGATION : ""}{headCase(head)}
            </span>
        </span>
    );
}

/** The state classes a chip or lane wears over its tone. */
function stateClass(base: string, tone: string, not: boolean, warned: boolean): string {
    const parts = [base, TONES[tone] ?? "", not ? styles.chipNegated : "", warned ? styles.chipWarned : ""];
    return parts.filter((part) => part !== "").join(" ");
}

/** A compact chip. */
function ChipEl({chip, warned, notes, span, text, act}: {
    readonly chip: ChipView;
    readonly warned: boolean;
    readonly notes: readonly string[];
    readonly span: Span;
    readonly text: string;
    readonly act: SegmentActions;
}): ReactElement {
    const {t} = useTranslation();
    return (
        <span
            className={stateClass(styles.chip, chip.tone, chip.not, warned)}
            title={notes.length > 0 ? notes.join("\n") : undefined}
            onClick={press((e) => {
                act.open(aimAt(e, text, span) ?? "end");
            })}
        >
            <Sect
                head={chip.head}
                not={chip.not}
                hint={t(chip.not ? "bar.include" : "bar.exclude")}
                className={styles.chipSect}
                onOpen={act.negate}
            />
            <span className={styles.chipBody}><Pieces pieces={chip.body} text={text}/></span>
            <Affordance label={t("bar.delete")} onPress={act.remove}/>
        </span>
    );
}

/** A lane: the scope's toned enclosure, terms as text, inner binds as chips of their own. */
function LaneEl({lane, warned, notes, span, text, act}: {
    readonly lane: LaneView;
    readonly warned: boolean;
    readonly notes: readonly string[];
    readonly span: Span;
    readonly text: string;
    readonly act: SegmentActions;
}): ReactElement {
    const {t} = useTranslation();
    return (
        <span
            className={stateClass(styles.lane, lane.tone, lane.not, warned)}
            title={notes.length > 0 ? notes.join("\n") : undefined}
            onClick={press((e) => {
                act.open(aimAt(e, text, span) ?? "end");
            })}
        >
            <Sect
                head={lane.head}
                not={lane.not}
                hint={t(lane.not ? "bar.include" : "bar.exclude")}
                className={styles.chipSect}
                onOpen={act.negate}
            />
            {lane.items.map((item, i) => {
                if (item.is === "or") return <Or key={i}/>;
                const openItem = press((e) => {
                    act.open(aimAt(e, text, item.span) ?? item.span.start);
                });
                if (item.is === "dead") {
                    return (
                        <span key={i} className={styles.deadFrag} onClick={openItem}>
                            <Classed text={text.slice(item.span.start, item.span.end)}/>
                        </span>
                    );
                }
                if (item.is === "term") {
                    return (
                        <span
                            key={i}
                            className={item.not ? `${styles.laneTerm} ${styles.vNot}` : styles.laneTerm}
                            onClick={openItem}
                        >
                            {item.not ? NEGATION : ""}<Pieces pieces={item.body} text={text}/>
                        </span>
                    );
                }
                return (
                    <span key={i} className={styles.laneBind} onClick={openItem}>
                        <Sect
                            head={item.head}
                            not={item.not}
                            hint={t(item.not ? "bar.include" : "bar.exclude")}
                            className={styles.bindSect}
                            onOpen={() => {
                                act.negateTerm(i);
                            }}
                        />
                        <span className={styles.bindBody}><Pieces pieces={item.body} text={text}/></span>
                        <Affordance label={t("bar.delete")} onPress={() => {
                            act.removeTerm(i);
                        }}/>
                    </span>
                );
            })}
            <Affordance label={t("bar.delete")} onPress={act.remove}/>
        </span>
    );
}

/**
 * One raw stretch of the segment — freeform text, an erred clause, inter-clause glue — drawn classed.
 *
 * Raw text takes no press of its own: it is text, so the bar's own hit test resolves a point inside it to the
 * character it landed on, and a press that turns into a drag selects rather than opening.
 */
function Raw({text, span, at, erred, selected}: {
    readonly text: string;
    /** Where this run sits in the segment's raw text. */
    readonly span: Span;
    /** Where the segment itself starts in the query, so the run can stamp its own place in it. */
    readonly at: number;
    readonly erred: boolean;
    /** The bar's selection, in the segment's coordinates, or absent while nothing is selected. */
    readonly selected?: Span;
}): ReactElement | null {
    if (text === "") return null;
    const covered = selected === undefined ? undefined
        : {
            start: Math.max(selected.start, span.start) - span.start,
            end: Math.min(selected.end, span.end) - span.start
        };
    return (
        <span
            className={erred ? styles.erred : undefined}
            // Its own characters, drawn verbatim: a press inside it resolves to the one it landed on, whether
            // the run is freeform text or the raw spelling a broken clause fell back to.
            data-at={at + span.start}
            data-plain=""
        >
            <Classed text={text} selected={covered}/>
        </span>
    );
}

/**
 * A settled segment at rest: its clauses as chips, lanes and raw text, in written order, covering the segment's
 * text exactly.
 */
export function SettledSegment({text, at, act, selected}: {
    readonly text: string;
    /** Where the segment starts in the query — what its raw runs stamp themselves with. */
    readonly at: number;
    readonly act: SegmentActions;
    /** The stretch of this segment the bar's selection covers, in the segment's own coordinates. */
    readonly selected?: Span;
}): ReactElement {
    const views = useMemo(() => describe(parse(text)), [text]);
    const parts: ReactNode[] = [];
    let drawn = 0;
    /** One stretch of raw text, keyed by where it starts. */
    const raw = (from: number, to: number, erred: boolean): ReactElement | null => (
        <Raw
            key={`raw-${String(from)}`}
            text={text.slice(from, to)}
            span={{start: from, end: to}}
            at={at}
            erred={erred}
            selected={selected}
        />
    );
    views.forEach((view, i) => {
        if (view.span.start > drawn) parts.push(raw(drawn, view.span.start, false));
        if (view.form === "chip") {
            parts.push(<ChipEl key={i} chip={view.chip} warned={view.warned} notes={view.notes}
                               span={view.span} text={text} act={act}/>);
        } else if (view.form === "lane") {
            parts.push(<LaneEl key={i} lane={view.lane} warned={view.warned} notes={view.notes}
                               span={view.span} text={text} act={act}/>);
        } else {
            parts.push(
                <span key={i} title={view.notes.length > 0 ? view.notes.join("\n") : undefined}>
                    {raw(view.span.start, view.span.end, view.form === "error")}
                </span>,
            );
        }
        drawn = view.span.end;
    });
    if (drawn < text.length) parts.push(raw(drawn, text.length, false));
    return <>{parts}</>;
}
