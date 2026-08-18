/**
 * @file The delimiter-pairing cells of the interaction matrix: a lone delimiter spawns its pair, a pair typed
 * over a selection encloses it, a closer steps over its own next character, the scope closer walks out of the
 * chip, Backspace inside an empty pair takes both halves, and one Ctrl+Z takes a pairing back whole.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {clearBar, expectQuery, openHarness, openKind, settledSegments, slot} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

test("a lone delimiter spawns its pair with the caret in the middle", async () => {
    for (const [opener, pair] of [["\"", "\"\""], ["{", "{}"], ["(", "()"]]) {
        await clearBar(page);
        await page.keyboard.type(opener, {delay: 5});
        await expectQuery(page, pair);
        expect(await slot(page)).toMatchObject({value: pair, start: 1, end: 1});
    }
});

test("typed over a selection the pair encloses it, the selection surviving inside", async () => {
    await clearBar(page);
    await page.keyboard.type("fire", {delay: 5});
    await page.keyboard.press("Shift+Home");
    await page.keyboard.type("{", {delay: 5});
    await expectQuery(page, "{fire}");
    expect(await slot(page)).toMatchObject({value: "{fire}", start: 1, end: 5});
});

test("a closer typed against its own next character steps over instead of doubling", async () => {
    await clearBar(page);
    await page.keyboard.type("(a", {delay: 5});
    await expectQuery(page, "(a)");
    expect(await slot(page)).toMatchObject({start: 2});
    await page.keyboard.type(")", {delay: 5});
    await expectQuery(page, "(a)");
    expect(await slot(page)).toMatchObject({start: 3});
});

test("the scope closer at a scoped slot's end steps over the chip's own closer, walking out", async () => {
    await clearBar(page);
    await page.keyboard.type("model:fire", {delay: 5});
    await expectQuery(page, "model:{fire}");
    await page.keyboard.type("}", {delay: 5});
    await expectQuery(page, "model:fire ");
    expect(await openKind(page)).toBe("tail");
});

test("Backspace inside an empty pair takes both halves", async () => {
    await clearBar(page);
    await page.keyboard.type("{", {delay: 5});
    await expectQuery(page, "{}");
    await page.keyboard.press("Backspace");
    await expectQuery(page, "");
    expect(await slot(page)).toMatchObject({value: "", start: 0});
});

test("one Ctrl+Z takes an enclosure back whole, the caret landing at the change", async () => {
    await clearBar(page);
    await page.keyboard.type("fire", {delay: 5});
    await page.keyboard.press("Shift+Home");
    await page.keyboard.type("{", {delay: 5});
    await expectQuery(page, "{fire}");

    await page.keyboard.press("Control+z");
    await expectQuery(page, "fire");
    expect(await slot(page)).toMatchObject({value: "fire", start: 4});
});

test("one Ctrl+Z takes a spawn back whole", async () => {
    await clearBar(page);
    await page.keyboard.type("fire", {delay: 5});
    await page.keyboard.type("{", {delay: 5});
    await expectQuery(page, "fire{}");
    expect(await slot(page)).toMatchObject({start: 5});

    await page.keyboard.press("Control+z");
    await expectQuery(page, "fire");
});

test("an unclosed phrase inside a chip does not breed braces, however the chip is committed", async () => {
    await clearBar(page);
    // The pair spawns inside the chip's own scope; deleting the closer leaves the phrase open over the brace.
    await page.keyboard.type('name:"', {delay: 5});
    await expectQuery(page, 'name:{""}');
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    await expectQuery(page, 'name:{"}');

    // Enter commits it: the phrase is closed rather than left to swallow the separator, no second brace is
    // written, and the fresh tail is a tail rather than more of the phrase.
    await page.keyboard.press("Enter");
    await expectQuery(page, 'name:"" ');
    expect(await openKind(page)).toBe("tail");

    // And it is stable: reopening and committing again writes nothing further.
    await settledSegments(page).first().click();
    await page.keyboard.press("Enter");
    await expectQuery(page, 'name:"" ');
});
