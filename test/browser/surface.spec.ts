/**
 * @file The control surface's cells of the interaction matrix, driven by real keyboard and mouse.
 *
 * What is asserted is semantics: the query text the mirror carries, the slot's value and caret, the combobox
 * attributes the field publishes, and the words the offers spell. Never the panel's markup — the controls that
 * will live in this surface change its structure, and none of them changes what a picked offer writes.
 */
import type {Page} from "@playwright/test";
import {expect, test} from "@playwright/test";
import {
    barInput, clearBar, expectQuery, ghostText, litOffer, offerRows, openHarness, openKind, plainField,
    plainSwitch, seed, settledSegments, slot, surface,
} from "./helpers";

let page: Page;

test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await openHarness(page);
});

test.afterAll(async () => {
    await page.close();
});

/** The words the offers spell, in draw order — the first cell of each row. */
async function offered(): Promise<string[]> {
    return offerRows(page).evaluateAll((rows) =>
        rows.map((row) => row.firstElementChild?.textContent?.trim() ?? ""));
}

test("an empty bar offers every axis, and the field says a list is open", async () => {
    await clearBar(page);
    await expect(surface(page)).toBeVisible();
    const words = await offered();
    expect(words).toContain("model");
    expect(words).toContain("xpac");
    await expect(barInput(page)).toHaveAttribute("aria-expanded", "true");
    await expect(barInput(page)).toHaveRole("combobox");
});

test("a top-level word offers the doors it could open, from its first character", async () => {
    await clearBar(page);
    await page.keyboard.type("m", {delay: 5});
    await expect(surface(page)).toBeVisible();
    expect(await offered()).toContain("model");
    await page.keyboard.type("o", {delay: 5});
    expect((await offered())[0]).toBe("model");
});

test("the ghost draws the rest of the one candidate, and Tab takes it", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    await expect(ghostText(page)).toHaveText("del:");
    await page.keyboard.press("Tab");
    // Taking a door is typing its colon, so the scope gesture fires and the chip opens ready for its value.
    await expectQuery(page, "model:{}");
    expect(await openKind(page)).toBe("chip");
    expect(await slot(page)).toMatchObject({value: "", focused: true});
});

test("the right arrow takes the ghost too, since the caret has nothing left to walk past", async () => {
    await clearBar(page);
    await page.keyboard.type("cas", {delay: 5});
    await expect(ghostText(page)).toHaveText("t:");
    await page.keyboard.press("ArrowRight");
    // A property door takes a value rather than a scope, so no braces are spawned behind it.
    await expectQuery(page, "cast:");
    expect(await slot(page)).toMatchObject({value: "", focused: true});
});

test("one undo takes a picked offer back whole", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    await page.keyboard.press("Tab");
    await expectQuery(page, "model:{}");
    await page.keyboard.press("Control+z");
    await expectQuery(page, "mo");
});

test("the arrows steer the list, wrapping at either end, and the field points at what is lit", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    const words = await offered();

    await page.keyboard.press("ArrowDown");
    await expect(litOffer(page)).toHaveCount(1);
    expect((await litOffer(page).textContent())?.trim().startsWith(words[0])).toBe(true);
    const active = await barInput(page).getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    await expect(litOffer(page)).toHaveAttribute("id", active ?? "");

    // Down from the last wraps to the first; up from the first wraps to the last.
    for (let i = 1; i < words.length; i++) await page.keyboard.press("ArrowDown");
    expect((await litOffer(page).textContent())?.trim().startsWith(words[words.length - 1])).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect((await litOffer(page).textContent())?.trim().startsWith(words[0])).toBe(true);
    await page.keyboard.press("ArrowUp");
    expect((await litOffer(page).textContent())?.trim().startsWith(words[words.length - 1])).toBe(true);
});

test("Enter takes what is lit; with nothing lit it commits the query as it stands", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expectQuery(page, "morph:{}");

    await clearBar(page);
    await page.keyboard.type("fireball", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "fireball ");
});

test("Escape puts the surface away first, and only then cancels the segment", async () => {
    await seed(page, "model:fire");
    await page.keyboard.type("sca", {delay: 5});
    await expect(surface(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(surface(page)).toBeHidden();
    await expectQuery(page, "model:fire sca");

    await page.keyboard.press("Escape");
    await expectQuery(page, "model:fire ");
});

test("a press on an offer applies it and never takes the focus off the slot", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    await offerRows(page).first().click();
    await expectQuery(page, "model:{}");
    expect(await slot(page)).toMatchObject({focused: true});
});

test("inside a column's scope the surface offers its kinds and properties", async () => {
    await clearBar(page);
    await page.keyboard.type("model:", {delay: 5});
    await expectQuery(page, "model:{}");
    const words = await offered();
    expect(words).toContain("missile");
    expect(words).toContain("count");

    // A kind's word takes a value exactly as a property's does, so it goes in with its bind.
    await page.keyboard.type("miss", {delay: 5});
    await page.keyboard.press("Tab");
    await expectQuery(page, "model:{missile:}");
    await page.keyboard.type("fire", {delay: 5});
    await page.keyboard.press("Enter");
    await expectQuery(page, "model:{missile:fire} ");
});

test("a property goes in with its bind, and its value is what is offered next", async () => {
    await clearBar(page);
    await page.keyboard.type("cast:", {delay: 5});
    // A property door takes a value rather than a scope, so the slot stays braceless.
    await expectQuery(page, "cast:");
    expect(await offered()).toEqual(["instant", "any"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expectQuery(page, "cast:instant");
});

test("a minus before the word draws the exclusion the offer would write", async () => {
    await clearBar(page);
    await page.keyboard.type("-mo", {delay: 5});
    await expect(offerRows(page).first()).toContainText("−model");
    await offerRows(page).first().click();
    await expectQuery(page, "-model:{}");
});

test("the surface closes when the bar loses the focus, and comes back with it", async () => {
    await clearBar(page);
    await page.keyboard.type("mo", {delay: 5});
    await expect(surface(page)).toBeVisible();
    await page.locator("h1").click();
    await expect(surface(page)).toBeHidden();
    await barInput(page).focus();
    await expect(surface(page)).toBeVisible();
});

test("what the bar has run is offered back on an empty bar", async () => {
    await page.evaluate(() => {
        localStorage.removeItem("epsilook.search2.history");
    });
    await page.reload();
    await barInput(page).waitFor({state: "visible", timeout: 120_000});
    await clearBar(page);
    // Nothing remembered yet: the menu opens on the axes alone.
    expect(await offered()).not.toContain("model:fire");

    await page.keyboard.type("model:fire", {delay: 5});
    await page.keyboard.press("Enter");
    await clearBar(page);
    expect((await offered())[0]).toBe("model:fire");

    // Picking one puts it back in the bar whole, ready to edit.
    await offerRows(page).first().click();
    await expectQuery(page, "model:fire ");
});

test("every badge sits in one box, so the words beside them line up", async () => {
    await clearBar(page);
    await page.keyboard.type("xpac:", {delay: 5});
    await expect(offerRows(page).first()).toBeVisible();
    // Measured only once the art has decoded: an image still loading has no height, and twelve zeroes agree
    // with each other perfectly.
    await page.waitForFunction(() => {
        const art = [...document.querySelectorAll("[role=option] img")];
        return art.length > 0 && art.every((img) => (img as HTMLImageElement).complete);
    });
    const boxes = await offerRows(page).evaluateAll((rows) => rows.slice(0, 12).map((row) => {
        const art = row.querySelector("img")?.getBoundingClientRect();
        const word = row.querySelector("[class*='word']")?.getBoundingClientRect();
        return {w: Math.round(art?.width ?? 0), h: Math.round(art?.height ?? 0), at: Math.round(word?.left ?? 0)};
    }));
    // Sized on WIDTH, which is what the wiki this art comes from does. These are one-line wordmarks and
    // two-line lockups: at a shared HEIGHT the two-line ones render their lettering at half the size, and only
    // their widths can be made to agree. The words line up against that one width.
    expect(new Set(boxes.map((box) => box.w)).size).toBe(1);
    expect(new Set(boxes.map((box) => box.at)).size).toBe(1);
    // The height follows each mark's own aspect, so it varies — asserting otherwise is asserting the rule that
    // made them read as different sizes.
    expect(new Set(boxes.map((box) => box.h)).size).toBeGreaterThan(1);
});

test("every spelling that reaches an expansion narrows to it, and picking one writes its name", async () => {
    // The pack declares the ways in and the ordinal type parses against them; the surface reads that same list,
    // so a reader who knows an expansion by its key, its long name or its number finds it either way.
    // An expansion row leads with its badge, so the WORD is what is read rather than the row's first child.
    for (const typed of ["xpac:warl", "xpac:draenor", "xpac:6"]) {
        await clearBar(page);
        await page.keyboard.type(typed, {delay: 5});
        await expect(offerRows(page).first()).toBeVisible();
        await expect(offerRows(page)).toHaveCount(1);
        await expect(offerRows(page).first()).toContainText("WoD");
    }

    // Taking one writes the NAME, not the way in that found it.
    await offerRows(page).first().click();
    await expectQuery(page, "xpac:{WoD}");
});

test("a chip names the expansion, whichever way in the reader wrote", async () => {
    // `6` is a way in, not a spelling to uphold: drawing it back would put a numeral on a worded axis, which the
    // quote law then has to quote — `xpac:"6"`, which reads as nothing a reader meant.
    for (const [typed, drawn] of [["xpac:6", "WoD"], ["xpac:classic", "Vanilla"], ["xpac:2-6", "TBC–WoD"]]) {
        await seed(page, typed);
        await expect(settledSegments(page).first()).toContainText(drawn);
        await expect(settledSegments(page).first()).not.toContainText("\"");
    }
});

test("an offer once taken is spent: the same text typed again is not silently lit", async () => {
    // The light says which offer the reader is steering to. It was decided about one arrangement of query and
    // caret — and an arrangement RETURNED TO is not the one that was left, so a light taken (or hovered) at
    // `xpac:6` must not come back the next time those characters stand under the caret. It did, and Enter then
    // applied an offer nobody chose instead of running the query.
    await clearBar(page);
    await page.keyboard.type("xpac:6", {delay: 5});
    await expect(offerRows(page).first()).toBeVisible();
    await offerRows(page).first().click();
    await expectQuery(page, "xpac:{WoD}");

    await clearBar(page);
    await page.keyboard.type("xpac:6", {delay: 5});
    await expect(barInput(page)).not.toHaveAttribute("aria-activedescendant", /./);
    await page.keyboard.press("Enter");
    await expectQuery(page, "xpac:6 ");
});

test("the plaintext view keeps the way in, because it shows what was typed", async () => {
    await seed(page, "xpac:6");
    await plainSwitch(page).click();
    await expect(plainField(page)).toHaveValue("xpac:6 ");
    await plainSwitch(page).click();
});
