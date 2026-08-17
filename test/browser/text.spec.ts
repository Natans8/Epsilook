/**
 * @file The cells this increment rules: plain words are TEXT.
 *
 * Neighbouring words are one segment, the space between them is one of its characters, and a selection over
 * them is per character and needs no press first. Chips stay atomic, so the two are told apart by what a
 * selection can cover — and the band that shows it is one continuous stretch either way.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {
    bar, barInput, barSelection, expectQuery, HARNESS_URL, queryMirror, settledSegments, slot,
} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
});

test.afterAll(async () => {
    await page.close();
});

/** Opens the harness on one query, at rest, with nothing focused. */
async function opened(query: string): Promise<void> {
    await page.goto(`${HARNESS_URL}?q=${encodeURIComponent(query)}`);
    await expect(queryMirror(page)).toHaveAttribute("data-query", query, {timeout: 120_000});
    await page.mouse.click(4, 400);
}

/** The box of the settled child holding one query offset. */
async function childBox(at: number): Promise<{ x: number; y: number; width: number }> {
    const box = await page.locator(`[data-at="${String(at)}"]`).first().boundingBox();
    if (box === null) throw new Error(`no child at ${String(at)}`);
    return {x: box.x, y: box.y + box.height / 2, width: box.width};
}

test("neighbouring words are ONE settled child, drawn with the separators the reader typed", async () => {
    await opened("big red dragon");
    await expect(settledSegments(page)).toHaveCount(1);
    const held = await settledSegments(page).first().textContent();
    expect(held).toBe("big red dragon");
});

test("a drag across text selects by the character, whitespace included, with no press first", async () => {
    await opened("model:fire big red dragon");
    const text = await childBox(11);
    await page.mouse.move(text.x + 2, text.y);
    await page.mouse.down();
    await page.mouse.move(text.x + 30, text.y, {steps: 6});
    await page.mouse.up();
    const selected = await barSelection(page).getAttribute("data-selection");
    // Whatever the drag covered, it is a stretch of the WORDS — never the whole run, and never the chip.
    expect(selected).not.toBeNull();
    expect("big red dragon").toContain(selected ?? "");
    expect(selected?.length).toBeGreaterThan(1);
});

test("inside a run the selection is the platform's own, character by character, whitespace included", async () => {
    await opened("big red");
    await barInput(page).focus();
    await page.keyboard.press("End");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("Shift+ArrowLeft");
    // Four presses from the end reach across the space: the words are one piece of text and it selects as one.
    expect(await slot(page)).toMatchObject({value: "big red", start: 3, end: 7});
    // The bar's own selection stays out of it — nothing here crosses a segment boundary.
    await expect(barSelection(page)).toHaveCount(0);
});

test("a selection leaving a run takes the chip beyond it whole, and the run's own characters stay exact", async () => {
    await opened("model:fire big");
    await barInput(page).focus();
    await page.keyboard.press("End");
    for (let presses = 0; presses < 3; presses++) await page.keyboard.press("Shift+ArrowLeft");
    expect(await slot(page)).toMatchObject({value: "big", start: 0, end: 3});
    // One more press has nothing left inside the run, so the bar takes over — and a chip goes whole.
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(barSelection(page)).toHaveAttribute("data-selection", "model:fire big");
});

test("a press inside text lands the caret on the character it aimed at", async () => {
    await opened("big red dragon");
    const text = await childBox(0);
    await page.mouse.click(text.x + 2, text.y);
    // The whole run opens as one slot, and the caret sits at its start rather than at the run's end.
    expect(await slot(page)).toMatchObject({value: "big red dragon", start: 0, focused: true});
});

test("a drag reaching into a chip takes the whole chip, because half of one cannot be shown or copied", async () => {
    await opened("model:fire big red");
    const text = await childBox(11);
    const chip = await childBox(0);
    await page.mouse.move(text.x + 40, text.y);
    await page.mouse.down();
    await page.mouse.move(chip.x + 4, text.y, {steps: 10});
    await page.mouse.up();
    const selected = await barSelection(page).getAttribute("data-selection");
    expect(selected?.startsWith("model:fire")).toBe(true);
});

test("the selection is ONE band: every piece stands the same height and they meet with nothing between", async () => {
    await opened("model:{fire -missile} big red sound:>2");
    await bar(page).focus();
    await page.keyboard.press("Control+a");
    const bands = await page.locator("[class*='selected']").evaluateAll((els) => els.map((el) => {
        const box = el.getBoundingClientRect();
        return {left: box.left, right: box.right, top: box.top, height: box.height};
    }));
    expect(bands.length).toBeGreaterThan(2);
    for (const [i, band] of bands.entries()) {
        // Within a pixel: the band is one stretch to the eye, whatever the sub-pixel rounding does.
        expect(Math.abs(band.height - bands[0].height)).toBeLessThanOrEqual(1);
        expect(Math.abs(band.top - bands[0].top)).toBeLessThanOrEqual(1);
        // Each band begins where the one before it ended: no hole, no overlap.
        if (i > 0) expect(Math.abs(band.left - bands[i - 1].right)).toBeLessThanOrEqual(1);
    }
});

test("typing over a selection replaces it, and one undo brings the whole selection back", async () => {
    await opened("model:fire big red");
    await bar(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x");
    await page.keyboard.press("Control+z");
    // The undo lands at the change with that chip open, which is its editing spelling; leaving settles it.
    await barInput(page).blur();
    await expectQuery(page, "model:fire big red");
});
