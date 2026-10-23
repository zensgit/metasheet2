'use strict'

// Plugin-storage fakes WITH the host's atomic `consume` (packages/core-backend/src/types/plugin.ts
// PluginStorage.consume; durable = one DELETE ... RETURNING over plugin_kv). Stock-prep apply claims
// its single-use dry-run token through `consume` and refuses a store without it (501), so every fake
// that reaches apply must carry one. Not a suite (support/ is outside the chain-completeness walk).
//
// A Map-backed `consume` is ONE synchronous step (has + get + delete with no await in between), so two
// concurrent consumes of one key can never both answer the value — the property the durable one has.

function mapConsume(map, key) {
  if (!map.has(key)) return null
  const value = map.get(key)
  map.delete(key)
  return value === undefined ? null : value
}

// `Object.assign(new Map(), { durable: true })`, the shape several route-mount suites use as
// `context.storage`, plus `consume` and the host contract's `list` (every key, sorted — what the durable
// one's `SELECT key ... ORDER BY key` answers; the pilot readiness scans it for open large-BOM jobs).
function consumableMap({ durable = true } = {}) {
  const map = new Map()
  return Object.assign(map, {
    ...(durable ? { durable: true } : {}),
    async consume(key) {
      return mapConsume(map, key)
    },
    async list() {
      return Array.from(map.keys()).sort()
    },
  })
}

module.exports = {
  consumableMap,
  mapConsume,
}
