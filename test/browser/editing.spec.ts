/**
 * @file The editing cells of the interaction matrix: the scope editing form, boundary Backspace and Delete,
 * Escape restoring in place, the commit fixpoint, Enter, blur settle, and typing into a gap.
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

test("the bind spawns the scope form and spaces compose inside it", async () => {
    await clearBar(page);
    await page.keyboard.type("model:", {delay: 5});
    await expectQuery(page, "model:{}");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "", start: 0, end: 0});

    await page.keyboard.type("fire frost", {delay: 5});
    await expectQuery(page, "model:{fire frost}");
    expect(await slot(page)).toMatchObject({value: "fire frost"});

    // A multi-term interior keeps its braces on commit; the caret gets a fresh tail.
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{fire frost} ");
    expect(await openKind(page)).toBe("tail");
});

test("a single-term scope sheds its braces on commit", async () => {
    await clearBar(page);
    await page.keyboard.type("model:fire", {delay: 5});
    await expectQuery(page, "model:{fire}");
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:fire ");
});

test("commit simplifies to its fixpoint — nested braces shed in one settle", async () => {
    await clearBar(page);
    await page.keyboard.type("model:", {delay: 5});
    await page.keyboard.type("{", {delay: 5});
    await expectQuery(page, "model:{{}}");
    await page.keyboard.type("fire", {delay: 5});
    await expectQuery(page, "model:{{fire}}");
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:fire ");
});

test("boundary Backspace peels the braces, then the bind, then merges the words", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("ArrowLeft");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowLeft");
    await expectQuery(page, "model:fire sound:{bell} ");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0});

    // The brace pair goes first — structure before content.
    await page.keyboard.press("Backspace");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0});

    // Then the bind: the head dissolves back into one editable word — which, standing last with only the
    // trailing separator beyond it, is the true tail and fills.
    await page.keyboard.press("Backspace");
    await expectQuery(page, "model:fire soundbell ");
    expect(await openKind(page)).toBe("tail");
    expect(await slot(page)).toMatchObject({value: "soundbell", start: 5});

    // Then the word natively, and at its start the segments merge across the separator.
    for (let presses = 0; presses < 5; presses++) await page.keyboard.press("Backspace");
    await expectQuery(page, "model:fire bell ");
    expect(await slot(page)).toMatchObject({value: "bell", start: 0});
    await page.keyboard.press("Backspace");
    await expectQuery(page, "model:firebell ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "firebell", start: 4});
});

test("Backspace in a gap deletes the separator and the neighbours merge", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("ArrowLeft");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await openKind(page)).toBe("gap");

    await page.keyboard.press("Backspace");
    await expectQuery(page, "model:firesound:bell ");
    expect(await slot(page)).toMatchObject({value: "firesound:bell", start: 4});
});

test("Backspace from the tail merges into the last chip without rewrapping it", async () => {
    await seed(page, "model:fire");
    expect(await openKind(page)).toBe("tail");
    await page.keyboard.press("Backspace");
    // A text edit, not a reopen: the chip does not grow its editing braces.
    await expectQuery(page, "model:fire");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4});
});

test("Delete at the slot's end dissolves the scope, then merges the next segment in", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowRight");
    await expectQuery(page, "model:{fire} sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4});

    await page.keyboard.press("Delete");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4});

    await page.keyboard.press("Delete");
    await expectQuery(page, "model:firesound:bell ");
    expect(await slot(page)).toMatchObject({value: "firesound:bell", start: 4});
});

test("Escape restores the segment's opening state, the caret staying with it", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    for (let presses = 0; presses < 4; presses++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("xxx", {delay: 5});
    await expectQuery(page, "model:{firexxx} sound:bell ");

    await page.keyboard.press("Escape");
    await expectQuery(page, "model:{fire} sound:bell ");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4, end: 4, focused: true});
});

test("Enter in a gap moves to a fresh tail; Enter on the tail is a no-op", async () => {
    await seed(page, "model:fire");
    await page.keyboard.press("Home");
    expect(await openKind(page)).toBe("gap");
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:fire ");
    expect(await openKind(page)).toBe("tail");

    await page.keyboard.press("Enter");
    await expectQuery(page, "model:fire ");
    expect(await openKind(page)).toBe("tail");
});

test("blur settles the committed spelling, and steals no focus back", async () => {
    await seed(page, "model:fire", "sound:bell");
    await settledSegments(page).first().click();
    await expectQuery(page, "model:{fire} sound:bell ");

    await page.locator("h1").click();
    await expectQuery(page, "model:fire sound:bell ");
    expect(await slot(page)).toMatchObject({focused: false});
});

test("a bare separator typed into a gap is swallowed", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Home");
    expect(await openKind(page)).toBe("gap");
    await page.keyboard.press(" ");
    await expectQuery(page, "model:fire sound:bell ");
    expect(await openKind(page)).toBe("gap");
    expect(await slot(page)).toMatchObject({value: ""});
});

test("typing into a gap writes the value and its separator, becoming a segment", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Home");
    await page.keyboard.type("x", {delay: 5});
    await expectQuery(page, "x model:fire sound:bell ");
    expect(await openKind(page)).toBe("bare");
    expect(await slot(page)).toMatchObject({value: "x", start: 1});
});
