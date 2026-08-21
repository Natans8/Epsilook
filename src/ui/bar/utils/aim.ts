/**
 * @file Where a press landed in the query — the bar's hit test, and nothing else.
 *
 * The bar draws every character of the query exactly once and stamps each child with the offset it starts at,
 * which is what makes a point answerable at all: a child drawing plain text maps character by character, a chip
 * draws its parse instead and can only answer with an edge. Both readings live here, apart from the component,
 * because they are geometry rather than state — they take an element and a point and return an offset.
 */
import type {BarSegment} from "./plan";
import {segmentAt} from "./plan";

/** Where a press landed in the query, and whether that offset is a character or an edge. */
export interface Aim {
    readonly at: number;
    /** True where the thing under the point draws its own characters and could name the one pressed. */
    readonly exact: boolean;
    /**
     * The whole span of the thing under the point, where that thing is atomic.
     *
     * A press wants the nearer edge of a chip — that is the gap it means. A gesture that is REACHING one wants
     * the far edge: touching a chip at all takes the whole chip, so a selection never stops half way across one
     * and leaves its value looking picked out.
     */
    readonly span?: BarSegment | { readonly start: number; readonly end: number };
}

/**
 * The offset a point aims at, read from the stamps the bar puts on its own children.
 *
 * @param bar The bar element.
 * @param x The point's client x.
 * @param y The point's client y.
 * @returns The aim, or null where the point is over no stamped child at all.
 */
export function offsetAtPoint(bar: HTMLElement, x: number, y: number): Aim | null {
    const hit = document.caretPositionFromPoint?.(x, y);
    const node = hit?.offsetNode;
    const from = node instanceof Element ? node : node?.parentElement;
    const child = from?.closest<HTMLElement>("[data-at]");
    if (child === null || child === undefined || !bar.contains(child)) return null;
    const at = Number(child.dataset["at"]);
    if (child.dataset["plain"] === undefined || node === undefined) {
        const box = child.getBoundingClientRect();
        const span = {start: at, end: Number(child.dataset["end"] ?? at)};
        return {at: x < box.left + box.width / 2 ? span.start : span.end, exact: false, span};
    }
    const range = document.createRange();
    range.selectNodeContents(child);
    range.setEnd(node, hit?.offset ?? 0);
    return {at: at + range.toString().length, exact: true};
}

/**
 * The offset a press on the bar's own GROUND aims at, read the way a caret lands in wrapped text: the line the
 * press fell on decides first, and the position within that line second.
 *
 * The line matters more than the horizontal distance — pressing the empty space after the last chip of a line
 * means the end of THAT line, never the same horizontal spot on the line above it, which is what the platform's
 * own caret hit test answers with.
 *
 * @param bar The bar element.
 * @param x The point's client x.
 * @param y The point's client y.
 * @param text The query text.
 * @returns The offset the press means.
 */
export function groundAim(bar: HTMLElement, x: number, y: number, text: string): number {
    const kids = Array.from(bar.children)
        .map((child) => ({
            at: child instanceof HTMLElement ? child.dataset["at"] : undefined,
            box: child.getBoundingClientRect(),
        }))
        .filter((child) => child.at !== undefined && child.box.width > 0);
    if (kids.length === 0) return text.length;
    // The press's own line, or the last one above it when it fell past the final row.
    const bottom = Math.max(...kids.map((child) => child.box.bottom));
    const line = y >= bottom
        ? kids.filter((child) => child.box.bottom >= bottom - 1)
        : kids.filter((child) => y >= child.box.top && y <= child.box.bottom);
    if (line.length === 0) return text.length;
    const before = line.find((child) => x < child.box.left);
    if (before !== undefined) return Number(before.at);
    const last = line[line.length - 1];
    if (x < last.box.right) return Number(last.at);
    // Past everything on the line: the end of what stands on it — and on the last line that is the end of the
    // query, which is the one filling tail rather than a gap before anything.
    return last.box.bottom >= bottom - 1 ? text.length : segmentAt(text, Number(last.at)).end;
}
