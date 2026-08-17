/**
 * @file The traversal cells of the interaction matrix: arrows walking chip — gap — chip — gap — tail, the
 * front gap, and the empty chip evaporating on leave.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {expectQuery, openHarness, openKind, seed, slot} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

test("ArrowLeft walks tail into chip, gap, chip, front gap — committing what it leaves", async () => {
    await seed(page, "model:fire", "sound:bell");
    expect(await openKind(page)).toBe("tail");

    // Out of the empty tail: straight into the last chip's end — no phantom gap at the same spot.
    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire sound:{bell} ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "bell", start: 4, end: 4});

    // Through the slot natively, then out at its start: the gap before the chip, which settles it.
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowLeft");
    expect(await slot(page)).toMatchObject({start: 0});
    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");

    // From the gap: the previous chip's end.
    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:{fire} sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4, end: 4});

    // Out at the first chip's start: the front gap exists, and left of it there is nowhere to go.
    for (let presses = 0; presses < 5; presses++) await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");
    await page.keyboard.press("ArrowLeft");
    expect(await openKind(page)).toBe("gap");

    // The gap is the FRONT one: entering rightward opens the first segment at its start.
    await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:{fire} sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", start: 0, end: 0});
});

test("ArrowRight walks front gap to chip, gap, chip, then the one filling tail", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Home");
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.press("ArrowRight");
    expect(await slot(page)).toMatchObject({value: "fire", start: 0, end: 0});
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowRight");

    // Out at the chip's end: the gap after it.
    await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.press("ArrowRight");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0, end: 0});
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowRight");

    // From the last chip: one stop, the filling tail — never a gap and an empty segment both.
    await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("tail");

    // At the tail's end there is nowhere further.
    await page.keyboard.press("ArrowRight");
    expect(await openKind(page)).toBe("tail");
});

test("an empty chip at the end evaporates on ArrowLeft, landing at the text's end", async () => {
    await seed(page, "model:fire");
    await page.keyboard.type("sound:", {delay: 5});
    await expectQuery(page, "model:fire sound:{}");
    expect(await openKind(page)).toBe("chip");

    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:{fire}");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4, end: 4});
});

test("an empty chip at the end evaporates on ArrowRight, landing in the tail", async () => {
    await seed(page, "model:fire");
    await page.keyboard.type("sound:", {delay: 5});
    await expectQuery(page, "model:fire sound:{}");

    await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:fire ");
    expect(await openKind(page)).toBe("tail");
});

test("a mid-bar empty chip evaporates to the gap where it stood", async () => {
    await seed(page, "model:fire", "sound:bell");

    // Into the gap between the chips, then grow a chip there and empty it never — just bind it.
    await page.keyboard.press("ArrowLeft");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await openKind(page)).toBe("gap");
    await page.keyboard.type("anim:", {delay: 5});
    await expectQuery(page, "model:fire anim:{} sound:bell ");
    expect(await openKind(page)).toBe("chip");

    await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");

    // The gap is the one between the chips: entering rightward opens the following chip.
    await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:fire sound:{bell} ");
});
