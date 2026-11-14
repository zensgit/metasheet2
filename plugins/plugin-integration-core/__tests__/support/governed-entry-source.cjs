'use strict'

// R-69 1b-i — WHERE A DELEGATING ROUTE'S CODE NOW LIVES, for the source-reading guards.
//
// Three route handlers became thin: they build the principal context from `req` and call a
// request-free governed entry in http-routes.cjs (design baseline v2.3 §10.2.4; ADR
// adr-automation-pipeline-bridge-20261103.md §2 ③). Their guard chain moved, verbatim, into that entry.
// A source guard that pins "the handler does X before Y" must therefore read the handler AND the entry it
// delegates to — otherwise it would either go blind (the text is gone from the handler) or be weakened
// by deleting the handler from its list. `governedEntrySourceFor` returns the entry's body for a
// delegating handler (and '' for every other handler), after asserting that the handler really does
// delegate to it, so a guard that appends it can never be satisfied by an entry the route no longer calls.

const assert = require('node:assert/strict')

const GOVERNED_ENTRY_OF_HANDLER = Object.freeze({
  tableActionDryRun: 'governedStockPrepPull',
  pipelinesRun: 'runGovernedPipeline',
  pipelinesDryRun: 'runGovernedPipeline',
})

function governedEntryBody(src, entryName) {
  const text = src.replace(/\r\n/g, '\n')
  const marker = `\n  async function ${entryName}(`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `governed entry ${entryName} exists in http-routes.cjs`)
  assert.equal(text.indexOf(marker, start + 1), -1, `governed entry ${entryName} is defined once`)
  const end = text.indexOf('\n  }\n', start + 1)
  assert.notEqual(end, -1, `governed entry ${entryName} has a closing brace`)
  return text.slice(start + 1, end)
}

function handlerSlice(src, handler) {
  const text = src.replace(/\r\n/g, '\n')
  const start = text.indexOf(`\n    async ${handler}(req, res) {`)
  assert.notEqual(start, -1, `handler ${handler} exists in http-routes.cjs`)
  return text.slice(start + 1, text.indexOf('\n    },', start + 1))
}

/** The governed entry's body a delegating handler calls, prefixed with a newline; '' for any other handler. */
function governedEntrySourceFor(src, handler) {
  const entryName = GOVERNED_ENTRY_OF_HANDLER[handler]
  if (!entryName) return ''
  assert.ok(
    handlerSlice(src, handler).includes(`await ${entryName}(governedPrincipalContextFromRequest(req), `),
    `${handler} delegates to ${entryName} with a context built from its request`,
  )
  return `\n${governedEntryBody(src, entryName)}`
}

module.exports = {
  GOVERNED_ENTRY_OF_HANDLER,
  governedEntryBody,
  governedEntrySourceFor,
}
