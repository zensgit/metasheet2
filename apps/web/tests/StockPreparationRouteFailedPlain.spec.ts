import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 2026-10-10 integration-layer audit: every stock-prep / table-action route now answers an untyped server
// failure with ONE fixed, values-free 500 (plugins/plugin-integration-core/lib/http-routes.cjs
// VALUES_FREE_ROUTE_ERROR_MAPPERS). Its server sentence is fixed English written for logs. This spec pins
// that no screen shows that sentence: the stock-prep surfaces resolve the code to their own plain-language
// entry (never the generic "nothing changed" one, because a write route can fail part way), and the admin
// workbench — the one client that surfaces `error.message` — turns it into the same plain words + the code.

import {
  STOCK_PREP_BOARD_ERROR_GENERIC,
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  stockPrepBoardErrorPlain,
  stockPrepErrorPlain,
} from '../src/services/integration/stockPreparation/plainLanguage'
import { STOCK_PREP_PROJECT_TARGET_ERROR_CODES } from '../src/services/integration/stockPreparation/projectTarget'
import {
  INTEGRATION_VALUES_FREE_ROUTE_FAILURE_CODES,
  integrationApiErrorCode,
  integrationValuesFreeRouteFailureMessage,
  parseIntegrationResponse,
} from '../src/services/integration/workbench'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
// The server exports the code directly — require, never text-parse.
const { STOCK_PREPARATION_ROUTE_FAILED_CODE: SERVER_ROUTE_FAILED_CODE } =
  require(path.join(pluginLib, 'http-routes.cjs')).__internals as { STOCK_PREPARATION_ROUTE_FAILED_CODE: string }

const SERVER_FIXED_SENTENCE = 'the request could not be completed; this response does not describe the failure'

function envelopeResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'Content-Type': 'application/json' } })
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('stock-prep values-free route failure — plain language', () => {
  it('the server code is the one the web maps', () => {
    expect(SERVER_ROUTE_FAILED_CODE).toBe('STOCK_PREPARATION_ROUTE_FAILED')
    expect(INTEGRATION_VALUES_FREE_ROUTE_FAILURE_CODES).toContain(SERVER_ROUTE_FAILED_CODE)
    expect(INTEGRATION_VALUES_FREE_ROUTE_FAILURE_CODES).toContain('STOCK_PREPARATION_PROJECT_ROUTE_FAILED')
  })

  it('the stock-prep surfaces resolve it to its own entry, never the generic "nothing changed" one', () => {
    const entry = STOCK_PREP_ERROR_PLAIN[SERVER_ROUTE_FAILED_CODE]
    expect(entry).toBeTruthy()
    expect(entry.zh).toBeTruthy()
    expect(entry.en).toBeTruthy()
    expect(entry.zhNext).toBeTruthy()
    expect(entry.enNext).toBeTruthy()
    expect(stockPrepErrorPlain(SERVER_ROUTE_FAILED_CODE)).toBe(entry)
    expect(stockPrepErrorPlain(SERVER_ROUTE_FAILED_CODE)).not.toBe(STOCK_PREP_ERROR_GENERIC)
    expect(stockPrepBoardErrorPlain(SERVER_ROUTE_FAILED_CODE)).toBe(entry)
    expect(stockPrepBoardErrorPlain(SERVER_ROUTE_FAILED_CODE)).not.toBe(STOCK_PREP_BOARD_ERROR_GENERIC)
    // A write route can fail part way: the sentence must not promise that nothing changed.
    expect(entry.zh).not.toContain('没有变化')
    expect(entry.zh).not.toContain('没有改动')
    expect(entry.en.toLowerCase()).not.toContain('nothing')
    // The project-target flow (list / get / create / archive / restore) knows the code.
    expect(STOCK_PREP_PROJECT_TARGET_ERROR_CODES).toContain(SERVER_ROUTE_FAILED_CODE)
  })

  it('the admin workbench shows the plain words and the code, never the fixed English sentence', async () => {
    for (const code of [SERVER_ROUTE_FAILED_CODE, 'STOCK_PREPARATION_PROJECT_ROUTE_FAILED']) {
      const error = await caught(parseIntegrationResponse(envelopeResponse(500, { code, message: SERVER_FIXED_SENTENCE, details: {} })))
      expect(error.message).not.toContain(SERVER_FIXED_SENTENCE)
      expect(error.message).not.toContain('could not be completed')
      expect(error.message).toContain(STOCK_PREP_ERROR_PLAIN[code].zh)
      expect(error.message).toContain(code)
      expect(integrationApiErrorCode(error)).toBe(code)
      expect((error as Error & { status?: number }).status).toBe(500)
      expect(integrationValuesFreeRouteFailureMessage(code)).toBe(error.message)
    }
  })

  it('every other code keeps the server message exactly as before', async () => {
    const error = await caught(parseIntegrationResponse(envelopeResponse(409, { code: 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS', message: 'already registered', details: {} })))
    expect(error.message).toBe('already registered')
    expect(integrationValuesFreeRouteFailureMessage('STOCK_PREPARATION_PROJECT_TARGET_EXISTS')).toBeNull()
    expect(integrationValuesFreeRouteFailureMessage(undefined)).toBeNull()
    expect(integrationValuesFreeRouteFailureMessage('constructor')).toBeNull()
  })
})
