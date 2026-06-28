'use strict'

// Internal-only marker for the C3 K3 LIST read-smoke route. It is a Symbol so JSON
// request bodies, persisted adapter config, and source-action config cannot manufacture it.
const READ_SMOKE_LIST_REQUEST_MARKER = Symbol('plugin-integration-core.read-smoke-list-request')

module.exports = {
  READ_SMOKE_LIST_REQUEST_MARKER,
}
