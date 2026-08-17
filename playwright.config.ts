/**
 * @file Playwright configuration for the browser interaction suite under test/browser/.
 *
 * The suite drives the real dev harness with native keyboard and mouse input, so it runs apart from the fast
 * `npm test` loop: `npm run test:browser`, or through tools/check.py when a Playwright browser is installed.
 * Firefox is the project's verification browser; a further browser is one entry in `projects`.
 */
import {defineConfig} from "@playwright/test";

/** Where `npm run harness` serves the repo root; the harness page lives under /dev/harness/. */
const HARNESS = "http://127.0.0.1:8436";

export default defineConfig({
    testDir: "test/browser",
    use: {baseURL: HARNESS},
    projects: [
        {name: "firefox", use: {browserName: "firefox"}},
    ],
    // The harness rebuilds on every request, so a running instance always serves current source. Reusing an
    // existing server probes the port rather than trusting any recorded state — another session may already
    // hold it, and that instance serves this run equally well.
    webServer: {
        command: "npm run harness",
        url: `${HARNESS}/dev/harness/`,
        reuseExistingServer: true,
        timeout: 90_000,
    },
});
