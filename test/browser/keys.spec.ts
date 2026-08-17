/**
 * @file The key cells of the interaction matrix: Home and End as the bar's own ends, the Ctrl+A escalation —
 * a chip's slot natively first, then every chip in the bar's own selection — and the empty bar's inert keys.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {
    barInput, barSelection, clearBar, expectQuery, openHarness, openKind, seed, settledSegments, slot,
} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

test("Home commits and lands the front gap; End the last content's end", async () => {
    await seed(page, "model:fire", "sound:bell");
    await settledSegments(page).nth(1).locator("[class*='chipBody']").click();
    await expectQuery(page, "model:fire sound:{bell} ");

    await page.keyboard.press("Home");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.press("End");
    expect(await openKind(page)).toBe("tail");
    expect(await slot(page)).toMatchObject({value: ""});
});

test("Ctrl+A in a chip natively selects the slot first, then escalates to every chip", async () => {
    await seed(page, "model:fire", "sound:bell");
    await settledSegments(page).nth(1).locator("[class*='chipBody']").click();
    await expectQuery(page, "model:fire sound:{bell} ");

    // The first press is the platform's own select-all, scoped to the slot — the chip stays a chip.
    await page.keyboard.press("Control+a");
    await expectQuery(page, "model:fire sound:{bell} ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0, end: 4});

    // From a full selection it escalates to the bar's own selection: the chips stay chips, in committed
    // spelling, and what is selected is the query they spell.
    await page.keyboard.press("Control+a");
    await expectQuery(page, "model:fire sound:bell ");
    await expect(barSelection(page)).toHaveAttribute("data-selection", "model:fire sound:bell");
});

test("Ctrl+A from the tail selects every chip in one press — text has no interior to claim", async () => {
    await seed(page, "model:fire");
    expect(await openKind(page)).toBe("tail");
    await page.keyboard.press("Control+a");
    await expect(barSelection(page)).toHaveAttribute("data-selection", "model:fire");
});

test("typing over the selection replaces every selected chip, as one undo step", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x");
    expect(await slot(page)).toMatchObject({value: "x", start: 1});

    await page.keyboard.press("Control+z");
    await barInput(page).blur();
    await expectQuery(page, "model:fire sound:bell ");
});

test("a plain arrow collapses the selection to the side it points at", async () => {
    await seed(page, "model:fire", "sound:bell");

    await page.keyboard.press("Control+a");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("[data-selection]")).toHaveCount(0);
    expect(await openKind(page)).toBe("gap");
    // The gap is the front one: what is typed lands ahead of everything.
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x model:fire sound:bell ");

    await page.keyboard.press("Control+a");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-selection]")).toHaveCount(0);
    expect(await openKind(page)).toBe("tail");
});

test("the empty bar is inert: Ctrl+A, Enter, Home, End, arrows do nothing; a character starts text", async () => {
    await clearBar(page);
    for (const key of ["Control+a", "Enter", "Home", "End", "ArrowLeft", "ArrowRight"]) {
        await page.keyboard.press(key);
        await expectQuery(page, "");
        expect(await openKind(page)).toBe("tail");
    }
    await page.keyboard.type("f", {delay: 5});
    await expectQuery(page, "f");

    // A space in the empty bar types a space.
    await clearBar(page);
    await page.keyboard.press(" ");
    await expectQuery(page, " ");
});
