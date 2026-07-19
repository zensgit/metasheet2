/** record-link + FWB-2 — submit/execute rechecks (pure goldens, required lane). Fail-closed everywhere. */
import { describe, expect, test } from 'vitest'

import {
  recheckBoundRecordAtExecute,
  validateRecordLinkAtSubmit,
  type RecordLinkChecks,
} from '../../src/multitable/approval-fwb-record-link'

const trx = { query: async () => ({ rows: [], rowCount: 0 }) }
const checks = (over: Partial<Record<keyof RecordLinkChecks, boolean | 'throw'>> = {}): RecordLinkChecks => {
  const mk = (k: keyof RecordLinkChecks, dflt: boolean) => async () => {
    const v = over[k]
    if (v === 'throw') throw new Error('backend down')
    return v ?? dflt
  }
  return {
    fillerCanReadRecord: mk('fillerCanReadRecord', true),
    recordExists: mk('recordExists', true),
    recordIsLocked: mk('recordIsLocked', false),
    configurerCanWriteRecord: mk('configurerCanWriteRecord', true),
  }
}

describe('record-link + FWB-2 rechecks', () => {
  test('submit: unreadable AND nonexistent produce the SAME code (no existence oracle); errors fail closed', async () => {
    expect(await validateRecordLinkAtSubmit(checks(), 'u', 's', 'r')).toEqual({ ok: true })
    expect(await validateRecordLinkAtSubmit(checks({ fillerCanReadRecord: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'link_not_readable' })
    expect(await validateRecordLinkAtSubmit(checks({ fillerCanReadRecord: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'link_not_readable' })
  })

  test('execute: exists→locked→writable in order, each fail-closed (an ERRORED lock check counts as LOCKED)', async () => {
    expect(await recheckBoundRecordAtExecute(trx, checks(), 'u', 's', 'r')).toEqual({ ok: true })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordExists: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_missing' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordIsLocked: true }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_locked' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordIsLocked: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_locked' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ configurerCanWriteRecord: false }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_not_writable' })
    expect(await recheckBoundRecordAtExecute(trx, checks({ recordExists: 'throw' }), 'u', 's', 'r')).toEqual({ ok: false, code: 'record_missing' })
  })
})
