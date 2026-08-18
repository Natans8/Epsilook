/**
 * @file Shared plumbing for the interaction-matrix suite: loading the harness, seeding a query through real
 * keystrokes, and reading the bar's semantic state.
 *
 * Assertions go through three reads only — the `data-query` mirror (the canonical query text), the input's
 * value and selection, and the open position's kind from its wrapper class. Settled-segment DOM structure is
 * off limits: the committed-chip rendering replaces it, and the matrix outcomes are about text, caret and
 * position, not markup.
 */
import type {Locator, Page} from "@playwright/test";
import {expect} from "@playwright/test";

/** The harness page, served by `npm run harness` (the webServer in playwright.config.ts). */
export const HARNESS_URL = "/dev/harness/";

/** The bar's one input — the open position, whatever kind it currently is. */
export function barInput(page: Page): Locator {
    return page.locator("[class*='qbar'] input");
}

/** The bar element itself — ground presses land on it. */
export function bar(page: Page): Locator {
    return page.locator("[class*='qbar']");
}

/** The settled segments in bar order — press targets only, never a structural assertion. */
export function settledSegments(page: Page): Locator {
    return page.locator("[class*='qbar'] > [class*='settled']");
}

/** The plaintext view's own field: one text area holding the query verbatim. */
export function plainField(page: Page): Locator {
    return page.locator("[class*='qbar'] textarea");
}

/** The plaintext view's switch, which lives beside the count. */
export function plainSwitch(page: Page): Locator {
    return page.getByRole("switch", {name: /plain text/i});
}

/**
 * The bar, when it holds a selection: the element stamps the selected chips' own query text, which is what a
 * copy puts on the clipboard. Absent entirely while nothing is selected.
 */
export function barSelection(page: Page): Locator {
    return page.locator("[data-selection]");
}

/** The element mirroring the query text for scripted assertions. */
export function queryMirror(page: Page): Locator {
    return page.locator("[data-query]");
}

/** Loads the harness and waits out the pack load, until the bar is interactive. */
export async function openHarness(page: Page): Promise<void> {
    await page.goto(HARNESS_URL);
    await barInput(page).waitFor({state: "visible", timeout: 120_000});
}

/** Asserts the canonical query text, retrying until the bar settles on it. */
export async function expectQuery(page: Page, text: string): Promise<void> {
    await expect(queryMirror(page)).toHaveAttribute("data-query", text);
}

/** One snapshot of the input: its value, selection and focus. */
export interface SlotState {
    readonly value: string;
    readonly start: number;
    readonly end: number;
    readonly focused: boolean;
}

/** Reads the input's live state in one evaluate, so the fields are one snapshot. */
export async function slot(page: Page): Promise<SlotState> {
    return barInput(page).evaluate((el) => {
        const held = el as HTMLInputElement;
        return {
            value: held.value,
            start: held.selectionStart ?? -1,
            end: held.selectionEnd ?? -1,
            focused: document.activeElement === held,
        };
    });
}

/** The open position's kinds a wrapper class can name. Flat mode shares the tail's geometry, so it is
 * asserted through value and selection instead. */
export type OpenKind = "tail" | "chip" | "gap" | "bare";

/** Reads the open position's kind from the open wrapper's class. */
export async function openKind(page: Page): Promise<OpenKind> {
    return barInput(page).evaluate((el) => {
        const wrap = el.closest("[class*='tail'], [class*='hug']");
        const cls = wrap === null ? "" : wrap.className;
        if (cls.includes("tail")) return "tail";
        if (cls.includes("gapRest")) return "gap";
        if (cls.includes("openChip")) return "chip";
        return "bare";
    });
}

/**
 * Empties the bar through real input: commit and jump to the end, flatten (two presses cover every position:
 * a chip's first Ctrl+A only claims its own slot), delete the selection. Leaves the focused empty tail.
 */
export async function clearBar(page: Page): Promise<void> {
    await barInput(page).focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expectQuery(page, "");
}

/**
 * Seeds the bar by typing each term and committing it with Enter — the way a query is actually composed: a
 * bound term auto-spawns its scope and a space inside it composes rather than committing, so a multi-term
 * query goes in term by term. The committed query is the terms joined by separators, with a trailing one.
 */
export async function seed(page: Page, ...terms: readonly string[]): Promise<void> {
    await clearBar(page);
    for (const term of terms) {
        await page.keyboard.type(term, {delay: 5});
        await page.keyboard.press("Enter");
    }
    await expectQuery(page, terms.map((term) => `${term} `).join(""));
}

/**
 * The page point inside one character of a settled segment, a quarter into its advance — far enough from the
 * glyph boundary that a caret hit test answers this character's own offset, not the next one's.
 *
 * The character is named by the RUN it belongs to rather than by an index into the segment, because a settled
 * segment's rendered text is not its query text: a chip draws a head and a body and no delimiters, so counting
 * characters across the whole segment would be counting a rendering. Naming the run is stable against that.
 *
 * @param segment The settled segment.
 * @param run The exact text of the rendered run to aim inside — a chip's head or its value.
 * @param index Which character of that run to aim at.
 */
export async function charPoint(segment: Locator, run: string, index: number): Promise<{ x: number; y: number }> {
    return segment.evaluate((el: Element, [want, at]: [string, number]) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (node.textContent !== want) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            const box = range.getBoundingClientRect();
            return {x: box.x + box.width / 4, y: box.y + box.height / 2};
        }
        throw new Error(`no run reading "${want}" in the segment`);
    }, [run, index] as [string, number]);
}

/** The control surface's panel, present only while it has something to offer. */
export function surface(page: Page): Locator {
    return page.locator("[data-surface]");
}

/** The offers on the surface, in draw order. */
export function offerRows(page: Page): Locator {
    return page.locator("[data-surface] [role='option']");
}

/** The lit offer — where the keyboard stands in the list. */
export function litOffer(page: Page): Locator {
    return page.locator("[data-surface] [role='option'][aria-selected='true']");
}

/** The inline completion drawn past the caret, present only while one is on offer. */
export function ghostText(page: Page): Locator {
    return page.locator("[class*='ghost']");
}
