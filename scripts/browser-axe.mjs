import { createRequire } from 'node:module'

// Use the same axe version as the Playwright adapter, not another download.
const require = createRequire(import.meta.url)
const { source } = createRequire(require.resolve('@axe-core/playwright'))('axe-core')

/** Axe's UMD browser source registers itself with a page's AMD loader on every
 * scan. Monaco owns that loader; repeated scans otherwise redefine "axe-core".
 * Keep test instrumentation out of the application's module registry using
 * lexical parameters, without changing global define/require or console hooks.
 * window.axe, every accessibility rule and the zero-console-error gate remain.
 */
export const isolatedAxeSource = `(function(define, module, exports) {\n${source}\n}).call(window, undefined, undefined, undefined);`
