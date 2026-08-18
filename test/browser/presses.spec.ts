/**
 * @file The press cells of the interaction matrix: ground presses aimed line-aware at gaps and ends, a press
 * on a settled segment landing the caret on the aimed character, and the open chip's head keeping the session.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {bar, charPoint, expectQuery, openHarness, openKind, seed, settledSegments, slot} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

test("a ground press left of all content lands the front gap", async () => {
    await seed(page, "model:fire", "sound:bell");
    const box = await bar(page).boundingBox();
    if (box === null) throw new Error("the bar has no box");
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    expect(await openKind(page)).toBe("gap");

    // The gap is the front one: typing lands ahead of everything.
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x model:fire sound:bell ");
});

test("a ground press between two chips lands the gap left of the aimed child", async () => {
    await seed(page, "model:fire", "sound:bell");
    const first = await settledSegments(page).nth(0).boundingBox();
    const second = await settledSegments(page).nth(1).boundingBox();
    if (first === null || second === null) throw new Error("a settled segment has no box");
    await page.mouse.click((first.x + first.width + second.x) / 2, first.y + first.height / 2);
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "model:fire x sound:bell ");
});

test("a ground press past all content lands the content's end", async () => {
    await seed(page, "model:fire", "sound:bell");
    const box = await bar(page).boundingBox();
    if (box === null) throw new Error("the bar has no box");
    // The strip below the line is ground right of everything on it.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
    expect(await openKind(page)).toBe("tail");
    expect(await slot(page)).toMatchObject({focused: true});
});

test("a press on a CHIP opens it at the end of its value, wherever on the chip it landed", async () => {
    await seed(page, "model:fire", "sound:bell");
    // Aimed at the value's second character; a chip draws its parse rather than its text, and the reader
    // pressing one is continuing the ask rather than mending its middle.
    const aimed = await charPoint(settledSegments(page).nth(1), "bell", 1);
    await page.mouse.click(aimed.x, aimed.y);
    await expectQuery(page, "model:fire sound:{bell} ");
    expect(await slot(page)).toMatchObject({value: "bell", start: 4, end: 4});
});

test("a press on a settled segment's head flips its exclusion, as the field label did in 1.0", async () => {
    await seed(page, "model:fire", "sound:bell");
    const aimed = await charPoint(settledSegments(page).nth(1), "sound", 2);
    await page.mouse.click(aimed.x, aimed.y);
    await expectQuery(page, "model:fire -sound:bell ");
});

test("a press on the open chip's head keeps the session, caret at the value's start", async () => {
    await seed(page, "model:fire", "sound:bell");
    // The body opens the chip; the head is the toggle.
    await page.locator("[class*='chipBody']").first().click();
    await expectQuery(page, "model:{fire} sound:bell ");

    await page.locator("[data-open] [class*='headCell']").click();
    // No settle: the braces are still there, the input still focused, the caret at the value's start.
    await expectQuery(page, "model:{fire} sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", start: 0, end: 0, focused: true});
});
