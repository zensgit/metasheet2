'use strict'

// Shared fixtures are inert on import; this entry owns the complete suite run.
const { main } = require('./support/stock-preparation-bom-active-state-fixture.cjs')

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-bom-active-state.test.cjs', main)
