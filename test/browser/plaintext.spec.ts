/**
 * @file The plaintext view: the query exactly as it is, chosen by the reader rather than fallen into.
 *
 * What it must NOT do is as much of the contract as what it shows — no chips, no editing rewrites, no bind
 * gesture spawning braces — so most of these assert that the text came back unchanged.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {barInput, expectQuery, HARNESS_URL, openHarness, queryMirror, seed, slot} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

/** The view toggle beside the bar. */
const toggle = (): ReturnType<Page["locator"]> => page.getByRole("button", {name: /plain text/i});

test("the toggle switches the whole query into one plain text field, and back to chips", async () => {
    await seed(page, "model:fire", "sound:bell");
    await expect(page.locator("[data-start]")).toHaveCount(2);

    await toggle().click();
    // One field holding the query verbatim; no settled segments at all.
    expect(await slot(page)).toMatchObject({value: "model:fire sound:bell "});
    await expect(page.locator("[data-start]")).toHaveCount(0);

    await toggle().click();
    await expect(page.locator("[data-start]")).toHaveCount(2);
    await expectQuery(page, "model:fire sound:bell ");
});

test("the view survives a reload, because it is carried in the URL", async () => {
    await page.goto(`${HARNESS_URL}?q=model%3Afire&plain=1`);
    await expect(queryMirror(page)).toHaveAttribute("data-query", "model:fire", {timeout: 120_000});
    await expect(page.locator("[data-start]")).toHaveCount(0);
    expect(await slot(page)).toMatchObject({value: "model:fire"});
});

test("nothing is corrected in the plain view: a bind spawns no braces and a space commits nothing", async () => {
    await page.goto(`${HARNESS_URL}?plain=1`);
    await expect(queryMirror(page)).toHaveAttribute("data-query", "", {timeout: 120_000});
    await barInput(page).click();
    await page.keyboard.type("model:", {delay: 5});
    // In the chip view this is the moment `model:{}` appears. Here the text is what was typed.
    await expectQuery(page, "model:");
    await page.keyboard.type("fire frost", {delay: 5});
    await expectQuery(page, "model:fire frost");
    expect(await slot(page)).toMatchObject({value: "model:fire frost"});
});

test("leaving the plain view keeps the text exactly as it was typed", async () => {
    await page.goto(`${HARNESS_URL}?q=model%3A%7Bfire%7D&plain=1`);
    await expect(queryMirror(page)).toHaveAttribute("data-query", "model:{fire}", {timeout: 120_000});
    await toggle().click();
    // Back in the chip view the braces are still there until something commits them — the view changed, not
    // the query.
    await expectQuery(page, "model:{fire}");
});
