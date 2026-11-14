import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import * as hostMirror from '../../src/integration/yida-send-budget'

// Gate 4 (R-71 ⑦.2): plugins/plugin-integration-core/lib/yida-send-budget.cjs is the single definition
// of the YiDa owner send budgets. core-backend src keeps a constants-only mirror (it never imports a
// plugin lib module); this pins every mirrored value equal to the plugin's, so a change on either side
// reds here instead of drifting.
const require = createRequire(import.meta.url)
const PLUGIN_BUDGET = require('../../../../plugins/plugin-integration-core/lib/yida-send-budget.cjs') as Record<string, unknown>

const MIRRORED = ['YIDA_SEND_REQUEST_MAX_BYTES', 'YIDA_SEND_SNAPSHOT_MAX_BYTES', 'YIDA_SEND_SNAPSHOT_MAX_DEPTH',
  'YIDA_SEND_SNAPSHOT_MAX_NODES', 'YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH', 'YIDA_SEND_USER_ID_MAX_LENGTH']

describe('YiDa send budget host mirror', () => {
  it('mirrors exactly the plugin constants, value for value', () => {
    expect(Object.keys(hostMirror).sort()).toEqual(MIRRORED)
    expect(Object.keys(PLUGIN_BUDGET).filter(key => key.startsWith('YIDA_SEND_')).sort()).toEqual(MIRRORED)
    for (const key of MIRRORED) {
      expect(typeof PLUGIN_BUDGET[key]).toBe('number')
      expect((hostMirror as Record<string, unknown>)[key]).toBe(PLUGIN_BUDGET[key])
    }
    expect(hostMirror.YIDA_SEND_REQUEST_MAX_BYTES).toBe(262144)
  })
})
