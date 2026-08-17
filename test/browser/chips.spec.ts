/**
 * @file The committed-chip cells of the interaction matrix: the rest state, the × and + affordances as
 * undoable rewrites, per-term surgery inside a lane, and the raw forms that never chipify.
 *
 * Assertions stay on semantics — the query mirror, the input's state, button roles — never on chip markup.
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

/** Loads the harness with a query in the URL, waiting out the pack load; the bar arrives at rest. */
async function openWith(query: string): Promise<void> {
    await page.goto(`${HARNESS_URL}?q=${encodeURIComponent(query)}`);
    await expect(queryMirror(page)).toHaveAttribute("data-query", query, {timeout: 120_000});
}

/** The delete affordances, chips' and lanes' alike, in bar order. */
function deletes(): ReturnType<Page["locator"]> {
    return page.getByRole("button", {name: "Delete"});
}

/** The grow affordances, in bar order. */
function adds(): ReturnType<Page["locator"]> {
    return page.getByRole("button", {name: "Add a condition"});
}

/**
 * Whether the bar is at rest — its input parked out of sight rather than drawn as the editing form. Read from
 * the open wrapper's class, the same way {@link openKind} reads the open position's kind.
 */
async function parked(): Promise<boolean> {
    return barInput(page).evaluate((el) => el.closest("[class*='hiddenOpen']") !== null);
}

test("a query arriving by URL rests committed: the input is parked out of sight, unfocused", async () => {
    await openWith("model:fire sound:bell");
    expect(await slot(page)).toMatchObject({focused: false});
    expect(await parked()).toBe(true);
});

test("x removes the chip with its separator; the caret rests where it stood; one Ctrl+Z restores it", async () => {
    await seed(page, "model:fire", "sound:bell");
    await deletes().first().click();
    await expectQuery(page, "sound:bell ");
    expect(await slot(page)).toMatchObject({value: "", focused: true});

    await page.keyboard.press("Control+z");
    await barInput(page).blur();
    await expectQuery(page, "model:fire sound:bell ");
});

test("+ grows a chip into the lane form with a fresh term slot; typing and Enter commit the lane", async () => {
    await seed(page, "model:fire");
    await adds().first().click();
    await expectQuery(page, "model:{fire } ");
    expect(await slot(page)).toMatchObject({value: "fire ", start: 5, end: 5, focused: true});

    await page.keyboard.type("frost", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{fire frost} ");
});

test("Escape abandons a grow whole, typed condition included", async () => {
    await seed(page, "model:fire");
    await adds().first().click();
    await page.keyboard.type("frost", {delay: 5});
    await page.keyboard.press("Escape");
    await expectQuery(page, "model:fire ");
});

test("+ on a property chip offers a value alternative; abandoning it trims the separator back out", async () => {
    await seed(page, "cast:instant");
    await adds().first().click();
    await expectQuery(page, "cast:instant| ");
    await page.keyboard.type("2s", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "cast:instant|2s ");

    await adds().first().click();
    await barInput(page).blur();
    await expectQuery(page, "cast:instant|2s ");
});

test("an inner bind's x removes just that term, and the lane collapses to the compact spelling", async () => {
    await openWith("model:{fire attach:chest}");
    // The lane's own x is first; the inner bind's is second. The caret rests in a fresh tail afterwards, as
    // after any commit, so the settled text carries its separator.
    await deletes().nth(1).click();
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("a term alone in its alternation run takes the stranded or-edge with it", async () => {
    await openWith("model:{attach:chest | fire}");
    await deletes().nth(1).click();
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("a commit keeps the braces where shedding them would change the ask", async () => {
    // The colon-glued spelling reads as content, so the braces may not be shed on the settle.
    await openWith("model:{attach:chest}");
    await page.locator("[class*='settled']").first().click();
    await barInput(page).blur();
    await expectQuery(page, "model:{attach:chest}");
});

test("an invalid clause stays raw text and reopens raw, never wrapped", async () => {
    await openWith('scale:"50"');
    await page.locator("[class*='settled']").first().click();
    await expectQuery(page, 'scale:"50"');
    expect(await slot(page)).toMatchObject({value: '"50"', focused: true});
    await barInput(page).blur();
    await expectQuery(page, 'scale:"50"');
});

test("focus returning to the resting bar brings the editing form back at the remembered place", async () => {
    await seed(page, "model:fire");
    await barInput(page).blur();
    expect(await parked()).toBe(true);
    await barInput(page).focus();
    expect(await parked()).toBe(false);
    expect(await slot(page)).toMatchObject({focused: true});
});

test("an inner x is right even when settling the same segment shifts every span inside it", async () => {
    // The URL text was never committed: settling it trims the scope's interior, so a span read from the render
    // points at the wrong characters. The term is named by index, so the removal lands where it was aimed.
    await openWith("model:{ attach:chest attach:head }");
    await deletes().nth(2).click();
    await barInput(page).blur();
    // The survivor keeps its braces: the colon-glued spelling would ask a different question.
    await expectQuery(page, "model:{attach:chest} ");
});

test("an alternation chip sheds its braces on commit and still grows a lane", async () => {
    await seed(page, "model:fire|frost");
    await expectQuery(page, "model:fire|frost ");
    await adds().first().click();
    await expectQuery(page, "model:{fire|frost } ");
    await page.keyboard.type("missile", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{fire|frost missile} ");
});

test("a comparison chip grows a lane too — its + is not a dead button", async () => {
    await seed(page, "model>=4");
    await adds().first().click();
    await expectQuery(page, "model:{>=4 } ");
    await page.keyboard.type("fire", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{>=4 fire} ");
});
