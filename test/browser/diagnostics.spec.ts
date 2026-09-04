/**
 * @file The diagnostics strip: what the reader said about the query, one row each, under the bar.
 *
 * The rows are the parser's own diagnostics, so what is asserted here is the strip's contract with the page — a
 * row per finding, a fix that rewrites the query through the bar and takes its row with it, and a count line
 * that says no count was taken while an error stands — never the wording of any one diagnostic.
 */
import type {Locator, Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {barInput, expectQuery, HARNESS_URL} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
});

test.afterAll(async () => {
    await page.close();
});

/** The strip, by its accessible name rather than its markup. */
const strip = (): Locator => page.getByRole("list", {name: /reader said/i});

/** Loads the harness with a query in the URL, the one way to seed text the bar's own gestures would rewrite. */
async function openWith(query: string): Promise<void> {
    await page.goto(`${HARNESS_URL}?q=${encodeURIComponent(query)}`);
    await barInput(page).waitFor({state: "visible", timeout: 120_000});
}

test("a query the reader accepts draws no strip at all", async () => {
    await openWith("model:fire sound:bell");
    await expectQuery(page, "model:fire sound:bell");
    await expect(strip()).toHaveCount(0);
});

test("the chip view settles a spelling the chips cannot show on arrival, and the plain view keeps it", async () => {
    // Arriving in chips, the missing space is supplied and there is nothing left to warn about. Only the
    // warning's own fix applies on arrival; the braces wait for a commit, as any seeded editing form does.
    await openWith("model:{fire}sound:bell");
    await expectQuery(page, "model:{fire} sound:bell");
    await expect(strip()).toHaveCount(0);

    // Arriving in the plain view, the text is the reader's own: the brace is visible, so the warning stands.
    await page.goto(`${HARNESS_URL}?q=${encodeURIComponent("model:{fire}sound:bell")}&plain`);
    await barInput(page).or(page.locator("[class*='qbar'] textarea")).first().waitFor({state: "visible", timeout: 120_000});
    await expectQuery(page, "model:{fire}sound:bell");
    await expect(strip().getByRole("listitem")).toHaveCount(1);
});

test("a warning between two readings offers each as its own button, and the one taken rewrites the query", async () => {
    await openWith("model:{attach missile}");
    // Two readings, then removal, which every flawed clause offers last.
    const buttons = strip().getByRole("button");
    await expect(buttons).toHaveCount(3);
    await buttons.first().click();
    await expectQuery(page, "model:attach model:missile ");
    await expect(strip()).toHaveCount(0);
});

test("pointing at a row marks the clause it is about in the bar, and nothing else", async () => {
    await openWith("model:fire model:{attach missile}");
    const marked = page.locator("[class*='qbar'] > [class*='settled'][class*='aimed']");
    await expect(marked).toHaveCount(0);
    // From outside the strip: a pointer the last cell left resting inside the row's area would move within it
    // and never enter it.
    await page.mouse.move(0, 0);
    await strip().getByRole("listitem").first().hover();
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveAttribute("aria-label", "model:{attach missile}");
    await page.mouse.move(0, 0);
    await expect(marked).toHaveCount(0);
});

test("pointing at a marked clause in the bar lights the rows about it, and only those", async () => {
    await openWith("model:fire model:{attach missile} model:{-attach>2}");
    await page.mouse.move(0, 0);
    const lit = strip().locator("[class*='litRow']");
    await expect(strip().getByRole("listitem")).toHaveCount(2);
    await expect(lit).toHaveCount(0);

    await page.locator("[class*='qbar'] > [class*='settled']").nth(1).hover();
    await expect(lit).toHaveCount(1);
    await expect(lit).toContainText("two different kinds");

    await page.mouse.move(0, 0);
    await expect(lit).toHaveCount(0);
});

test("a preview that empties the bar keeps its height, so the offer stays under the pointer", async () => {
    await openWith("model:{attach missile}");
    await page.mouse.move(0, 0);
    const bar = page.locator("[class*='qbar']").first();
    const before = (await bar.boundingBox())?.height ?? 0;
    const remove = strip().getByRole("button", {name: "remove"});
    await remove.hover();
    await expect(page.locator("[class*='qbar'] > [class*='settled']")).toHaveCount(0);
    // Held, not shrunk, and still held a moment later: a bar that let go would lift the preview and loop.
    await page.waitForTimeout(300);
    expect((await bar.boundingBox())?.height ?? 0).toBe(before);
    await expect(page.locator("[class*='qbar'] > [class*='settled']")).toHaveCount(0);
    await expect(strip().getByRole("listitem")).toHaveCount(1);
});

test("hovering an offer draws the query it would write in the bar itself, and lifts it on leaving", async () => {
    await openWith("model:fire model:{attach missile}");
    await page.mouse.move(0, 0);
    const chips = page.locator("[class*='qbar'] > [class*='settled']");
    await expect(chips).toHaveCount(2);

    await strip().getByRole("button", {name: "one of each"}).hover();
    // The bar shows the rewrite: three chips, the two new ones marked as what changed. The text is untouched.
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(1)).toHaveAttribute("aria-label", "model:attach");
    await expect(chips.nth(2)).toHaveAttribute("aria-label", "model:missile");
    await expect(page.locator("[class*='qbar'] > [class*='settled'][class*='aimed']")).toHaveCount(2);
    await expectQuery(page, "model:fire model:{attach missile}");

    await page.mouse.move(0, 0);
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveAttribute("aria-label", "model:{attach missile}");
});

test("a warning's fix rewrites the query and takes its row with it, while an error keeps the count refused",
    async () => {
        // In the plain view, where a spelling warning stands rather than converging on arrival.
        await page.goto(`${HARNESS_URL}?q=${encodeURIComponent("model:{fire}sound:bell model:{-attach>2}")}&plain`);
        await page.locator("[class*='qbar'] textarea").waitFor({state: "visible", timeout: 120_000});
        await expect(strip().getByRole("listitem")).toHaveCount(2);
        await expect(page.getByText("not searched")).toBeVisible();

        await strip().getByRole("button", {name: "insert the space"}).click();
        await expectQuery(page, "model:{fire} sound:bell model:{-attach>2}");
        await expect(strip().getByRole("listitem")).toHaveCount(1);
        await expect(page.getByText("not searched")).toBeVisible();

        // The error's last offer takes the clause out whole, and the count is asked again.
        await strip().getByRole("button", {name: "remove"}).click();
        await expectQuery(page, "model:{fire} sound:bell");
        await expect(strip()).toHaveCount(0);
    });
