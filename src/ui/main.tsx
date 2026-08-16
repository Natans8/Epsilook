/**
 * The presentation layer's entry point: mounts the search 2.0 interface onto a
 * host element. React lives only under src/ui — the engine (src/search) stays
 * framework-free, and the react-seam guard in tools/check.py holds that line.
 */
import {createRoot} from "react-dom/client";
import {App} from "./app";

/** Mount the search 2.0 interface onto `host`, replacing its contents. */
export function mount(host: HTMLElement): void {
    createRoot(host).render(<App/>);
}
