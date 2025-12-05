// plugin-metrics.ts
// Provides optional prom-client counters for plugin lifecycle.
// Safe to import even if prom-client initialization order varies.

interface PromClient {
  Counter: new (config: { name: string; help: string }) => { inc: () => void }
}

let prom: PromClient | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  prom = require('prom-client') as PromClient
} catch {
  /* prom-client not available or not initialized */
}

function makeCounter(name: string, help: string) {
  if (!prom || !prom.Counter) {
    return { inc: () => void 0 }
  }
  return new prom.Counter({ name, help })
}

// Total successfully loaded plugins (after loadPlugin succeeds)
export const pluginLoadedTotal = makeCounter(
  'plugin_loaded_total',
  'Total number of plugins successfully loaded'
)

// Validation failures (lightweight validator)
export const pluginValidationFailTotal = makeCounter(
  'plugin_validation_fail_total',
  'Total number of plugin validation failures (lightweight validator)'
)

// Future candidates (left for later instrumentation):
// export const pluginSandboxWrapFailTotal = makeCounter('plugin_sandbox_wrap_fail_total', 'Sandbox wrapping failures');
