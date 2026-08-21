/**
 * @file One lane item of a settled segment, re-read from that segment's own text.
 *
 * Found by INDEX rather than by span, because a press settles whatever segment was open first and that commit
 * can rewrite the very segment being acted on — trimming a scope's interior shifts every span inside it. The
 * index survives, because a commit never adds or removes a term.
 */
import type {Span} from "../../../search/index";
import {describe, parse} from "../../../search/index";

/**
 * One lane item of a settled segment, re-read from that segment's own text.
 *
 * @param segment The segment's text.
 * @param index Which of the lane's items to find.
 * @returns The item's span and whether it stands alone in its run, or null when the segment no longer draws
 *   a lane with that item — a settle can collapse one, and a press that raced it must then do nothing.
 */
export function laneItemAt(segment: string, index: number): { span: Span; lone: boolean } | null {
    const view = describe(parse(segment)).find((held) => held.form === "lane");
    const item = view?.form === "lane" ? view.lane.items[index] : undefined;
    if (item === undefined || item.is === "or" || item.is === "dead") return null;
    return {span: item.span, lone: item.lone};
}
