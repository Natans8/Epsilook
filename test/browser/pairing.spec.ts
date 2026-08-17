/**
 * @file The delimiter-pairing cells of the interaction matrix: a lone delimiter spawns its pair, a pair typed
 * over a selection encloses it, a closer steps over its own next character, the scope closer walks out of the
 * chip, Backspace inside an empty pair takes both halves, and one Ctrl+Z takes a pairing back whole.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {clearBar, expectQuery, openHarness, openKind, slot} from "./helpers";

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
