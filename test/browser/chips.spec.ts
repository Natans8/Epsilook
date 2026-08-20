/**
 * @file The committed-chip cells of the interaction matrix: the rest state, the × and + affordances as
 * undoable rewrites, per-term surgery inside a lane, and the raw forms that never chipify.
 *
 * Assertions stay on semantics — the query mirror, the input's state, button roles — never on chip markup.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {
    bar, barInput, clearBar, expectQuery, HARNESS_URL, openHarness, queryMirror, seed, settledSegments, slot,
} from "./helpers";

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

test("an inner bind's x removes just that term, and the lane collapses to the compact spelling", async () => {
    await openWith("model:{fire attach:chest}");
    // Each mark sits at the tail of the pill it removes, so an inner bind's comes before the lane's own. The
    // caret rests in a fresh tail afterwards, as after any commit, so the settled text carries its separator.
    await deletes().first().click();
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("a term alone in its alternation run takes the stranded or-edge with it", async () => {
    await openWith("model:{attach:chest | fire}");
    await deletes().first().click();
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("a commit keeps the braces where shedding them would change the ask", async () => {
    // The colon-glued spelling reads as content, so the braces may not be shed on the settle. The single
    // pair draws as the lane, whose head cell is the negate toggle — the VALUE is what opens it.
    await openWith("model:{attach:chest}");
    await page.locator("[class*='settled']").getByText("chest").click();
    await barInput(page).blur();
    await expectQuery(page, "model:{attach:chest}");
});

test("an invalid clause stays raw text and reopens raw, never wrapped", async () => {
    await openWith("scale:abc");
    await page.locator("[class*='settled']").first().click();
    await expectQuery(page, "scale:abc");
    expect(await slot(page)).toMatchObject({value: "abc", focused: true});
    await barInput(page).blur();
    await expectQuery(page, "scale:abc");
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
    // The SECOND inner bind's mark: the marks read left to right, each at the tail of its own pill.
    await deletes().nth(1).click();
    await barInput(page).blur();
    // The survivor keeps its braces: the colon-glued spelling would ask a different question.
    await expectQuery(page, "model:{attach:chest} ");
});

test("Ctrl+A selects every chip rather than flattening the bar to raw text", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Control+a");
    // The query is untouched and the chips are still chips: the selection is a selection, not a rewrite.
    await expectQuery(page, "model:fire sound:bell ");
    await expect(page.locator("[data-selection]")).toHaveAttribute("data-selection", "model:fire sound:bell");
});

test("Escape clears the selection, and Delete removes every selected chip as one undo step", async () => {
    await seed(page, "model:fire", "sound:bell");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-selection]")).toHaveCount(0);

    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await expectQuery(page, "");
    await page.keyboard.press("Control+z");
    await barInput(page).blur();
    await expectQuery(page, "model:fire sound:bell ");
});

test("Shift+arrow at the slot's edge takes whole segments, one per press", async () => {
    await seed(page, "model:fire", "sound:bell", "cast:2s");
    // The caret rests in the fresh tail, so the first press takes the segment behind it.
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(page.locator("[data-selection]")).toHaveAttribute("data-selection", "cast:2s");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(page.locator("[data-selection]")).toHaveAttribute("data-selection", "sound:bell cast:2s");
    // And back: the anchor stays put while the focus walks.
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.locator("[data-selection]")).toHaveAttribute("data-selection", "cast:2s");
});

test("a drag across the bar selects the chips it crosses, and the copy is their own query text", async () => {
    await seed(page, "model:fire", "sound:bell", "cast:2s");
    const first = await page.locator("[data-at]").nth(0).boundingBox();
    const box = await bar(page).boundingBox();
    if (first === null || box === null) throw new Error("the bar has no box");
    await page.mouse.move(first.x + 4, first.y + first.height / 2);
    await page.mouse.down();
    // To the bar's far edge: the anchor chip opens under the press, so every box right of it has moved.
    await page.mouse.move(box.x + box.width - 8, first.y + first.height / 2, {steps: 8});
    await page.mouse.up();
    await expect(page.locator("[data-selection]"))
        .toHaveAttribute("data-selection", "model:fire sound:bell cast:2s");

    // Ctrl+C hands the clipboard exactly that text — the query those chips spell. The clipboard itself is
    // stood in for: Firefox grants no read permission to a test, and what is asserted is what the bar handed
    // over, which is the behaviour in question.
    await page.evaluate(() => {
        const held = window as unknown as { copied?: string };
        held.copied = undefined;
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: (text: string) => {
                    held.copied = text;
                }
            },
        });
    });
    await page.keyboard.press("Control+c");
    const copied = await page.evaluate(() => (window as unknown as { copied?: string }).copied);
    expect(copied).toBe("model:fire sound:bell cast:2s");
});

test("the bar's affordances stay out of the tab order, and its input keeps its name", async () => {
    await seed(page, "model:fire", "sound:bell", "cast:2s");
    // Six chips carry a dozen buttons; none of them may stand between Tab and the query input.
    const stops = await page.evaluate(() => Array.from(document.querySelectorAll("button, input, select"))
        .filter((el) => (el as HTMLElement).tabIndex >= 0)
        .map((el) => el.getAttribute("aria-label") ?? el.tagName));
    expect(stops.filter((name) => name === "Delete")).toEqual([]);
    await expect(barInput(page)).toHaveAttribute("aria-label", /search spells/i);
});

test("each settled chip announces the query text it stands for; text announces nothing", async () => {
    await seed(page, "model:fire", "-model:missile", "dragon");
    const labels = await page.locator("[role='group']").evaluateAll(
        (els) => els.map((el) => el.getAttribute("aria-label")));
    // A chip draws its parse, so it says what it asks. Plain text reads as itself and needs no second name.
    expect(labels).toEqual(["model:fire", "-model:missile"]);
});

/** Opens the first chip and parks the caret at the end of its value, using only the keyboard's own moves. */
async function openAtValueEnd(): Promise<void> {
    // The body, not the head: the head is the exclusion toggle.
    await page.locator("[class*='chipBody']").first().click();
    // Ctrl+A takes the slot's contents; the arrow collapses that selection to its right edge.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("ArrowRight");
}

test("growth has a keyboard path: the + is a shortcut for what typing already does", async () => {
    await seed(page, "model:fire");
    await openAtValueEnd();
    // A space and a term inside the chip is exactly the state the + reaches.
    await page.keyboard.type(" frost", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{fire frost} ");
});

test("the other growth is a keystroke too: an alternative value is typed, not clicked", async () => {
    await seed(page, "model:fire");
    await openAtValueEnd();
    await page.keyboard.type("|frost", {delay: 5});
    await page.keyboard.press("Enter");
    // A row matching either value, which is a different question from the lane's two conditions.
    await expectQuery(page, "model:fire|frost ");
});

test("the head is the exclusion toggle, as it was in 1.0 — and it flips back", async () => {
    await seed(page, "model:fire");
    await page.locator("[class*='chipSect']").first().click();
    await barInput(page).blur();
    await expectQuery(page, "-model:fire ");

    await page.locator("[class*='chipSect']").first().click();
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("an inner bind's head flips that term alone, leaving the lane's others as they are", async () => {
    await openWith("model:{fire attach:chest}");
    // The lane's own head is first; the inner bind's is second.
    await page.locator("[class*='bindSect']").first().click();
    await barInput(page).blur();
    // The caret rests in a fresh tail afterwards, as it does after any commit.
    await expectQuery(page, "model:{fire -attach:chest} ");
});

test("a flip is one undo step", async () => {
    await seed(page, "model:fire");
    await page.locator("[class*='chipSect']").first().click();
    await expectQuery(page, "-model:fire ");
    await page.keyboard.press("Control+z");
    await barInput(page).blur();
    await expectQuery(page, "model:fire ");
});

test("two conditions of one row are joined, so a lane stops reading as a phrase", async () => {
    await seed(page, "model:{fire missile}");
    // Juxtaposition IS the conjunction, so the query writes a space and nothing else; the lane draws what the
    // space means, as a RULE rather than a character — nothing on screen may be mistaken for something typed.
    const joints = settledSegments(page).first().locator("[class*='joint']");
    await expect(joints).toHaveCount(1);
    expect((await settledSegments(page).first().innerText()).includes("·")).toBe(false);
    // It joins CONDITIONS. An alternation of values is one condition however many values it offers, so the
    // chip that draws it has nothing to join.
    await seed(page, "model:fire|frost");
    await expect(settledSegments(page).first().locator("[class*='joint']")).toHaveCount(0);
});

test("a query the parser refuses says what is wrong instead of counting", async () => {
    // An invalid clause is dropped from the evaluable groups, so `xpac:zzz` constrained nothing and reported the
    // whole pack — a wrong answer wearing the authority of a number. The clause is squiggled either way; the
    // status line now carries the reason in its place.
    await clearBar(page);
    await page.keyboard.type("xpac:zzz", {delay: 5});
    await page.keyboard.press("Enter");
    const status = page.locator("[role=status]");
    await expect(status).toContainText("xpac takes one of");
    await expect(status).not.toContainText("spells");

    // A query that parses answers as it always did.
    await clearBar(page);
    await page.keyboard.type("xpac:legion", {delay: 5});
    await page.keyboard.press("Enter");
    await expect(status).toContainText("spells");
});
