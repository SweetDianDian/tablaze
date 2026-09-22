# Navigation policy probe evidence

The [sanitized measurement record](evidence/navigation-policy-probe-v1.json) preserves supplementary local probes from 2026-09-22. These are single executions of named scenarios, not statistical reliability estimates or a Browser Use comparison. No models, paid services, personal browser, or external test destinations were used.

The route and nine-case CDP reports recorded Node v25.9.0, Playwright 1.63.0 and Chrome 153.0.8010.53. Contexts blocked service workers. The later OOPIF/stress and disconnect reports did not independently record runtime versions; their scripts identify the launch configuration only.

| Probe | Recorded observation |
| --- | --- |
| `context.route` with `continue()` | Forbidden server received a request through direct, chained, iframe and popup redirects. Direct iframe and first-popup destinations were blocked. |
| `route.fetch({maxRedirects:0})` then `fulfill()` | Direct, chained and popup redirects still reached the forbidden server. The iframe redirect produced zero forbidden requests **without a denial event**; this is not enforcement proof. |
| Standalone flattened CDP; normal Playwright launch | All six prohibited navigation scenarios produced zero forbidden-server requests. Three allowed Cookie/303/307 scenarios retained the measured behavior. |
| Development `navigation-guard.ts` module | The same nine cases completed: six prohibited cases each had zero downstream requests and one context denial; the three allowed cases had zero denials. |
| Cross-process iframe and two-context stress | `Target.getTargets` confirmed an iframe target. Its prohibited navigation produced zero requests. Across 24 popup closes, context denial counts advanced from `[1,0]` to `[7,6]`; the second context remained usable after closing the first, whose counter was retired. |
| Raw CDP transport disconnect | With a Document request paused, terminating the guard socket changed server request count from 0 to 2 within the 400 ms observation window; navigation completed. The retained result does not identify both request paths. |

Allowed-response checks observed a redirect-set cookie at the destination, POST→GET with an empty body for 303, and preserved POST/body for 307. These checks do not establish cache, streaming, or every authentication behavior. First-popup `request.frame()` threw in the route probe, so enforcement cannot require that API.

The successful launch probe used `--remote-debugging-port=0` and `--enable-automation`. It discovered only its owned browser endpoint through public `Browser.getBrowserCommandLine` and that profile's `DevToolsActivePort`. The CDP guard enabled Request-stage Document interception before resuming attached targets and configured recursive flattened auto-attachment. No profile paths, fixture URLs, bodies, cookie values or raw error messages are published here.

The disconnect counterexample is a limitation: Chrome may resume paused requests after losing CDP. Closing the owned browser on transport failure is best effort; this is a document navigation policy, not an atomic fail-closed network firewall. Subresource traffic is outside this probe's scope.

The JSON includes hashes of retained scripts and original result files calculated at publication. Those files remain local; execution-time source/build hashes were **not** captured. The module probes directly imported TypeScript under Node 25, not `dist`. The nine-case module run preceded subsequent startup/detached-target cleanup edits, while the OOPIF/stress run used a later development version. Neither proves equality with the final source or build.

Full public BrowserEngine/MCP/CLI regression counts and build provenance are maintained separately by the main test run. They are deliberately not inferred or backfilled into this immutable probe record.

The final public build passed **353/353** full-suite tests, including **35** navigation-policy/CLI/lifecycle regressions (0 failed, skipped or cancelled). The [full log](evidence/development-tests.txt) and [source/build manifest](evidence/development-validation.json) bind that separate run to its tested files. Reproduce with `TABLAZE_BROWSER_CHANNEL=chrome npm test` for installed Chrome, or `npm test` after installing managed Chromium.
