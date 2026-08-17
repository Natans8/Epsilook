/**
 * @file The key cells of the interaction matrix: Home and End as the bar's own ends, the Ctrl+A escalation —
 * a chip's slot natively first, the whole query flat from a full selection — and the empty bar's inert keys.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {clearBar, expectQuery, openHarness, openKind, seed, settledSegments, slot} from "./helpers";

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
    await settledSegments(page).nth(1).click();
    await expectQuery(page, "model:fire sound:{bell} ");

    await page.keyboard.press("Home");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.press("End");
    expect(await openKind(page)).toBe("tail");
    expect(await slot(page)).toMatchObject({value: ""});
});

test("Ctrl+A in a chip natively selects the slot first, then escalates to the flat query", async () => {
    await seed(page, "model:fire", "sound:bell");
    await settledSegments(page).nth(1).click();
    await expectQuery(page, "model:fire sound:{bell} ");

    // The first press is the platform's own select-all, scoped to the slot — the chip stays a chip.
    await page.keyboard.press("Control+a");
    await expectQuery(page, "model:fire sound:{bell} ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0, end: 4});

    // From a full selection it escalates: the whole query, flat and selected, in committed spelling.
    await page.keyboard.press("Control+a");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await slot(page)).toMatchObject({
        value: "model:fire sound:bell ", start: 0, end: "model:fire sound:bell ".length,
    });
});

test("Ctrl+A from the tail goes flat in one press — text has no interior to claim", async () => {
    await seed(page, "model:fire");
    expect(await openKind(page)).toBe("tail");
    await page.keyboard.press("Control+a");
    expect(await slot(page)).toMatchObject({
        value: "model:fire ", start: 0, end: "model:fire ".length,
    });
});

test("typing over the flat selection replaces the whole query and exits flat", async () => {
    await seed(page, "model:fire");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x");
    expect(await slot(page)).toMatchObject({value: "x", start: 1});
});

test("arrows exit flat mode to the bar's ends", async () => {
    await seed(page, "model:fire");
    await page.keyboard.press("Control+a");

    // The first press collapses the selection natively; the second, at the start, exits to the front gap.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire ");
    expect(await openKind(page)).toBe("gap");

    // A gap's Ctrl+A goes flat in one press too; rightward the flat exits to the tail.
    await page.keyboard.press("Control+a");
    expect(await slot(page)).toMatchObject({value: "model:fire "});
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await openKind(page)).toBe("tail");
    expect(await slot(page)).toMatchObject({value: ""});
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
