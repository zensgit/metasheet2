/**
 * Owner closure item 4 — startup FAIL-CLOSED policy for a durable-delivery boot failure.
 *
 * With the flag ON the wired producer families SUPPRESS their legacy post-commit emits, so a swallowed boot
 * failure does not "degrade" to the legacy path — it strands every outbox row with no dispatcher (a silent,
 * total delivery outage strictly worse than a crash). index.ts's boot catch consults this disposition and
 * RETHROWS on 'fail-closed'; these tests pin the policy so a future edit cannot silently soften it.
 */
import { describe, expect, test } from 'vitest'

import { durableBootFailureDisposition } from '../../src/multitable/automation-durable-activation'

describe('durableBootFailureDisposition — flag-ON boot failures abort startup', () => {
  test('flag ON → fail-closed (the boot site must rethrow; legacy emits are suppressed, degraded mode = outage)', () => {
    expect(durableBootFailureDisposition({ AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe('fail-closed')
    expect(durableBootFailureDisposition({ AUTOMATION_DURABLE_DELIVERY_ENABLED: ' TRUE ' } as unknown as NodeJS.ProcessEnv)).toBe('fail-closed')
  })

  test('flag OFF / absent / garbage → degraded-ok (nothing suppressed; legacy path delivers)', () => {
    expect(durableBootFailureDisposition({} as NodeJS.ProcessEnv)).toBe('degraded-ok')
    expect(durableBootFailureDisposition({ AUTOMATION_DURABLE_DELIVERY_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv)).toBe('degraded-ok')
    expect(durableBootFailureDisposition({ AUTOMATION_DURABLE_DELIVERY_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe('degraded-ok')
  })
})
