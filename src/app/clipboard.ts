import {$, el} from "../util";
/* --------------------------------------------------------- clipboard */

let toastTimer = 0;

export function toast(msg: string): void {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
}

export function copyText(text: string, wrapTicks = false, message?: string): void {
    if (wrapTicks) text = "`" + text + "`";
    const done = () => toast(message || `Copied:  ${text}`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
        fallbackCopy(text, done);
    }
}

/**
 * execCommand-based clipboard fallback (the deprecated API is the only
 * option when navigator.clipboard is unavailable, e.g. plain-http hosts).
 */
function fallbackCopy(text: string, done: () => void) {
    // ta.select() steals focus — put it back afterwards
    const prev = (document.activeElement as HTMLElement | null);
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
        // Fallback for browsers without async navigator.clipboard — there is no
        // non-deprecated synchronous copy API.
        // noinspection JSDeprecatedSymbols
        document.execCommand("copy");
        done();
    } catch {
        toast("Copy failed");
    }
    ta.remove();
    if (prev && prev !== document.body) prev.focus({preventScroll: true});
}
