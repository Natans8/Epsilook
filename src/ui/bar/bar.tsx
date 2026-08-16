/**
 * @file The bar: committed chips around one open segment, with the control surface anchored beneath it.
 *
 * The bar renders the parse of the query text. Clauses outside the open region are committed — chips, lanes,
 * freeform text or raw error text per {@link clauseView} — and the open region renders as the {@link Editor}.
 *
 * The session model: a press anywhere on the bar's empty ground opens the end; a press outside the whole wrap —
 * bar and surface together — commits and closes. Arrows flow through chips, opening each neighbour with the caret
 * on the entering side; Backspace at a boundary arms before it deletes; `/` reaches the bar from anywhere on the
 * page; Ctrl+Z steps operations whether or not a slot is open.
 */
import type {MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {PackDomain} from "../../data";
import type {Clause, Head, Parsed} from "../../search/index";
import {fold, HEADS} from "../../search/index";
import type {QueryState} from "./state";
import {clauseView} from "./segments";
import {CommittedClause} from "./chip";
import {Editor} from "./editor";
import type {SurfaceContext} from "./surface";
import {axisDoors, Surface} from "./surface";
import {openHead} from "./highlight";
import styles from "./bar.module.css";

/** A grown clause's edit text: the head kept, the value fenced into a scope with an open slot at its tail. */
function grownText(raw: string): string {
    const head = openHead(raw);
    if (head === null) return raw;
    const rest = head.rest.trim();
    if (rest.startsWith("{") && rest.endsWith("}")) {
        return `${raw.slice(0, head.consumed)}${rest.slice(0, -1).trimEnd()} }`;
    }
    return `${raw.slice(0, head.consumed)}{${rest} }`;
}

/** The one ghost candidate for the open segment: axis shortcuts for free text, nothing for the corpus. */
function ghostFor(edit: string): string {
    const head = openHead(edit);
    if (head !== null) return "";
    const word = edit.trim();
    if (word === "" || !/^[\p{L}\p{N}_]+$/u.test(word)) return "";
    const folded = fold(word);
    const match = axisDoors().find((door) => door.word.startsWith(folded) && door.word !== folded);
    if (match !== undefined) return `${match.word.slice(folded.length)}:`;
    return axisDoors().some((door) => door.word === folded) ? ":" : "";
}

/**
 * The bar with its control surface.
 */
export function Bar({state, parsed, domains, history, linked, onSimplify}: {
    readonly state: QueryState;
    readonly parsed: Parsed;
    readonly domains: Record<string, PackDomain> | undefined;
    readonly history: readonly string[];
    readonly linked: number | null;
    readonly onSimplify: () => void;
}): ReactElement {
    const {t} = useTranslation();
    const wrap = useRef<HTMLDivElement>(null);
    const editorHost = useRef<HTMLSpanElement>(null);
    const [anchorLeft, setAnchorLeft] = useState(0);
    const caretHint = useRef<"start" | "end">("end");

    const editStart = state.pieces.before.length;
    const editEnd = editStart + state.pieces.edit.length;

    const beforeClauses = parsed.clauses.filter((clause) => clause.span.end <= editStart
        || (!state.editing && clause.span.start < editStart));
    const afterClauses = parsed.clauses.filter((clause) => clause.span.start >= editEnd
        && !beforeClauses.includes(clause));

    const views = useMemo(() => new Map(parsed.clauses.map((clause) =>
        [clause, clauseView(clause, state.text)])), [parsed, state.text]);

    /** The slot's input element, for every gesture that returns focus to it. */
    const slotInput = (): HTMLInputElement | null =>
        editorHost.current?.querySelector("input") ?? null;

    // The surface anchors to the open chip: measure where the editor sits whenever it moves.
    useLayoutEffect(() => {
        if (!state.editing) return;
        const host = editorHost.current;
        const box = wrap.current;
        if (host === null || box === null) return;
        const left = host.offsetLeft;
        setAnchorLeft(Math.max(0, Math.min(left, box.clientWidth - 320)));
    }, [state.editing, state.pieces.before, state.pieces.edit]);

    // A press outside the wrap — bar and surface together — ends the editing session.
    useEffect(() => {
        if (!state.editing) return;
        const outside = (event: globalThis.MouseEvent): void => {
            if (wrap.current !== null && !wrap.current.contains(event.target as Node)) state.close();
        };
        document.addEventListener("mousedown", outside);
        return (): void => { document.removeEventListener("mousedown", outside); };
    }, [state.editing, state]);

    // `/` reaches the bar from anywhere; Ctrl+Z and Ctrl+Y step operations even with no slot open.
    useEffect(() => {
        const keys = (event: globalThis.KeyboardEvent): void => {
            const target = event.target as HTMLElement;
            const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
            if (event.key === "/" && !typing) {
                event.preventDefault();
                caretHint.current = "end";
                state.openEnd();
                return;
            }
            if (typing) return;
            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "z") {
                event.preventDefault();
                state.undo();
            } else if (event.ctrlKey && (event.key.toLowerCase() === "y"
                || (event.shiftKey && event.key.toLowerCase() === "z"))) {
                event.preventDefault();
                state.redo();
            }
        };
        document.addEventListener("keydown", keys);
        return (): void => { document.removeEventListener("keydown", keys); };
    }, [state]);

    const actions = {
        open: (start: number, end: number) => {
            caretHint.current = "end";
            state.openSpan(start, end);
        },
        remove: (start: number, end: number) => { state.deleteSpan(start, end); },
        grow: (start: number, end: number) => {
            const raw = state.text.slice(start, end);
            const grown = grownText(raw);
            caretHint.current = "end";
            state.openSpan(start, end);
            state.type(grown);
        },
    };

    const chipState = (clause: Clause): {warn: boolean; armed: boolean; linked: boolean} => ({
        warn: parsed.diagnostics.some((d) =>
            parsed.clauses[d.clause] === clause && d.severity === "warning"),
        armed: state.armed !== null && state.armed.start === clause.span.start
            && state.armed.end === clause.span.end,
        linked: linked !== null && parsed.clauses[linked] === clause,
    });

    /** The clause under the caret, for routing its diagnostics to the surface instead of the tray. */
    const editedClause = state.editing
        ? parsed.clauses.findIndex((clause) => clause.span.start < editEnd && clause.span.end > editStart)
        : -1;

    const head: Head | null = (() => {
        const open = openHead(state.pieces.edit);
        return open === null ? null : HEADS.get(fold(open.word)) ?? null;
    })();

    const surfaceContext: SurfaceContext | null = (() => {
        if (!state.editing) return null;
        const open = openHead(state.pieces.edit);
        if (open !== null && head !== null) return {at: "open", head, rest: open.rest};
        if (state.text.trim() === "") return {at: "menu"};
        const word = state.pieces.edit.trim();
        if (word !== "" && /^[\p{L}\p{N}_]+$/u.test(word)) return {at: "free", word};
        return null;
    })();

    const surfaceMessages = editedClause >= 0
        ? parsed.diagnostics.filter((d) => d.clause === editedClause).map((d) => d.message)
        : [];

    const leaveLeft = (): void => {
        const previous = beforeClauses.at(-1);
        if (previous !== undefined) {
            caretHint.current = "end";
            state.openSpan(previous.span.start, previous.span.end);
        }
    };
    const leaveRight = (): void => {
        const next = afterClauses[0];
        if (next !== undefined) {
            caretHint.current = "start";
            state.openSpan(next.span.start, next.span.end);
        } else if (state.pieces.after.trim() === "" && state.pieces.edit !== "") {
            caretHint.current = "end";
            state.commit(true);
        }
    };
    const backspaceAtStart = (): void => {
        const previous = beforeClauses.at(-1);
        if (previous === undefined) return;
        const span = {start: previous.span.start, end: previous.span.end};
        if (state.armed !== null && state.armed.start === span.start && state.armed.end === span.end) {
            state.deleteSpan(span.start, span.end);
            caretHint.current = "end";
            state.openEnd();
        } else {
            state.arm(span);
        }
    };

    const editorEvents = {
        onChange: state.type,
        onCommit: (openNew: boolean) => { state.commit(openNew); },
        onClose: state.close,
        onLeaveLeft: leaveLeft,
        onLeaveRight: leaveRight,
        onBackspaceAtStart: backspaceAtStart,
        onArrowDown: () => {
            const surface = wrap.current?.querySelector<HTMLElement>("[data-surface]");
            surface?.querySelector<HTMLElement>("button, input")?.focus();
        },
        onUndo: state.undo,
        onRedo: state.redo,
    };

    const surfaceActions = {
        setRest: (rest: string) => {
            const open = openHead(state.pieces.edit);
            state.type(open === null ? rest : state.pieces.edit.slice(0, open.consumed) + rest);
        },
        openAxis: (word: string) => { state.type(`${word}:`); },
        recall: (query: string) => { state.replaceAll(query); },
        focusSlot: () => { slotInput()?.focus(); },
    };

    const committed = (clause: Clause): ReactElement => (
        <CommittedClause
            key={`${String(clause.span.start)}-${String(clause.span.end)}`}
            view={views.get(clause) ?? {is: "raw", text: state.text.slice(clause.span.start, clause.span.end)}}
            span={clause.span}
            state={chipState(clause)}
            actions={actions}
        />
    );

    /** Empty ground anywhere on the bar opens the end; interactive children swallow their own presses. */
    const onBarGround = (e: ReactMouseEvent<HTMLDivElement>): void => {
        const target = e.target as HTMLElement;
        if (target.closest("button, input, [data-own-press]") !== null) return;
        e.preventDefault();
        caretHint.current = "end";
        state.openEnd();
        requestAnimationFrame(() => slotInput()?.focus());
    };

    return (
        <div ref={wrap} className={styles.wrap}>
            <div className={styles.bar} onMouseDown={onBarGround}>
                {beforeClauses.map(committed)}
                {state.editing && (
                    <span ref={editorHost} data-own-press="">
                        <Editor
                            key={editStart}
                            value={state.pieces.edit}
                            ghost={ghostFor(state.pieces.edit)}
                            initialCaret={caretHint.current}
                            events={editorEvents}
                            placeholder={state.text.trim() === "" ? t("bar.placeholder") : undefined}
                        />
                    </span>
                )}
                {!state.editing && state.text.trim() === "" && (
                    <span className={styles.placeholder}>{t("bar.placeholder")}</span>
                )}
                {afterClauses.map(committed)}
                <span className={styles.grow}/>
                <span className={styles.tools}>
                    <button type="button" className={styles.tool} onClick={onSimplify}>
                        {t("bar.simplify")}
                    </button>
                    <button type="button" className={styles.tool} disabled title={t("bar.help")}>
                        ?
                    </button>
                </span>
            </div>
            {surfaceContext !== null && (
                <div data-surface="">
                    <Surface
                        context={surfaceContext}
                        domains={domains}
                        history={history}
                        messages={surfaceMessages}
                        actions={surfaceActions}
                        left={anchorLeft}
                    />
                </div>
            )}
        </div>
    );
}
