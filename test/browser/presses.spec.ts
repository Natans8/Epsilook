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

test("a press on the open chip's head flips exclusion without ending the session", async () => {
    await seed(page, "model:fire", "sound:bell");
    // The body opens the chip; the head is the exclusion toggle, in the open form exactly as on a settled one.
    await page.locator("[class*='chipBody']").first().click();
    await expectQuery(page, "model:{fire} sound:bell ");

    await page.locator("[data-open] [class*='headCell']").click();
    // Flipped, and NOT settled: the editing braces are still there and the field still holds the caret.
    await expectQuery(page, "-model:{fire} sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", focused: true});

    // And it flips back, so the head is a toggle rather than a one-way door.
    await page.locator("[data-open] [class*='headCell']").click();
    await expectQuery(page, "model:{fire} sound:bell ");
});

test("a minus at the value's start flips the segment, and a sign still reads as a sign", async () => {
    // The keyboard's path to the head's toggle. A press on the body lands the caret at the value's END, and
    // Home is query-wide by ruling, so the slot's own start is reached by walking one press per character.
    const toStart = async (chars: number): Promise<void> => {
        for (let i = 0; i < chars; i++) await page.keyboard.press("ArrowLeft");
    };

    await seed(page, "model:fire");
    await page.locator("[class*='chipBody']").first().click();
    await toStart(4);
    await page.keyboard.type("-");
    await expectQuery(page, "-model:{fire} ");

    // Before a DIGIT it stays a sign, or `scale:{-50%}` would stop agreeing with `scale:-50%`.
    await seed(page, "scale:50%");
    await page.locator("[class*='chipBody']").first().click();
    await toStart(3);
    await page.keyboard.type("-");
    await expect(page.locator("[data-query]")).toHaveAttribute("data-query", /-50/);
});
