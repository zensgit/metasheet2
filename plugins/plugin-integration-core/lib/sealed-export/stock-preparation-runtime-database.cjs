'use strict'

const { Pool } = require('pg')

const { createDb } = require('../db.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')

const runtimeDatabases = new WeakSet()
const provisioningDatabases = new WeakSet()

function requiredText(value, maxLength = 4096) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }
  return value
}

function createRoleBoundDatabase({
  applicationName,
  brand,
  connectionString,
  expectedRole,
} = {}) {
  const ownedConnectionString = requiredText(connectionString)
  const ownedExpectedRole = requiredText(expectedRole, 128)
  let pool
  try {
    pool = new Pool({
      application_name: applicationName,
      connectionString: ownedConnectionString,
      max: 2,
    })
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  let ready = false
  let closed = false

  async function queryWith(client, sql, params) {
    const result = await client.query(sql, params)
    return result.rows
  }

  const database = Object.freeze({
    async query(sql, params) {
      if (closed) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      try {
        return await queryWith(pool, sql, params)
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    },
    async transaction(callback) {
      if (closed || typeof callback !== 'function') {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      let client
      let finished = false
      try {
        client = await pool.connect()
        await client.query('BEGIN')
        const trx = Object.freeze({
          query: (sql, params) => queryWith(client, sql, params),
          async commit() {
            if (finished) return
            await client.query('COMMIT')
            finished = true
          },
          async rollback() {
            if (finished) return
            await client.query('ROLLBACK')
            finished = true
          },
        })
        const result = await callback(trx)
        if (!finished) {
          await client.query('COMMIT')
          finished = true
        }
        return result
      } catch (error) {
        if (client && !finished) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // best-effort rollback before the closed failure leaves this boundary
          }
        }
        if (isTrustedSealedExportError(error)) {
          return Promise.reject(error)
        }
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      } finally {
        if (client) client.release()
      }
    },
  })
  const scopedDb = createDb({ database })
  const handle = Object.freeze({
    db: scopedDb,
    async assertReady() {
      if (closed) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      let rows
      try {
        rows = await pool.query(
          'SELECT current_user AS current_user, session_user AS session_user',
        )
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      if (
        rows.rows.length !== 1
        || rows.rows[0].current_user !== ownedExpectedRole
        || rows.rows[0].session_user !== ownedExpectedRole
      ) {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      ready = true
      return Object.freeze({
        externalWrite: false,
        roleVerified: true,
        valuesFree: true,
      })
    },
    async close() {
      if (closed) return
      closed = true
      ready = false
      try {
        await pool.end()
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    },
    isReady() {
      return ready && !closed
    },
  })
  brand.add(handle)
  return handle
}

function createStockPreparationRuntimeDatabase(options = {}) {
  return createRoleBoundDatabase({
    ...options,
    applicationName: 'metasheet-s6a-stock-preparation-runtime',
    brand: runtimeDatabases,
  })
}

function createStockPreparationProvisioningDatabase(options = {}) {
  return createRoleBoundDatabase({
    ...options,
    applicationName: 'metasheet-s6a-stock-preparation-provisioning',
    brand: provisioningDatabases,
  })
}

function isStockPreparationRuntimeDatabase(value) {
  return runtimeDatabases.has(value)
}

function isStockPreparationProvisioningDatabase(value) {
  return provisioningDatabases.has(value)
}

module.exports = Object.freeze({
  createStockPreparationProvisioningDatabase,
  createStockPreparationRuntimeDatabase,
  isStockPreparationProvisioningDatabase,
  isStockPreparationRuntimeDatabase,
})
