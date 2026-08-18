/**
 * @file The pattern's colouring, driven by real typing.
 *
 * What is asserted is which part of a pattern got marked as what, and that between the slashes the query's own
 * colour language stops: the class a span carries is the semantics here, exactly as the query text is elsewhere.
 * Which part is which is the library's answer and is pinned by unit tests; these cells are the wiring.
 */
import type {Locator, Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {barInput, clearBar, openHarness, plainField, plainSwitch, seed} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

/** Every marked part of every pattern in the bar, as the characters it covers and the mark it wears. */
async function marked(where: Locator): Promise<[string, string][]> {
    return where.locator("span[class*='rx']").evaluateAll((spans) => spans.map((span) => [
        span.textContent ?? "",
        (/rx[A-Za-z]+/u.exec(span.className) ?? [""])[0],
    ] as [string, string]));
}

/** The bar, whichever view it is in. */
const bar = (at: Page): Locator => at.locator("[class*='qbar']");

test("a settled pattern is coloured by regex's own grammar", async () => {
    await seed(page, String.raw`name:/^fire[a-z]\d/`);
    expect(await marked(bar(page))).toEqual([
        ["^", "rxMeta"], ["[", "rxMeta"], ["a", "rxClass"], ["-", "rxMeta"], ["z", "rxClass"],
        ["]", "rxMeta"], [String.raw`\d`, "rxMeta"],
    ]);
});

test("the exclusion red stops at the slashes — a pattern keeps its own colours", async () => {
    await seed(page, "-name:/^fire/");
    await expect(page.locator("[class*='negHead']").first()).toBeVisible();
    // The head is red and the pattern is not: two colour languages, and the inner one wins inside it.
    expect(await marked(bar(page))).toEqual([["^", "rxMeta"]]);
    await expect(page.locator("span[class*='rx']").first()).not.toHaveClass(/runNeg|negHead/u);
});

test("what the pattern language refuses is marked where it breaks, carrying its reason", async () => {
    await clearBar(page);
    await barInput(page).focus();
    await page.keyboard.type("name:/fire(ball/", {delay: 5});
    const broken = page.locator("span[class*='rxError']").first();
    await expect(broken).toHaveText("(");
    await expect(broken).toHaveAttribute("title", /unclosed/iu);
});

test("the plaintext view colours a pattern the same way", async () => {
    await seed(page, "name:/^fire[a-z]/");
    await plainSwitch(page).click();
    await expect(plainField(page)).toBeVisible();
    expect(await marked(bar(page))).toEqual([
        ["^", "rxMeta"], ["[", "rxMeta"], ["a", "rxClass"], ["-", "rxMeta"], ["z", "rxClass"], ["]", "rxMeta"],
    ]);
    await plainSwitch(page).click();
});

test("a slash outside a value position stays an ordinary character, and is not coloured", async () => {
    await seed(page, "spells/fire");
    expect(await marked(bar(page))).toEqual([]);
});
