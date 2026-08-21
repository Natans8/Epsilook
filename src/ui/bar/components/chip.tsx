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
import {createContext, Fragment, useContext, useMemo} from "react";
import {useTranslation} from "react-i18next";
import type {ChipView, ClauseView, LaneView, Piece, Run, Span} from "../../../search/index";
import {describe, GRAMMAR, NEGATION, paint, parse, runsWithin} from "../../../search/index";
import {Classed, Pattern} from "./classed";
import type {SegmentActions} from "../hooks/session";
import {toneOf} from "./tone";
import styles from "./chip.module.css";

/**
 * Heads are lowercase everywhere: `scale`, never `Scale`.
 *
 * The head is the word the reader types, so it is spelled the way they would type it — which also means no
 * acronym can ever be spelled wrong, because there is no capitalisation rule to get wrong. The value beside it
 * carries the weight instead.
 */
export const headCase = (word: string): string => word.toLowerCase();

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
    const at = document.caretPositionFromPoint?.(e.clientX, e.clientY) ?? null;
    if (at === null || at.offsetNode.nodeType !== Node.TEXT_NODE) return null;
    const piece = at.offsetNode.textContent ?? "";
    if (piece === "") return null;
    // First occurrence wins; ambiguity costs at most the sibling occurrence of the same word.
    const found = raw.slice(window.start, window.end).indexOf(piece);
    if (found < 0) return null;
    return window.start + found + Math.min(at.offset, piece.length);
}

/**
 * What joins two conditions that must both hold.
 *
 * Juxtaposition IS the conjunction in this language, so the query writes a space between two conditions and
 * nothing else — and a lane of bare terms copied that, drawing `model:{fire missile}` as a two-word phrase
 * rather than as two asks about one row. The alternation already draws its own word between runs; this is the
 * other half of that pair.
 *
 * Drawn as a RULE rather than as a glyph: the lane's head is already divided from its body by a line, so the
 * same line between two conditions says they are separate cells of one enclosure — and it puts no character
 * on screen that a reader could mistake for something they typed.
 */
function Joint(): ReactElement {
    return <span className={styles.joint} aria-hidden="true"/>;
}

/**
 * One mark a chip carries: a small button drawn as GEOMETRY rather than typed as a glyph.
 *
 * A font's `×` is not centred on its line box — measured in the shipped face, the cross's ink sits 1.5px low
 * at 12px, a fraction of the font size rather than a fixed amount. Centring the box therefore cannot centre
 * the mark, and a nudge measured for one size and face is wrong at the next: this is the bug that was fixed by
 * hand in 1.0 and came back here. Lines drawn inside a square viewBox are centred by construction, at any
 * size, in any face — so the shape arrives as the path to draw, and every mark shares this frame.
 */
function MarkButton({label, className, onPress, children}: {
    /** What the mark does, said in full: several marks stand in one bar and each removes a different thing. */
    readonly label: string;
    /** Which mark this is — what its hover says it will do. */
    readonly className: string;
    readonly onPress: () => void;
    /** The path or paths to draw inside the square viewBox. */
    readonly children: ReactNode;
}): ReactElement {
    return (
        // The slot is a line box of the neighbouring text's own metrics, so the mark inside it can align to
        // that text rather than to a cell that is taller than the text: see the CSS for why that matters.
        <span className={styles.markSlot}>
            <button
                type="button"
                className={className}
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
                    {children}
                </svg>
            </button>
        </span>
    );
}

/**
 * The delete mark, at the tail of whatever it removes.
 *
 * Named by WHAT it removes, not just by the act: a bar of chips draws one of these per chip and per lane term,
 * and a row of controls all called "Delete" tells a reader who cannot see which is which nothing at all.
 */
function Affordance({what, onPress}: {
    /** The query text of the thing this removes — what a reader would type to ask for it again. */
    readonly what: string;
    readonly onPress: () => void;
}): ReactElement {
    const {t} = useTranslation();
    return (
        <MarkButton label={t("bar.deleteThis", {what})} className={styles.chipX} onPress={onPress}>
            <path d="M3.6 3.6 8.4 8.4 M8.4 3.6 3.6 8.4"/>
        </MarkButton>
    );
}

/** The alternation connective, wherever a gate or a lane run meets the next — the typed word, never a symbol. */
function Or(): ReactElement {
    return <span className={styles.vOr}>{GRAMMAR.orWord}</span>;
}

/**
 * The direction arrow on a sort capsule: it says which way the order runs, and a press turns it round — the
 * arrow is the invert gesture, the text beside it stays the edit gesture. Geometry, not a glyph, for the same
 * centring reason as the delete mark.
 */
function SortArrow({descending, label, onPress}: {
    readonly descending: boolean;
    readonly label: string;
    readonly onPress: () => void;
}): ReactElement {
    return (
        <MarkButton label={label} className={styles.sortArrow} onPress={onPress}>
            {descending
                ? <path d="M6 2.8 V9.2 M3.4 6.8 L6 9.4 L8.6 6.8"/>
                : <path d="M6 9.2 V2.8 M3.4 5.2 L6 2.6 L8.6 5.2"/>}
        </MarkButton>
    );
}

/**
 * The pictures a vocabulary word may carry, by the word that names it.
 *
 * A CONTEXT rather than a prop: every chip body can want one and nothing between the bar and a piece has any
 * use for it, so drilling it through four components would be threading a value past the parts that ignore it.
 * The map itself is declared beside the vocabulary in `art.ts`, exactly as the offers' badges are.
 */
export const ChipArt = createContext<Readonly<Record<string, string>>>({});

/**
 * The segment's painted runs, so every raw surface inside it takes a SLICE rather than painting itself.
 *
 * A fragment cannot classify itself into the same answer: lexically `attach:` is a top-level head and wears
 * gold, while the query it was cut from knows it is a model door and wears blue. Drawn either way the same
 * characters read as two different things depending on which surface the reader is looking at. Carried as
 * context rather than threaded, because only the two leaves that draw raw text need it.
 */
export const ChipRuns = createContext<readonly Run[]>([]);

/**
 * A body's pieces as one continuous inline run: real spaces between pieces, never flex gaps, so the text reads
 * as text. A swatch stays tight against the word that follows it, grouped under one vocabulary mark.
 */
function Pieces({pieces, text}: { readonly pieces: readonly Piece[]; readonly text: string }): ReactElement {
    const art = useContext(ChipArt);
    const runs = useContext(ChipRuns);
    const out: ReactNode[] = [];
    for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (out.length > 0) out.push(" ");
        if (piece.is === "word" && art[piece.text] !== undefined) {
            // Grouped with its word under one mark, exactly as a swatch is: the picture is an attribute of the
            // word, not a thing standing beside it.
            out.push(
                <span key={i} className={styles.vGroup}>
                    <img className={styles.chipArt} src={art[piece.text]} alt="" aria-hidden="true"/>
                    {piece.text}
                </span>,
            );
            continue;
        }
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
                    <Classed text={text.slice(piece.span.start, piece.span.end)}
                             runs={runsWithin(runs, piece.span)}/>
                </span>,
            );
            continue;
        }
        if (piece.is === "regex") {
            out.push(
                <span key={i}>
                    <span className={styles.vQuote}>{GRAMMAR.regex}</span>
                    <Pattern pattern={piece.pattern}/>
                    <span className={styles.vQuote}>{GRAMMAR.regex}</span>
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
function stateClass(base: string, tone: string, not: boolean, warned: boolean, wholly: boolean): string {
    const parts = [base, toneOf(tone), not ? styles.chipNegated : "", warned ? styles.chipWarned : "",
        wholly ? styles.underBand : ""];
    return parts.filter((part) => part !== "").join(" ");
}

/**
 * The anatomy every settled ask wears: `[head | body ×]` inside one toned enclosure.
 *
 * A chip, a lane and a directive differ only in what stands between the head and the delete mark, so the
 * frame is stated once. What it fixes in place is the press rule and the two edges: whichever of the three a
 * reader is looking at, pressing the head flips exclusion, pressing anywhere else opens the segment, and the
 * mark at the tail removes it.
 */
function Capsule({base, head, not, tone, warned, wholly, notes, what, act, children}: {
    /** The enclosure's own shape: compact, or a lane's row of cells. */
    readonly base: string;
    readonly head: string;
    readonly not: boolean;
    readonly tone: string;
    readonly warned: boolean;
    /**
     * Whether the bar's selection covers this segment WHOLE.
     *
     * The band is the bar's and is drawn on the wrapper; what the chip does underneath it — flattening its own
     * fills so the band reads as one block — is the chip's, and is stated in this component's own sheet. It
     * arrives as a prop rather than as an ancestor class because a scoped stylesheet cannot reach across a file
     * boundary, and reaching in from the bar's sheet is what held every chip class there.
     */
    readonly wholly: boolean;
    readonly notes: readonly string[];
    /** The segment's query text, which names the delete mark. */
    readonly what: string;
    readonly act: SegmentActions;
    readonly children: ReactNode;
}): ReactElement {
    const {t} = useTranslation();
    return (
        <span
            className={stateClass(base, tone, not, warned, wholly)}
            title={notes.length > 0 ? notes.join("\n") : undefined}
            // At the END, wherever on the chip the press landed. A chip draws its PARSE — a notated number, a
            // desugared count, a display glyph — so aiming at a character means aiming at a rendering, and the
            // reader who wants to change a chip is almost always continuing it rather than mending its middle.
            onClick={press(() => {
                act.open("end");
            })}
        >
            <Sect
                head={head}
                not={not}
                hint={t(not ? "bar.include" : "bar.exclude")}
                className={styles.chipSect}
                onOpen={act.negate}
            />
            {children}
            <Affordance what={what} onPress={act.remove}/>
        </span>
    );
}

/** A compact chip. */
function ChipEl({chip, warned, wholly, notes, text, act}: {
    readonly chip: ChipView;
    readonly warned: boolean;
    readonly wholly: boolean;
    readonly notes: readonly string[];
    readonly text: string;
    readonly act: SegmentActions;
}): ReactElement {
    return (
        <Capsule base={styles.chip} head={chip.head} not={chip.not} tone={chip.tone}
                 warned={warned} wholly={wholly} notes={notes} what={text} act={act}>
            <span className={styles.chipBody}><Pieces pieces={chip.body} text={text}/></span>
        </Capsule>
    );
}

/** A lane: the scope's toned enclosure, terms as text, inner binds as chips of their own. */
function LaneEl({lane, warned, wholly, notes, text, act}: {
    readonly lane: LaneView;
    readonly warned: boolean;
    readonly wholly: boolean;
    readonly notes: readonly string[];
    readonly text: string;
    readonly act: SegmentActions;
}): ReactElement {
    const runs = useContext(ChipRuns);
    const {t} = useTranslation();
    return (
        <Capsule base={styles.lane} head={lane.head} not={lane.not} tone={lane.tone}
                 warned={warned} wholly={wholly} notes={notes} what={text} act={act}>
            {lane.items.map((item, i) => {
                if (item.is === "or") return <Or key={i}/>;
                const openItem = press((e) => {
                    act.open(aimAt(e, text, item.span) ?? item.span.start);
                });
                // Between two conditions that must both hold; never beside the alternation's own word, which
                // already says what joins the runs it sits between.
                const joint = i > 0 && lane.items[i - 1].is !== "or" ? <Joint/> : null;
                if (item.is === "dead") {
                    return (
                        <Fragment key={i}>
                            {joint}
                            <span className={styles.deadFrag} onClick={openItem}>
                                <Classed text={text.slice(item.span.start, item.span.end)}
                                         runs={runsWithin(runs, item.span)}/>
                            </span>
                        </Fragment>
                    );
                }
                if (item.is === "term") {
                    return (
                        <Fragment key={i}>
                            {joint}
                            <span
                                className={item.not ? `${styles.laneTerm} ${styles.vNot}` : styles.laneTerm}
                                onClick={openItem}
                            >
                                {item.not ? NEGATION : ""}<Pieces pieces={item.body} text={text}/>
                            </span>
                        </Fragment>
                    );
                }
                return (
                    <Fragment key={i}>
                        {joint}
                        <span className={styles.laneBind} onClick={openItem}>
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
                            <Affordance
                                what={text.slice(item.span.start, item.span.end)}
                                onPress={() => {
                                    act.removeTerm(i);
                                }}
                            />
                        </span>
                    </Fragment>
                );
            })}
        </Capsule>
    );
}

/**
 * A directive: sort, or the limit.
 *
 * A directive shapes the LIST, not the set, so it wears the same anatomy as every ask in a neutral capsule
 * with no column tone — what tells it apart is what it holds, never a decorated edge. A sort draws one cell
 * per door, each with its own arrow that turns that door round; anywhere else on the capsule edits. Neither a
 * brace nor a minus renders: the capsule draws its parse, and the direction IS the arrow.
 */
function DirectiveEl({view, wholly, text, act}: {
    readonly view: Extract<ClauseView, { form: "directive" }>;
    readonly wholly: boolean;
    readonly text: string;
    readonly act: SegmentActions;
}): ReactElement {
    const {t} = useTranslation();
    const doors = view.doors;
    return (
        <span
            // A sequence needs the lane's row of cells; one door, or a count, sits in the compact shape.
            className={[doors !== undefined && doors.length > 1 ? styles.lane : styles.chip, styles.directive,
                wholly ? styles.underBand : ""].filter((held) => held !== "").join(" ")}
            onClick={press(() => {
                act.open("end");
            })}
        >
            <span className={styles.chipSect}>{headCase(view.word)}</span>
            {doors === undefined
                ? <span className={styles.chipBody}>{view.value}</span>
                : doors.map((door, d) => (
                    <Fragment key={d}>
                        {d > 0 && <Joint/>}
                        <span className={`${styles.laneTerm} ${styles.directiveDoor}`}>
                            {door.word}
                            <SortArrow
                                descending={door.descending}
                                label={t(door.descending ? "bar.sortDesc" : "bar.sortAsc")}
                                onPress={() => {
                                    act.toggleSort(d);
                                }}
                            />
                        </span>
                    </Fragment>
                ))}
            <Affordance what={text} onPress={act.remove}/>
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
    const runs = useContext(ChipRuns);
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
            <Classed text={text} runs={runsWithin(runs, span)} selected={covered}/>
        </span>
    );
}

/**
 * A settled segment at rest: its clauses as chips, lanes and raw text, in written order, covering the segment's
 * text exactly.
 */
export function SettledSegment({text, at, act, selected, wholly = false}: {
    readonly text: string;
    /** Where the segment starts in the query — what its raw runs stamp themselves with. */
    readonly at: number;
    readonly act: SegmentActions;
    /** The stretch of this segment the bar's selection covers, in the segment's own coordinates. */
    readonly selected?: Span;
    /** Whether that selection covers the segment WHOLE, which is the only state a chip draws for itself. */
    readonly wholly?: boolean;
}): ReactElement {
    const views = useMemo(() => describe(parse(text)), [text]);
    // Painted once for the whole segment: a chip's raw fragments are cut out of it, and a cut cannot be
    // re-classified into the same answer as the query it came from.
    const painted = useMemo(() => paint(text), [text]);
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
            parts.push(<ChipEl key={i} chip={view.chip} warned={view.warned} wholly={wholly}
                               notes={view.notes} text={text} act={act}/>);
        } else if (view.form === "lane") {
            parts.push(<LaneEl key={i} lane={view.lane} warned={view.warned} wholly={wholly}
                               notes={view.notes} text={text} act={act}/>);
        } else if (view.form === "directive") {
            parts.push(<DirectiveEl key={i} view={view} wholly={wholly} text={text} act={act}/>);
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
    return <ChipRuns.Provider value={painted}>{parts}</ChipRuns.Provider>;
}
