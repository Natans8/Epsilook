/**
 * @file The bar: committed chips around one open segment, with the control surface anchored beneath it.
 *
 * The bar renders the parse of the query text. Clauses outside the open region are committed — chips, lanes,
 * freeform text or raw error text per {@link clauseView} — and the open region renders as the {@link Editor}.
 * Every gesture maps to a transition on {@link QueryState}: arrows flow through chips by committing one segment
 * and opening its neighbour, Backspace at a boundary arms before it deletes, a chip click opens its span.
 */
import type {ReactElement} from "react";
import {useMemo} from "react";
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
    const editStart = state.pieces.before.length;
    const editEnd = editStart + state.pieces.edit.length;

    const beforeClauses = parsed.clauses.filter((clause) => clause.span.end <= editStart
        || (!state.editing && clause.span.start < editStart));
    const afterClauses = parsed.clauses.filter((clause) => clause.span.start >= editEnd
        && !beforeClauses.includes(clause));

    const views = useMemo(() => new Map(parsed.clauses.map((clause) =>
        [clause, clauseView(clause, state.text)])), [parsed, state.text]);

    const actions = {
        open: state.openSpan,
        remove: (start: number, end: number) => { state.deleteSpan(start, end); },
        grow: (start: number, end: number) => {
            const raw = state.text.slice(start, end);
            const grown = grownText(raw);
            // Replace the span with its grown spelling, then open it with the caret in the new slot.
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
        if (previous !== undefined) state.openSpan(previous.span.start, previous.span.end);
    };
    const leaveRight = (): void => {
        const next = afterClauses[0];
        if (next !== undefined) state.openSpan(next.span.start, next.span.end);
        else if (state.pieces.after.trim() === "" && state.pieces.edit !== "") state.commit(true);
    };
    const backspaceAtStart = (): void => {
        const previous = beforeClauses.at(-1);
        if (previous === undefined) return;
        const span = {start: previous.span.start, end: previous.span.end};
        if (state.armed !== null && state.armed.start === span.start && state.armed.end === span.end) {
            state.deleteSpan(span.start, span.end);
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
        onArrowDown: () => {},
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

    return (
        <div className={styles.wrap}>
            <div
                className={styles.bar}
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget) { e.preventDefault(); state.openEnd(); }
                }}
            >
                {beforeClauses.map(committed)}
                {state.editing && (
                    <Editor
                        value={state.pieces.edit}
                        ghost={ghostFor(state.pieces.edit)}
                        events={editorEvents}
                        placeholder={state.text.trim() === "" ? t("bar.placeholder") : undefined}
                    />
                )}
                {!state.editing && state.text.trim() === "" && (
                    <span className={styles.placeholder}>{t("bar.placeholder")}</span>
                )}
                {afterClauses.map(committed)}
                <span
                    className={styles.grow}
                    onMouseDown={(e) => { e.preventDefault(); state.openEnd(); }}
                />
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
                <Surface
                    context={surfaceContext}
                    domains={domains}
                    history={history}
                    messages={surfaceMessages}
                    actions={surfaceActions}
                />
            )}
        </div>
    );
}
