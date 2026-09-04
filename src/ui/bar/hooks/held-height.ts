/**
 * @file A box that keeps its height while it draws a picture of another text.
 *
 * A preview may draw fewer chips than the text has — none at all, for a removal — and a bar that shrank would
 * move whatever stands beneath it out from under the pointer that asked for the preview, lifting it, growing
 * back, and looping. So while a preview stands the bar keeps the height it had when the preview began. The
 * height is read whenever the box is not holding and its size changes, so the hold never measures a picture.
 */
import type {RefObject} from "react";
import {useLayoutEffect, useRef} from "react";

/**
 * The box to hold: attach the ref to the element whose height must not fall while `holding` is true.
 *
 * @param holding Whether a picture of another text is being drawn.
 * @returns The ref for the element.
 */
export function useHeldHeight(holding: boolean): RefObject<HTMLDivElement | null> {
    const box = useRef<HTMLDivElement>(null);
    const kept = useRef<number | null>(null);
    useLayoutEffect(() => {
        const el = box.current;
        if (el === null) return undefined;
        if (holding) {
            el.style.minHeight = kept.current === null ? "" : `${String(kept.current)}px`;
            return undefined;
        }
        el.style.minHeight = "";
        kept.current = el.offsetHeight;
        const watch = new ResizeObserver(() => {
            kept.current = el.offsetHeight;
        });
        watch.observe(el);
        return (): void => {
            watch.disconnect();
        };
    }, [holding]);
    return box;
}
