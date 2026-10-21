'use strict'

// A STAND-IN FOR A DATABASE DRIVER THAT IS NOT INSTALLED — and one that refuses to be used.
//
// The plugin's entry point (`index.cjs`) requires `pg` at module load, through
// lib/sealed-export/stock-preparation-runtime-database.cjs, and `mssql` lazily inside the SQL Server
// producers. A suite that activates the REAL entry point to prove a WIRING property therefore cannot
// even load it on a checkout where the plugin's own dependencies were not installed — which is a
// property of the checkout, not of the code under test.
//
// This module exists so such a suite can supply those specifiers WITHOUT pretending to be a database.
// Every property read yields another refusing proxy, and every CALL or `new` throws by name. So:
//
//   * a load-time destructure (`const { Pool } = require('pg')`) succeeds, which is all the entry
//     point needs to finish activating with the sealed-snapshot runtime flag off; and
//   * the first line of code that actually tries to CONNECT fails loudly and says which symbol it
//     reached for — it can never silently "work" and green a test that should have been red.
//
// It is installed only as a LAST-RESORT resolution fallback (see the suites that use it): on any
// checkout with the dependencies present, the real driver resolves and this file is never loaded.

function refusingProxy(name) {
  return new Proxy(function absentRuntimeDriver() {}, {
    apply() {
      throw new Error(`absent runtime driver called: ${name} (this test path must not touch a database)`)
    },
    construct() {
      throw new Error(`absent runtime driver constructed: ${name} (this test path must not touch a database)`)
    },
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive || property === Symbol.toStringTag) return undefined
      return refusingProxy(`${name}.${String(property)}`)
    },
  })
}

module.exports = refusingProxy('absent-runtime-driver')
