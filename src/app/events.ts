import {currentSuggestIndex, hideSuggest, moveSuggestSelection, pickCurrentSuggestion, pickSuggestItem, updateSuggest} from "./autocomplete";
import {activateField, applyKbSel, atomCount, atomGapAtPoint, cancelActiveField, clearBarSel, commitActiveChip, deleteBarSel, editChipAt, flushPending, inputAtom, insertFreeChipHere, paintBarSel, redoBar, renderBar, selRange, serializeBarSel, sizeInput, syncBar, undoBar} from "./bar";
import {activateVersion, applyUrl} from "./boot";
import {copyText} from "./clipboard";
import {barHover, barHoverOut, markCaretCapsule} from "./highlight";
import {ID_CMD_PASTE, ID_CMD_TYPED, canonField, isChipField, parseQueryParts, serializeQuery, setChips} from "./query";
import {layoutRow, renderMore} from "./render";
import {COUNT_SORTS, applyFiltersAndSort, runSearch, scheduleSearch} from "./run";
import {toggleSound} from "./sound";
import {TRI_LABELS, qInput, state} from "./state";
import type {Chip} from "./state";
import {ensureFieldsVisible, setHelp, shareLink, stateToUrl} from "./url";
import * as Export from "../export";
import {$, $$, $$inputs, targetClosest} from "../util";
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
function crossSearch(query: string, mode: "replace"|"add"|"exclude" = "replace") {
    const parts = mode === "replace" ? [] : parseQueryParts(serializeQuery());
    // clicking the same pill twice must not stack the same chip twice
    const key = (p: Chip) => `${p.not ? "-" : ""}${p.field}:${p.text}`;
    const have = new Set(parts.map(key));
    for (const p of parseQueryParts(mode === "exclude" ? "-" + query : query)) {
        if (!have.has(key(p))) parts.push(p);
    }
    setChips(parts);
    runSearch({push: true});
    window.scrollTo({top: 0});
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
        const box = suggestBox;
        if (!box.hidden) {
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
    let dragSel: {anchor: number; x0: number; y0: number; fromInput: boolean; engaged: boolean} | null = null;
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
        }
        else if (t.dataset.expand) {
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

    // column visibility
    for (const box of $$inputs("#columns input[type=checkbox]")) {
        box.addEventListener("change", () => {
            state.hiddenCols[box.dataset.col!] = !box.checked;
            try {
                localStorage.setItem("epsilook.hiddenCols.v5", JSON.stringify(state.hiddenCols));
            } catch { /* storage blocked — the choice lasts this page only */
            }
            applyHiddenCols();
            runSearch();
        });
    }

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
        // the worked examples are live: running one closes the dialog so the
        // results it just produced are actually visible
        const ex = targetClosest(e, ".help-ex button[data-search]");
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
    for (const box of $$inputs("#columns input[type=checkbox]")) {
        box.checked = !state.hiddenCols[box.dataset.col!];
    }
}
