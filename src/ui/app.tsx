/**
 * @file Increment 1 of the input layer: the bar shell — one plain input at 1.0's metrics, a live worker-backed
 * count in a 1.0-style status line, and the URL carrying the query.
 *
 * Deliberately nothing else: no chips, no transformation, no completion, no controls. Each of those arrives as
 * its own increment, tested and judged, per the rebuild ruling.
 */
import type {ReactElement} from "react";
import {useEffect, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {PackInfo, Searcher} from "./searcher";
import {Bar} from "./bar/bar";
import styles from "./app.module.css";

/** The query the URL carries, or nothing. */
const urlQuery = (): string => new URLSearchParams(location.search).get("q") ?? "";

/** Rewrites one URL parameter and reloads — the knob transitions that need a refetch. */
function reloadWith(param: string, value: string): void {
    const url = new URL(location.href);
    url.searchParams.set(param, value);
    location.href = url.toString();
}

/** The interface languages a catalog is bundled for. */
const APP_LANGUAGES = ["en", "ru"];

/**
 * The page.
 */
export function App({info, searcher}: {
    readonly info: PackInfo;
    readonly searcher: Searcher;
}): ReactElement {
    const {t, i18n} = useTranslation();
    const [text, setText] = useState(urlQuery);
    const [result, setResult] = useState<{ count: number; ms: number; for: string } | null>(null);
    const asked = useRef("");

    // The count runs in the worker; the page debounces the ask and shows the last answer dimmed until the
    // current one lands.
    useEffect(() => {
        searcher.counts((count, ms) => {
            setResult({count, ms, for: asked.current});
        });
    }, [searcher]);
    useEffect(() => {
        const timer = setTimeout(() => {
            asked.current = text;
            searcher.query(text, "final");
        }, 120);
        return (): void => {
            clearTimeout(timer);
        };
    }, [searcher, text]);

    // The URL is the view: the query lands in it once typing pauses.
    useEffect(() => {
        const timer = setTimeout(() => {
            const url = new URL(location.href);
            if (text.trim() === "") url.searchParams.delete("q");
            else url.searchParams.set("q", text);
            window.history.replaceState(null, "", url);
        }, 400);
        return (): void => {
            clearTimeout(timer);
        };
    }, [text]);

    const stale = result === null || result.for !== text;

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>{t("harness.title")}</h1>
                <span className={styles.subtitle}>{t("harness.subtitle")}</span>
                <span className={styles.knobs}>
                    <label className={styles.knob}>
                        {t("harness.version")}
                        <select
                            value={info.version.id}
                            onChange={(e) => {
                                reloadWith("v", e.target.value);
                            }}
                        >
                            {info.versions.filter((v) => v.hidden !== true).map((v) => (
                                <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                        </select>
                    </label>
                    <label
                        className={styles.knob}
                        title={info.locales.length < 2 ? t("harness.onlyLanguage") : undefined}
                    >
                        {t("harness.packLanguage")}
                        <select
                            value={info.locale}
                            disabled={info.locales.length < 2}
                            onChange={(e) => {
                                reloadWith("lang", e.target.value);
                            }}
                        >
                            {info.locales.map((locale) => (
                                <option key={locale} value={locale}>{locale}</option>
                            ))}
                        </select>
                    </label>
                </span>
            </header>

            <section className={styles.searchbox}>
                <div className={styles.barRow}>
                    <Bar text={text} onText={setText} placeholder={t("bar.placeholder")}/>
                </div>
                <div
                    className={`${styles.status} ${stale ? styles.statusStale : ""}`}
                    role="status"
                >
                    {result !== null && (
                        `${result.count.toLocaleString()} ${t("count.result", {count: result.count})}`
                        + ` · ${t("count.elapsed", {ms: result.ms})}`
                    )}
                </div>
            </section>

            <footer className={styles.footer}>
                <label className={styles.knob}>
                    {t("harness.appLanguage")}
                    <select
                        value={i18n.resolvedLanguage ?? "en"}
                        onChange={(e) => {
                            reloadWith("lng", e.target.value);
                        }}
                    >
                        {APP_LANGUAGES.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                </label>
            </footer>
        </div>
    );
}
