'use strict'

// Internal-only marker for the C3 K3 LIST read-smoke route. It is a Symbol so JSON
// request bodies, persisted adapter config, and source-action config cannot manufacture it.
const READ_SMOKE_LIST_REQUEST_MARKER = Symbol('plugin-integration-core.read-smoke-list-request')

// Internal-only marker for the C4 K3 BOM read-smoke route (#1709). Same Symbol discipline as the
// LIST marker: BOM read is reachable ONLY through the credentialed read-smoke route, never from a
// JSON request body, persisted adapter config, or source-action config.
const READ_SMOKE_BOM_REQUEST_MARKER = Symbol('plugin-integration-core.read-smoke-bom-request')

// Internal-only marker for the BL2 K3 BOM/GetList-by-material read (#1709, BL0 design-lock
// integration-k3wise-bom-list-by-material-id-design-lock-20260705.md). Same Symbol discipline: the
// by-material BOM list read is reachable ONLY through the read-source runtime builders, never from a
// JSON request body, persisted adapter config, or source-action config.
const READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER = Symbol('plugin-integration-core.read-smoke-bom-list-by-material-request')

module.exports = {
  READ_SMOKE_LIST_REQUEST_MARKER,
  READ_SMOKE_BOM_REQUEST_MARKER,
  READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER,
}
