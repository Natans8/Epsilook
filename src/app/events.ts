import {
    applyCategoryWord,
    currentSuggestIndex,
    hideSuggest,
    moveSuggestSelection,
    pickCurrentSuggestion,
    pickSuggestItem,
    updateSuggest
} from "./autocomplete";
import {
    activateField,
    applyKbSel,
    atomCount,
    atomGapAtPoint,
    cancelActiveField,
    clearBarSel,
    commitActiveChip,
    deleteBarSel,
    editChipAt,
    flushPending,
    inputAtom,
    insertFreeChipHere,
    paintBarSel,
    redoBar,
    renderBar,
    selRange,
    serializeBarSel,
    sizeInput,
    syncBar,
    undoBar
} from "./bar";
import {activateVersion, applyUrl} from "./boot";
import {copyText} from "./clipboard";
import {barHover, barHoverOut, markCaretCapsule} from "./highlight";
import {
    ID_CMD_PASTE,
    ID_CMD_TYPED,
    canonField,
    isChipField,
    parseQueryParts,
    serializeChips,
    serializeQuery,
    setChips
} from "./query";
import {layoutRow, renderMore} from "./render";
import {COUNT_SORTS, applyFiltersAndSort, runSearch, scheduleSearch} from "./run";
import {toggleSound} from "./sound";
import {COL_ORDER, TRI_LABELS, qInput, state} from "./state";
import type {Chip} from "../query";
import {ensureFieldsVisible, setHelp, shareLink, stateToUrl, urlForQuery} from "./url";
import * as Export from "../export";
import {$, $$, targetClosest} from "../dom";
/* ------------------------------------------------------------ events */

/**
 * Run a pill's query. `mode` says how it meets the search already in the bar:
 *
 *   replace   the pill's question on its own — the plain click
 *   add       narrow what is on screen by it — SHIFT-click
 *   exclude   narrow by everything BUT it — CTRL/Cmd-click
 *
 * Shift adds and Ctrl excludes, by the user's call (2026-07-29). The pairing
 * is deliberate: adding is the one you reach for while exploring, and Shift
 * is the easier chord.
 *
 * ADDING IS THE MODIFIER, NOT THE DEFAULT. A pill click is most often "show
 * me this", asked of the whole game; a click that silently kept the last
 * search would make an empty result the ordinary outcome of exploring, and
 * the counterpart pills (an invisibility channel's detectors) navigate to a
 * question the current one contradicts — they would produce nothing at all.
 *
 * BOTH MODIFIERS NARROW. Excluding used to REPLACE the query with a lone
 * exclusion, which selects nearly every spell in the game and answers
 * nothing; it now means "what I am looking at, but not that". With an empty
 * bar it still does exactly what it always did.
 */
type CrossMode = "replace" | "add" | "exclude";

/**
 * The chips a pill's query would put in the bar — PURE, so the same answer can
 * be committed (a click) or merely written into a URL (a middle-click) without
 * the two ever diverging about what the pill means.
 */
function crossSearchParts(query: string, mode: CrossMode): Chip[] {
    const parts = mode === "replace" ? [] : parseQueryParts(serializeQuery());
    // clicking the same pill twice must not stack the same chip twice
    const key = (p: Chip) => `${p.not ? "-" : ""}${p.field}:${p.text}`;
    const have = new Set(parts.map(key));
    for (const p of parseQueryParts(mode === "exclude" ? "-" + query : query)) {
        if (!have.has(key(p))) parts.push(p);
    }
    return parts;
}

function crossSearch(query: string, mode: CrossMode = "replace") {
    setChips(crossSearchParts(query, mode));
    runSearch({push: true});
    window.scrollTo({top: 0});
}

/**
 * Open a pill's query in a new tab, keeping this one exactly as it is.
 *
 * IT IS ALWAYS THE PILL'S OWN QUESTION — mode "replace" — and the modifiers
 * play no part. That is not a simplification, it is what the gesture means: the
 * modifiers exist to NARROW what is on screen, and a new tab already keeps what
 * is on screen, in the tab you came from. "This, on its own, over there" is the
 * whole question, so there is one rule and nothing to remember.
 *
 * `noopener` because the opened page has no business reaching back through
 * `window.opener`, and it lets the browser give the tab its own process.
 */
function crossSearchNewTab(query: string) {
    window.open(urlForQuery(serializeChips(crossSearchParts(query, "replace"))),
        "_blank", "noopener");
}

export function wireEvents() {
    const input = qInput;
    // the three bar elements every handler below reaches for
    const bar = $("#qbar");
    const editwrap = $("#editwrap");
    const suggestBox = $("#suggest");

    input.addEventListener("input", (e) => {
        if (!state.activeField) {
            // pasted text arrives whole, so a "model:fire" inside it never
            // passes the caret check below — parse the full value into chips
            // instead. Only for pastes: while typing, tags chip at the ":"
            if ((e as InputEvent).inputType === "insertFromPaste"
                && (/(^|\s)-?[a-z]+:\S/i.test(input.value) || ID_CMD_PASTE.test(input.value))) {
                const parts = parseQueryParts(input.value);
                if (parts.some((p) => p.field !== "all")) {
                    ensureFieldsVisible(parts); // splices chips in without setChips
                    const last = parts[parts.length - 1];
                    const trailing = last && last.field === "all" ? parts.pop()!.text : "";
                    const at = Math.min(state.pos, state.chips.length);
                    state.chips.splice(at, 0, ...parts);
                    state.pos = at + parts.length;
                    input.value = trailing;
                    input.setSelectionRange(input.value.length, input.value.length);
                    syncBar();
                    scheduleSearch();
                    return;
                }
            }
            // a "field:" tag just typed — anywhere, not only at the end: text
            // before it stays free words, text after the caret becomes the
            // tag's content (e.g. "model:|statue" -> model: chip with "statue").
            // Inside an open "quote the prefix stays literal — quoting is how
            // you search for the text model: itself.
            const caret = input.selectionStart ?? input.value.length;
            const before = input.value.slice(0, caret);
            const inQuote = ((before.match(/"/g) || []).length % 2) === 1;
            const m = before.match(/(^|\s)(-?)([a-z]+):$/i);
            if (m && !inQuote && isChipField(canonField(m[3].toLowerCase()))) {
                const field = canonField(m[3].toLowerCase());
                const rest = input.value.slice(caret);
                input.value = input.value.slice(0, m.index! + m[1].length);
                activateField(field, {not: m[2] === "-"});
                if (rest) {
                    input.value = rest;
                    input.setSelectionRange(0, 0);
                    sizeInput();
                    scheduleSearch();
                }
                return;
            }
            // an Epsilon command just finished with a space — ".cast " (or
            // .cas/.ca/.c/.aura/.aur/.au) opens an id: chip, the space acting
            // as the tag's ":"
            const cm = before.match(ID_CMD_TYPED);
            if (cm && !inQuote) {
                const rest = input.value.slice(caret);
                input.value = input.value.slice(0, cm.index! + cm[1].length);
                activateField("id");
                if (rest) {
                    input.value = rest;
                    input.setSelectionRange(0, 0);
                    sizeInput();
                    scheduleSearch();
                }
                return;
            }
        }
        updateSuggest(); // field prefixes, or category words inside fx:/model:
        sizeInput();
        scheduleSearch();
    });

    // the highlight backdrop scrolls with the input it sits under (a long
    // value scrolls inside #q rather than widening the pill)
    input.addEventListener("scroll", () => {
        const box = document.getElementById("qhl");
        if (box) box.scrollLeft = input.scrollLeft;
    });
    // hover behaviour for the marked words in the input: the backdrop is
    // inert, so the input answers for whatever span is under the pointer
    input.addEventListener("mousemove", barHover);
    input.addEventListener("mouseleave", barHoverOut);
    // the caret decides which capsule is lit, and it moves without the value
    // changing — so this cannot ride on syncHighlight alone
    document.addEventListener("selectionchange", () => {
        if (document.activeElement === input) markCaretCapsule();
    });
    input.addEventListener("focus", markCaretCapsule);
    input.addEventListener("blur", markCaretCapsule);

    input.addEventListener("keydown", (e) => {
        if (!suggestBox.hidden) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                moveSuggestSelection(e.key === "ArrowDown" ? 1 : -1);
                return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && currentSuggestIndex() >= 0)) {
                e.preventDefault();
                pickCurrentSuggestion();
                return;
            }
            if (e.key === "Escape") {
                hideSuggest();
                return;
            }
        }

        // ---- bar undo/redo (the bar keeps its own history — see barHistory) ----
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.key.toLowerCase() === "z") {
            e.preventDefault();
            if (e.shiftKey) redoBar(); else undoBar();
            return;
        }
        if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
            e.preventDefault();
            redoBar();
            return;
        }

        // ---- bar-wide selection (chips + input as one line) ----
        if (mod && !e.altKey && e.key.toLowerCase() === "a"
            && (state.chips.length || state.activeField || input.value)) {
            e.preventDefault();
            input.select();
            state.barSel = {anchor: 0, focus: atomCount()};
            paintBarSel();
            return;
        }
        if (state.barSel) {
            if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
                e.preventDefault();
                const text = serializeBarSel();
                if (text) copyText(text);
                if (e.key.toLowerCase() === "x") deleteBarSel();
                return;
            }
            if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                deleteBarSel();
                return;
            }
            if (e.key === "Escape") {
                clearBarSel();
                return;
            }
            if (!e.shiftKey && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                clearBarSel();
                return; // the input's own selection collapses natively
            }
            // typing/pasting over the selection is handled in beforeinput —
            // it fires for every way text can enter the input, keydown doesn't
        }
        if (e.shiftKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            const I = inputAtom(), N = atomCount();
            if (state.barSel) {
                e.preventDefault();
                const focus = state.barSel.focus + (e.key === "ArrowLeft" ? -1 : 1);
                applyKbSel(state.barSel.anchor, Math.max(0, Math.min(N, focus)));
                return;
            }
            // spill out of the input into the chips beside it
            if (e.key === "ArrowLeft" && input.selectionStart === 0 && I > 0) {
                e.preventDefault();
                applyKbSel(I + 1, I - 1);
                return;
            }
            if (e.key === "ArrowRight" && input.selectionEnd === input.value.length && I < N - 1) {
                e.preventDefault();
                applyKbSel(I, I + 2);
                return;
            }
        }

        const caretAtStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const caretAtEnd = input.selectionStart === input.value.length
            && input.selectionEnd === input.value.length;

        // typing "-" at the very start of a tag flips it to an exclusion,
        // instead of typing "-model:..." from scratch
        if (e.key === "-" && state.activeField && caretAtStart) {
            e.preventDefault();
            state.activeNot = !state.activeNot;
            renderBar();
            return;
        }

        if (e.key === "Enter") {
            commitActiveChip();
            syncBar();
            runSearch({push: true});
        } else if ((e.key === "Tab" || e.key === "Escape" || (e.key === "ArrowRight" && caretAtEnd))
            && state.activeField) {
            // close the tag being typed — lands in the gap right after it
            e.preventDefault();
            commitActiveChip();
            syncBar();
            scheduleSearch();
        } else if (e.key === "ArrowLeft" && state.activeField && caretAtStart) {
            // close the tag being typed — lands in the gap right before it
            e.preventDefault();
            commitActiveChip("before");
            syncBar();
            scheduleSearch();
        } else if (e.key === "ArrowLeft" && !state.activeField && caretAtStart && state.pos > 0) {
            // walk left out of the plain-text run (or empty gap) into the
            // chip before it — any text is committed as a free run first
            e.preventDefault();
            const at = insertFreeChipHere();
            editChipAt(at === -1 ? state.pos - 1 : at - 1, "end");
        } else if (e.key === "ArrowRight" && !state.activeField && caretAtEnd && state.pos < state.chips.length) {
            // walk right out of the plain-text run into the chip after it
            e.preventDefault();
            const at = insertFreeChipHere();
            editChipAt(at === -1 ? state.pos : at + 1, "start");
        } else if (e.key === "Backspace" && state.activeField && caretAtStart) {
            // cursor at the start of a tag's contents (or tag empty): strip the
            // tag, leaving the contents behind as plain text
            e.preventDefault();
            cancelActiveField();
        } else if (e.key === "Backspace" && !state.activeField && caretAtStart && state.pos > 0) {
            // backspacing past the start of the plain-text run: dive into
            // editing the chip to the left, caret at its end
            e.preventDefault();
            const at = insertFreeChipHere();
            editChipAt(at === -1 ? state.pos - 1 : at - 1, "end");
        }
    });

    // context-menu copy/cut on the input honor a bar selection too
    input.addEventListener("copy", (e) => {
        if (!state.barSel) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", serializeBarSel());
    });
    input.addEventListener("cut", (e) => {
        if (!state.barSel) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", serializeBarSel());
        deleteBarSel();
    });
    // any text entering the input (typed, pasted, IME-composed) replaces a
    // bar selection first — beforeinput fires before the mutation lands, so
    // the new text arrives at the collapsed caret the deletion leaves.
    // Context-menu Undo/Redo reroute to the bar's own history: the native
    // stack only knows the input's text, not the chips around it.
    input.addEventListener("beforeinput", (e) => {
        if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
            e.preventDefault();
            if (e.inputType === "historyUndo") undoBar(); else redoBar();
            return;
        }
        if (state.barSel) deleteBarSel();
    });
    input.addEventListener("paste", () => {
        if (state.barSel) deleteBarSel();
    });
    document.addEventListener("mousedown", (e) => {
        if (state.barSel && !targetClosest(e, "#qbar")) clearBarSel();
    });

    // mouse-drag selection across the bar. A drag within the input stays
    // native; once the pointer leaves the editor (or the drag started on a
    // chip), whole atoms select between the anchor gap and the pointer.
    let dragSel: { anchor: number; x0: number; y0: number; fromInput: boolean; engaged: boolean } | null = null;
    let suppressBarClick = false;

    function onBarDragMove(e: MouseEvent): void {
        if (!dragSel) return;
        if (!dragSel.engaged) {
            if (Math.abs(e.clientX - dragSel.x0) < 4 && Math.abs(e.clientY - dragSel.y0) < 4) return;
            if (dragSel.fromInput) {
                const r = editwrap.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right
                    && e.clientY >= r.top && e.clientY <= r.bottom) return;
                // leaving the editor: anchor at the input's far edge so the
                // whole free-text run rides along with the selection
                const I = inputAtom();
                dragSel.anchor = atomGapAtPoint(e.clientX, e.clientY) <= I ? I + 1 : I;
            }
            dragSel.engaged = true;
        }
        e.preventDefault(); // stop native text selection fighting the overlay
        const focus = atomGapAtPoint(e.clientX, e.clientY);
        if (focus === dragSel.anchor) {
            clearBarSel();
            return;
        }
        state.barSel = {anchor: dragSel.anchor, focus};
        const [s, en] = selRange()!; // non-null: barSel was just set
        const I = inputAtom();
        if (s <= I && I < en) input.select();
        else input.setSelectionRange(input.value.length, input.value.length);
        paintBarSel();
    }

    function onBarDragEnd(e: MouseEvent): void {
        onBarDragMove(e); // a fast drag's last mousemove lags the release point
        document.removeEventListener("mousemove", onBarDragMove);
        document.removeEventListener("mouseup", onBarDragEnd);
        if (dragSel && dragSel.engaged) {
            suppressBarClick = true; // the release click must not move the gap
            input.focus({preventScroll: true});
        }
        dragSel = null;
    }

    bar.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        clearBarSel();
        const fromInput = !!targetClosest(e, "#editwrap");
        // keep focus (and suppress native chip-text selection); clicks still fire
        if (!fromInput) e.preventDefault();
        dragSel = {
            anchor: atomGapAtPoint(e.clientX, e.clientY),
            x0: e.clientX, y0: e.clientY, fromInput, engaged: false,
        };
        document.addEventListener("mousemove", onBarDragMove);
        document.addEventListener("mouseup", onBarDragEnd);
    });

    // chip clicks: × removes, field label flips include/exclude, body edits
    bar.addEventListener("click", (e) => {
        if (suppressBarClick) {
            suppressBarClick = false;
            return;
        }
        const x = targetClosest(e, "[data-chip-remove]");
        if (x) {
            const idx = Number(x.dataset.chipRemove);
            state.chips.splice(idx, 1);
            if (idx < state.pos) state.pos -= 1;
            syncBar();
            input.focus();
            scheduleSearch();
            return;
        }
        const label = targetClosest(e, "[data-chip-not]");
        if (label) {
            const chip = state.chips[Number(label.dataset.chipNot)];
            chip.not = !chip.not;
            renderBar();
            input.focus();
            scheduleSearch();
            return;
        }
        if (targetClosest(e, "#editlabel")) {
            state.activeNot = !state.activeNot;
            renderBar();
            input.focus();
            scheduleSearch();
            return;
        }
        const chip = targetClosest(e, "[data-chip-edit]");
        if (chip) {
            // flush anything pending elsewhere first, correcting the target
            // index if that insertion landed before it
            let idx = Number(chip.dataset.chipEdit);
            const insertedAt = flushPending();
            if (insertedAt !== -1 && insertedAt <= idx) idx += 1;
            editChipAt(idx);
            return;
        }
        if (targetClosest(e, "#editwrap")) return; // clicks in the editor place the caret natively

        // bar background: commit whatever's pending and move the gap (and
        // cursor) to where the click landed
        const past = (elem: Element) => { // is the click past this element in reading order?
            const r = elem.getBoundingClientRect();
            return e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > (r.left + r.right) / 2);
        };
        let gap = 0;
        for (const c of $$(".qchip", bar)) {
            if (past(c)) gap = Number(c.dataset.chipEdit) + 1;
        }
        const afterPending = past(editwrap);
        const insertedAt = flushPending();
        if (insertedAt !== -1 && (insertedAt < gap || (insertedAt === gap && afterPending))) gap += 1;
        state.pos = Math.min(gap, state.chips.length);
        syncBar();
        input.focus();
        scheduleSearch();
    });

    // suggestions
    suggestBox.addEventListener("mousedown", (e) => {
        const item = targetClosest(e, ".suggest-item");
        if (item) {
            e.preventDefault();
            pickSuggestItem(item);
        }
    });
    document.addEventListener("click", (e) => {
        if (!targetClosest(e, "#qbar") && !targetClosest(e, "#suggest")) hideSuggest();
    });

    // field buttons: "+ Label" includes, "−" (or shift-click) excludes
    $("#tabs").addEventListener("click", (e) => {
        const btn = targetClosest(e, "button[data-field]");
        if (btn) activateField(btn.dataset.field!, {not: btn.dataset.not === "1" || e.shiftKey});
    });

    // results: copy buttons / cross-search / expanders (event delegation)
    $("#results").addEventListener("click", (e) => {
        const t = targetClosest(e, "button");
        if (!t) return;
        if (t.dataset.copy) copyText(t.dataset.copy, e.shiftKey);
        else if (t.dataset.play) toggleSound(t);
        else if (t.dataset.search) {
            // data-nav marks a segment that navigates rather than filters
            // (see clickHint in pills.js) — it only ever replaces
            const mode = t.dataset.nav ? "replace"
                : e.shiftKey ? "add"
                    : (e.ctrlKey || e.metaKey) ? "exclude" : "replace";
            crossSearch(t.dataset.search!, mode);
        } else if (t.dataset.expand) {
            // reveal this cell fully; the row grows to fit it and its siblings
            // re-clamp to the taller budget, revealing more of themselves
            const td = t.closest("td")!;
            td.dataset.expanded = "1";
            layoutRow(td.closest("tr")!);
        }
    });

    // example searches on the empty-state panel
    $("#empty-state").addEventListener("click", (e) => {
        const b = targetClosest(e, "button[data-search]");
        if (b) crossSearch(b.dataset.search!);
    });

    /* Middle-click any searchable pill to open its question in a new tab.
     *
     * ONE HANDLER ON THE DOCUMENT, not one per surface. Every affordance that
     * filters is already a `button[data-search]` — result pills, the empty
     * state's examples, the help dialog's worked examples — so delegating from
     * the top means a fourth surface inherits this instead of having to
     * remember it. (The plain-click handlers stay per-surface because they
     * differ: the help one closes its dialog first.)
     *
     * `auxclick` is the event for a non-primary button; a middle press never
     * fires `click` at all. And the mousedown below is not decoration — on
     * Windows a middle press over a non-link starts the browser's autoscroll,
     * so without it the new tab opens behind a drifting scroll cursor.
     */
    document.addEventListener("mousedown", (e) => {
        if (e.button === 1 && targetClosest(e, "button[data-search]")) e.preventDefault();
    });
    document.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return; // right-click keeps the browser's own menu
        const b = targetClosest(e, "button[data-search]");
        if (!b) return;
        e.preventDefault();
        crossSearchNewTab(b.dataset.search!);
    });

    // share + export
    $("#share-link").addEventListener("click", shareLink);
    $("#export-csv").addEventListener("click", Export.csv);
    $("#export-json").addEventListener("click", Export.json);
    $("#export-discord").addEventListener("click", Export.discord);

    // filters — tri-state, each click cycles any -> only with -> only without.
    // Part of the shareable state, so the URL follows (a push: Back undoes the
    // toggle like it undoes a search)
    const TRI_STATES: ("" | "with" | "without")[] = ["", "with", "without"];
    for (const btn of $$("#filters button.tri")) {
        btn.addEventListener("click", () => {
            const key = btn.dataset.filter!;
            const next = TRI_STATES[(TRI_STATES.indexOf(state.filters[key]) + 1) % TRI_STATES.length];
            state.filters[key] = next;
            btn.dataset.state = next;
            btn.setAttribute("aria-label", `${(btn.textContent ?? "").trim()} filter: ${TRI_LABELS[next]}`);
            applyFiltersAndSort();
            stateToUrl(true);
        });
    }

    // column visibility — the chip's click, suppressed by wireColumnOrder when
    // the press turned out to be a drag
    for (const chip of $$("#columns .col-chip")) {
        chip.addEventListener("click", () => {
            const col = chip.dataset.col!;
            state.hiddenCols[col] = !state.hiddenCols[col];
            saveColPrefs();
            applyHiddenCols();
            runSearch();
        });
    }
    // …and column order, and the chip↔column pairing, on the same rack
    wireColumnOrder();
    wireColumnHighlight();

    // sorting: click cycles ascending -> descending -> back to automatic
    // order; entry-count columns start descending (extreme spells first)
    for (const th of $$("th[data-sort]")) {
        th.addEventListener("click", () => {
            const key = th.dataset.sort!;
            const first = COUNT_SORTS.has(key) ? -1 : 1;
            if (state.sort.key !== key) state.sort = {key, dir: first};
            else if (state.sort.dir === first) state.sort.dir = -first;
            else state.sort = {key: "auto", dir: 1};
            applyFiltersAndSort();
            stateToUrl(true); // shareable + Back undoes the sort, like the filters
        });
    }

    // help dialog (native <dialog>: Esc closes it for free)
    const help = ($("#help") as HTMLDialogElement);
    $("#help-btn").addEventListener("click", () => setHelp(true));
    $("#help-close").addEventListener("click", () => setHelp(false));
    // Esc and the form's own close bypass the handlers above, so the URL is
    // squared up here — one place, whatever closed it
    help.addEventListener("close", () => {
        if (new URLSearchParams(location.search).has("help")) stateToUrl(true);
    });
    help.addEventListener("click", (e) => {
        if (e.target === help) return setHelp(false); // backdrop click
        /* A word that says nothing without an argument is not run — it is
         * STARTED. `attach` alone is a filename search for "attach", so
         * clicking it would answer a question nobody asked; instead the field
         * opens with the word typed and the caret waiting where its value
         * goes, which is what picking the same word from the suggestion list
         * already does (applyCategoryWord). */
        const start = targetClosest(e, "[data-start]");
        if (start) {
            help.close();
            activateField(start.dataset.field!);
            return applyCategoryWord(start.dataset.start!);
        }
        // every worked example is live: running one closes the dialog so the
        // results it just produced are actually visible
        const ex = targetClosest(e, "button[data-search]");
        if (ex) {
            help.close();
            crossSearch(ex.dataset.search!);
        }
    });

    // infinite scroll
    new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) renderMore();
    }, {rootMargin: "600px"}).observe($("#sentinel"));

    // resizing changes how pills wrap, so cell heights change — re-run the
    // height clamp on every rendered row (debounced). Expanded cells stay open.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            for (const tr of $("#results tbody").children) layoutRow((tr as HTMLElement));
        }, 150);
    });

    // back/forward (pushState entries and legacy #q= entries both land here)
    window.addEventListener("popstate", () => applyUrl({push: false}));

    // version switch
    const versionSel = ($("#version") as HTMLSelectElement);
    versionSel.addEventListener("change", async () => {
        const entry = state.versions.find((v) => v.id === versionSel.value);
        if (entry) await activateVersion(entry, {push: true});
    });
}

export function updateTabs() {
    for (const tab of $$("#tabs .tab")) {
        const isField = tab.dataset.field === state.activeField;
        tab.classList.toggle("active", isField && !state.activeNot);
        tab.classList.toggle("active-not", isField && state.activeNot);
    }
}

/* Hide table columns and sync the checkboxes. Field buttons stay
   * visible — clicking one un-hides its column via ensureFieldVisible.
   * The "Only spells with" filters are independent of column visibility:
   * they narrow the result list whether or not the column is shown. */
export function applyHiddenCols() {
    const table = $("#results");
    for (const [col, hidden] of Object.entries(state.hiddenCols)) {
        table.classList.toggle(`hide-${col}`, hidden);
    }
    for (const chip of $$("#columns .col-chip")) {
        const shown = !state.hiddenCols[chip.dataset.col!];
        chip.classList.toggle("off", !shown);
        // role="switch", so the state is aria-checked — a switch that reported
        // aria-pressed would be a button wearing a switch's clothes
        chip.setAttribute("aria-checked", String(shown));
    }
    describeCols();
}

/** Both display preferences live under one key family, written together. */
function saveColPrefs(): void {
    try {
        localStorage.setItem("epsilook.hiddenCols.v5", JSON.stringify(state.hiddenCols));
        localStorage.setItem("epsilook.colOrder.v1", JSON.stringify(state.colOrder));
    } catch { /* storage blocked — the choice lasts this page only */
    }
}

/**
 * Put the table and the panel into `state.colOrder`.
 *
 * Reordering is pure DOM movement: hiding is a class on the table, so a hidden
 * column is still a cell in every row and nothing here has to know or care
 * which columns are on screen. Moving the nodes rather than re-running the
 * search is also what keeps this instant — the cells already exist, and a
 * re-render would throw away the icons the rows have lazily loaded.
 */
export function applyColOrder(): void {
    const table = $("#results");
    const headRow = table.querySelector("thead tr");
    const at = (row: Element, col: string) => row.querySelector(`.c-${col}`);
    // append in order: a node already in the parent MOVES rather than
    // duplicating, so walking the order once is the whole reorder
    for (const col of state.colOrder) {
        const th = headRow && at(headRow, col);
        if (th) headRow!.appendChild(th);
    }
    for (const row of table.querySelectorAll("tbody tr")) {
        // an "empty" placeholder row spans the table and has no payload cells
        for (const col of state.colOrder) {
            const td = at(row, col);
            if (td) row.appendChild(td);
        }
    }
    const rack = $("#cols-rack");
    for (const col of state.colOrder) {
        const chip = rack.querySelector(`.col-chip[data-col="${col}"]`);
        if (chip) rack.appendChild(chip);
    }
    describeCols();
}

/**
 * Say what each chip is and does, in the tooltip and to a screen reader.
 *
 * Both facts a chip carries are POSITIONAL — whether its column is on, and
 * where in the order it sits — so both change under the user's hands and
 * neither can be written into the markup once. Composed here, next to the two
 * functions that change them.
 */
function describeCols(): void {
    const n = state.colOrder.length;
    for (const chip of $$("#columns .col-chip")) {
        const col = chip.dataset.col!;
        // its own span, not the chip's textContent: the grip and the switch are
        // empty elements today and a trim would still work, but a segment that
        // ever gains text would silently join the name
        const name = (chip.querySelector(".col-name")?.textContent || col).trim();
        const shown = !state.hiddenCols[col];
        const at = state.colOrder.indexOf(col) + 1;
        // the switch and the grip now say "click" and "drag" on their own, so
        // what is left for the tooltip is the CONSEQUENCE (which is invisible
        // and surprising) and the keyboard route (which has no affordance)
        chip.title = [
            `${name} column — ${shown ? `column ${at} of ${n}` : "hidden"}`,
            shown
                ? "Hiding it also leaves it out of plain-word search and exports"
                : "Hidden: not shown, not searched by plain words, not exported",
            `Click: ${shown ? "hide it" : "show it"}`,
            "Drag: move it left or right",
            "Alt + ← →: move it from the keyboard",
        ].join("\n");
        chip.setAttribute("aria-label",
            `${name} column, ${shown ? `shown, position ${at} of ${n}` : "hidden"}`);
    }
}

/** Move a column to a new index, then apply and remember it. */
function moveCol(col: string, to: number): void {
    const from = state.colOrder.indexOf(col);
    const at = Math.max(0, Math.min(state.colOrder.length - 1, to));
    if (from < 0 || from === at) return;
    state.colOrder.splice(from, 1);
    state.colOrder.splice(at, 0, col);
    applyColOrder();
    saveColPrefs();
}

/** How far the pointer must travel before a press becomes a drag, not a tick. */
const DRAG_SLOP = 4;

/** Suppressed mid-drag: the chips move under the pointer, so the pair would
 *  strobe through every column the dragged chip passes over. */
let dragging = false;

/**
 * Light one column and its chip together, or clear both.
 *
 * THIS IS THE ANSWER TO "NOTHING SAYS IT IS TIED TO THE COLUMNS BELOW", and it
 * had to be a demonstration rather than a label. The obvious fix — position
 * each chip over the column it controls — is not available: the table is about
 * 2,280px wide inside a ~1,230px wrap, so it scrolls horizontally, and the
 * fifth column starts past the right edge of the window the rack is drawn in.
 * A relationship you watch happen survives that; an alignment cannot.
 *
 * Both directions are wired, and the second is the one that teaches: hovering a
 * HEADER lights its chip, which is how someone who never looked at the toolbar
 * finds out what moves the column under their pointer.
 */
function litColumn(col: string | null): void {
    const table = $("#results");
    for (const c of COL_ORDER) table.classList.toggle(`lit-${c}`, c === col);
    for (const chip of $$("#columns .col-chip")) {
        chip.classList.toggle("lit", chip.dataset.col === col);
    }
}

/** Hover and focus, from either end. */
function wireColumnHighlight(): void {
    const pair = (el: Element | null, key: "col" | "sort") => {
        const val = (el as HTMLElement | null)?.dataset[key];
        // `id` and `name` are sortable headers too, and neither is a column the
        // rack can move — so the key has to be one the rack actually holds
        litColumn(val && COL_ORDER.includes(val) ? val : null);
    };

    for (const [root, sel, key] of [
        [$("#columns"), ".col-chip", "col"],
        [$("#results").querySelector("thead"), "th", "sort"],
    ] as const) {
        if (!root) continue;
        root.addEventListener("pointerover", (e) => {
            if (dragging) return;
            pair((e.target as Element)?.closest(sel), key);
        });
        root.addEventListener("pointerleave", () => litColumn(null));
        // keyboard parity: the same pairing on focus, so tabbing the rack shows
        // which column each chip owns
        root.addEventListener("focusin", (e) => pair((e.target as Element)?.closest(sel), key));
        root.addEventListener("focusout", () => litColumn(null));
    }
}

/**
 * Drag a column label to reorder the table, with an arrow-key equivalent.
 *
 * IN THE PANEL THAT ALREADY TICKS THEM (the user's first suggestion), because
 * the panel is the one place the columns are listed as a set — the table's own
 * headers are click-to-sort, and overloading a header with a drag would put two
 * meanings on one press.
 *
 * POINTER EVENTS, NOT HTML5 DRAG-AND-DROP, and the reason is not preference:
 * `draggable` + dragstart/dragover/drop was written first and cannot be
 * verified here — CDP's synthetic mouse input does not start a native drag, so
 * the automation reports success while nothing moves. It is also mouse-only:
 * a touch device gets no drag at all. Pointer events cover mouse, touch and pen
 * through one path and can be driven end to end in a browser, which is the
 * difference between "should work" and "measured".
 *
 * The keyboard half is not a courtesy either — a drag has no keyboard form, so
 * without it the feature would simply not exist for part of the audience. It
 * hangs off the checkbox, already in the tab order, and the panel's title says
 * so rather than leaving it to be found.
 */
function wireColumnOrder(): void {
    const panel = $("#columns");
    let held: HTMLElement | null = null;   // the label under the press
    let startX = 0;
    let moved = false;                     // has it passed the slop yet

    const clearMarks = () => {
        for (const c of $$("#columns .col-chip")) {
            c.classList.remove("dragging", "drop-before", "drop-after");
        }
    };
    /** The chip the pointer is over, and which side of its midline. */
    const overAt = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        const chip = el && (el as Element).closest<HTMLElement>("#columns .col-chip");
        if (!chip || chip === held) return null;
        const box = chip.getBoundingClientRect();
        return {chip, before: x < box.left + box.width / 2};
    };

    panel.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const chip = (e.target as Element)?.closest<HTMLElement>(".col-chip");
        if (!chip) return;
        held = chip;
        startX = e.clientX;
        moved = false;
        // capture so the drag survives the pointer leaving the chip — the
        // chips reorder underneath it, so it leaves constantly
        chip.setPointerCapture(e.pointerId);
    });

    panel.addEventListener("pointermove", (e) => {
        if (!held) return;
        if (!moved && Math.abs(e.clientX - startX) < DRAG_SLOP) return;
        moved = true;
        dragging = true;
        litColumn(null);       // the pair would strobe as the chips reflow
        held.classList.add("dragging");
        const to = overAt(e.clientX, e.clientY);
        for (const c of $$("#columns .col-chip")) c.classList.remove("drop-before", "drop-after");
        if (to) to.chip.classList.add(to.before ? "drop-before" : "drop-after");
    });

    panel.addEventListener("pointerup", (e) => {
        if (!held) return;
        const chip = held, dragged = moved;
        held = null;
        dragging = false;
        clearMarks();
        if (!dragged) return;              // a plain press: let the click toggle
        const to = overAt(e.clientX, e.clientY);
        if (to) {
            const col = chip.dataset.col!;
            // index in the list WITHOUT the dragged column, so dropping to the
            // right of a neighbour does not land one short
            const rest = state.colOrder.filter((c) => c !== col);
            const target = rest.indexOf(to.chip.dataset.col!);
            moveCol(col, to.before ? target : target + 1);
        }
        // the press is about to become a click, and a click hides the column —
        // swallow exactly this one
        panel.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        }, {capture: true, once: true});
    });

    panel.addEventListener("pointercancel", () => {
        held = null;
        dragging = false;
        clearMarks();
    });

    // keyboard parity. Alt keeps it clear of the arrow keys that walk a
    // toolbar, and of the Space/Enter that toggle the chip.
    panel.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        const chip = (e.target as Element)?.closest<HTMLElement>(".col-chip");
        if (!chip) return;
        e.preventDefault();
        const col = chip.dataset.col!;
        moveCol(col, state.colOrder.indexOf(col) + (e.key === "ArrowLeft" ? -1 : 1));
        chip.focus();   // the node moved out from under the focus ring
    });
}
