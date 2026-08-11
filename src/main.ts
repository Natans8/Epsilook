/* The bundle's entry point — the only file esbuild is pointed at
 * (tools/build.mjs). It exists to state the app's wiring in one place:
 *
 *   - pilltypes is imported for its side effects (it registers every pill
 *     type); losing this import would silently empty the registry, which is
 *     why tools/build.mjs verifies every src file is reachable from here.
 *   - boot is imported last and starts the app (its module body runs boot()).
 *
 * Everything else is pulled in transitively by the modules that use it.
 *
 * ⚠ `src/search/` IS DELIBERATELY ABSENT. Search 2.0 is being built BESIDE the
 * shipped engine and nothing drives it yet (PLAN §8: 1.0 is deleted in ONE
 * commit at PHASE 8, never edited in place), so importing it would ship dead
 * code — and worse: its schema validates at import time and THROWS on a
 * duplicate word, which in the browser is a white screen instead of a failed
 * check. `npx tsc`, `node --test` and `tools/check.py` are the three consumers
 * that hold it honest, and none of them can take the site down. PHASE 5 wires
 * it in, when there is something to drive.
 */
import "./pilltypes";
import "./app/boot";
