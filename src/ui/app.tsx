/**
 * Root component of the search 2.0 interface.
 *
 * TODO: replace with the designed interface once the design document exists.
 * Until then this component proves the toolchain end to end: a query parsed
 * through the engine, the result rendered by React.
 */
import type {ReactElement} from "react";
import {parse} from "../search/index";

/** The search 2.0 application. */
export function App(): ReactElement {
    const example = "model:{fire -missile} scale:>50";
    const parsed = parse(example);
    return (
        <p>
            search 2.0 — <code>{example}</code> parses to {parsed.clauses.length} clauses
            with {parsed.diagnostics.length} diagnostics
        </p>
    );
}
