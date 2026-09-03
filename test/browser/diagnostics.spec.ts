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

test("a warning's fix rewrites the query and takes its row with it, while an error keeps the count refused",
    async () => {
        await openWith("model:{fire}sound:bell model:{-attach>2}");
        await expect(strip().getByRole("listitem")).toHaveCount(2);
        await expect(page.getByText("not searched")).toBeVisible();

        await strip().getByRole("button").click();
        await expectQuery(page, "model:{fire} sound:bell model:{-attach>2} ");
        await expect(strip().getByRole("listitem")).toHaveCount(1);
        await expect(strip().getByRole("button")).toHaveCount(0);
        await expect(page.getByText("not searched")).toBeVisible();
    });
