/* The bundle's entry point — the only file esbuild is pointed at
 * (tools/build.mjs). It exists to state the app's wiring in one place:
 *
 *   - pilltypes is imported for its side effects (it registers every pill
 *     type); losing this import would silently empty the registry, which is
 *     why tools/build.mjs verifies every src file is reachable from here.
 *   - boot is imported last and starts the app (its module body runs boot()).
 *
 * Everything else is pulled in transitively by the modules that use it.
 */
import "./pilltypes";
import "./app/boot";
